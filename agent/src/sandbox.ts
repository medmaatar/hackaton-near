/**
 * Boots a local NEAR sandbox node inside the agent container.
 *
 * It provisions:
 *   - root account `sandbox` with 10k NEAR
 *   - sub-account `usdc.sandbox` with the MockFt contract + 10,000,000 USDC supply
 *   - sub-account `mandate.sandbox` with the Mandate contract
 *   - sub-accounts `amine.sandbox` (trader) and `broker.sandbox` (agent)
 *   - credits the trader with 50,000 USDC
 *   - trader calls `ft_transfer_call` to vault 20,000 USDC into the mandate contract
 *   - trader signs Mandate #0 (USDC/BTC, 20,000 USDC cap, 40 bps floor, 0.05% fee)
 *
 * After this function returns, the agent operates against a 100% real onchain
 * contract with zero mock code on the policy path.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Account, PublicKey, actions } from "near-api-js";
import { Sandbox } from "near-sandbox";
import { setRuntime } from "./runtime.js";

const ROOT_ID = "sandbox";
const ROOT_KEY =
  "ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB" as const;
const ROOT_PUBKEY = "ed25519:5BGSaf6YjVm7565VzWQHNxoyEjwr3jUpRJSGjREvU9dB";

const ONE_NEAR = 1_000_000_000_000_000_000_000_000n;
const GAS = 150_000_000_000_000n;

export interface LocalChain {
  sandbox: Sandbox;
  rpcUrl: string;
  contractId: string;
  usdcId: string;
  traderId: string;
  agentId: string;
  mandateId: number;
}

export async function bootLocalChain(): Promise<LocalChain> {
  setRuntime({ booting: true });
  console.log("booting local NEAR sandbox...");

  const sandbox = await Sandbox.start({
    config: {
      rpcPort: 3030,
      additionalGenesis: { epoch_length: 500 },
    },
  });
  const rpcUrl = sandbox.rpcUrl;
  console.log(`sandbox running at ${rpcUrl}`);

  const root = new Account(ROOT_ID, rpcUrl, ROOT_KEY);

  // Accounts
  const usdcId = `usdc.${ROOT_ID}`;
  const contractId = `mandate.${ROOT_ID}`;
  const traderId = `amine.${ROOT_ID}`;
  const agentId = `broker.${ROOT_ID}`;

  // Read precompiled WASMs from the artifact directory.
  const artifactDir = process.env.ARTIFACTS_DIR ?? "/artifacts";
  const mandateWasm = readFileSync(resolve(artifactDir, "mandate_otc.wasm"));
  const mockFtWasm = readFileSync(resolve(artifactDir, "mock_ft.wasm"));

  // 1. Create accounts and fund them with native NEAR.
  for (const id of [usdcId, contractId, traderId, agentId, `desk-a.${ROOT_ID}`, `desk-b.${ROOT_ID}`, `desk-d.${ROOT_ID}`]) {
    await root.signAndSendTransaction({
      receiverId: id,
      actions: [
        actions.createAccount(),
        actions.transfer(50n * ONE_NEAR),
        actions.addFullAccessKey(PublicKey.fromString(ROOT_PUBKEY)),
      ],
    });
  }

  // 2. Deploy Mock FT and mint initial supply.
  const usdcAccount = new Account(usdcId, rpcUrl, ROOT_KEY);
  await usdcAccount.signAndSendTransaction({
    receiverId: usdcId,
    actions: [
      actions.deployContract(mockFtWasm),
      actions.functionCall("new", { total_supply: "100000000000000" }, GAS, 0n), // 100M USDC
    ],
  });

  // Register trader and mandate contract for storage on Mock FT.
  for (const acct of [traderId, contractId]) {
    await root.signAndSendTransaction({
      receiverId: usdcId,
      actions: [
        actions.functionCall(
          "storage_deposit",
          { account_id: acct },
          GAS,
          2_000_000_000_000_000_000_000n, // 0.002 NEAR
        ),
      ],
    });
  }

  // Mint 50,000 USDC to the trader.
  await usdcAccount.signAndSendTransaction({
    receiverId: usdcId,
    actions: [
      actions.functionCall(
        "mint",
        { account_id: traderId, amount: "50000000000" }, // 50k USDC
        GAS,
        0n,
      ),
    ],
  });

  // 3. Deploy Mandate Contract.
  const mandateAccount = new Account(contractId, rpcUrl, ROOT_KEY);
  await mandateAccount.signAndSendTransaction({
    receiverId: contractId,
    actions: [
      actions.deployContract(mandateWasm),
      actions.functionCall("new", { admin: agentId, treasury: agentId }, GAS, 0n),
    ],
  });

  // 4. Trader vaults 20,000 USDC into the mandate contract.
  const traderAccount = new Account(traderId, rpcUrl, ROOT_KEY);
  await traderAccount.signAndSendTransaction({
    receiverId: usdcId,
    actions: [
      actions.functionCall(
        "ft_transfer_call",
        {
          receiver_id: contractId,
          amount: "20000000000", // 20k USDC
          msg: "",
        },
        GAS,
        1n,
      ),
    ],
  });

  // 5. Trader signs Mandate #0.
  // Reference price: 75,788 USDC per BTC (USDC 6 decimals scale = 75_788_000_000)
  const REF_PRICE = "75788000000";
  await traderAccount.signAndSendTransaction({
    receiverId: contractId,
    actions: [
      actions.functionCall(
        "create_mandate",
        {
          agent: agentId,
          pair: "USDC/BTC",
          sell_token: usdcId,
          buy_token: "nep141:nbtc.bridge.near",
          max_size: "20000000000", // 20k USDC cap
          reference_price: REF_PRICE,
          max_slippage_bps: 40, // 0.40% floor
          allowed_counterparties: [`desk-a.${ROOT_ID}`, `desk-b.${ROOT_ID}`, "desk-a.near", "desk-b.near"],
          min_reputation: 50,
          ttl_seconds: 6 * 3600,
          fee_bps: 5, // 0.05%
        },
        GAS,
        0n,
      ),
    ],
  });

  console.log("local chain ready: Mandate #0 active, 20k USDC vaulted");
  setRuntime({
    chain: "local",
    rpcUrl,
    contractId,
    usdcContract: usdcId,
    mandateId: 0,
    booting: false,
  });

  return {
    sandbox,
    rpcUrl,
    contractId,
    usdcId,
    traderId,
    agentId,
    mandateId: 0,
  };
}
