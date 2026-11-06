//! A plain NEP-141 fungible token for the Tier 2 demo: 6 decimals, no minting after `new`, worth nothing.
//!
//! The Ainek contract pays with a token (SPEC §4.3: `ft_transfer`), so the demo and the sandbox test need one
//! that behaves like the real ones. All of the token logic is `near-contract-standards`, NEAR's own
//! implementation of the standards; this file only wires it up, following the official example
//! (https://github.com/near-examples/FT).
//!
//! Three NEAR standards meet here, and each matters to the demo:
//! - NEP-141 (`ft_transfer`, `ft_balance_of`): the transfer itself. `ft_transfer` must carry exactly
//!   1 yoctoNEAR, which proves the call was signed with a full-access key (or sent by a contract).
//! - NEP-145 (`storage_deposit`): an account must be registered before it can hold the token. A transfer
//!   to an unregistered receiver fails; that is the `Failed` status of an action.
//! - NEP-148 (`ft_metadata`): `decimals`, which the agent service reads to turn "12.5" into units.
//!
//! No tests of its own, on purpose: there is no logic of ours here. The sandbox test of the Ainek contract
//! (`contracts/ainek/tests/test_agent.rs`) deploys this wasm and moves tokens through it.

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, NearToken, PanicOnDefault, PromiseOrValue, near};

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    token: FungibleToken,
}

#[near]
impl Contract {
    /// The whole supply goes to `owner_id`; nothing can be minted later.
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128) -> Self {
        let mut token = FungibleToken::new(b"t");
        token.internal_register_account(&owner_id);
        token.internal_deposit(&owner_id, total_supply.0);
        // The NEP-141 event explorers and wallets index balances from; without it the supply is invisible to them.
        FtMint {
            owner_id: &owner_id,
            amount: total_supply,
            memo: Some("initial supply"),
        }
        .emit();
        Self { token }
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        self.token
            .internal_ft_resolve_transfer(&sender_id, receiver_id, amount)
            .0
            .into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Ainek demo token".to_string(),
            symbol: "AINEK".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}
