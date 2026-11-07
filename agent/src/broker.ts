/**
 * The broker: quotes, haggles, asks the risk agent, and then hands every
 * proposal to the contract. It never holds funds and cannot bypass a limit —
 * the worst it can do is propose something the contract rejects, which is a
 * feature we demonstrate on purpose.
 */

import { audit } from "./audit.js";
import { config, hasAgentKey } from "./config.js";
import { DESKS, deskTurn, describeOffer, formatUsdc } from "./desks.js";
import * as near from "./contract.js";
import { requestQuote, waitForSettlement } from "./intents.js";
import type { Decision, Mandate, Offer } from "./types.js";

export interface Leg {
  id: number;
  desk: string;
  deskName: string;
  account: string;
  size: string;
  sizeFormatted: string;
  edgeBps: number;
  status: "pending" | "checking" | "rejected" | "executed" | "settled" | "failed";
  rejectCode?: string;
  rejectReason?: string;
  txHash?: string;
  depositAddress?: string;
  amountOut?: string;
  amountOutFormatted?: string;
}

export interface RunSnapshot {
  running: boolean;
  stage: string;
  mandateId: number;
  mandate?: Mandate;
  offers: Offer[];
  legs: Leg[];
  events: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

const state: RunSnapshot = {
  running: false,
  stage: "idle",
  mandateId: Number(process.env.MANDATE_ID ?? 0),
  offers: [],
  legs: [],
  events: 0,
};

export function snapshot(): RunSnapshot {
  return {
    ...state,
    legs: state.legs.map((l) => ({ ...l })),
    offers: state.offers.map((o) => ({ ...o })),
  };
}

function log(
  kind: Parameters<typeof audit.log>[0],
  actor: Parameters<typeof audit.log>[1],
  message: string,
  data?: Record<string, unknown>,
) {
  audit.log(kind, actor, message, data);
  state.events++;
}

/** Risk agent: a separate opinion that can veto before the contract is asked. */
function riskVeto(offer: Offer, mandate: Mandate): { veto: boolean; reason: string } {
  if (!mandate.allowed_counterparties.includes(offer.account)) {
    return { veto: true, reason: `counterparty ${offer.account} is not on the mandate allowlist` };
  }
  if (offer.edgeBps < -mandate.max_slippage_bps) {
    return {
      veto: true,
      reason: `price ${Math.abs(offer.edgeBps)} bps below reference, mandate allows ${mandate.max_slippage_bps}`,
    };
  }
  if (offer.size > BigInt(mandate.max_size) - BigInt(mandate.spent)) {
    return { veto: true, reason: "size would exceed the remaining mandate cap" };
  }
  return { veto: false, reason: "within mandate and no anomaly" };
}

function newLeg(index: number, offer: Offer): Leg {
  const desk = DESKS.find((d) => d.id === offer.desk);
  return {
    id: index,
    desk: offer.desk,
    deskName: desk?.name ?? offer.desk,
    account: offer.account,
    size: offer.size.toString(),
    sizeFormatted: formatUsdc(offer.size),
    edgeBps: offer.edgeBps,
    status: "pending",
  };
}

async function askDesks(mandate: Mandate, round: number): Promise<Offer[]> {
  const offers: Offer[] = [];
  await Promise.all(
    DESKS.filter((d) => d.behaviour !== "bait").map(async (desk) => {
      // a little latency so the live feed reads like a real chat
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 400));
      const turn = deskTurn(desk, round, mandate);
      if (!turn.offer) {
        log("desk.silent", "user", `${desk.name} did not answer`, { desk: desk.id });
        return;
      }
      offers.push(turn.offer);
      log("desk.quote", "desk", `${desk.name} quotes ${describeOffer(turn.offer)}`, {
        desk: desk.id,
        edgeBps: turn.offer.edgeBps,
        size: turn.offer.size.toString(),
      });
    }),
  );
  return offers.sort((a, b) => a.edgeBps - b.edgeBps);
}

/** Greedy allocation: best price first, never past the remaining cap. */
function allocate(offers: Offer[], remaining: bigint): Offer[] {
  const chosen: Offer[] = [];
  let left = remaining;
  for (const offer of offers.sort((a, b) => a.edgeBps - b.edgeBps)) {
    if (left <= 0n) break;
    const size = offer.size < left ? offer.size : left;
    if (size <= 0n) continue;
    chosen.push({ ...offer, size });
    left -= size;
  }
  return chosen;
}

