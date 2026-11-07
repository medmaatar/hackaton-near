# Mandate OTC

**Give an AI broker your mandate, not your keys.**

An OTC desk on NEAR where an AI broker negotiates your trade, but can only act
inside limits you signed. The limits live in a smart contract that also holds the
funds, so a wrong, buggy or manipulated agent cannot move money outside the
mandate. Approved trades settle cross-chain through NEAR Intents.

```
                 ┌──────────────────────────┐
   trader ──────▶│  mandate contract (Rust) │  holds USDC, enforces every limit
     │           └───────────┬──────────────┘
     │ sign once             │ only this contract can move funds
     ▼                       ▼
┌─────────────┐      ┌───────────────┐      ┌──────────────────┐
│  dashboard  │◀────▶│ broker agent  │─────▶│ NEAR Intents     │
│  (React)    │ SSE  │ (Node)        │      │ 1Click settlement│
└─────────────┘      └───────┬───────┘      └──────────────────┘
                             │ quotes / haggles
                     ┌───────▼────────┐
                     │ 4 desk bots    │ A tight · B wide · C silent · D bait
                     └────────────────┘
```

## What is actually built

| Piece | State |
| --- | --- |
| Mandate contract (Rust, near-sdk 5.30) | 19 rule tests pass; wasm builds in Docker |
| Vault custody + fee split + reputation | implemented, tested |
| Broker agent (Node/TypeScript) | quotes, counters, risk veto, executes |
| 4 counterparty bots | deterministic, so the demo never depends on a model |
| Dashboard (React) | live feed over SSE, mandate, legs, reputation |
| NEAR Intents | real 1Click quotes verified on mainnet; contract pays the deposit account directly |
| Private inference (NEAR AI Cloud) | client wired, optional; demo runs without it |

Everything runs in containers. The host needs Docker and nothing else.

## Run it

```bash
docker compose up --build
# dashboard: http://localhost:3000
```

Click **Run negotiation**. With the default `SETTLEMENT_MODE=mock` the agent
performs **real onchain `check_trade` view calls** against the deployed contract
and simulates only the settlement leg — so you can see a real contract rejection
with no keys and no funds.

Terminal version:

```bash
make demo
```

## The mandate check

One function, `evaluate`, is the single source of truth. `check_trade` exposes it
as a view, `approve_and_swap` uses it before moving a token.

| Rule | Code | Test |
| --- | --- | --- |
| contract not paused | `ContractPaused` | `pause_stops_everything` |
| mandate exists and is active | `UnknownMandate`, `MandateNotActive` | `trader_can_halt_their_mandate` |
| mandate not expired | `MandateExpired` | `rejects_an_expired_mandate` |
| quote still valid | `QuoteExpired` | `rejects_a_stale_quote` |
| size within the cumulative cap | `SizeExceedsMandate` | `rejects_cumulative_spend_past_the_cap` |
| counterparty on the allowlist | `CounterpartyNotAllowed` | `rejects_counterparty_off_the_allowlist` |
| counterparty reputation floor | `ReputationTooLow` | `rejects_low_reputation_counterparty` |
| price within the mandate floor | `PriceBelowFloor` | `rejects_price_below_the_floor` |
| vault covers size + fee | `InsufficientBalance` | `rejects_insufficient_vault_balance` |
| only the agent may execute | — | `only_the_agent_can_execute` |
| rejection leaves the vault untouched | — | `rejection_onchain_leaves_the_vault_untouched` |

Run them:

```bash
make test
```

## Why the contract holds the funds

NEAR Intents' signed-intent path needs a NEP-413 signature, which a smart
contract cannot produce. So we use the deposit path instead: 1Click returns a
fresh implicit account, and the contract sends USDC there **after** its own check
passes.

That inverts the trust model in the right direction:

- the agent has no key to the vault and no ability to redirect the deposit;
- the only account that can move the vault is the contract, and it only moves
  what `evaluate` approved;
- the transfer itself is the authorisation — there is no second signature to leak.

The agent can still pick a bad `deposit_address`. It cannot pick one that costs
the trader more than the mandate allows, and quote-signature verification is on
the roadmap (see below).

## NEAR Intents, verified on mainnet

Measured while building, not copied from a doc:

- `POST /v0/quote` works without a JWT (0.25% fee; a JWT from
  [partners.near-intents.org](https://partners.near-intents.org) drops it to 0.2%).
- A real quote for **25 USDC → BTC** returned `0.00032924 BTC`, ETA 20 s.
- The `depositAddress` is a **64-hex implicit account that does not exist yet**,
  so a bare `ft_transfer` fails. The contract therefore calls `storage_deposit`
  (0.002 NEAR) and chains `ft_transfer` in the same receipt.
- `btc.omft.near` rejects anything under ~6.4 USDC; `nbtc.bridge.near` works for
  small sizes.
- There is no Intents testnet. That is why the contract is mainnet-only.

Reproduce it:

```bash
make quote
```

## Live mode (small real amounts)

```bash
cp .env.example .env         # fill AGENT_SECRET_KEY, TRADER_SECRET_KEY
make deploy                  # deploy the contract, needs ~0.6 NEAR
make bootstrap               # trader funds the vault and signs the mandate
# set MANDATE_ID + SETTLEMENT_MODE=live in .env
docker compose up -d
```

Sizes are capped by `MAX_TRADE_USDC`; the demo uses 20–50 USDC.

## Tracks

| Track | What the repo demonstrates |
| --- | --- |
| Autonomous Business | agent negotiates and settles on its own, earns a 0.05% performance fee split by the contract |
| AI Security & Defense | policy engine in the contract, risk-agent veto, onchain blocked-trade demo, reputation |
| Unstoppable DeFi | non-custodial settlement through NEAR Intents |
| Agent Economy | fee ledger, agent budget, pays for its own data |
| AI Swarms | 4 desk bots plus scout/negotiator/risk roles in one broker |
| Privacy & Private AI | NEAR AI Cloud client behind one config switch |
| Real-World Money | OTC workflow with a compliance hook (`verified` flag) |

## Layout

```
contract/     Rust mandate contract + rule tests
agent/        broker, desk bots, Intents client, HTTP/SSE server
dashboard/    React dashboard served by nginx
docker/       Dockerfiles + nginx config
compose.yaml  agent + dashboard + contract build + tools
```

## Honest limits

- The desk bots are simulated counterparties. Settlement is real; the haggling
  is scripted so the demo is reproducible.
- `report_outcome` is an agent attestation, not an oracle. It is logged per
  trade so anyone can audit the history.
- Quote-signature verification, wallet-connect for the mandate form, real
  KYC/KYB, fiat ramps and custody for third parties are roadmap, not claims.
- The performance fee is real but tiny; the ledger exists, the economics do not
  yet.

## Roadmap

1. Verify 1Click's quote signature onchain, so a malicious agent cannot swap in
   its own deposit address.
2. Wallet selector for the mandate form; the trader's key never touches the server.
3. Real compliance provider behind the allowlist flag.
4. Multiple mandates per trader with desk exposure limits.
