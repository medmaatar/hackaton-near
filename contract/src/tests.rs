//! One test per mandate rule. If a rule is not here, it is not enforced.

use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const T0: u64 = 1_760_000_000_000_000_000; // some 2025 timestamp in ns

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn trader() -> AccountId {
    acc("amine.near")
}
fn agent() -> AccountId {
    acc("broker.near")
}
fn desk_a() -> AccountId {
    acc("desk-a.near")
}
fn desk_b() -> AccountId {
    acc("desk-b.near")
}
fn desk_d() -> AccountId {
    acc("desk-d.near")
}
fn usdc() -> AccountId {
    acc("usdc.near")
}
fn admin() -> AccountId {
    acc("admin.near")
}

/// 75,788 USDC per BTC, expressed in USDC base units (6 decimals).
const REF_PRICE: u128 = 75_788_000_000;
/// 20,000 USDC cap.
const MAX_SIZE: u128 = 20_000_000_000;
/// 25 USDC.
const TWENTY_FIVE: u128 = 25_000_000;
/// 0.00032924 BTC, about 24.95 USDC at the reference price.
const BTC_OUT_OK: u128 = 32_924;

struct Harness {
    contract: Contract,
}

fn setup() -> Harness {
    let mut ctx = VMContextBuilder::new();
    ctx.current_account_id(acc("mandate.near"))
        .signer_account_id(trader())
        .predecessor_account_id(trader())
        .block_timestamp(T0);
    testing_env!(ctx.build());

    let contract = Contract::new(admin(), acc("treasury.near"));
    Harness { contract }
}

impl Harness {
    fn as_caller(&self, who: &AccountId) {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id(acc("mandate.near"))
            .signer_account_id(who.clone())
            .predecessor_account_id(who.clone())
            .block_timestamp(self.now());
        testing_env!(ctx.build());
    }

    fn now(&self) -> u64 {
        T0
    }

    fn advance(&mut self, seconds: u64) {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id(acc("mandate.near"))
            .signer_account_id(trader())
            .predecessor_account_id(trader())
            .block_timestamp(T0 + seconds * 1_000_000_000);
        testing_env!(ctx.build());
    }

    fn fund(&mut self, who: AccountId, amount: u128) {
        self.contract.ft_on_transfer(who, U128(amount), "".into());
    }

    fn mandate(&mut self) -> u128 {
        self.as_caller(&trader());
        let id = self.contract.create_mandate(
            agent(),
            "USDC/BTC".into(),
            usdc(),
            "nep141:nbtc.bridge.near".into(),
            U128(MAX_SIZE),
            U128(REF_PRICE),
            40, // max 0.40% worse than reference
            vec![desk_a(), desk_b()],
            50,
            6 * 3600,
            5, // 0.05%
        );
        id.0
    }

    fn check(
        &self,
        id: u128,
        cp: AccountId,
        amount: u128,
        min_out: u128,
        deadline: u64,
    ) -> Decision {
        self.contract
            .check_trade(U128(id as u128), cp, U128(amount), U128(min_out), deadline)
    }
}

#[test]
fn creates_mandate_with_signed_limits() {
    let mut h = setup();
    let id = h.mandate();
    assert_eq!(id, 0);
    let m = h.contract.get_mandate(U128(0));
    assert_eq!(m.owner, trader());
    assert_eq!(m.agent, agent());
    assert_eq!(m.max_size.0, MAX_SIZE);
    assert_eq!(m.max_slippage_bps, 40);
    assert_eq!(m.fee_bps, 5);
    assert_eq!(m.status, MandateStatus::Active);
    assert_eq!(m.expiry, T0 + 6 * 3600 * 1_000_000_000);
    assert_eq!(h.contract.next_mandate_id, 1);
}

#[test]
fn approves_a_trade_inside_every_limit() {
    let mut h = setup();
    let id = h.mandate();
    h.fund(trader(), 1_000_000_000); // 1,000 USDC

    let d = h.check(id, desk_a(), TWENTY_FIVE, BTC_OUT_OK, 0);
    assert!(d.approved, "expected approval, got {:?}", d);
    assert_eq!(d.code, RejectCode::Ok);
    assert!(d.price_edge_bps > -40);
}

#[test]
fn rejects_size_above_the_cap() {
    let mut h = setup();
    let id = h.mandate();
    h.fund(trader(), 100_000_000_000);

    let d = h.check(id, desk_a(), 25_000_000_000, 32_900_000_000, 0);
    assert!(!d.approved);
    assert_eq!(d.code, RejectCode::SizeExceedsMandate);
}

