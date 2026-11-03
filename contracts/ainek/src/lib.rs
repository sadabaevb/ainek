//! Spike A (docs/prompts/day1-rust-spikes.md): the smallest possible key log.
//! One change method (`log_key`) appends a string, one view method (`head`) reads the last entry.
//! The real ABI (KeyEntry, hash chain, verifiers) lands in session 2 — see docs/SPEC.md §4.1.

use near_sdk::store::Vector;
use near_sdk::{env, near};

// NEAR: contract state lives in the account's key-value storage and is (de)serialized with Borsh
// on every call. SDK collections like `Vector` store each element under its own storage key, so a
// call only loads the elements it touches. The prefix (`b"e"`) namespaces those keys; every
// collection in the contract needs a unique one.
#[near(contract_state)]
pub struct Contract {
    entries: Vector<String>,
}

// NEAR: implementing `Default` lets the contract run without an explicit `#[init]` call after
// deploy — the first call finds no state and starts from `default()`. The real contract will use
// `#[init]` + `PanicOnDefault` because it needs an owner.
impl Default for Contract {
    fn default() -> Self {
        Self {
            entries: Vector::new(b"e"),
        }
    }
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct Head {
    pub index: u64,
    pub entry: String,
}

#[near]
impl Contract {
    /// Change method: needs a signed transaction and costs gas. Returns the index of the new entry.
    pub fn log_key(&mut self, entry: String) -> u64 {
        let index = u64::from(self.entries.len());
        self.entries.push(entry.clone());

        // NEAR: NEP-297 events are plain log lines with the `EVENT_JSON:` prefix. Indexers and
        // explorers (nearblocks shows them under "Logs") parse this format; nothing else is needed.
        let event = near_sdk::serde_json::json!({
            "standard": "ainek",
            "version": "1.0.0",
            "event": "key_logged",
            "data": [{
                "index": index,
                "entry": entry,
                "verifier": env::predecessor_account_id(),
            }],
        });
        env::log_str(&format!("EVENT_JSON:{event}"));

        index
    }

    /// View method (`&self`): served by an RPC node for free, no transaction or signature.
    pub fn head(&self) -> Option<Head> {
        let len = self.entries.len();
        let last = len.checked_sub(1)?;
        self.entries.get(last).map(|entry| Head {
            index: u64::from(last),
            entry: entry.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::get_logs;

    #[test]
    fn head_is_none_on_empty_log() {
        assert_eq!(Contract::default().head(), None);
    }

    #[test]
    fn log_key_appends_and_head_returns_latest() {
        let mut contract = Contract::default();
        assert_eq!(contract.log_key("key-a".into()), 0);
        assert_eq!(contract.log_key("key-b".into()), 1);
        // Append-only: head is always the most recent entry, indices never reused.
        assert_eq!(
            contract.head(),
            Some(Head { index: 1, entry: "key-b".into() })
        );
    }

    #[test]
    fn log_key_emits_nep297_event() {
        let mut contract = Contract::default();
        contract.log_key("key-a".into());
        let logs = get_logs();
        assert_eq!(logs.len(), 1);
        let json = logs[0]
            .strip_prefix("EVENT_JSON:")
            .expect("NEP-297 events must start with EVENT_JSON:");
        let event: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(json).unwrap();
        assert_eq!(event["standard"], "ainek");
        assert_eq!(event["event"], "key_logged");
        assert_eq!(event["data"][0]["index"], 0);
    }
}
