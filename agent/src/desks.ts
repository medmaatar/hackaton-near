/**
 * Counterparty desk bots.
 *
 * These stand in for the Telegram brokers a trader would message by hand. Each
 * one has a different behaviour so the negotiation has something to show:
 * one is tight but size-capped, one fills size but gouges on price, one never
 * answers, and one is not on the allowlist and tries to bait the agent.
 *
 * Prices are expressed as basis points away from the mandate's reference price,
 * so the same bots work at any market level.
 */

import type { Desk, Mandate, Offer } from "./types.js";

export const USDC = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

export const DESKS: Desk[] = [
  {
    id: "A",
    name: "Alpaca",
    account: "desk-a.near",
    behaviour: "tight",
    headline: "Tight price, limited size",
  },
  {
    id: "B",
    name: "BigBlock",
    account: "desk-b.near",
    behaviour: "block",
    headline: "Full size, wide spread",
  },
  {
    id: "C",
    name: "ColdCall",
    account: "desk-c.near",
    behaviour: "silent",
    headline: "Never answers",
  },
  {
    id: "D",
    name: "Phantom",
    account: "desk-d.near",
    behaviour: "bait",
    headline: "Not on the allowlist, suspiciously good",
  },
];

/** Convert a price edge in bps (negative = worse than reference) to a minimum output. */
export function edgeToMinOut(size: bigint, edgeBps: number, referencePrice: bigint): bigint {
  // size is sell-token base units at 6 decimals, referencePrice is sell units (1e6)
  // per whole buy token, output is buy-token base units at 8 decimals.
  const scale = 10_000n + BigInt(edgeBps);
  return (size * scale * 100_000_000n) / (10_000n * referencePrice);
}

export function minOutToEdge(minOut: bigint, size: bigint, referencePrice: bigint): number {
  if (size === 0n) return 0;
  const valueOut = (minOut * referencePrice) / 100_000_000n;
  return Number(((valueOut - size) * 10_000n) / size);
}

interface DeskRound {
  edgeBps: number;
  size: bigint;
  note: string;
}

/** What a desk says on its nth turn. Deterministic on purpose: a demo must not
 *  depend on a model's mood. The LLM only writes the prose around these. */
function scriptFor(desk: Desk, round: number, mandate: Mandate): DeskRound | null {
  const refSize = BigInt(mandate.max_size);
  const bidSize = (usdc: number) => {
    const s = USDC(usdc);
    return s < refSize ? s : refSize;
  };

  switch (desk.behaviour) {
    case "tight":
      if (round === 0) return { edgeBps: -25, size: bidSize(10_000), note: "0.25% under, 10k max" };
      if (round === 1) return { edgeBps: -20, size: bidSize(15_000), note: "0.20% under, I can stretch to 15k" };
      return { edgeBps: -20, size: bidSize(15_000), note: "that is my best" };

    case "block":
      if (round === 0) return { edgeBps: -55, size: refSize, note: "0.55% under, full size, take it or leave it" };
      if (round === 1) return { edgeBps: -38, size: refSize, note: "0.38% under, full size" };
      return { edgeBps: -38, size: refSize, note: "firm" };

    case "silent":
      return null;

    case "bait":
      if (round === 0)
        return { edgeBps: -10, size: USDC(40_000), note: "0.10% under, 40k, ready now" };
      return { edgeBps: -8, size: USDC(40_000), note: "I can do 0.08%" };
  }
}

export interface DeskTurn {
  desk: Desk;
  round: number;
  offer: Offer | null;
}

export function deskTurn(desk: Desk, round: number, mandate: Mandate, now = Date.now()): DeskTurn {
  const roundData = scriptFor(desk, round, mandate);
  if (!roundData) return { desk, round, offer: null };

  const referencePrice = BigInt(mandate.reference_price);
  const { edgeBps, size, note } = roundData;
  return {
    desk,
    round,
    offer: {
      desk: desk.id,
      account: desk.account,
      pair: mandate.pair,
      size,
      minOut: edgeToMinOut(size, edgeBps, referencePrice),
      edgeBps,
      expiresAt: now + 10 * 60 * 1000,
      note,
    },
  };
}

export function formatUsdc(amount: bigint): string {
  return (Number(amount) / 1e6).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatBtc(amount: bigint): string {
  return (Number(amount) / 1e8).toFixed(8);
}

export function describeOffer(offer: Offer): string {
  const side = offer.edgeBps <= 0 ? "below" : "above";
  const pct = (Math.abs(offer.edgeBps) / 100).toFixed(2);
  return `${offer.desk}: ${formatUsdc(offer.size)} USDC for ${formatBtc(offer.minOut)} BTC (${pct}% ${side} reference)`;
}
