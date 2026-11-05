//! Ainek key log, SPEC §4.1: a public, append-only log of TEE signing keys written by registered
//! verifiers. Each entry is chained to the previous one by hash (like Certificate Transparency), so
//! anyone holding the log head can detect a rewritten history.
//!
//! NEAR notes for the two of us:
//! - Contract state is stored under the account and (de)serialized with Borsh on every call. The
//!   `store::*` collections keep each element under its own storage key (the byte prefix passed to
//!   `new`), so a call only loads what it touches. Every collection needs a distinct prefix.
//! - `&self` methods are *view* calls: an RPC node runs them for free, no transaction. `&mut self`
//!   methods are *change* calls: a signed transaction, gas, and `env::predecessor_account_id()`
//!   tells us who called.

mod canonical;

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableSet, LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

/// Upper bound for list views so a single RPC call stays within node limits.
const MAX_PAGE: u32 = 100;

/// What a verifier submits (SPEC §4.1 `KeyEntryInput`). Field names are the JSON field names; the
/// same shape is `KeyEntryInput` in `packages/proof/src/schema.ts`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct KeyEntryInput {
    /// Canonical NEAR AI model id, e.g. "z-ai/glm-5.3-flash".
    pub model: String,
    /// hex: ed25519 public key (32 bytes) or eth address for ecdsa.
    pub signing_address: String,
    /// "ed25519" | "ecdsa"
    pub signing_algo: String,
    /// hex, from the model report; the key the client pins for E2EE.
    pub signing_public_key: String,
    /// sha256(app_compose) hex — the MRCONFIGID payload.
    pub compose_hash: String,
    /// "sha256:<hex>" digests from app_compose.
    pub image_digests: Vec<String>,
    /// "UpToDate" | ...
    pub tcb_status: String,
    /// sha256 of the Intel Trust Authority token, hex, or "" if absent.
    pub ita_jwt_hash: String,
    /// sha256 of the NRAS JWT, hex, or "" if absent.
    pub nras_result_hash: String,
    /// hex, the nonce used for this report.
    pub nonce: String,
    /// sha256 of the full attestation report JSON kept off-chain.
    pub report_hash: String,
    /// Unix ms on the verifier's clock. U64 travels as a decimal string in JSON (near-sdk rule).
    pub observed_at: U64,
}

/// A logged entry (SPEC §4.1 `KeyEntry`): the input plus what the contract adds.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct KeyEntry {
    pub model: String,
    pub signing_address: String,
    pub signing_algo: String,
    pub signing_public_key: String,
    pub compose_hash: String,
    pub image_digests: Vec<String>,
    pub tcb_status: String,
    pub ita_jwt_hash: String,
    pub nras_result_hash: String,
    pub nonce: String,
    pub report_hash: String,
    pub observed_at: U64,
    pub index: u64,
    pub verifier: AccountId,
    /// entry_hash of the previous entry; "" for the first one.
    pub prev_hash: String,
    /// sha256(utf8(prev_hash) || utf8(canonical_json(input)) || utf8(verifier)), hex.
    pub entry_hash: String,
    pub block_height: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Head {
    pub index: u64,
    pub entry_hash: String,
}

/// What the chain remembers about a proof (SPEC §4.2): never the proof, only its salted hash plus
/// which key-log entry it was checked against and when it was committed.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct ProofCommit {
    /// "model" | "action"
    pub kind: String,
    pub log_index: u64,
    pub block_height: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    verifiers: IterableSet<AccountId>,
    entries: Vector<KeyEntry>,
    /// model -> indices into `entries`, so `latest_keys` does not scan the whole log.
    by_model: LookupMap<String, Vector<u64>>,
    /// "<account>/<commit>" -> commit record. Keyed per account so two users committing the same
    /// hash do not collide, and so `proof_commit(account, commit)` is a single lookup.
    commits: LookupMap<String, ProofCommit>,
    /// Prepaid storage per account, yoctoNEAR. A function-call key cannot attach a deposit, so the
    /// account owner tops this up once with a full-access key (`deposit_storage`) and the chat
    /// then commits with the FC key, each commit paying for its own bytes from this balance.
    storage_credit: LookupMap<AccountId, u128>,
}

