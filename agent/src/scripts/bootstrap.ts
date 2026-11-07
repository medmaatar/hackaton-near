/**
 * One-time setup for a live demo:
 *   1. read a market reference price from the 1Click token list (free, signed by the feed)
 *   2. move USDC from the trader into the contract vault (ft_transfer_call)
 *   3. sign the mandate that caps what the agent may do
 *
 *   docker compose run --rm agent npm run bootstrap
 */

import { Account, actions } from "near-api-js";
import { config, hasTraderKey } from "../config.js";

if (!hasTraderKey) throw new Error("TRADER_SECRET_KEY is required (the trader signs the mandate)");

const usdcContract = config.usdcAsset.replace("nep141:", "");
const sizeUsdc = Number(process.env.MANDATE_SIZE_USDC ?? 25);
const maxSize = BigInt(Math.round(sizeUsdc * 1_000_000));
const slippageBps = Number(process.env.MANDATE_SLIPPAGE_BPS ?? 40);
const feeBps = Number(process.env.MANDATE_FEE_BPS ?? 5);
const ttlSeconds = Number(process.env.MANDATE_TTL_SECONDS ?? 6 * 3600);

const trader = new Account(
  config.traderAccount,
  config.rpcUrl,
  (config.traderKey as `ed25519:${string}`),
);

async function referencePrice(): Promise<bigint> {
  const res = await fetch(`${config.intentsBaseUrl}/v0/tokens`);
  const tokens = (await res.json()) as Array<{ assetId: string; price?: number }>;
  const usdc = tokens.find((t) => t.assetId === config.usdcAsset)?.price;
  const btc = tokens.find((t) => t.assetId === config.btcAsset)?.price;
  if (!usdc || !btc) throw new Error("could not read reference prices from 1Click");
  // USDC per BTC, scaled 1e6 so it lands in USDC base units.
  const price = BigInt(Math.round((btc / usdc) * 1_000_000));
  console.log(`reference: ${btc} USD/BTC -> ${price} (USDC base units per BTC)`);
  return price;
}

const reference = await referencePrice();

console.log(`funding vault with ${sizeUsdc} USDC from ${config.traderAccount}`);
const fund = (await trader.signAndSendTransaction({
  receiverId: usdcContract,
  actions: [
    actions.functionCall(
      "ft_transfer_call",
      { receiver_id: config.contractId, amount: maxSize.toString(), msg: "" },
      100_000_000_000_000n,
      1n,
    ),
  ],
})) as any;
console.log("fund status:", (fund.result ?? fund).status);

const created = (await trader.signAndSendTransaction({
  receiverId: config.contractId,
  actions: [
    actions.functionCall(
      "create_mandate",
      {
        agent: config.agentAccount,
        pair: "USDC/BTC",
        sell_token: usdcContract,
        buy_token: config.btcAsset,
        max_size: maxSize.toString(),
        reference_price: reference.toString(),
        max_slippage_bps: slippageBps,
        allowed_counterparties: ["desk-a.near", "desk-b.near", "desk-c.near"],
        min_reputation: Number(process.env.MANDATE_MIN_REPUTATION ?? 50),
        ttl_seconds: ttlSeconds,
        fee_bps: feeBps,
      },
      100_000_000_000_000n,
      0n,
    ),
  ],
})) as any;

const logs: string[] = ((created.result ?? created).receipts_outcome ?? []).flatMap(
  (r: any) => r.outcome?.logs ?? [],
);
const event = logs
  .filter((l) => l.startsWith("EVENT_JSON:"))
  .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)))
  .find((e) => e.event === "mandate_created");

console.log("mandate created:", event?.data ?? "(check the audit trail)");
console.log(`\nset MANDATE_ID=${event?.data?.mandate_id ?? 0} in .env and run the demo`);
