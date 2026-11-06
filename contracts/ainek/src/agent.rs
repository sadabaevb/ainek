//! Agents and policy decisions, SPEC §4.3 (tier 2).
//!
//! An agent is a NEAR account that may only call `commit_proof` and `propose_action` (its function-call
//! key is scoped to this contract). Whether the action fits the owner's policy is decided off-chain, inside an attested
//! OutLayer job (`jobs/policy`), which signs its decision with a key that exists only in the TEE. The
//! contract never sees the policy; it checks that the decision is for exactly this action, was made
//! under the registered policy, by the registered key, for the real time and the real amount already
//! spent today, and has not been used before. Then it acts on the verdict:
//! `Allow` moves the tokens, `NeedsApproval` waits for the owner, `Deny` is only recorded.
//!
//! NEAR notes for the two of us:
//! - The contract itself holds the tokens and is the sender of `ft_transfer`. That is a call to another
//!   contract, so it does not happen inside our transaction: we schedule a *promise* and get the
//!   result later in a callback (`on_transfer`). Until then the action is `Executing`.
//! - `ft_transfer` requires exactly 1 yoctoNEAR attached (NEP-141 asks for it as proof that a
//!   full-access key signed). The agent's function-call key cannot attach anything, so the 1 yocto
//!   comes from this contract's own balance.
//! - `env::ed25519_verify` is a host function: the signature check runs natively in the node, ~1 TGas.

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise};

use crate::canonical::canonical_json;
use crate::{commit_key, emit, is_hex64, Contract, ContractExt};

/// The job signs decisions that live ten minutes: `expires_at = now + 600 000` (SPEC §6.2).
const DECISION_LIFETIME_MS: u64 = 600_000;
/// How far the agent's clock may run ahead of block time. Without an upper bound on `expires_at` the
/// agent could ask the job for a decision "made" far in the future and keep it forever.
const MAX_CLOCK_SKEW_MS: u64 = 120_000;
const DAY_MS: u64 = 86_400_000;
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
const ON_TRANSFER_GAS: Gas = Gas::from_tgas(10);
/// A call that may send a transfer needs the two amounts above on top of its own work. near-api-js
/// attaches 30 TGas by default, which is not enough; ask for it up front instead of failing halfway.
const MIN_GAS_WITH_TRANSFER: Gas = Gas::from_tgas(60);
/// How many actions of one agent may wait for the owner at once. Keeps the `Agent` value, the
/// `pending_actions` view and the callback's work small.
const MAX_PENDING: usize = 20;
/// Bounds what one action adds to the `ft_transfer` arguments and to the `pending_actions` view.
const MAX_MEMO_BYTES: usize = 256;

/// SPEC §4.3. The same shape as `Action` in `packages/proof/src/schema.ts`.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Action {
    pub kind: String,
    pub token_id: AccountId,
    pub receiver_id: AccountId,
    pub amount: U128,
    pub memo: String,
}

/// What the policy job signs (SPEC §4.3, §6.2). `expires_at` is unix milliseconds.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Decision {
    pub verdict: String,
    pub policy_hash: String,
    pub policy_version: u32,
    pub action_commit: String,
    pub model_proof_commit: String,
    pub nonce: String,
    pub expires_at: U64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Agent {
    pub policy_hash: String,
    pub policy_version: u32,
    /// ed25519 public key of the policy job's TEE key, 64 hex chars.
    pub tee_pubkey: String,
    pub token_id: AccountId,
    pub paused: bool,
    /// The UTC day (`block time / 24 h`) that `spent` belongs to; on another day `spent` counts as 0.
    pub spent_day: u64,
    pub spent: u128,
    /// Ids of actions waiting for the owner, oldest first.
    pub pending: Vec<u64>,
}

impl Agent {
    fn spent_on(&self, day: u64) -> u128 {
        if self.spent_day == day { self.spent } else { 0 }
    }
}

#[near(serializers = [json])]
pub struct AgentInfo {
    pub agent_id: AccountId,
    pub policy_hash: String,
    pub policy_version: u32,
    pub tee_pubkey: String,
    pub token_id: AccountId,
    pub paused: bool,
    /// What the agent passes to the policy job as `spent_today`.
    pub spent_today: U128,
}