#[test]
fn rejects_cumulative_spend_past_the_cap() {
    let mut h = setup();
    let id = h.mandate();
    h.fund(trader(), 100_000_000_000);
    h.as_caller(&agent());

    let m = h.contract.get_mandate(U128(id as u128));
    h.contract.approve_and_swap(
        U128(id as u128),
        desk_a(),
        U128(15_000_000_000),
        U128(19_700_000_000),
        acc("1e33465c71f868b4580947c8a39a1df5c4ccd63f84e92b1c70de8578d95071c4"),
        0,
    );
    let _ = m;

    // 15,000 spent; another 6,000 would cross the 20,000 cap.
    let d = h.check(id, desk_a(), 6_000_000_000, 7_900_000_000, 0);
    assert!(!d.approved);
    assert_eq!(d.code, RejectCode::SizeExceedsMandate);
}

#[test]
fn rejects_counterparty_off_the_allowlist() {
    let mut h = setup();
    let id = h.mandate();
    h.fund(trader(), 1_000_000_000);

    let d = h.check(id, desk_d(), TWENTY_FIVE, BTC_OUT_OK, 0);
    assert!(!d.approved);
    assert_eq!(d.code, RejectCode::CounterpartyNotAllowed);
}

#[test]
fn rejects_price_below_the_floor() {
    let mut h = setup();
    let id = h.mandate();
    h.fund(trader(), 1_000_000_000);

    // 0.00032 BTC for 25 USDC = 24.25 USDC of value, ~3% below reference.
    let d = h.check(id, desk_b(), TWENTY_FIVE, 32_000, 0);
    assert!(!d.approved);
    assert_eq!(d.code, RejectCode::PriceBelowFloor);
    assert!(d.price_edge_bps < -200);
}

#[test]
fn rejects_an_expired_mandate() {
    let mut h = setup();
    let id = h.mandate();
    h.fund(trader(), 1_000_000_000);
    // jump 6 hours + 1 second
    let mut ctx = VMContextBuilder::new();
    ctx.current_account_id(acc("mandate.near"))
        .predecessor_account_id(trader())
        .block_timestamp(T0 + 6 * 3600 * 1_000_000_000 + 1_000_000_000);
    testing_env!(ctx.build());

    let d = h.check(id, desk_a(), TWENTY_FIVE, BTC_OUT_OK, 0);
    assert!(!d.approved);
    assert_eq!(d.code, RejectCode::MandateExpired);
}

#[test]
fn rejects_a_stale_quote() {
    let mut h = setup();
    let id = h.mandate();
    h.fund(trader(), 1_000_000_000);

    let d = h.check(id, desk_a(), TWENTY_FIVE, BTC_OUT_OK, T0 - 1);
    assert!(!d.approved);
    assert_eq!(d.code, RejectCode::QuoteExpired);
}

#[test]
fn rejects_insufficient_vault_balance() {
    let mut h = setup();
    let id = h.mandate();
    h.fund(trader(), 10_000_000); // 10 USDC, trying to trade 25

    let d = h.check(id, desk_a(), TWENTY_FIVE, BTC_OUT_OK, 0);
    assert!(!d.approved);
    assert_eq!(d.code, RejectCode::InsufficientBalance);
}

#[test]
fn rejects_low_reputation_counterparty() {
    let mut h = setup();
    let id = h.mandate();
    h.fund(trader(), 1_000_000_000);

    // desk-a fails a deal a few times, then tries again
    h.as_caller(&agent());
    for _ in 0..3 {
        h.contract.report_outcome(U128(id as u128), desk_a(), false);
    }
    let rep = h.contract.get_reputation(desk_a());
    assert_eq!(rep.score, 0);

    let d = h.check(id, desk_a(), TWENTY_FIVE, BTC_OUT_OK, 0);
    assert!(!d.approved);
    assert_eq!(d.code, RejectCode::ReputationTooLow);
}

#[test]
fn agent_moves_funds_and_earns_a_fee() {
    let mut h = setup();
    let id = h.mandate();
    h.fund(trader(), 1_000_000_000);
    h.as_caller(&agent());

    let deposit = acc("1e33465c71f868b4580947c8a39a1df5c4ccd63f84e92b1c70de8578d95071c4");
    let d = h.contract.approve_and_swap(
        U128(id as u128),
        desk_a(),
        U128(TWENTY_FIVE),
        U128(BTC_OUT_OK),
        deposit,
        0,
    );
    assert!(d.approved);

    // 25 USDC notional + 0.05% fee
    let fee = TWENTY_FIVE * 5 / 10_000;
    assert_eq!(h.contract.get_balance(trader()).0, 1_000_000_000 - TWENTY_FIVE - fee);

    let m = h.contract.get_mandate(U128(id as u128));
    assert_eq!(m.spent.0, TWENTY_FIVE);
    assert_eq!(m.trades, 1);

    let ledger = h.contract.get_fee_ledger(agent(), trader());
    assert_eq!(ledger.agent_earned.0, fee * 70 / 100);
    assert_eq!(ledger.treasury_earned.0, fee - fee * 70 / 100);
    assert_eq!(ledger.trades, 1);
}

