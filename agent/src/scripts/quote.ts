/**
 * Day-1 de-risking spike for NEAR Intents.
 *
 *   docker compose run --rm agent npm run quote -- 25
 *
 * 1. asks 1Click for a free dry quote (no deposit address, nothing committed)
 * 2. asks for a real quote (creates a deposit address, still moves no funds)
 * 3. prints the exact transfer a contract would have to make
 */

import { config } from "../config.js";
import { requestQuote } from "../intents.js";

const sizeUsdc = Number(process.argv[2] ?? 25);
const amount = BigInt(Math.round(sizeUsdc * 1_000_000));

console.log(`\nUSDC -> BTC, ${sizeUsdc} USDC\n`);

const dry = await requestQuote({
  originAsset: config.usdcAsset,
  destinationAsset: config.btcAsset,
  amount,
  recipient: config.traderAccount,
  refundTo: config.traderAccount,
  dry: true,
});
console.log("dry quote :", dry.amountOutFormatted, "BTC, eta", dry.timeEstimate, "s");

const live = await requestQuote({
  originAsset: config.usdcAsset,
  destinationAsset: config.btcAsset,
  amount,
  recipient: config.traderAccount,
  refundTo: config.traderAccount,
});
console.log("real quote:", live.amountOutFormatted, "BTC");
console.log("  deposit :", live.depositAddress);
console.log("  min out :", live.minAmountOut?.toString() ?? "n/a");
console.log("  deadline:", live.deadline);

const dep = live.depositAddress!;
console.log(`
The contract must therefore:
  1. storage_deposit(${dep}) on ${config.usdcAsset.replace("nep141:", "")}
  2. ft_transfer(${amount} -> ${dep})

Both are issued from approve_and_swap after the mandate check passes, so the
agent never has to be trusted with the funds.
`);

const res = await fetch(config.rpcUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: "storage",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: config.usdcAsset.replace("nep141:", ""),
      method_name: "storage_balance_of",
      args_base64: Buffer.from(JSON.stringify({ account_id: dep })).toString("base64"),
    },
  }),
});
const body = (await res.json()) as any;
const decoded = Buffer.from(body.result?.result ?? []).toString("utf8");
console.log(`storage_balance_of(${dep.slice(0, 8)}...) = ${decoded}  (null means unregistered)`);