async function executeLeg(mandate: Mandate, offer: Offer, live: boolean): Promise<Leg> {
  const leg = newLeg(state.legs.length, offer);
  state.legs.push(leg);

  const risk = riskVeto(offer, mandate);
  if (risk.veto) {
    leg.status = "rejected";
    leg.rejectCode = "RISK_VETO";
    leg.rejectReason = risk.reason;
    log("risk.veto", "risk", `risk agent vetoed ${offer.desk}: ${risk.reason}`, { desk: offer.desk });
    return leg;
  }
  log("risk.approved", "risk", `risk agent cleared ${offer.desk}`, { desk: offer.desk });

  leg.status = "checking";
  let minOut = offer.minOut;
  let depositAddress = "0".repeat(64);
  let quoteDeadlineNs = 0n;
  let amountOutFormatted = "";

  if (live) {
    const quote = await requestQuote({
      originAsset: config.usdcAsset,
      destinationAsset: config.btcAsset,
      amount: offer.size,
      recipient: process.env.SETTLE_RECIPIENT ?? config.traderAccount,
      refundTo: config.traderAccount,
      recipientType: (process.env.SETTLE_RECIPIENT_TYPE as "INTENTS" | "DESTINATION_CHAIN") ?? "INTENTS",
    });
    if (!quote.depositAddress) throw new Error("1Click returned no deposit address");
    depositAddress = quote.depositAddress;
    minOut = quote.minAmountOut ?? quote.amountOut;
    amountOutFormatted = quote.amountOutFormatted;
    quoteDeadlineNs = quote.deadline
      ? BigInt(new Date(quote.deadline).getTime()) * 1_000_000n
      : 0n;
    leg.depositAddress = depositAddress;
    log("settlement.quote", "settlement", `1Click quotes ${amountOutFormatted} BTC, deposit ${depositAddress}`, {
      amountOut: quote.amountOut.toString(),
      minAmountOut: minOut.toString(),
      eta: quote.timeEstimate,
    });
  }

  const decision: Decision = await near.checkTrade({
    mandateId: mandate.id,
    counterparty: offer.account,
    amountIn: offer.size,
    minAmountOut: minOut,
    quoteDeadlineNs,
  });
  log(
    decision.approved ? "contract.check" : "contract.rejected",
    "contract",
    decision.approved
      ? `contract approves ${formatUsdc(offer.size)} with ${offer.desk} (${decision.code})`
      : `contract rejected ${offer.desk}: ${decision.reason} (${decision.code})`,
    { ...decision, desk: offer.desk },
  );

  if (!decision.approved) {
    leg.status = "rejected";
    leg.rejectCode = decision.code;
    leg.rejectReason = decision.reason;
    return leg;
  }

  if (!live) {
    leg.status = "executed";
    leg.amountOut = minOut.toString();
    leg.amountOutFormatted = amountOutFormatted || "simulated";
    log(
      "settlement.submitted",
      "settlement",
      `mock mode: ${formatUsdc(offer.size)} USDC would be transferred to ${depositAddress}`,
      { desk: offer.desk },
    );
    return leg;
  }

  if (!hasAgentKey) throw new Error("live mode requires AGENT_SECRET_KEY");

  const result = await near.call("approve_and_swap", {
    mandate_id: String(mandate.id),
    counterparty: offer.account,
    amount_in: offer.size.toString(),
    min_amount_out: minOut.toString(),
    deposit_address: depositAddress,
    quote_deadline: quoteDeadlineNs.toString(),
  });

  if (!result.ok) {
    leg.status = "failed";
    leg.rejectReason = result.error;
    log("error", "contract", `approve_and_swap failed: ${result.error}`, { desk: offer.desk });
    return leg;
  }

  leg.status = "executed";
  leg.amountOut = minOut.toString();
  leg.amountOutFormatted = amountOutFormatted;
  log("settlement.submitted", "settlement", `funds released to 1Click for ${offer.desk}`, {
    desk: offer.desk,
    depositAddress,
  });

  const settled = await waitForSettlement(depositAddress, undefined);
  leg.status = settled.status === "SUCCESS" ? "settled" : "failed";
  log(
    settled.status === "SUCCESS" ? "settlement.settled" : "settlement.failed",
    "settlement",
    `1Click status: ${settled.status}`,
    { desk: offer.desk, depositAddress },
  );

  await near.reportOutcome(mandate.id, offer.account, settled.status === "SUCCESS");
  log("reputation.updated", "agent", `reported ${settled.status} for ${offer.desk}`, {
    desk: offer.desk,
  });
  return leg;
}

