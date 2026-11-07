/** All configuration comes from the environment. Nothing is read from disk. */

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required env var ${name}`);
  }
  return v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export const config = {
  port: num("PORT", 8787),

  network: env("NEAR_NETWORK", "mainnet") as "mainnet" | "testnet",
  rpcUrl: env("NEAR_RPC_URL", "https://free.rpc.fastnear.com"),
  explorer: env("NEAR_EXPLORER", "https://nearblocks.io"),

  contractId: env("MANDATE_CONTRACT", "mandate-otc.near"),
  agentAccount: env("AGENT_ACCOUNT", "broker.near"),
  agentKey: process.env.AGENT_SECRET_KEY ?? "",
  traderAccount: env("TRADER_ACCOUNT", "amine.near"),
  traderKey: process.env.TRADER_SECRET_KEY ?? "",

  /**
   * mock  - negotiation, policy checks and fees are real; the Intents leg is
   *         simulated so judges can run the repo with no funds and no keys.
   * live  - a real 1Click quote and a real onchain ft_transfer to the deposit
   *         account. Small sizes only.
   */
  settlementMode: env("SETTLEMENT_MODE", "mock") as "mock" | "live",

  intentsBaseUrl: env("INTENTS_BASE_URL", "https://1click.chaindefuser.com"),
  intentsJwt: process.env.INTENTS_JWT ?? "",

  // USDC on NEAR, 6 decimals, and the Intents-wrapped BTC on NEAR, 8 decimals.
  usdcAsset: env(
    "USDC_ASSET",
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  ),
  btcAsset: env("BTC_ASSET", "nep141:nbtc.bridge.near"),
  usdcDecimals: 6,
  btcDecimals: 8,

  llmBaseUrl: env("NEAR_AI_BASE_URL", "https://cloud-api.near.ai/v1"),
  llmApiKey: process.env.NEAR_AI_API_KEY ?? "",
  llmModel: env("NEAR_AI_MODEL", "deepseek-v4-flash"),

  /** Hard stop for a demo run: never propose more than this. */
  maxTradeUsdc: num("MAX_TRADE_USDC", 25),
} as const;

export const hasAgentKey = config.agentKey.length > 0;
export const hasTraderKey = config.traderKey.length > 0;
export const llmEnabled = config.llmApiKey.length > 0;
