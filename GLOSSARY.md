# Glossary

Terms this repo uses in code, tests, UI copy and issues. Use these words, not
synonyms.

**Mandate** — the signed, onchain set of limits for one trader: pair, cumulative
size cap, price floor, counterparty allowlist, reputation floor, expiry, fee cap.
A mandate is not an order: it authorises a range of trades, not one trade.

**Vault** — the USDC balance the mandate contract holds for a trader. The agent
has no key to it. `ft_on_transfer` credits it, `approve_and_swap` debits it,
`withdraw` empties it.

**Desk** — a counterparty that quotes. In this repo the desks are bots with fixed
behaviours (tight, wide, silent, bait). Never call them "market makers" in UI
copy.

**Offer** — one structured quote from a desk: size, minimum output, price edge in
basis points, expiry. Structured on purpose; free text never crosses the
negotiation boundary.

**Leg** — one execution against one desk. A plan that splits size across two
desks has two legs. `Trade` is the onchain record of a leg that was approved.

**Edge** — price versus the mandate reference, in basis points. Negative is worse
for the trader. The mandate's `max_slippage_bps` is the floor on edge.

**Decision** — the contract's verdict on a proposed leg: `approved`, `code`
(stable string such as `CounterpartyNotAllowed`), `reason`, `notional`,
`price_edge_bps`.

**Deposit address** — the implicit account 1Click returns for a quote. The
contract registers it for storage and transfers into it; the transfer is the
authorisation.

**Risk veto** — the broker's own pre-check before it asks the contract. A veto is
not enforcement; the contract is.

**Settlement** — the Intents leg: quote, transfer, poll status. "Mock mode" means
policy checks are real and settlement is simulated.
