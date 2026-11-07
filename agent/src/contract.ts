/** Minimal NEAR client: views over raw JSON-RPC, writes through near-api-js. */

import { Buffer } from "node:buffer";
import { Account, actions } from "near-api-js";
import { config, hasAgentKey } from "./config.js";
import type { Decision, Mandate } from "./types.js";

const GAS = 150_000_000_000_000n; // 150 TGas

let agentAccount: Account | null = null;

function account(): Account {
  if (!hasAgentKey) throw new Error("AGENT_SECRET_KEY is not set");
  if (!agentAccount) {
    agentAccount = new Account(
      config.agentAccount,
      config.rpcUrl,
      (config.agentKey as `ed25519:${string}`),
    );
  }
  return agentAccount;
}

export async function view<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "mandate-otc",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: config.contractId,
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
      receiverId: config.contractId,
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
  return view<Mandate>("get_mandate", { mandate_id: String(id) });
}

/** Real onchain policy check. Free, no key, no funds moved. */
export async function checkTrade(args: {
  mandateId: number;
  counterparty: string;
  amountIn: bigint;
  minAmountOut: bigint;
  quoteDeadlineNs: bigint;
}): Promise<Decision> {
  return view<Decision>("check_trade", {
    mandate_id: String(args.mandateId),
    counterparty: args.counterparty,
    amount_in: args.amountIn.toString(),
    min_amount_out: args.minAmountOut.toString(),
    quote_deadline: args.quoteDeadlineNs.toString(),
  });
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
  return view<{ completed: number; failed: number; score: number }>("get_reputation", {
    counterparty,
  });
}

export function explorerTx(hash: string): string {
  return `${config.explorer}/tx/${hash}`;
}

export function explorerAccount(id: string): string {
  return `${config.explorer}/address/${id}`;
}