/// State layout of the v1 deployment (key log only), read once by `migrate`.
#[near(serializers = [borsh])]
struct ContractV1 {
    owner: AccountId,
    verifiers: IterableSet<AccountId>,
    entries: Vector<KeyEntry>,
    by_model: LookupMap<String, Vector<u64>>,
}

#[near]
impl Contract {
    /// Deploy + `new` are batched in one transaction; until then every call panics (PanicOnDefault).
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            verifiers: IterableSet::new(b"v"),
            entries: Vector::new(b"e"),
            by_model: LookupMap::new(b"m"),
            commits: LookupMap::new(b"p"),
            storage_credit: LookupMap::new(b"s"),
        }
    }

    /// v1 -> v2 state upgrade, run once in the same transaction as the code deploy
    /// (`cargo near deploy ... with-init-call migrate`). The collections keep their prefixes, so
    /// only the root struct is rewritten; the key log is untouched.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: ContractV1 = env::state_read().expect("no v1 state to migrate");
        Self {
            owner: old.owner,
            verifiers: old.verifiers,
            entries: old.entries,
            by_model: old.by_model,
            commits: LookupMap::new(b"p"),
            storage_credit: LookupMap::new(b"s"),
        }
    }

    // ---- verifiers ------------------------------------------------------------------------------

    /// Owner-gated for now (SPEC §4.1; open registration is pending the Nov 3 sync decision).
    pub fn register_verifier(&mut self, account_id: AccountId) {
        self.assert_owner();
        require!(self.verifiers.insert(account_id.clone()), "verifier is already registered");
        emit("verifier_registered", json!({ "account_id": account_id }));
    }

    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn verifiers(&self) -> Vec<AccountId> {
        self.verifiers.iter().cloned().collect()
    }

    // ---- key log --------------------------------------------------------------------------------

    /// Append an entry. Only registered verifiers. Returns the new entry's index.
    pub fn log_key(&mut self, entry: KeyEntryInput) -> u64 {
        let verifier = env::predecessor_account_id();
        require!(
            self.verifiers.contains(&verifier),
            "only a registered verifier can log keys"
        );
        validate_input(&entry);

        let index = u64::from(self.entries.len());
        let prev_hash = self
            .entries
            .get(self.entries.len().wrapping_sub(1))
            .map(|e| e.entry_hash.clone())
            .unwrap_or_default();
        let entry_hash = entry_hash_of(&prev_hash, &entry, &verifier);

        let model = entry.model.clone();
        let logged = KeyEntry {
            model: entry.model,
            signing_address: entry.signing_address,
            signing_algo: entry.signing_algo,
            signing_public_key: entry.signing_public_key,
            compose_hash: entry.compose_hash,
            image_digests: entry.image_digests,
            tcb_status: entry.tcb_status,
            ita_jwt_hash: entry.ita_jwt_hash,
            nras_result_hash: entry.nras_result_hash,
            nonce: entry.nonce,
            report_hash: entry.report_hash,
            observed_at: entry.observed_at,
            index,
            verifier: verifier.clone(),
            prev_hash,
            entry_hash: entry_hash.clone(),
            block_height: env::block_height(),
        };
        self.entries.push(logged);

        if !self.by_model.contains_key(&model) {
            // Nested collection: its prefix must be unique per model and distinct from the others.
            let prefix = [b"i".as_slice(), model.as_bytes()].concat();
            self.by_model.insert(model.clone(), Vector::new(prefix));
        }
        self.by_model
            .get_mut(&model)
            .expect("index vector was just inserted")
            .push(index);

        emit(
            "key_logged",
            json!({
                "index": index,
                "model": model,
                "signing_address": self.entries[index as u32].signing_address,
                "verifier": verifier,
                "entry_hash": entry_hash,
            }),
        );
        index
    }

    /// Latest entry; `null` while the log is empty.
    pub fn head(&self) -> Option<Head> {
        let last = self.entries.len().checked_sub(1)?;
        self.entries.get(last).map(|e| Head {
            index: e.index,
            entry_hash: e.entry_hash.clone(),
        })
    }

    pub fn entry(&self, index: u64) -> Option<KeyEntry> {
        let index = u32::try_from(index).ok()?;
        self.entries.get(index).cloned()
    }

    /// Entries `[index, index + limit)` in log order; `limit` is capped at 100.
    pub fn entries_since(&self, index: u64, limit: u32) -> Vec<KeyEntry> {
        let Ok(start) = u32::try_from(index) else {
            return vec![];
        };
        let limit = limit.min(MAX_PAGE);
        self.entries.iter().skip(start as usize).take(limit as usize).cloned().collect()
    }

    /// Entries for `model` whose `observed_at` is within `max_age_ns` of the current block time,
    /// newest first, at most 100. `observed_at` is the verifier's clock: the contract records it,
    /// the client's trust policy decides which verifiers to believe (SPEC §4.1, §7.1).
    pub fn latest_keys(&self, model: String, max_age_ns: U64) -> Vec<KeyEntry> {
        let cutoff_ns = env::block_timestamp().saturating_sub(max_age_ns.0);
        let Some(indices) = self.by_model.get(&model) else {
            return vec![];
        };
        indices
            .iter()
            .rev()
            .filter_map(|&i| self.entries.get(i as u32))
            .filter(|e| e.observed_at.0.saturating_mul(1_000_000) >= cutoff_ns)
            .take(MAX_PAGE as usize)
            .cloned()
            .collect()
    }

    // ---- proof commits (SPEC §4.2) --------------------------------------------------------------

    /// Prepay storage for the caller's future `commit_proof` calls. Must be sent with a full-access
    /// key because it attaches NEAR. Returns the caller's new credit in yoctoNEAR.
    #[payable]
    pub fn deposit_storage(&mut self) -> U128 {
        let account = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached > 0, "attach a deposit to prepay storage");
        let credit = self.storage_credit.get(&account).copied().unwrap_or(0) + attached;
        self.storage_credit.insert(account, credit);
        U128(credit)
    }

    pub fn storage_balance_of(&self, account: AccountId) -> U128 {
        U128(self.storage_credit.get(&account).copied().unwrap_or(0))
    }

    /// Record `commit = sha256(salt || canonical_json(proof))` for the caller. Any account; made for
    /// the function-call key the wallet adds at login, hence no deposit here: the bytes this call
    /// adds are paid from the caller's `deposit_storage` credit (SPEC §4.2).
    pub fn commit_proof(&mut self, commit: String, kind: String, log_index: u64) {
        let account = env::predecessor_account_id();
        require!(is_hex64(&commit), "commit must be 64 lowercase hex chars");
        require!(kind == "model" || kind == "action", "kind must be model or action");
        require!(
            log_index < u64::from(self.entries.len()),
            "log_index points past the end of the key log"
        );
        let key = commit_key(&account, &commit);
        require!(!self.commits.contains_key(&key), "this proof is already committed");

        let before = env::storage_usage();
        self.commits.insert(
            key,
            ProofCommit { kind: kind.clone(), log_index, block_height: env::block_height() },
        );
        // Charge exactly the bytes written. `storage_usage` is updated as collections are flushed
        // at the end of the call, so flush here to measure.
        self.commits.flush();
        let added = env::storage_usage().saturating_sub(before);
        let cost = env::storage_byte_cost().as_yoctonear() * u128::from(added);
        let credit = self.storage_credit.get(&account).copied().unwrap_or(0);
        require!(
            credit >= cost,
            "not enough prepaid storage: call deposit_storage with a full-access key first"
        );
        self.storage_credit.insert(account.clone(), credit - cost);

        emit(
            "proof_committed",
            json!({ "account": account, "commit": commit, "kind": kind, "log_index": log_index }),
        );
    }

    pub fn proof_commit(&self, account: AccountId, commit: String) -> Option<ProofCommit> {
        self.commits.get(&commit_key(&account, &commit)).cloned()
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can do this");
    }
}

