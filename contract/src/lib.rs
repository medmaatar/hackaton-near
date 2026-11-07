//! Mandate OTC — onchain policy engine and vault for an AI broker.
//!
//! The broker (agent) negotiates off-chain and *proposes* trades. This contract
//! is the only thing that can move the trader's funds, and it only moves them
//! when a proposal satisfies every rule the trader signed. The agent never holds
//! a key to this account, so a manipulated or buggy agent cannot move a single
//! token outside the mandate.

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::json;
use near_sdk::{
    env, near, near_bindgen, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
};

/// Hard ceiling on the performance fee, regardless of what a mandate asks for.
pub const MAX_FEE_BPS: u32 = 50; // 0.50%
/// A mandate can never be longer than 30 days.
pub const MAX_MANDATE_NS: u64 = 30 * 24 * 60 * 60 * 1_000_000_000;
/// Known counterparties start here until they have a track record.
pub const NEUTRAL_SCORE: u32 = 50;
/// Storage deposit forwarded to the FT contract for a fresh Intents deposit account.
pub const STORAGE_DEPOSIT_YOCTO: u128 = 2_000_000_000_000_000_000_000; // 0.002 NEAR

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(crate = "near_sdk::serde")]
pub enum MandateStatus {
    Active,
    Paused,
    Closed,
}

/// Why a proposal was accepted or rejected. Codes are stable strings so the
/// dashboard and the audit trail can render them without translation tables.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(crate = "near_sdk::serde")]
pub enum RejectCode {
    Ok,
    ContractPaused,
    UnknownMandate,
    MandateNotActive,
    MandateExpired,
    QuoteExpired,
    ZeroAmount,
    CounterpartyNotAllowed,
    ReputationTooLow,
    SizeExceedsMandate,
    InsufficientBalance,
    PriceBelowFloor,
}