/// In JSON a status is its bare name, e.g. `"Pending"` (SPEC §4.3).
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ActionStatus {
    /// Waits for the owner's `approve` or `reject`.
    Pending,
    /// The transfer was sent to the token; its result is not known yet.
    Executing,
    Executed,
    /// The token refused the transfer.
    Failed,
    /// By the policy.
    Denied,
    /// By the owner.
    Rejected,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct ActionRecord {
    pub action_id: u64,
    pub agent_id: AccountId,
    pub action: Action,
    pub decision: Decision,
    /// base64 in JSON, as the job printed it: with `decision` and the agent's `tee_pubkey` anyone can
    /// re-check.
    pub tee_signature: Base64VecU8,
    /// The policy key the signature was checked against. Kept per action: `update_policy` may replace
    /// the agent's key later, and an old action must stay checkable.
    pub tee_pubkey: String,
    pub status: ActionStatus,
    /// The UTC day the action was proposed and its amount counted: `approve` works only on that day, and
    /// only that day's total gets the amount back.
    pub day: u64,
    pub block_height: u64,
}

/// The UTC day a block time falls into. The one definition of "today" for the daily total.
fn day_of(time_ms: u64) -> u64 {
    time_ms / DAY_MS
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(env::sha256(bytes))
}

fn canonical<T: near_sdk::serde::Serialize>(value: &T) -> String {
    let value = serde_json::to_value(value).unwrap_or_else(|e| env::panic_str(&e.to_string()));
    canonical_json(&value).unwrap_or_else(|e| env::panic_str(&e))
}

#[near]
impl Contract {
    // ---- registry (owner) -----------------------------------------------------------------------

    /// `policy_hash`, `policy_version` and `tee_pubkey` come from the first run of the policy job
    /// (docs/DEPLOY.md). `token_id` is the one NEP-141 token this agent may move. Needs 1 yoctoNEAR, like
    /// every owner method below except `pause_agent` (see `assert_owner_full_access`): whoever registers an
    /// agent chooses the key whose decisions move the contract's tokens.
    #[payable]
    pub fn register_agent(
        &mut self,
        agent_id: AccountId,
        policy_hash: String,
        policy_version: u32,
        tee_pubkey: String,
        token_id: AccountId,
    ) {
        self.assert_owner_full_access();
        require!(!self.agents.contains_key(&agent_id), "agent is already registered");
        require!(is_hex64(&policy_hash), "policy_hash must be 64 lowercase hex chars");
        require!(is_hex64(&tee_pubkey), "tee_pubkey must be 64 lowercase hex chars");
        emit(
            "agent_registered",
            json!({ "agent_id": agent_id, "policy_hash": policy_hash, "policy_version": policy_version,
                    "tee_pubkey": tee_pubkey, "token_id": token_id }),
        );
        self.agents.insert(
            agent_id,
            Agent {
                policy_hash,
                policy_version,
                tee_pubkey,
                token_id,
                paused: false,
                spent_day: 0,
                spent: 0,
                pending: Vec::new(),
            },
        );
    }

    /// A new policy or a new decision key. Decisions signed under the old values stop being accepted at
    /// once. (A new build of the job alone does not need this: on OutLayer the key can move to it, SPEC §3.5.)
    #[payable]
    pub fn update_policy(
        &mut self,
        agent_id: AccountId,
        policy_hash: String,
        policy_version: u32,
        tee_pubkey: String,
    ) {
        self.assert_owner_full_access();
        require!(is_hex64(&policy_hash), "policy_hash must be 64 lowercase hex chars");
        require!(is_hex64(&tee_pubkey), "tee_pubkey must be 64 lowercase hex chars");
        let mut agent = self.agent_or_panic(&agent_id);
        agent.policy_hash = policy_hash.clone();
        agent.policy_version = policy_version;
        agent.tee_pubkey = tee_pubkey.clone();
        self.agents.insert(agent_id.clone(), agent);
        emit(
            "policy_updated",
            json!({ "agent_id": agent_id, "policy_hash": policy_hash, "policy_version": policy_version,
                    "tee_pubkey": tee_pubkey }),
        );
    }

    /// The stop button, contract side: a paused agent cannot propose and its pending actions cannot be
    /// approved. (The other half is deleting the agent's function-call key, done by the agent account.)
    /// The one owner method without the 1 yoctoNEAR: stopping must stay simple. The worst a stray key can
    /// do with it is stop the agent until the owner lifts the pause; actions waiting for approval that
    /// cross midnight UTC meanwhile lapse and have to be proposed again. `#[payable]` only so that an
    /// owner who attaches the 1 yoctoNEAR out of habit is not refused on the stop button.
    #[payable]
    pub fn pause_agent(&mut self, agent_id: AccountId) {
        self.assert_owner();
        self.set_paused(agent_id, true);
    }

    #[payable]
    pub fn unpause_agent(&mut self, agent_id: AccountId) {
        self.assert_owner_full_access();
        self.set_paused(agent_id, false);
    }

    // ---- actions --------------------------------------------------------------------------------

    /// Called by the agent with its function-call key, with at least 60 TGas. Returns the action id; what happened to the
    /// action is in `action(id).status` and in the events. The record's storage is paid from the
    /// agent's `deposit_storage` credit, like `commit_proof`.
    ///
    /// `tee_signature` is base64 of the ed25519 signature over `canonical_json(decision)`.
    pub fn propose_action(
        &mut self,
        action: Action,
        model_proof_commit: String,
        decision: Decision,
        tee_signature: Base64VecU8,
    ) -> u64 {
        let storage_before = env::storage_usage();
        let agent_id = env::predecessor_account_id();
        let mut agent = self.agent_or_panic(&agent_id);
        require!(!agent.paused, "agent is paused");
        require!(action.kind == "ft_transfer", "only ft_transfer actions are supported");
        require!(action.memo.len() <= MAX_MEMO_BYTES, &format!("memo is longer than {MAX_MEMO_BYTES} bytes"));
        require!(action.token_id == agent.token_id, "this agent is not registered for that token");

        // The decision is about this action, this model proof and the registered policy.
        require!(
            decision.policy_hash == agent.policy_hash && decision.policy_version == agent.policy_version,
            "decision was made under a different policy than the registered one"
        );
        let action_commit = sha256_hex(canonical(&action).as_bytes());
        require!(decision.action_commit == action_commit, "decision does not cover this action");
        require!(
            is_hex64(&model_proof_commit) && decision.model_proof_commit == model_proof_commit,
            "decision does not cover this model proof"
        );
        // ...and that commit is on chain under the agent's name (`commit_proof`, kind "model") from before
        // the action: a public, dated record of which log entry it points at. The contract cannot see what
        // the commit hides, so this does not prove a real model answer is behind it; it gives an auditor
        // something to ask the agent's owner to open.
        require!(
            self.commits.get(&commit_key(&agent_id, &model_proof_commit)).is_some_and(|c| c.kind == "model"),
            "model_proof_commit is not a model proof this agent committed: call commit_proof first"
        );

        // It is still valid, and was not "made" in the future.
        let now_ms = env::block_timestamp_ms();
        let expires_at = decision.expires_at.0;
        require!(expires_at > now_ms, "decision has expired");
        require!(
            expires_at <= now_ms + DECISION_LIFETIME_MS + MAX_CLOCK_SKEW_MS,
            "decision expires too far in the future"
        );

        // The job saw the real time and the real amount spent today. Both reach the job from the
        // agent, the party the policy restrains, and neither is a field of the decision; the job
        // folds them into the nonce (SPEC §6.2), so we recompute it from our own numbers.
        let day = day_of(now_ms);
        let spent_today = agent.spent_on(day);
        let decided_at = expires_at - DECISION_LIFETIME_MS;
        let nonce = sha256_hex(format!("{action_commit}:{decided_at}:{spent_today}").as_bytes());
        require!(
            decision.nonce == nonce,
            "decision was made for a different time or spent_today than the contract's"
        );
        require!(
            self.used_nonces.insert(format!("{agent_id}/{nonce}")),
            "this decision was already used"
        );

        // It was signed by the key of the registered policy job.
        let signature: [u8; 64] = tee_signature
            .0
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("tee_signature must be 64 bytes"));
        let public_key: [u8; 32] = hex::decode(&agent.tee_pubkey)
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .unwrap_or_else(|| env::panic_str("registered tee_pubkey is not 32 bytes"));
        require!(
            env::ed25519_verify(&signature, canonical(&decision).as_bytes(), &public_key),
            "decision signature does not verify under the registered policy key"
        );

        let action_id = u64::from(self.actions.len());
        let status = match decision.verdict.as_str() {
            "Allow" => ActionStatus::Executing,
            "NeedsApproval" => ActionStatus::Pending,
            "Deny" => ActionStatus::Denied,
            _ => env::panic_str("verdict must be Allow, Deny or NeedsApproval"),
        };
        if status != ActionStatus::Denied {
            // Counted now, also while it waits for approval, so that queued actions cannot add up
            // past the daily cap. Given back if the owner rejects or the token refuses.
            agent.spent_day = day;
            agent.spent = spent_today
                .checked_add(action.amount.0)
                .unwrap_or_else(|| env::panic_str("daily total overflows"));
        }
        if status == ActionStatus::Pending {
            require!(agent.pending.len() < MAX_PENDING, "too many actions are waiting for approval");
            agent.pending.push(action_id);
        }
        let agent_tee_pubkey = agent.tee_pubkey.clone();
        self.agents.insert(agent_id.clone(), agent);

        // No amount and no receiver in events (SPEC §4.3); the transfer itself is public on-chain.
        emit(
            "action_proposed",
            json!({ "action_id": action_id, "agent_id": agent_id, "verdict": decision.verdict,
                    "policy_hash": decision.policy_hash, "policy_version": decision.policy_version,
                    "action_commit": decision.action_commit,
                    "model_proof_commit": decision.model_proof_commit }),
        );
        let transfer = (status == ActionStatus::Executing).then(|| self.transfer(action_id, &action));
        self.actions.push(ActionRecord {
            action_id,
            agent_id: agent_id.clone(),
            action,
            decision,
            tee_signature,
            tee_pubkey: agent_tee_pubkey,
            status,
            day,
            block_height: env::block_height(),
        });
        // Flushed so that `charge_storage` sees the new bytes (a LookupSet writes through at once).
        self.agents.flush();
        self.actions.flush();
        self.charge_storage(&agent_id, storage_before);

        match transfer {
            Some(promise) => promise.detach(),
            None if status == ActionStatus::Pending => {
                emit("action_pending", json!({ "action_id": action_id, "agent_id": agent_id }))
            }
            None => emit("action_denied", json!({ "action_id": action_id, "agent_id": agent_id })),
        }
        action_id
    }

    /// The owner lets a `Pending` action through (at least 60 TGas, 1 yoctoNEAR). The policy's decision may be older
    /// than ten minutes by now: the limit is on proposing, a human needs longer. But only on the day the
    /// action was proposed.
    #[payable]
    pub fn approve(&mut self, action_id: u64) -> Promise {
        self.assert_owner_full_access();
        let mut record = self.pending_or_panic(action_id);
        let mut agent = self.agent_or_panic(&record.agent_id);
        require!(!agent.paused, "agent is paused");
        // `update_policy` also cancels what was decided under the old policy or key and is still waiting.
        require!(
            record.decision.policy_hash == agent.policy_hash
                && record.decision.policy_version == agent.policy_version
                && record.tee_pubkey == agent.tee_pubkey,
            "action was decided under a policy or key that has since been replaced: reject it"
        );
        // Approval never lifts the daily cap (SPEC §6.2). The amount was counted against the cap of the day
        // it was proposed; on a later day it would move on top of what that day's own cap already let
        // through. So the owner rejects it and the agent asks the policy job again.
        require!(
            record.day == day_of(env::block_timestamp_ms()),
            "action was proposed on an earlier day: reject it and let the agent propose again"
        );
        agent.pending.retain(|id| *id != action_id);
        self.agents.insert(record.agent_id.clone(), agent);
        let transfer = self.transfer(action_id, &record.action);
        record.status = ActionStatus::Executing;
        emit("action_approved", json!({ "action_id": action_id, "agent_id": record.agent_id }));
        self.actions.replace(action_id as u32, record);
        transfer
    }

    #[payable]
    pub fn reject(&mut self, action_id: u64) {
        self.assert_owner_full_access();
        let record = self.pending_or_panic(action_id);
        self.finish(record, ActionStatus::Rejected, "action_rejected");
    }

    /// Callback of the `ft_transfer` promise. `#[private]`: only this contract can call it.
    #[private]
    pub fn on_transfer(&mut self, action_id: u64) {
        let record = self.action(action_id).unwrap_or_else(|| env::panic_str("no such action"));
        require!(record.status == ActionStatus::Executing, "action is not being executed");
        if near_sdk::is_promise_success() {
            self.finish(record, ActionStatus::Executed, "action_executed");
        } else {
            self.finish(record, ActionStatus::Failed, "action_failed");
        }
    }

    // ---- views ----------------------------------------------------------------------------------

    pub fn agent(&self, agent_id: AccountId) -> Option<AgentInfo> {
        self.agents.get(&agent_id).map(|a| AgentInfo {
            agent_id,
            policy_hash: a.policy_hash.clone(),
            policy_version: a.policy_version,
            tee_pubkey: a.tee_pubkey.clone(),
            token_id: a.token_id.clone(),
            paused: a.paused,
            spent_today: U128(a.spent_on(day_of(env::block_timestamp_ms()))),
        })
    }

    pub fn action(&self, action_id: u64) -> Option<ActionRecord> {
        u32::try_from(action_id).ok().and_then(|i| self.actions.get(i)).cloned()
    }

    pub fn pending_actions(&self, agent_id: AccountId) -> Vec<ActionRecord> {
        let ids = self.agents.get(&agent_id).map(|a| a.pending.clone()).unwrap_or_default();
        ids.into_iter().filter_map(|id| self.action(id)).collect()
    }

    // ---- internals ------------------------------------------------------------------------------

    fn agent_or_panic(&self, agent_id: &AccountId) -> Agent {
        self.agents.get(agent_id).cloned().unwrap_or_else(|| env::panic_str("agent is not registered"))
    }

    fn pending_or_panic(&self, action_id: u64) -> ActionRecord {
        let record = self.action(action_id).unwrap_or_else(|| env::panic_str("no such action"));
        require!(record.status == ActionStatus::Pending, "action is not waiting for approval");
        record
    }

    fn set_paused(&mut self, agent_id: AccountId, paused: bool) {
        let mut agent = self.agent_or_panic(&agent_id);
        agent.paused = paused;
        self.agents.insert(agent_id.clone(), agent);
        emit(if paused { "agent_paused" } else { "agent_unpaused" }, json!({ "agent_id": agent_id }));
    }

    /// `ft_transfer` on the token with this contract as the sender, then `on_transfer` with the result.
    fn transfer(&self, action_id: u64, action: &Action) -> Promise {
        require!(
            env::prepaid_gas() >= MIN_GAS_WITH_TRANSFER,
            "attach at least 60 TGas: the token transfer and its callback are paid from it"
        );
        let memo = (!action.memo.is_empty()).then_some(&action.memo);
        let args = json!({ "receiver_id": action.receiver_id, "amount": action.amount, "memo": memo });
        Promise::new(action.token_id.clone())
            .function_call(
                "ft_transfer".to_string(),
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                FT_TRANSFER_GAS,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(ON_TRANSFER_GAS).on_transfer(action_id))
    }

    /// Final status of an action. Anything but `Executed` gives the amount back to the day's total.
    fn finish(&mut self, mut record: ActionRecord, status: ActionStatus, event: &str) {
        let mut agent = self.agent_or_panic(&record.agent_id);
        agent.pending.retain(|id| *id != record.action_id);
        if status != ActionStatus::Executed && agent.spent_day == record.day {
            agent.spent = agent.spent.saturating_sub(record.action.amount.0);
        }
        self.agents.insert(record.agent_id.clone(), agent);
        record.status = status;
        emit(event, json!({ "action_id": record.action_id, "agent_id": record.agent_id }));
        self.actions.replace(record.action_id as u32, record);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

    /// Outputs of the real policy job (`jobs/policy`) for a published test key. Using them here means
    /// the contract is tested against what the job actually signs, not against a re-implementation.
    const FIXTURE: &str = include_str!("../../../docs/test-vectors/policy-decision.json");
    /// The `now` every fixture decision was made for; they expire ten minutes later.
    const DECIDED_AT_MS: u64 = 1_762_200_000_000;
    const ALLOW: usize = 0;
    const NEEDS_APPROVAL: usize = 1;
    const DENY_AFTER_SPENDING: usize = 2;
    const DENY: usize = 3;
    const OWNER: &str = "owner.testnet";
    const AGENT: &str = "agent.testnet";

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn fixture() -> serde_json::Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn at(caller: &str, time_ms: u64) {
        at_with(caller, time_ms, 0, vec![]);
    }

    /// The owner signing with a full-access key: only such a key can attach the 1 yoctoNEAR.
    fn owner_at(time_ms: u64) {
        at_with(OWNER, time_ms, 1, vec![]);
    }

    fn at_with(caller: &str, time_ms: u64, deposit: u128, promise_results: Vec<PromiseResult>) {
        let context = VMContextBuilder::new()
            .current_account_id(acc("ainek.testnet"))
            .predecessor_account_id(acc(caller))
            .block_timestamp(time_ms * 1_000_000)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build();
        testing_env!(context, test_vm_config(), RuntimeFeesConfig::test(), Default::default(), promise_results);
    }

    /// A contract with the agent registered under the fixture's policy and key, storage prepaid.
    fn setup() -> Contract {
        let f = fixture();
        let decision = &f["cases"][0]["output"]["decision"];
        owner_at(DECIDED_AT_MS);
        let mut contract = Contract::new(acc(OWNER));
        contract.register_agent(
            acc(AGENT),
            decision["policy_hash"].as_str().unwrap().to_string(),
            decision["policy_version"].as_u64().unwrap() as u32,
            f["cases"][0]["output"]["pubkey"].as_str().unwrap().to_string(),
            acc("token.ainek.testnet"),
        );
        at_with(AGENT, DECIDED_AT_MS, NearToken::from_near(1).as_yoctonear(), vec![]);
        contract.deposit_storage();
        // The agent has committed the model proof the fixture decisions refer to (what `commit_proof` stores).
        let commit = f["cases"][0]["input"]["model_proof_commit"].as_str().unwrap();
        contract.commits.insert(commit_key(&acc(AGENT), commit), model_proof());
        contract
    }

    fn model_proof() -> crate::ProofCommit {
        crate::ProofCommit { kind: "model".into(), log_index: 0, block_height: 0 }
    }

    fn args(case: usize) -> (Action, String, Decision, Base64VecU8) {
        let f = fixture();
        let c = &f["cases"][case];
        (
            serde_json::from_value(c["input"]["action"].clone()).unwrap(),
            c["input"]["model_proof_commit"].as_str().unwrap().to_string(),
            serde_json::from_value(c["output"]["decision"].clone()).unwrap(),
            serde_json::from_value(c["output"]["sig"].clone()).unwrap(),
        )
    }

    /// The agent proposes a fixture case five seconds after the job decided.
    fn propose(contract: &mut Contract, case: usize) -> u64 {
        let (action, commit, decision, sig) = args(case);
        at(AGENT, DECIDED_AT_MS + 5_000);
        contract.propose_action(action, commit, decision, sig)
    }

    fn settle(contract: &mut Contract, action_id: u64, result: PromiseResult) {
        at_with("ainek.testnet", DECIDED_AT_MS + 6_000, 0, vec![result]);
        contract.on_transfer(action_id);
    }

    fn status(contract: &Contract, action_id: u64) -> ActionStatus {
        contract.action(action_id).unwrap().status
    }

    fn spent_today(contract: &Contract) -> u128 {
        contract.agent(acc(AGENT)).unwrap().spent_today.0
    }

    /// The function calls this call scheduled: (receiver, method, JSON args, attached yoctoNEAR).
    fn scheduled_calls() -> Vec<(String, String, String, u128)> {
        let mut calls = Vec::new();
        for receipt in get_created_receipts() {
            for action in receipt.actions {
                if let near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } = action {
                    let text = |bytes: Vec<u8>| String::from_utf8(bytes).unwrap();
                    calls.push((receipt.receiver_id.to_string(), text(method_name), text(args), attached_deposit.as_yoctonear()));
                }
            }
        }
        calls
    }

    /// Whether this call scheduled an `ft_transfer` on the token.
    fn transfer_scheduled() -> bool {
        scheduled_calls().iter().any(|(receiver, method, _, _)| receiver == "token.ainek.testnet" && method == "ft_transfer")
    }

    fn already_spent(contract: &mut Contract, amount: u128) {
        let mut agent = contract.agents.get(&acc(AGENT)).unwrap().clone();
        agent.spent_day = DECIDED_AT_MS / DAY_MS;
        agent.spent = amount;
        contract.agents.insert(acc(AGENT), agent);
    }

    #[test]
    fn an_allowed_action_moves_the_tokens_and_ends_executed() {
        let mut contract = setup();
        let id = propose(&mut contract, ALLOW);
        // The contract sends exactly what the decision covered, with the 1 yocto NEP-141 requires, and asks
        // to be told the result.
        let calls = scheduled_calls();
        let transfer = r#"{"receiver_id":"aibek.testnet","amount":"300000000","memo":"October"}"#;
        assert_eq!(calls[0], ("token.ainek.testnet".into(), "ft_transfer".into(), transfer.into(), 1));
        assert_eq!(calls[1], ("ainek.testnet".into(), "on_transfer".into(), r#"{"action_id":0}"#.into(), 0));
        assert_eq!(calls.len(), 2);
        assert_eq!(status(&contract, id), ActionStatus::Executing);
        assert_eq!(spent_today(&contract), 300_000_000);

        settle(&mut contract, id, PromiseResult::Successful(vec![]));
        assert_eq!(status(&contract, id), ActionStatus::Executed);
        assert_eq!(spent_today(&contract), 300_000_000, "an executed transfer stays in the day's total");
    }

    /// SPEC §4.3: events carry no amount and no receiver.
    #[test]
    fn events_name_the_action_but_not_the_amount_or_the_receiver() {
        let mut contract = setup();
        propose(&mut contract, ALLOW);
        let logs = get_logs().join("\n");
        assert!(logs.contains("action_proposed") && logs.contains(r#""verdict":"Allow""#), "{logs}");
        assert!(!logs.contains("300000000") && !logs.contains("aibek"), "{logs}");
    }

    #[test]
    fn a_transfer_the_token_refuses_ends_failed_and_frees_the_daily_total() {
        let mut contract = setup();
        let id = propose(&mut contract, ALLOW);
        settle(&mut contract, id, PromiseResult::Failed);
        assert_eq!(status(&contract, id), ActionStatus::Failed);
        assert_eq!(spent_today(&contract), 0);
    }

    #[test]
    fn needs_approval_moves_nothing_until_the_owner_approves() {
        let mut contract = setup();
        let id = propose(&mut contract, NEEDS_APPROVAL);
        assert!(!transfer_scheduled());
        assert_eq!(status(&contract, id), ActionStatus::Pending);
        assert_eq!(contract.pending_actions(acc(AGENT)).len(), 1);
        // Counted while it waits, so queued actions cannot add up past the daily cap.
        assert_eq!(spent_today(&contract), 400_000_000);

        owner_at(DECIDED_AT_MS + 3_600_000); // a human may take longer than the decision's ten minutes
        contract.approve(id).detach();
        assert!(transfer_scheduled());
        assert_eq!(status(&contract, id), ActionStatus::Executing);
        assert!(contract.pending_actions(acc(AGENT)).is_empty());
    }

    #[test]
    #[should_panic(expected = "only the owner can do this")]
    fn the_agent_cannot_approve_its_own_action() {
        let mut contract = setup();
        let id = propose(&mut contract, NEEDS_APPROVAL);
        at(AGENT, DECIDED_AT_MS + 6_000);
        contract.approve(id).detach();
    }

    #[test]
    fn a_rejected_action_moves_nothing_and_frees_the_daily_total() {
        let mut contract = setup();
        let id = propose(&mut contract, NEEDS_APPROVAL);
        owner_at(DECIDED_AT_MS + 6_000);
        contract.reject(id);
        assert!(!transfer_scheduled());
        assert_eq!(status(&contract, id), ActionStatus::Rejected);
        assert_eq!(spent_today(&contract), 0);
        assert!(contract.pending_actions(acc(AGENT)).is_empty());
    }

    #[test]
    #[should_panic(expected = "action is not waiting for approval")]
    fn an_action_cannot_be_approved_twice() {
        let mut contract = setup();
        let id = propose(&mut contract, NEEDS_APPROVAL);
        owner_at(DECIDED_AT_MS + 6_000);
        contract.approve(id).detach();
        contract.approve(id).detach();
    }

    #[test]
    fn a_denied_action_is_recorded_and_moves_nothing() {
        let mut contract = setup();
        let id = propose(&mut contract, DENY);
        assert!(!transfer_scheduled());
        assert_eq!(status(&contract, id), ActionStatus::Denied);
        assert_eq!(spent_today(&contract), 0);
        assert!(get_logs().join("\n").contains("action_denied"));
    }

    #[test]
    #[should_panic(expected = "this decision was already used")]
    fn a_decision_cannot_be_used_twice() {
        let mut contract = setup();
        propose(&mut contract, DENY);
        propose(&mut contract, DENY);
    }

    #[test]
    #[should_panic(expected = "decision has expired")]
    fn an_expired_decision_is_refused() {
        let mut contract = setup();
        let (action, commit, decision, sig) = args(ALLOW);
        at(AGENT, DECIDED_AT_MS + DECISION_LIFETIME_MS);
        contract.propose_action(action, commit, decision, sig);
    }

    /// Otherwise the agent could feed the job a far-future `now` and hold a decision that never expires.
    #[test]
    #[should_panic(expected = "decision expires too far in the future")]
    fn a_decision_made_for_a_time_in_the_future_is_refused() {
        let mut contract = setup();
        let (action, commit, decision, sig) = args(ALLOW);
        at(AGENT, DECIDED_AT_MS - MAX_CLOCK_SKEW_MS - 1);
        contract.propose_action(action, commit, decision, sig);
    }

    #[test]
    #[should_panic(expected = "decision signature does not verify")]
    fn a_decision_signed_by_another_key_is_refused() {
        let mut contract = setup();
        let (_, _, decision, _) = args(ALLOW);
        owner_at(DECIDED_AT_MS);
        contract.update_policy(acc(AGENT), decision.policy_hash, decision.policy_version, "11".repeat(32));
        propose(&mut contract, ALLOW);
    }

    #[test]
    #[should_panic(expected = "decision signature does not verify")]
    fn a_decision_edited_after_signing_is_refused() {
        let mut contract = setup();
        let (action, commit, mut decision, sig) = args(DENY);
        decision.verdict = "Allow".to_string();
        at(AGENT, DECIDED_AT_MS + 5_000);
        contract.propose_action(action, commit, decision, sig);
    }

    #[test]
    #[should_panic(expected = "decision does not cover this action")]
    fn a_decision_for_another_action_is_refused() {
        let mut contract = setup();
        let (mut action, commit, decision, sig) = args(ALLOW);
        action.amount = U128(499_000_000);
        at(AGENT, DECIDED_AT_MS + 5_000);
        contract.propose_action(action, commit, decision, sig);
    }

    #[test]
    #[should_panic(expected = "decision does not cover this model proof")]
    fn a_decision_for_another_model_proof_is_refused() {
        let mut contract = setup();
        let (action, _, decision, sig) = args(ALLOW);
        at(AGENT, DECIDED_AT_MS + 5_000);
        contract.propose_action(action, "ef".repeat(32), decision, sig);
    }

    #[test]
    #[should_panic(expected = "decision was made under a different policy")]
    fn a_decision_under_a_replaced_policy_is_refused() {
        let mut contract = setup();
        let pubkey = contract.agent(acc(AGENT)).unwrap().tee_pubkey;
        owner_at(DECIDED_AT_MS);
        contract.update_policy(acc(AGENT), "ee".repeat(32), 4, pubkey);
        propose(&mut contract, ALLOW);
    }

    /// The agent tells the job how much it has spent today. The contract keeps its own total and
    /// refuses a decision that was made for any other number, in either direction.
    #[test]
    #[should_panic(expected = "different time or spent_today")]
    fn a_decision_made_for_an_understated_spent_today_is_refused() {
        let mut contract = setup();
        already_spent(&mut contract, 1_900_000_000);
        propose(&mut contract, ALLOW); // the job was told "0 spent" and allowed 300 more
    }

    #[test]
    fn a_decision_made_for_the_real_spent_today_is_accepted() {
        let mut contract = setup();
        already_spent(&mut contract, 1_900_000_000);
        let id = propose(&mut contract, DENY_AFTER_SPENDING);
        assert_eq!(status(&contract, id), ActionStatus::Denied);
        assert_eq!(spent_today(&contract), 1_900_000_000);
    }

    /// A new policy must not leave actions approved-in-waiting under the old one.
    #[test]
    #[should_panic(expected = "policy or key that has since been replaced")]
    fn a_pending_action_cannot_be_approved_after_the_policy_changed() {
        let mut contract = setup();
        let id = propose(&mut contract, NEEDS_APPROVAL);
        let pubkey = contract.agent(acc(AGENT)).unwrap().tee_pubkey;
        owner_at(DECIDED_AT_MS + 6_000);
        contract.update_policy(acc(AGENT), "ee".repeat(32), 4, pubkey);
        contract.approve(id).detach();
    }

    /// Rotating the job's key (a new build) must cancel what the old key signed, even under the same policy.
    #[test]
    #[should_panic(expected = "policy or key that has since been replaced")]
    fn a_pending_action_cannot_be_approved_after_the_key_changed() {
        let mut contract = setup();
        let id = propose(&mut contract, NEEDS_APPROVAL);
        let info = contract.agent(acc(AGENT)).unwrap();
        owner_at(DECIDED_AT_MS + 6_000);
        contract.update_policy(acc(AGENT), info.policy_hash, info.policy_version, "11".repeat(32));
        contract.approve(id).detach();
    }

    /// An old action stays checkable after the agent's key was replaced.
    #[test]
    fn the_record_keeps_the_key_its_signature_was_checked_against() {
        let mut contract = setup();
        let id = propose(&mut contract, DENY);
        let info = contract.agent(acc(AGENT)).unwrap();
        owner_at(DECIDED_AT_MS + 6_000);
        contract.update_policy(acc(AGENT), info.policy_hash, info.policy_version, "11".repeat(32));
        assert_eq!(contract.action(id).unwrap().tee_pubkey, info.tee_pubkey);
    }

    /// The daily cap is hard: approval never lifts it (SPEC §6.2). An action waiting since yesterday was
    /// counted against yesterday's cap; approved today it would move on top of everything today's cap
    /// lets through, two caps in one day. The owner can only reject it.
    #[test]
    #[should_panic(expected = "action was proposed on an earlier day")]
    fn an_action_cannot_be_approved_on_a_later_day() {
        let mut contract = setup();
        let id = propose(&mut contract, NEEDS_APPROVAL);
        owner_at(DECIDED_AT_MS + DAY_MS);
        contract.approve(id).detach();
    }

    #[test]
    fn an_action_left_from_an_earlier_day_can_be_rejected_and_does_not_count_today() {
        let mut contract = setup();
        let id = propose(&mut contract, NEEDS_APPROVAL);
        owner_at(DECIDED_AT_MS + DAY_MS);
        assert_eq!(spent_today(&contract), 0);
        contract.reject(id);
        assert_eq!(status(&contract, id), ActionStatus::Rejected);
        assert_eq!(spent_today(&contract), 0);
        assert!(contract.pending_actions(acc(AGENT)).is_empty());
    }

    // A function-call key on the owner's account is not enough (see `assert_owner_full_access`) to register
    // an agent with a key of the attacker's, swap the policy key, lift a pause, or let a waiting payment
    // through or drop it.

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn registering_an_agent_needs_the_owners_full_access_key() {
        let mut contract = setup();
        at(OWNER, DECIDED_AT_MS);
        contract.register_agent(acc("other.testnet"), "ab".repeat(32), 1, "cd".repeat(32), acc("token.ainek.testnet"));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn replacing_the_policy_key_needs_the_owners_full_access_key() {
        let mut contract = setup();
        at(OWNER, DECIDED_AT_MS);
        contract.update_policy(acc(AGENT), "ab".repeat(32), 2, "cd".repeat(32));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn approving_needs_the_owners_full_access_key() {
        let mut contract = setup();
        let id = propose(&mut contract, NEEDS_APPROVAL);
        at(OWNER, DECIDED_AT_MS + 60_000);
        contract.approve(id).detach();
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn rejecting_needs_the_owners_full_access_key() {
        let mut contract = setup();
        let id = propose(&mut contract, NEEDS_APPROVAL);
        at(OWNER, DECIDED_AT_MS + 60_000);
        contract.reject(id);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn lifting_a_pause_needs_the_owners_full_access_key() {
        let mut contract = setup();
        at(OWNER, DECIDED_AT_MS);
        contract.pause_agent(acc(AGENT));
        contract.unpause_agent(acc(AGENT));
    }

    /// The stop button must work from anything that can sign for the owner, with no deposit.
    #[test]
    fn pausing_needs_no_deposit() {
        let mut contract = setup();
        at(OWNER, DECIDED_AT_MS);
        contract.pause_agent(acc(AGENT));
        assert!(contract.agent(acc(AGENT)).unwrap().paused);
    }

    /// The contract pays only NEP-141 transfers; the job denies other kinds, and the contract does not
    /// rely on that.
    #[test]
    #[should_panic(expected = "only ft_transfer actions are supported")]
    fn an_action_of_another_kind_is_refused() {
        let mut contract = setup();
        let (mut action, commit, decision, sig) = args(ALLOW);
        action.kind = "ft_transfer_call".into();
        at(AGENT, DECIDED_AT_MS + 5_000);
        contract.propose_action(action, commit, decision, sig);
    }

    /// One action must not be able to carry an arbitrarily large payload into the token call and the views.
    #[test]
    #[should_panic(expected = "memo is longer than 256 bytes")]
    fn an_oversized_memo_is_refused() {
        let mut contract = setup();
        let (mut action, commit, decision, sig) = args(ALLOW);
        action.memo = "x".repeat(MAX_MEMO_BYTES + 1);
        at(AGENT, DECIDED_AT_MS + 5_000);
        contract.propose_action(action, commit, decision, sig);
    }

    /// An action must point at a model proof commit that is on chain under the agent's own name, so that
    /// every payment has a dated public record an auditor can ask to have opened.
    #[test]
    #[should_panic(expected = "not a model proof this agent committed")]
    fn a_model_proof_the_agent_never_committed_is_refused() {
        let mut contract = setup();
        let (_, commit, ..) = args(ALLOW);
        contract.commits.remove(&commit_key(&acc(AGENT), &commit));
        // Somebody else's commit of the same hash does not count.
        contract.commits.insert(commit_key(&acc("other.testnet"), &commit), model_proof());
        propose(&mut contract, ALLOW);
    }

    #[test]
    #[should_panic(expected = "not a model proof this agent committed")]
    fn an_action_proof_commit_does_not_pass_for_a_model_proof() {
        let mut contract = setup();
        let (_, commit, ..) = args(ALLOW);
        let action_proof = crate::ProofCommit { kind: "action".into(), ..model_proof() };
        contract.commits.insert(commit_key(&acc(AGENT), &commit), action_proof);
        propose(&mut contract, ALLOW);
    }

    #[test]
    #[should_panic(expected = "too many actions are waiting for approval")]
    fn the_queue_of_actions_waiting_for_the_owner_is_bounded() {
        let mut contract = setup();
        let mut agent = contract.agents.get(&acc(AGENT)).unwrap().clone();
        agent.pending = (100..100 + MAX_PENDING as u64).collect();
        contract.agents.insert(acc(AGENT), agent);
        propose(&mut contract, NEEDS_APPROVAL);
    }

    /// near-api-js attaches 30 TGas by default: say so at once instead of running out halfway.
    #[test]
    #[should_panic(expected = "attach at least 60 TGas")]
    fn an_allowed_action_with_too_little_gas_is_refused_up_front() {
        let mut contract = setup();
        let (action, commit, decision, sig) = args(ALLOW);
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("ainek.testnet"))
            .predecessor_account_id(acc(AGENT))
            .block_timestamp((DECIDED_AT_MS + 5_000) * 1_000_000)
            .prepaid_gas(Gas::from_tgas(30))
            .build());
        contract.propose_action(action, commit, decision, sig);
    }

    #[test]
    fn the_daily_total_starts_again_the_next_day() {
        let mut contract = setup();
        propose(&mut contract, NEEDS_APPROVAL);
        at(AGENT, DECIDED_AT_MS + DAY_MS);
        assert_eq!(spent_today(&contract), 0);
    }

    #[test]
    #[should_panic(expected = "agent is not registered")]
    fn an_unregistered_account_cannot_propose() {
        let mut contract = setup();
        let (action, commit, decision, sig) = args(ALLOW);
        at("mallory.testnet", DECIDED_AT_MS + 5_000);
        contract.propose_action(action, commit, decision, sig);
    }

    #[test]
    #[should_panic(expected = "agent is paused")]
    fn a_paused_agent_cannot_propose() {
        let mut contract = setup();
        owner_at(DECIDED_AT_MS);
        contract.pause_agent(acc(AGENT));
        propose(&mut contract, ALLOW);
    }

    /// The stop button must also stop what is already waiting.
    #[test]
    #[should_panic(expected = "agent is paused")]
    fn a_paused_agents_pending_action_cannot_be_approved() {
        let mut contract = setup();
        let id = propose(&mut contract, NEEDS_APPROVAL);
        owner_at(DECIDED_AT_MS + 6_000);
        contract.pause_agent(acc(AGENT));
        contract.approve(id).detach();
    }

    #[test]
    fn an_unpaused_agent_works_again() {
        let mut contract = setup();
        owner_at(DECIDED_AT_MS);
        contract.pause_agent(acc(AGENT));
        assert!(contract.agent(acc(AGENT)).unwrap().paused);
        contract.unpause_agent(acc(AGENT));
        let id = propose(&mut contract, DENY);
        assert_eq!(status(&contract, id), ActionStatus::Denied);
    }

    #[test]
    #[should_panic(expected = "only the owner can do this")]
    fn the_agent_cannot_unpause_itself() {
        let mut contract = setup();
        owner_at(DECIDED_AT_MS);
        contract.pause_agent(acc(AGENT));
        at(AGENT, DECIDED_AT_MS);
        contract.unpause_agent(acc(AGENT));
    }

    #[test]
    #[should_panic(expected = "only the owner can do this")]
    fn only_the_owner_registers_agents() {
        let mut contract = setup();
        at(AGENT, DECIDED_AT_MS);
        contract.register_agent(acc("other.testnet"), "ab".repeat(32), 1, "cd".repeat(32), acc("token.ainek.testnet"));
    }

    /// The agent's function-call key cannot attach NEAR, so the record is paid from prepaid credit.
    #[test]
    #[should_panic(expected = "not enough prepaid storage")]
    fn proposing_without_prepaid_storage_is_refused() {
        let mut contract = setup();
        contract.storage_credit.insert(acc(AGENT), 0);
        propose(&mut contract, DENY);
    }

    #[test]
    fn proposing_is_paid_from_the_agents_prepaid_storage() {
        let mut contract = setup();
        let before = contract.storage_balance_of(acc(AGENT)).0;
        propose(&mut contract, DENY);
        assert!(contract.storage_balance_of(acc(AGENT)).0 < before);
    }

    #[test]
    #[should_panic(expected = "not registered for that token")]
    fn an_action_on_another_token_is_refused() {
        let mut contract = setup();
        let (mut action, commit, decision, sig) = args(ALLOW);
        action.token_id = acc("other-token.testnet");
        at(AGENT, DECIDED_AT_MS + 5_000);
        contract.propose_action(action, commit, decision, sig);
    }

    #[test]
    #[should_panic(expected = "action is not being executed")]
    fn a_transfer_result_cannot_be_reported_twice() {
        let mut contract = setup();
        let id = propose(&mut contract, ALLOW);
        settle(&mut contract, id, PromiseResult::Failed);
        settle(&mut contract, id, PromiseResult::Successful(vec![]));
    }
}
