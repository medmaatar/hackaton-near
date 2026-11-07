# The contract holds the funds, not the agent

**Status:** accepted · 2026-11-07

## Context

The pitch is "the agent can be wrong without putting funds at risk". Two
architectures can support that sentence:

1. the agent holds the key, the contract only records limits;
2. the contract holds the funds, the agent only proposes.

Option 1 is easier (no custody logic, no storage deposits) but it makes the
contract a log. Anyone who compromises the agent key drains the wallet and the
onchain limits are decorative.

NEAR Intents has two deposit paths. The signed-intent path requires a NEP-413
signature from an account key. A smart contract cannot produce one — it has no
private key, and chain signatures would add an MPC dependency and latency.

## Decision

The mandate contract custodies the trader's USDC and uses the `ORIGIN_CHAIN`
deposit path: 1Click returns a deposit address, and `approve_and_swap` issues
`storage_deposit` + `ft_transfer` to it only after `evaluate` approves.

## Consequences

- The contract must be deployed on **mainnet** (Intents has no testnet, and a
  testnet contract cannot hold mainnet USDC). Deployment cost ~0.6 NEAR.
- Every approval costs a little NEAR for the deposit-account storage
  registration (0.002 NEAR). Acceptable at OTC sizes; noted for small trades.
- The agent can still choose a hostile `deposit_address`. Mitigation in
  progress: verify the 1Click quote signature onchain before transferring.
- The demo can run with no keys at all: `check_trade` is a view, so the
  rejection moment is real even when settlement is simulated.
