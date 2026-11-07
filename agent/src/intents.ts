/** Thin client for the 1Click / NEAR Intents swap API. */

import { config } from "./config.js";

const base = config.intentsBaseUrl.replace(/\/$/, "");

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (config.intentsJwt) h.Authorization = `Bearer ${config.intentsJwt}`;
  return h;
}

export interface QuoteRequest {
  originAsset: string;
  destinationAsset: string;
  amount: bigint;
  recipient: string;
  refundTo: string;
  /** INTENTS keeps the output on NEAR; DESTINATION_CHAIN withdraws to the chain. */
  recipientType?: "INTENTS" | "DESTINATION_CHAIN";
  depositType?: "INTENTS" | "ORIGIN_CHAIN";
  dry?: boolean;
}

export interface Quote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: bigint;
  amountInFormatted: string;
  amountOut: bigint;
  amountOutFormatted: string;
  minAmountOut?: bigint;
  deadline?: string;
  timeEstimate?: number;
  raw: unknown;
}

export async function requestQuote(req: QuoteRequest): Promise<Quote> {
  const deadline = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const body = {
    dry: req.dry ?? false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: req.originAsset,
    depositType: req.depositType ?? "ORIGIN_CHAIN",
    destinationAsset: req.destinationAsset,
    amount: req.amount.toString(),
    refundTo: req.refundTo,
    refundType: req.depositType === "INTENTS" ? "INTENTS" : "ORIGIN_CHAIN",
    recipient: req.recipient,
    recipientType: req.recipientType ?? "INTENTS",
    deadline,
    quoteWaitingTimeMs: 3000,
  };

  const res = await fetch(`${base}/v0/quote`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(`intents quote failed (${res.status}): ${json?.message ?? "unknown"}`);
  }
  const q = json.quote ?? {};
  if (!q.amountOut) {
    throw new Error(`intents quote missing amountOut: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return {
    depositAddress: q.depositAddress,
    depositMemo: q.depositMemo,
    amountIn: BigInt(q.amountIn ?? body.amount),
    amountInFormatted: q.amountInFormatted ?? "",
    amountOut: BigInt(q.amountOut),
    amountOutFormatted: q.amountOutFormatted ?? "",
    minAmountOut: q.minAmountOut ? BigInt(q.minAmountOut) : undefined,
    deadline: q.deadline,
    timeEstimate: q.timeEstimate,
    raw: json,
  };
}

export interface SwapStatus {
  status: string;
  updatedAt?: string;
  swapDetails?: unknown;
}

export async function requestStatus(
  depositAddress: string,
  depositMemo?: string,
): Promise<SwapStatus> {
  const url = new URL(`${base}/v0/status`);
  url.searchParams.set("depositAddress", depositAddress);
  if (depositMemo) url.searchParams.set("depositMemo", depositMemo);
  const res = await fetch(url, { headers: headers() });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`intents status failed (${res.status})`);
  return { status: json.status ?? "UNKNOWN", updatedAt: json.updatedAt, swapDetails: json.swapDetails };
}

/** Poll until the swap reaches a terminal state or we run out of patience. */
export async function waitForSettlement(
  depositAddress: string,
  depositMemo: string | undefined,
  timeoutMs = 120_000,
): Promise<SwapStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: SwapStatus = { status: "PENDING_DEPOSIT" };
  while (Date.now() < deadline) {
    last = await requestStatus(depositAddress, depositMemo);
    if (["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"].includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return last;
}
