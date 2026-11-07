/**
 * Values that are resolved at boot: on a local sandbox the contract address and
 * mandate id do not exist until the chain is up, so they cannot be env-only.
 */

import { config } from "./config.js";

export type Chain = "local" | "mainnet";

export const runtime = {
  chain: (process.env.CHAIN ?? "local") as Chain,
  rpcUrl: config.rpcUrl,
  contractId: config.contractId,
  usdcContract: config.usdcAsset.replace("nep141:", ""),
  mandateId: Number(process.env.MANDATE_ID ?? 0),
  /** true while the local sandbox is being provisioned */
  booting: false,
};

export function setRuntime(patch: Partial<typeof runtime>): void {
  Object.assign(runtime, patch);
}

/** Contract calls happen on both chains; only live settlement moves real value. */
export function executesOnchain(): boolean {
  if (config.settlementMode === "live") return true;
  if (runtime.chain === "local" && runtime.contractId.endsWith(".sandbox")) return true;
  return false;
}
