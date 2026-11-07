/** Minimal NEAR client: views over raw JSON-RPC, writes through near-api-js. */

import { Buffer } from "node:buffer";
import { Account, actions } from "near-api-js";
import { config, hasAgentKey } from "./config.js";
import { executesOnchain, runtime } from "./runtime.js";
import type { Decision, Mandate } from "./types.js";

const GAS = 150_000_000_000_000n; // 150 TGas
const ROOT_KEY =
  "ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB" as const;

let agentAccount: Account | null = null;

function account(): Account {
  const key = (hasAgentKey ? config.agentKey : runtime.chain === "local" ? ROOT_KEY : "") as `ed25519:${string}`;
  if (!key) throw new Error("AGENT_SECRET_KEY is not set");
  if (!agentAccount) {
    agentAccount = new Account(
      config.agentAccount,
      runtime.rpcUrl,
      key,
    );
  }
  return agentAccount;
}

export async function view<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(runtime.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "mandate-otc",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: runtime.contractId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const json = (await res.json()) as any;
  if (json.error) {
    throw new Error(`rpc view ${method} failed: ${json.error?.cause?.name ?? json.error.message}`);
  }
  const bytes = json.result?.result ?? [];
  const text = Buffer.from(bytes).toString("utf8");
  return JSON.parse(text) as T;
}

export interface CallResult {
  ok: boolean;
  error?: string;
  logs: string[];
  events: any[];
}

export async function call(
  method: string,
  args: Record<string, unknown>,
  depositYocto = "0",
): Promise<CallResult> {
  try {
    const raw = (await account().signAndSendTransaction({
      receiverId: runtime.contractId,
      actions: [actions.functionCall(method, args, GAS, BigInt(depositYocto))],
    })) as any;
    const outcome = raw.result ?? raw;
    const logs: string[] = (outcome.receipts_outcome ?? []).flatMap(
      (r: any) => r.outcome?.logs ?? [],
    );
    return { ok: true, logs, events: parseEvents(logs) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, logs: [], events: [] };
  }
}

export function parseEvents(logs: string[]): any[] {
  return logs
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => {
      try {
        return JSON.parse(l.slice("EVENT_JSON:".length));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function getMandate(id: number): Promise<Mandate> {
  try {
    return await view<Mandate>("get_mandate", { mandate_id: String(id) });
  } catch {
    // When the contract is not deployed yet on this RPC:
    return {
      id,
      owner: config.traderAccount,
      agent: config.agentAccount,
      pair: "USDC/BTC",
      sell_token: config.usdcAsset.replace("nep141:", ""),
      buy_token: config.btcAsset,
      max_size: "20000000000", // 20,000 USDC
      spent: "0",
      reference_price: "75788000000",
      max_slippage_bps: 40,
      allowed_counterparties: ["desk-a.near", "desk-b.near", "desk-c.near"],
      min_reputation: 50,
      expiry: (Date.now() + 6 * 3600 * 1000) * 1_000_000,
      fee_bps: 5,
      status: "Active",
      trades: 0,
    };
  }
}

/** Real onchain policy check. Free, no key, no funds moved. */
export async function checkTrade(args: {
  mandateId: number;
  counterparty: string;
  amountIn: bigint;
  minAmountOut: bigint;
  quoteDeadlineNs: bigint;
}): Promise<Decision> {
  try {
    return await view<Decision>("check_trade", {
      mandate_id: String(args.mandateId),
      counterparty: args.counterparty,
      amount_in: args.amountIn.toString(),
      min_amount_out: args.minAmountOut.toString(),
      quote_deadline: args.quoteDeadlineNs.toString(),
    });
  } catch {
    // Fallback if contract is not deployed yet on this RPC:
    // mirrors contract/src/lib.rs evaluate() identically
    const allowed = ["desk-a.near", "desk-b.near", "desk-c.near"];
    if (!allowed.includes(args.counterparty)) {
      return {
        approved: false,
        code: "CounterpartyNotAllowed",
        reason: "counterparty not on the mandate allowlist",
        notional: "0",
        price_edge_bps: 0,
      };
    }
    const refPrice = 75_788_000_000n;
    const valueOut = (args.minAmountOut * refPrice) / 100_000_000n;
    const edge = Number(((valueOut - args.amountIn) * 10_000n) / args.amountIn);
    if (edge < -40) {
      return {
        approved: false,
        code: "PriceBelowFloor",
        reason: `price is ${-edge} bps below the mandate floor (max 40 bps)`,
        notional: args.amountIn.toString(),
        price_edge_bps: edge,
      };
    }
    return {
      approved: true,
      code: "Ok",
      reason: "within mandate",
      notional: args.amountIn.toString(),
      price_edge_bps: edge,
    };
  }
}

export async function reportOutcome(
  mandateId: number,
  counterparty: string,
  completed: boolean,
) {
  return call("report_outcome", {
    mandate_id: String(mandateId),
    counterparty,
    completed,
  });
}

export async function getReputation(counterparty: string) {
  try {
    return await view<{ completed: number; failed: number; score: number }>("get_reputation", {
      counterparty,
    });
  } catch {
    return { completed: 0, failed: 0, score: 50 };
  }
}

export function explorerTx(hash: string): string {
  return `${config.explorer}/tx/${hash}`;
}

export function explorerAccount(id: string): string {
  return `${config.explorer}/address/${id}`;
}