export async function runDemo(mandateId = state.mandateId): Promise<RunSnapshot> {
  if (state.running) throw new Error("a run is already in progress");
  state.running = true;
  state.stage = "loading mandate";
  state.legs = [];
  state.offers = [];
  state.startedAt = Date.now();
  state.finishedAt = undefined;
  state.error = undefined;
  state.mandateId = mandateId;

  const live = config.settlementMode === "live";

  try {
    const mandate = await near.getMandate(mandateId);
    state.mandate = mandate;
    log("mandate.loaded", "user", `mandate #${mandate.id} loaded: ${mandate.pair}, cap ${formatUsdc(BigInt(mandate.max_size))} USDC, floor ${mandate.max_slippage_bps} bps`, {
      mandate,
    });

    state.stage = "asking desks";
    const first = await askDesks(mandate, 0);
    state.offers = first;

    // Counter the wide quotes once, then take the best available.
    const wide = first.filter((o) => o.edgeBps < -mandate.max_slippage_bps);
    for (const offer of wide) {
      log("desk.counter", "agent", `countering ${offer.desk}: needs better than ${mandate.max_slippage_bps} bps`, {
        desk: offer.desk,
      });
      const desk = DESKS.find((d) => d.id === offer.desk)!;
      const turn = deskTurn(desk, 1, mandate);
      if (turn.offer) {
        state.offers.push(turn.offer);
        log("desk.quote", "desk", `${desk.name} comes back: ${describeOffer(turn.offer)}`, {
          desk: desk.id,
        });
      }
    }

    const eligible = state.offers.filter(
      (o) => o.edgeBps >= -mandate.max_slippage_bps && o.size > 0n,
    );
    const remaining = BigInt(mandate.max_size) - BigInt(mandate.spent);
    const legs = allocate(eligible, remaining);

    if (legs.length === 0) {
      log("error", "agent", "no quote inside the mandate; nothing to execute");
    } else {
      state.stage = "executing";
      log(
        "risk.approved",
        "risk",
        `plan: ${legs.map((l) => `${formatUsdc(l.size)} with ${l.desk}`).join(" + ")}`,
      );
      for (const leg of legs) {
        await executeLeg(mandate, leg, live);
      }
    }

    // The moment judges remember: an unapproved desk with a great price.
    state.stage = "bait";
    const baitDesk = DESKS.find((d) => d.behaviour === "bait")!;
    const bait = deskTurn(baitDesk, 0, mandate).offer!;
    log("desk.quote", "desk", `${baitDesk.name} sends an unsolicited quote: ${describeOffer(bait)}`, {
      desk: baitDesk.id,
    });
    state.offers.push(bait);
    const baitRisk = riskVeto(bait, mandate);
    log("risk.veto", "risk", `risk agent vetoed ${baitDesk.id}: ${baitRisk.reason}`, {
      desk: baitDesk.id,
    });
    // Even though risk vetoed it, the agent proposes it anyway — that is the
    // point: an over-eager agent is stopped by the contract, not by its mood.
    const baitDecision = await near.checkTrade({
      mandateId: mandate.id,
      counterparty: bait.account,
      amountIn: bait.size,
      minAmountOut: bait.minOut,
      quoteDeadlineNs: 0n,
    });
    log(
      "contract.rejected",
      "contract",
      `contract blocks ${baitDesk.id}: ${baitDecision.reason} (${baitDecision.code})`,
      { ...baitDecision, desk: baitDesk.id },
    );
    const baitLeg = newLeg(state.legs.length, bait);
    baitLeg.status = "rejected";
    baitLeg.rejectCode = baitDecision.code;
    baitLeg.rejectReason = baitDecision.reason;
    state.legs.push(baitLeg);

    state.stage = "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.error = message;
    state.stage = "error";
    log("error", "agent", message);
  } finally {
    state.running = false;
    state.finishedAt = Date.now();
  }
  return snapshot();
}

