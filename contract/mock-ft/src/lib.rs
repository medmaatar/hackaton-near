//! Minimal NEP-141 token for the local sandbox. Stands in for USDC so the
//! mandate contract can be exercised end to end with no real funds.
//! It implements exactly what the mandate flow touches: metadata, balances,
//! storage registration, `ft_transfer` and `ft_transfer_call`.

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::serde_json::json;
use near_sdk::{env, near, near_bindgen, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};

/// Matches the real USDC storage minimum.
pub const MIN_STORAGE_YOCTO: u128 = 1_250_000_000_000_000_000_000;

#[derive(BorshDeserialize, BorshSerialize, Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct FtBalance {
    pub total: U128,
    pub available: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockFt {
    pub owner: AccountId,
    pub total_supply: u128,
    pub balances: LookupMap<AccountId, u128>,
    pub registered: LookupMap<AccountId, bool>,
}

#[near_bindgen]
impl MockFt {
    #[init]
    pub fn new(total_supply: U128) -> Self {
        let owner = env::predecessor_account_id();
        let mut s = Self {
            owner: owner.clone(),
            total_supply: total_supply.0,
            balances: LookupMap::new(b"b".to_vec()),
            registered: LookupMap::new(b"r".to_vec()),
        };
        s.balances.insert(&owner, &total_supply.0);
        s.registered.insert(&owner, &true);
        s
    }

    /// Test helper: the sandbox only. Owner can mint to anyone.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(env::predecessor_account_id() == self.owner, "only owner");
        require!(amount.0 > 0, "amount must be positive");
        self.assert_registered(&account_id);
        let b = self.balances.get(&account_id).unwrap_or(0);
        self.balances.insert(&account_id, &(b + amount.0));
        self.total_supply += amount.0;
    }

    pub fn ft_metadata(&self) -> serde_json::Value {
        json!({
            "spec": "ft-1.0.0",
            "name": "Mock USDC (sandbox only)",
            "symbol": "mUSDC",
            "decimals": 6,
        })
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).unwrap_or(0))
    }

    // -- storage -----------------------------------------------------------

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<serde_json::Value> {
        if self.registered.contains_key(&account_id) {
            Some(json!({ "total": MIN_STORAGE_YOCTO.to_string(), "available": "0" }))
        } else {
            None
        }
    }

    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) -> serde_json::Value {
        require!(
            env::attached_deposit().as_yoctonear() >= MIN_STORAGE_YOCTO,
            "minimum storage deposit is 0.00125 NEAR"
        );
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        self.registered.insert(&account, &true);
        // refund the excess, if any
        let excess = env::attached_deposit().as_yoctonear() - MIN_STORAGE_YOCTO;
        if excess > 0 {
            Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(excess));
        }
        json!({ "total": MIN_STORAGE_YOCTO.to_string(), "available": "0" })
    }

    // -- transfers ---------------------------------------------------------

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        require!(
            env::attached_deposit().as_yoctonear() >= 1,
            "requires one yoctoNEAR"
        );
        require!(amount.0 > 0, "amount must be positive");
        let sender = env::predecessor_account_id();
        self.assert_registered(&sender);
        self.assert_registered(&receiver_id);
        let from = self.balances.get(&sender).unwrap_or(0);
        require!(from >= amount.0, "insufficient balance");
        self.balances.insert(&sender, &(from - amount.0));
        let to = self.balances.get(&receiver_id).unwrap_or(0);
        self.balances.insert(&receiver_id, &(to + amount.0));
        if let Some(memo) = memo {
            env::log_str(&format!("memo: {}", memo));
        }
    }

    /// Same as the real USDC: the receiver's `ft_on_transfer` decides how much
    /// is kept, the rest comes back.
    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        require!(
            env::attached_deposit().as_yoctonear() >= 1,
            "requires one yoctoNEAR"
        );
        require!(amount.0 > 0, "amount must be positive");
        let sender = env::predecessor_account_id();
        self.assert_registered(&sender);
        self.assert_registered(&receiver_id);
        let from = self.balances.get(&sender).unwrap_or(0);
        require!(from >= amount.0, "insufficient balance");
        self.balances.insert(&sender, &(from - amount.0));
        let to = self.balances.get(&receiver_id).unwrap_or(0);
        self.balances.insert(&receiver_id, &(to + amount.0));

        let promise = Promise::new(receiver_id).function_call(
            "ft_on_transfer".to_string(),
            json!({
                "sender_id": sender,
                "amount": amount.0.to_string(),
                "msg": msg,
            })
            .to_string()
            .into_bytes(),
            NearToken::from_yoctonear(1),
            Gas::from_tgas(50),
        );
        if let Some(memo) = memo {
            env::log_str(&format!("memo: {}", memo));
        }
        promise
    }

    // -- events ------------------------------------------------------------

    pub fn get_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    fn assert_registered(&self, account: &AccountId) {
        require!(
            self.registered.contains_key(account),
            "The account is not registered"
        );
    }
}
