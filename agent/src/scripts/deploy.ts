/**
 * Deploy the mandate contract from the built artifact.
 *
 *   docker compose run --rm agent npm run deploy
 *
 * Requires the target account to exist on mainnet with >= ~0.6 NEAR.
 */

import { readFileSync } from "node:fs";
import { Account, actions } from "near-api-js";
import { config, hasAgentKey } from "../config.js";

if (!hasAgentKey) throw new Error("AGENT_SECRET_KEY is required to deploy");

const wasmPath = process.env.WASM_PATH ?? "/artifacts/mandate_otc.wasm";
const code = readFileSync(wasmPath);
console.log(`deploying ${code.byteLength} bytes to ${config.contractId}`);

const account = new Account(
  config.agentAccount,
  config.rpcUrl,
  (config.agentKey as `ed25519:${string}`),
);

const raw = (await account.signAndSendTransaction({
  receiverId: config.contractId,
  actions: [
    actions.deployContract(code),
    actions.functionCall(
      "new",
      {
        admin: config.agentAccount,
        treasury: process.env.TREASURY_ACCOUNT ?? config.agentAccount,
      },
      30_000_000_000_000n,
      0n,
    ),
  ],
})) as any;

const outcome = raw.result ?? raw;
console.log("status:", outcome.status);
console.log("tx:", outcome.transaction?.hash ?? outcome.transaction_outcome?.id ?? "(see explorer)");