impl RejectCode {
    pub fn is_ok(&self) -> bool {
        *self == RejectCode::Ok
    }
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Decision {
    pub approved: bool,
    pub code: RejectCode,
    /// Human readable, safe to show in the dashboard.
    pub reason: String,
    /// Value of the proposed size at the reference price, in sell-token base units.
    pub notional: U128,
    /// Signed price tolerance against the mandate floor, in basis points.
    /// Negative means the proposal is worse than the floor.
    pub price_edge_bps: i64,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Mandate {
    pub id: u128,
    pub owner: AccountId,
    pub agent: AccountId,
    pub pair: String,
    pub sell_token: AccountId,
    pub buy_token: String,
    /// Cumulative cap on sell-token base units across all trades.
    pub max_size: U128,
    pub spent: U128,
    /// Reference price expressed as sell-token units (1e6 scale) per whole buy token.
    pub reference_price: U128,
    /// How far below the reference the trader accepts to trade.
    pub max_slippage_bps: u32,
    pub allowed_counterparties: Vec<AccountId>,
    pub min_reputation: u32,
    pub expiry: u64,
    pub fee_bps: u32,
    pub status: MandateStatus,
    pub trades: u32,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Trade {
    pub id: u128,
    pub mandate_id: u128,
    pub counterparty: AccountId,
    pub amount_in: U128,
    pub min_amount_out: U128,
    pub fee: U128,
    pub deposit_address: AccountId,
    pub timestamp: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(crate = "near_sdk::serde")]
pub struct Reputation {
    pub completed: u32,
    pub failed: u32,
    pub score: u32,
    pub last_update: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct FeeLedger {
    pub agent_earned: U128,
    pub treasury_earned: U128,
    pub trades: u32,
    pub notional: U128,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub admin: AccountId,
    pub treasury: AccountId,
    pub paused: bool,
    pub next_mandate_id: u128,
    pub next_trade_id: u128,
    pub mandates: UnorderedMap<u128, Mandate>,
    pub trades: UnorderedMap<u128, Trade>,
    /// Trader account -> spendable sell-token balance held by this contract.
    pub balances: LookupMap<AccountId, u128>,
    pub reputation: LookupMap<AccountId, Reputation>,
    pub agent_fees: LookupMap<AccountId, u128>,
    pub treasury_fees: u128,
    pub total_notional: u128,
}

#[near_bindgen]
impl Contract {
    #[init]
    pub fn new(admin: AccountId, treasury: AccountId) -> Self {
        Self {
            admin,
            treasury,
            paused: false,
            next_mandate_id: 0,
            next_trade_id: 0,
            mandates: UnorderedMap::new(b"m".to_vec()),
            trades: UnorderedMap::new(b"t".to_vec()),
            balances: LookupMap::new(b"b".to_vec()),
            reputation: LookupMap::new(b"r".to_vec()),
            agent_fees: LookupMap::new(b"af".to_vec()),
            treasury_fees: 0,
            total_notional: 0,
        }
    }

    // -- funds in ----------------------------------------------------------

    /// NEP-141 receiver. Get here via `ft_transfer_call` on the sell token.
    /// `sender_id` is the trader; funds are credited to their vault balance.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        require!(!self.paused, "contract is paused");
        let _ = msg;
        let current = self.balances.get(&sender_id).unwrap_or(0);
        self.balances.insert(&sender_id, &(current + amount.0));
        self.log_event(
            "deposit",
            json!({ "trader": sender_id, "amount": amount.0, "balance": current + amount.0 }),
        );
        U128(0) // accept the full transfer
    }

    // -- mandate lifecycle -------------------------------------------------

    /// The trader signs this once. Everything the agent may do is fixed here.
    #[allow(clippy::too_many_arguments)]
    pub fn create_mandate(
        &mut self,
        agent: AccountId,
        pair: String,
        sell_token: AccountId,
        buy_token: String,
        max_size: U128,
        reference_price: U128,
        max_slippage_bps: u32,
        allowed_counterparties: Vec<AccountId>,
        min_reputation: u32,
        ttl_seconds: u64,
        fee_bps: u32,
    ) -> U128 {
        let owner = env::predecessor_account_id();
        require!(!self.paused, "contract is paused");
        require!(max_size.0 > 0, "max_size must be positive");
        require!(reference_price.0 > 0, "reference price must be positive");
        require!(max_slippage_bps <= 10_000, "slippage out of range");
        require!(fee_bps <= MAX_FEE_BPS, "fee above contract cap");
        require!(min_reputation <= 100, "score is 0..=100");
        require!(ttl_seconds > 0, "ttl must be positive");
        let ttl_ns = ttl_seconds
            .checked_mul(1_000_000_000)
            .expect("ttl overflow");
        require!(ttl_ns <= MAX_MANDATE_NS, "mandate too long");
        require!(
            !allowed_counterparties.is_empty(),
            "allowlist cannot be empty"
        );

        let id = self.next_mandate_id;
        self.next_mandate_id += 1;
        let mandate = Mandate {
            id,
            owner: owner.clone(),
            agent,
            pair: pair.clone(),
            sell_token,
            buy_token,
            max_size,
            spent: U128(0),
            reference_price,
            max_slippage_bps,
            allowed_counterparties,
            min_reputation,
            expiry: env::block_timestamp() + ttl_ns,
            fee_bps,
            status: MandateStatus::Active,
            trades: 0,
        };
        self.mandates.insert(&id, &mandate);
        self.log_event(
            "mandate_created",
            json!({
                "mandate_id": id,
                "owner": owner,
                "pair": pair,
                "max_size": max_size.0,
                "reference_price": reference_price.0,
                "max_slippage_bps": max_slippage_bps,
                "expiry": mandate.expiry,
                "fee_bps": fee_bps,
            }),
        );
        U128(id)
    }

    /// Trader can halt their own mandate at any time, with or without the agent.
    pub fn set_mandate_status(&mut self, mandate_id: U128, status: MandateStatus) {
        let mut m = self.internal_mandate(mandate_id.0);
        let caller = env::predecessor_account_id();
        require!(
            caller == m.owner || caller == self.admin,
            "only owner or admin"
        );
        m.status = status.clone();
        self.mandates.insert(&mandate_id.0, &m);
        self.log_event(
            "mandate_status",
            json!({ "mandate_id": mandate_id.0, "status": format!("{:?}", status) }),
        );
    }

    /// The trader may move the reference price (e.g. after a market move) but the
    /// agent can never do this, so the agent cannot talk the floor down.
    pub fn set_reference_price(&mut self, mandate_id: U128, reference_price: U128) {
        let mut m = self.internal_mandate(mandate_id.0);
        require!(
            env::predecessor_account_id() == m.owner,
            "only the mandate owner"
        );
        require!(reference_price.0 > 0, "reference price must be positive");
        let old = m.reference_price.0;
        m.reference_price = reference_price;
        self.mandates.insert(&mandate_id.0, &m);
        self.log_event(
            "reference_price_updated",
            json!({ "mandate_id": mandate_id.0, "old": old, "new": reference_price.0 }),
        );
    }

    // -- the core: policy check -------------------------------------------

    /// Pure policy evaluation. Used by `approve_and_swap`, by the agent before it
    /// proposes, and by the dashboard. Never mutates state, never moves funds.
    pub fn check_trade(
        &self,
        mandate_id: U128,
        counterparty: AccountId,
        amount_in: U128,
        min_amount_out: U128,
        quote_deadline: u64,
    ) -> Decision {
        match self.evaluate(
            mandate_id.0,
            &counterparty,
            amount_in.0,
            min_amount_out.0,
            quote_deadline,
        ) {
            Ok(decision) => decision,
            Err(decision) => decision,
        }
    }

    /// The only path that moves money. Re-checks every rule onchain, debits the
    /// trader's vault (notional + fee), and forwards the notional to the 1Click
    /// deposit account the quote named. On failure the whole receipt reverts.
    pub fn approve_and_swap(
        &mut self,
        mandate_id: U128,
        counterparty: AccountId,
        amount_in: U128,
        min_amount_out: U128,
        deposit_address: AccountId,
        quote_deadline: u64,
    ) -> Decision {
        let decision = match self.evaluate(
            mandate_id.0,
            &counterparty,
            amount_in.0,
            min_amount_out.0,
            quote_deadline,
        ) {
            Ok(d) => d,
            Err(d) => {
                self.log_event(
                    "trade_rejected",
                    json!({
                        "mandate_id": mandate_id.0,
                        "counterparty": counterparty,
                        "amount_in": amount_in.0,
                        "code": format!("{:?}", d.code),
                        "reason": d.reason,
                    }),
                );
                env::panic_str(&format!("mandate rejected: {}", d.reason));
            }
        };

        let mut m = self.internal_mandate(mandate_id.0);
        require!(
            env::predecessor_account_id() == m.agent,
            "only the mandate agent can propose trades"
        );

        let amount = amount_in.0;
        let fee = amount
            .checked_mul(m.fee_bps as u128)
            .expect("fee overflow")
            / 10_000;
        let debit = amount + fee;

        let mut balance = self.balances.get(&m.owner).unwrap_or(0);
        require!(balance >= debit, "insufficient vault balance");
        balance -= debit;
        self.balances.insert(&m.owner, &balance);

        m.spent = U128(m.spent.0 + amount);
        m.trades += 1;
        self.mandates.insert(&mandate_id.0, &m);

        // fee split: 70% agent, 30% platform treasury
        let agent_cut = fee * 70 / 100;
        let treasury_cut = fee - agent_cut;
        let earned = self.agent_fees.get(&m.agent).unwrap_or(0);
        self.agent_fees.insert(&m.agent, &(earned + agent_cut));
        self.treasury_fees += treasury_cut;
        self.total_notional += amount;

        let trade_id = self.next_trade_id;
        self.next_trade_id += 1;
        self.trades.insert(
            &trade_id,
            &Trade {
                id: trade_id,
                mandate_id: mandate_id.0,
                counterparty: counterparty.clone(),
                amount_in,
                min_amount_out,
                fee: U128(fee),
                deposit_address: deposit_address.clone(),
                timestamp: env::block_timestamp(),
            },
        );

        self.log_event(
            "trade_approved",
            json!({
                "trade_id": trade_id,
                "mandate_id": mandate_id.0,
                "counterparty": counterparty,
                "amount_in": amount,
                "min_amount_out": min_amount_out.0,
                "fee": fee,
                "deposit_address": deposit_address,
                "price_edge_bps": decision.price_edge_bps,
                "notional": decision.notional.0,
            }),
        );
        self.log_event(
            "fee_split",
            json!({
                "trade_id": trade_id,
                "agent": m.agent,
                "agent_cut": agent_cut,
                "treasury_cut": treasury_cut,
            }),
        );

        // 1Click hands back a fresh implicit account that is not registered on
        // the token contract yet, so register it before transferring.
        let token = m.sell_token.clone();
        let _ = Promise::new(token.clone())
            .function_call(
                "storage_deposit".to_string(),
                json!({ "account_id": deposit_address }).to_string().into_bytes(),
                NearToken::from_yoctonear(STORAGE_DEPOSIT_YOCTO),
                Gas::from_tgas(10),
            )
            .then(Promise::new(token).function_call(
                "ft_transfer".to_string(),
                json!({
                    "receiver_id": deposit_address,
                    "amount": amount.to_string(),
                    "memo": format!("mandate:{}", mandate_id.0),
                })
                .to_string()
                .into_bytes(),
                NearToken::from_yoctonear(1),
                Gas::from_tgas(25),
            ));

        decision
    }

    // -- reputation & reporting -------------------------------------------

    /// The agent reports how the deal ended. Intentional: the contract cannot see
    /// off-chain settlement, so this is an agent attestation, and it is logged
    /// per trade so anyone can audit a desk's history.
    pub fn report_outcome(
        &mut self,
        mandate_id: U128,
        counterparty: AccountId,
        completed: bool,
    ) {
        let m = self.internal_mandate(mandate_id.0);
        require!(
            env::predecessor_account_id() == m.agent,
            "only the mandate agent"
        );
        let mut rep = self.reputation.get(&counterparty).unwrap_or(Reputation {
            completed: 0,
            failed: 0,
            score: NEUTRAL_SCORE,
            last_update: 0,
        });
        if completed {
            rep.completed += 1;
        } else {
            rep.failed += 1;
        }
        rep.score = score_from(&rep);
        rep.last_update = env::block_timestamp();
        self.reputation.insert(&counterparty, &rep);
        self.log_event(
            "reputation_updated",
            json!({
                "counterparty": counterparty,
                "completed": rep.completed,
                "failed": rep.failed,
                "score": rep.score,
            }),
        );
    }

    // -- withdrawals -------------------------------------------------------

    /// Trader pulls unspent funds back out at any time.
    pub fn withdraw(&mut self, amount: U128) {
        let trader = env::predecessor_account_id();
        let balance = self.balances.get(&trader).unwrap_or(0);
        require!(balance >= amount.0 && amount.0 > 0, "insufficient balance");
        self.balances.insert(&trader, &(balance - amount.0));
        let token = self
            .default_sell_token(&trader)
            .expect("no mandate to infer token from");
        self.log_event(
            "withdraw",
            json!({ "trader": trader, "amount": amount.0 }),
        );
        let _ = Promise::new(token).function_call(
            "ft_transfer".to_string(),
            json!({
                "receiver_id": trader,
                "amount": amount.0.to_string(),
                "memo": "mandate-otc:withdraw",
            })
            .to_string()
            .into_bytes(),
            NearToken::from_yoctonear(1),
            Gas::from_tgas(25),
        );
    }

    /// The agent withdraws the fees it earned. It can never touch trader funds.
    pub fn withdraw_agent_fees(&mut self, token: AccountId) {
        let agent = env::predecessor_account_id();
        let earned = self.agent_fees.get(&agent).unwrap_or(0);
        require!(earned > 0, "nothing to withdraw");
        self.agent_fees.insert(&agent, &0u128);
        self.log_event(
            "agent_fee_withdraw",
            json!({ "agent": agent, "amount": earned }),
        );
        let _ = Promise::new(token).function_call(
            "ft_transfer".to_string(),
            json!({
                "receiver_id": agent,
                "amount": earned.to_string(),
                "memo": "mandate-otc:agent-fee",
            })
            .to_string()
            .into_bytes(),
            NearToken::from_yoctonear(1),
            Gas::from_tgas(25),
        );
    }

    // -- admin -------------------------------------------------------------

    pub fn pause(&mut self, paused: bool) {
        self.assert_admin();
        self.paused = paused;
        self.log_event("paused", json!({ "paused": paused }));
    }

    // -- views -------------------------------------------------------------

    pub fn get_mandate(&self, mandate_id: U128) -> Mandate {
        self.internal_mandate(mandate_id.0)
    }

    pub fn get_trade(&self, trade_id: U128) -> Trade {
        self.trades.get(&trade_id.0).expect("unknown trade")
    }

    pub fn get_balance(&self, trader: AccountId) -> U128 {
        U128(self.balances.get(&trader).unwrap_or(0))
    }

    pub fn get_reputation(&self, counterparty: AccountId) -> Reputation {
        self.reputation.get(&counterparty).unwrap_or(Reputation {
            completed: 0,
            failed: 0,
            score: NEUTRAL_SCORE,
            last_update: 0,
        })
    }

    pub fn get_fee_ledger(&self, agent: AccountId, trader: AccountId) -> FeeLedger {
        let mut trades = 0u32;
        let mut notional = 0u128;
        for (_, t) in self.trades.iter() {
            if let Some(m) = self.mandates.get(&t.mandate_id) {
                if m.owner == trader {
                    trades += 1;
                    notional += t.amount_in.0;
                }
            }
        }
        FeeLedger {
            agent_earned: U128(self.agent_fees.get(&agent).unwrap_or(0)),
            treasury_earned: U128(self.treasury_fees),
            trades,
            notional: U128(notional),
        }
    }

    pub fn get_stats(&self) -> serde_json::Value {
        json!({
            "mandates": self.mandates.len(),
            "trades": self.trades.len(),
            "total_notional": self.total_notional.to_string(),
            "treasury_fees": self.treasury_fees.to_string(),
            "paused": self.paused,
        })
    }

    // -- internals ---------------------------------------------------------

    fn internal_mandate(&self, id: u128) -> Mandate {
        self.mandates.get(&id).expect("unknown mandate")
    }

    fn default_sell_token(&self, trader: &AccountId) -> Option<AccountId> {
        for (_, m) in self.mandates.iter() {
            if &m.owner == trader {
                return Some(m.sell_token);
            }
        }
        None
    }

    fn assert_admin(&self) {
        require!(
            env::predecessor_account_id() == self.admin,
            "only admin"
        );
    }

    fn log_event(&self, event: &str, data: serde_json::Value) {
        env::log_str(
            &json!({
                "standard": "mandate-otc",
                "version": "1.0.0",
                "event": event,
                "data": data,
            })
            .to_string(),
        );
    }

    /// Single source of truth for every rule. Returns Ok(approved) or Err(reject).
    fn evaluate(
        &self,
        mandate_id: u128,
        counterparty: &AccountId,
        amount_in: u128,
        min_amount_out: u128,
        quote_deadline: u64,
    ) -> Result<Decision, Decision> {
        let reject = |code: RejectCode, reason: &str| Decision {
            approved: false,
            code,
            reason: reason.to_string(),
            notional: U128(0),
            price_edge_bps: 0,
        };

        if self.paused {
            return Err(reject(RejectCode::ContractPaused, "contract is paused"));
        }
        let m = match self.mandates.get(&mandate_id) {
            Some(m) => m,
            None => return Err(reject(RejectCode::UnknownMandate, "unknown mandate")),
        };
        if m.status != MandateStatus::Active {
            return Err(reject(
                RejectCode::MandateNotActive,
                "mandate is not active",
            ));
        }
        if env::block_timestamp() >= m.expiry {
            return Err(reject(RejectCode::MandateExpired, "mandate expired"));
        }
        if quote_deadline > 0 && env::block_timestamp() >= quote_deadline {
            return Err(reject(RejectCode::QuoteExpired, "quote expired"));
        }
        if amount_in == 0 || min_amount_out == 0 {
            return Err(reject(RejectCode::ZeroAmount, "size or output is zero"));
        }
        if !m.allowed_counterparties.contains(counterparty) {
            return Err(reject(
                RejectCode::CounterpartyNotAllowed,
                "counterparty not on the mandate allowlist",
            ));
        }
        let score = self
            .reputation
            .get(counterparty)
            .map(|r| r.score)
            .unwrap_or(NEUTRAL_SCORE);
        if score < m.min_reputation {
            return Err(reject(
                RejectCode::ReputationTooLow,
                "counterparty reputation below the mandate floor",
            ));
        }
        if m.spent.0 + amount_in > m.max_size.0 {
            return Err(reject(
                RejectCode::SizeExceedsMandate,
                "size exceeds the mandate cap",
            ));
        }

        let fee = amount_in
            .checked_mul(m.fee_bps as u128)
            .expect("fee overflow")
            / 10_000;
        let balance = self.balances.get(&m.owner).unwrap_or(0);
        if balance < amount_in + fee {
            return Err(reject(
                RejectCode::InsufficientBalance,
                "vault balance does not cover size plus fee",
            ));
        }

        // Value the output at the mandate's reference price (sell units, 1e6 scale)
        // and require it to be within `max_slippage_bps` of the input.
        let value_out_e6 = (min_amount_out as u128)
            .checked_mul(m.reference_price.0)
            .expect("price overflow")
            / 100_000_000; // buy-token 8 decimals -> 1e6 scale
        let lhs = value_out_e6 * 10_000;
        let rhs = amount_in * (10_000 - m.max_slippage_bps as u128);
        if lhs < rhs {
            let edge = ((value_out_e6 as i128 - amount_in as i128) * 10_000)
                / amount_in as i128;
            return Err(Decision {
                approved: false,
                code: RejectCode::PriceBelowFloor,
                reason: format!(
                    "price is {} bps below the mandate floor (max {} bps)",
                    -edge, m.max_slippage_bps
                ),
                notional: U128(amount_in),
                price_edge_bps: edge as i64,
            });
        }

        let edge = ((value_out_e6 as i128 - amount_in as i128) * 10_000) / amount_in as i128;
        Ok(Decision {
            approved: true,
            code: RejectCode::Ok,
            reason: "within mandate".to_string(),
            notional: U128(amount_in),
            price_edge_bps: edge as i64,
        })
    }
}

/// 100 when everything settled, 0 when nothing ever did, neutral before then.
fn score_from(rep: &Reputation) -> u32 {
    let total = rep.completed as u64 + rep.failed as u64;
    if total == 0 {
        return NEUTRAL_SCORE;
    }
    ((rep.completed as u64 * 100) / total) as u32
}

#[cfg(test)]
mod tests;