#[test]
fn only_the_agent_can_execute() {
    let mut h = setup();
    let id = h.mandate();
    h.fund(trader(), 1_000_000_000);
    h.as_caller(&trader());

    let deposit = acc("1e33465c71f868b4580947c8a39a1df5c4ccd63f84e92b1c70de8578d95071c4");
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        h.contract.approve_and_swap(
            U128(id as u128),
            desk_a(),
            U128(TWENTY_FIVE),
            U128(BTC_OUT_OK),
            deposit,
            0,
        );
    }));
    assert!(res.is_err(), "trader must not be able to execute");
}

#[test]
fn rejection_onchain_leaves_the_vault_untouched() {
    let mut h = setup();
    let id = h.mandate();
    h.fund(trader(), 1_000_000_000);
    h.as_caller(&agent());

    let deposit = acc("1e33465c71f868b4580947c8a39a1df5c4ccd63f84e92b1c70de8578d95071c4");
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        h.contract.approve_and_swap(
            U128(id as u128),
            desk_d(), // not allowed, and far too big
            U128(40_000_000_000),
            U128(52_600_000_000),
            deposit,
            0,
        );
    }));
    assert!(res.is_err());
    assert_eq!(h.contract.get_balance(trader()).0, 1_000_000_000);
    assert_eq!(h.contract.get_mandate(U128(id as u128)).spent.0, 0);
}

#[test]
fn trader_can_halt_their_mandate() {
    let mut h = setup();
    let id = h.mandate();
    h.fund(trader(), 1_000_000_000);
    h.as_caller(&trader());
    h.contract
        .set_mandate_status(U128(id as u128), MandateStatus::Paused);

    let d = h.check(id, desk_a(), TWENTY_FIVE, BTC_OUT_OK, 0);
    assert!(!d.approved);
    assert_eq!(d.code, RejectCode::MandateNotActive);
}

#[test]
fn only_owner_can_move_the_reference_price() {
    let mut h = setup();
    let id = h.mandate();
    h.as_caller(&agent());
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        h.contract.set_reference_price(U128(id as u128), U128(1))
    }));
    assert!(res.is_err(), "the agent must not move the price floor");

    h.as_caller(&trader());
    h.contract.set_reference_price(U128(id as u128), U128(REF_PRICE + 1));
    assert_eq!(
        h.contract.get_mandate(U128(id as u128)).reference_price.0,
        REF_PRICE + 1
    );
}

#[test]
fn fee_cap_is_enforced_at_creation() {
    let mut h = setup();
    h.as_caller(&trader());
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        h.contract.create_mandate(
            agent(),
            "USDC/BTC".into(),
            usdc(),
            "nbtc".into(),
            U128(MAX_SIZE),
            U128(REF_PRICE),
            40,
            vec![desk_a()],
            50,
            3600,
            MAX_FEE_BPS + 1,
        )
    }));
    assert!(res.is_err(), "fee above the contract cap must be rejected");
}

#[test]
fn pause_stops_everything() {
    let mut h = setup();
    let id = h.mandate();
    h.fund(trader(), 1_000_000_000);
    h.as_caller(&admin());
    h.contract.pause(true);

    let d = h.check(id, desk_a(), TWENTY_FIVE, BTC_OUT_OK, 0);
    assert!(!d.approved);
    assert_eq!(d.code, RejectCode::ContractPaused);
}

#[test]
fn reputation_score_tracks_outcomes() {
    let mut h = setup();
    let id = h.mandate();
    h.as_caller(&agent());
    h.contract.report_outcome(U128(id as u128), desk_b(), true);
    h.contract.report_outcome(U128(id as u128), desk_b(), true);
    h.contract.report_outcome(U128(id as u128), desk_b(), false);
    let rep = h.contract.get_reputation(desk_b());
    assert_eq!(rep.completed, 2);
    assert_eq!(rep.failed, 1);
    assert_eq!(rep.score, 66);
}

#[test]
fn neutral_score_for_unknown_counterparty() {
    let h = setup();
    assert_eq!(h.contract.get_reputation(desk_d()).score, NEUTRAL_SCORE);
}