fn commit_key(account: &AccountId, commit: &str) -> String {
    format!("{account}/{commit}")
}

/// `sha256(utf8(prev_hash) || utf8(canonical_json(input)) || utf8(verifier))`, hex.
/// `prev_hash` is the 64-char hex *text*, not 32 raw bytes (SPEC §4.1 note; TS: `entryHashOf`).
pub fn entry_hash_of(prev_hash: &str, input: &KeyEntryInput, verifier: &AccountId) -> String {
    let value = serde_json::to_value(input).expect("KeyEntryInput is serializable");
    let canonical = canonical::canonical_json(&value).unwrap_or_else(|e| env::panic_str(&e));
    let bytes = [prev_hash.as_bytes(), canonical.as_bytes(), verifier.as_bytes()].concat();
    hex::encode(env::sha256(&bytes))
}

/// Mirror of the zod `KeyEntryInput` schema: reject what the client would refuse to parse anyway,
/// so garbage never enters the chain.
fn validate_input(e: &KeyEntryInput) {
    require!(!e.model.is_empty(), "model is required");
    require!(!e.signing_address.is_empty(), "signing_address is required");
    require!(
        e.signing_algo == "ed25519" || e.signing_algo == "ecdsa",
        "signing_algo must be ed25519 or ecdsa"
    );
    require!(!e.signing_public_key.is_empty(), "signing_public_key is required");
    require!(!e.tcb_status.is_empty(), "tcb_status is required");
    require!(is_hex64(&e.compose_hash), "compose_hash must be 64 lowercase hex chars");
    require!(is_hex64(&e.nonce), "nonce must be 64 lowercase hex chars");
    require!(is_hex64(&e.report_hash), "report_hash must be 64 lowercase hex chars");
    require!(
        e.ita_jwt_hash.is_empty() || is_hex64(&e.ita_jwt_hash),
        "ita_jwt_hash must be 64 lowercase hex chars or empty"
    );
    require!(
        e.nras_result_hash.is_empty() || is_hex64(&e.nras_result_hash),
        "nras_result_hash must be 64 lowercase hex chars or empty"
    );
    require!(
        e.image_digests.iter().all(|d| !d.is_empty()),
        "image_digests must not contain empty strings"
    );
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// NEP-297 event: a log line with the `EVENT_JSON:` prefix; explorers and indexers parse it.
fn emit(event: &str, data: serde_json::Value) {
    let payload = json!({
        "standard": "ainek",
        "version": "1.0.0",
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    const VECTORS: &str = include_str!("../../../docs/test-vectors/canonical.json");

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn set_caller(caller: &str, block_timestamp_ns: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("ainek.testnet"))
            .predecessor_account_id(acc(caller))
            .block_timestamp(block_timestamp_ns)
            .build());
    }

    /// The recorded `KeyEntryInput` from docs/test-vectors (Bektur's day-1 report).
    fn vector_input() -> (KeyEntryInput, String, String) {
        let doc: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        let v = &doc["commits"]["entry_hash"];
        let input: KeyEntryInput = serde_json::from_value(v["input"].clone()).unwrap();
        (
            input,
            v["verifier"].as_str().unwrap().to_string(),
            v["entry_hash"].as_str().unwrap().to_string(),
        )
    }

    fn contract_with_verifier(verifier: &str) -> Contract {
        set_caller("owner.testnet", 0);
        let mut c = Contract::new(acc("owner.testnet"));
        c.register_verifier(acc(verifier));
        c
    }

    #[test]
    fn entry_hash_matches_shared_vector() {
        // The TS client recomputes this hash to check the chain; both sides must agree exactly.
        let (input, verifier, expected) = vector_input();
        assert_eq!(entry_hash_of("", &input, &acc(&verifier)), expected);

        let mut c = contract_with_verifier(&verifier);
        set_caller(&verifier, 0);
        assert_eq!(c.log_key(input), 0);
        let head = c.head().unwrap();
        assert_eq!(head, Head { index: 0, entry_hash: expected });
    }

    #[test]
    fn chain_links_each_entry_to_the_previous_hash() {
        let (input, verifier, _) = vector_input();
        let mut c = contract_with_verifier(&verifier);
        set_caller(&verifier, 0);
        c.log_key(input.clone());
        c.log_key(input.clone());
        let e0 = c.entry(0).unwrap();
        let e1 = c.entry(1).unwrap();
        assert_eq!(e0.prev_hash, "");
        assert_eq!(e1.prev_hash, e0.entry_hash);
        // Same input, different prev_hash: the hash must differ, otherwise the chain proves nothing.
        assert_ne!(e1.entry_hash, e0.entry_hash);
        assert_eq!(
            e1.entry_hash,
            entry_hash_of(&e0.entry_hash, &input, &acc(&verifier))
        );
        assert_eq!(c.entries_since(0, 10).len(), 2);
        assert_eq!(c.entries_since(1, 10)[0].index, 1);
        assert!(c.entries_since(2, 10).is_empty());
    }

    #[test]
    #[should_panic(expected = "only a registered verifier can log keys")]
    fn unregistered_account_cannot_log() {
        let (input, _, _) = vector_input();
        let mut c = contract_with_verifier("v1.ainek.testnet");
        set_caller("mallory.testnet", 0);
        c.log_key(input);
    }

    #[test]
    #[should_panic(expected = "only the owner can do this")]
    fn non_owner_cannot_register_verifier() {
        let mut c = contract_with_verifier("v1.ainek.testnet");
        set_caller("mallory.testnet", 0);
        c.register_verifier(acc("mallory.testnet"));
    }

    #[test]
    fn latest_keys_filters_by_model_and_age() {
        let (input, verifier, _) = vector_input();
        let observed_ns = input.observed_at.0 * 1_000_000;
        let mut c = contract_with_verifier(&verifier);
        set_caller(&verifier, observed_ns);
        c.log_key(input.clone());

        let day_ns = U64(24 * 3600 * 1_000_000_000);
        // One hour after the observation: inside a 24 h window.
        set_caller(&verifier, observed_ns + 3600 * 1_000_000_000);
        assert_eq!(c.latest_keys(input.model.clone(), day_ns).len(), 1);
        assert!(c.latest_keys("other/model".into(), day_ns).is_empty());
        // Two days later: outside the window — a stale key must not count as current.
        set_caller(&verifier, observed_ns + 2 * day_ns.0);
        assert!(c.latest_keys(input.model.clone(), day_ns).is_empty());
        // "No limit" from the /log page: u64::MAX must not overflow the cutoff arithmetic.
        assert_eq!(c.latest_keys(input.model, U64(u64::MAX)).len(), 1);
    }

    #[test]
    fn log_key_emits_nep297_key_logged_event() {
        let (input, verifier, expected) = vector_input();
        let mut c = contract_with_verifier(&verifier);
        set_caller(&verifier, 0);
        c.log_key(input);
        let log = get_logs().pop().unwrap();
        let event: serde_json::Value =
            serde_json::from_str(log.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        assert_eq!(event["standard"], "ainek");
        assert_eq!(event["event"], "key_logged");
        assert_eq!(event["data"][0]["entry_hash"], expected);
        assert_eq!(event["data"][0]["verifier"], verifier);
    }

    // ---- proof commits ------------------------------------------------------------------------

    const COMMIT: &str = "f415f768dc1fa81dfed5a6d1cf421f90b7fa70bba60f7815ea32f995b5810dbf";

    fn set_caller_with_deposit(caller: &str, yocto: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("ainek.testnet"))
            .predecessor_account_id(acc(caller))
            .attached_deposit(near_sdk::NearToken::from_yoctonear(yocto))
            .build());
    }

    /// A contract with one logged key, so `log_index == 0` is a valid reference.
    fn contract_with_one_entry() -> Contract {
        let (input, verifier, _) = vector_input();
        let mut c = contract_with_verifier(&verifier);
        set_caller(&verifier, 0);
        c.log_key(input);
        c
    }

    #[test]
    fn commit_proof_is_paid_from_prepaid_storage_and_is_readable_back() {
        let mut c = contract_with_one_entry();
        // Alice's owner tops up once with a full-access key...
        set_caller_with_deposit("alice.testnet", 10_u128.pow(23)); // 0.1 NEAR
        let credit = c.deposit_storage().0;
        assert_eq!(credit, 10_u128.pow(23));
        // ...then the chat commits with the FC key: no deposit attached.
        set_caller("alice.testnet", 0);
        c.commit_proof(COMMIT.into(), "model".into(), 0);

        let stored = c.proof_commit(acc("alice.testnet"), COMMIT.into()).unwrap();
        assert_eq!(stored.kind, "model");
        assert_eq!(stored.log_index, 0);
        // The commit is charged for exactly the bytes it added; the credit must go down.
        let left = c.storage_balance_of(acc("alice.testnet")).0;
        assert!(left < credit, "storage was not charged");
        assert!(credit - left < 10_u128.pow(22), "a ~100-byte commit must cost well under 0.01 NEAR");
        // Someone else's view of the same hash is empty: commits are per account.
        assert!(c.proof_commit(acc("bob.testnet"), COMMIT.into()).is_none());

        let log = get_logs().pop().unwrap();
        let event: serde_json::Value =
            serde_json::from_str(log.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        assert_eq!(event["event"], "proof_committed");
        assert_eq!(event["data"][0]["account"], "alice.testnet");
        assert_eq!(event["data"][0]["commit"], COMMIT);
    }

    #[test]
    #[should_panic(expected = "not enough prepaid storage")]
    fn commit_proof_without_prepaid_storage_fails() {
        // Otherwise anyone with a free FC key could fill the contract's storage at the owner's cost.
        let mut c = contract_with_one_entry();
        set_caller("alice.testnet", 0);
        c.commit_proof(COMMIT.into(), "model".into(), 0);
    }

    #[test]
    #[should_panic(expected = "already committed")]
    fn commit_proof_rejects_duplicates() {
        let mut c = contract_with_one_entry();
        set_caller_with_deposit("alice.testnet", 10_u128.pow(23));
        c.deposit_storage();
        set_caller("alice.testnet", 0);
        c.commit_proof(COMMIT.into(), "model".into(), 0);
        c.commit_proof(COMMIT.into(), "action".into(), 0);
    }

    #[test]
    #[should_panic(expected = "log_index points past the end of the key log")]
    fn commit_proof_must_reference_an_existing_log_entry() {
        // A proof claims "checked against entry N": N must exist or the claim is meaningless.
        let mut c = contract_with_one_entry();
        set_caller_with_deposit("alice.testnet", 10_u128.pow(23));
        c.deposit_storage();
        set_caller("alice.testnet", 0);
        c.commit_proof(COMMIT.into(), "model".into(), 1);
    }

    #[test]
    #[should_panic(expected = "kind must be model or action")]
    fn commit_proof_rejects_unknown_kind() {
        let mut c = contract_with_one_entry();
        set_caller_with_deposit("alice.testnet", 10_u128.pow(23));
        c.deposit_storage();
        set_caller("alice.testnet", 0);
        c.commit_proof(COMMIT.into(), "receipt".into(), 0);
    }

    #[test]
    #[should_panic(expected = "attach a deposit")]
    fn deposit_storage_requires_a_deposit() {
        let mut c = contract_with_one_entry();
        set_caller("alice.testnet", 0);
        c.deposit_storage();
    }

    #[test]
    #[should_panic(expected = "compose_hash must be 64 lowercase hex chars")]
    fn rejects_malformed_hex() {
        let (mut input, verifier, _) = vector_input();
        input.compose_hash = "ABC".into();
        let mut c = contract_with_verifier(&verifier);
        set_caller(&verifier, 0);
        c.log_key(input);
    }
}
