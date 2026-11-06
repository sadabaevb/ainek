//! Integration test of tier 2 (SPEC §4.3): the real policy job (`jobs/policy`, run natively here) decides
//! and signs, the agent submits with a function-call key that can only call `commit_proof` and `propose_action`, and the
//! real contract wasm in a local NEAR sandbox node checks the decision with the node's own
//! `ed25519_verify` and acts on it.
//!
//! The token is real too: `contracts/demo-token`, NEAR's own NEP-141 implementation. So an allowed action
//! and an approved one really move tokens, and a transfer the token refuses (a receiver who is not
//! registered on it) ends `Failed` and leaves the daily total. `spent_today` is read from the contract
//! before each decision, as the agent service does.

use std::io::Write;
use std::process::{Command, Stdio};

mod common;

use common::{create_subaccount, now_ms};
use near_api::NearToken;
use near_sdk::serde_json::{self, json, Value};

/// A recorded key-log entry: the agent's model proof must point at a logged key.
const VECTORS: &str = include_str!("../../../docs/test-vectors/canonical.json");
/// A published test seed (docs/test-vectors/policy-decision.json), never a real key.
const TEST_KEY: &str = "ed25519:US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx";

/// Runs `jobs/policy` the way OutLayer does: secrets in env, input on stdin, the decision on stdout.
fn policy_job(policy: &Value, input: &Value) -> Value {
    let mut child = Command::new(env!("CARGO"))
        .args(["run", "--quiet", "--locked"])
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../jobs/policy"))
        .env("POLICY_JSON", policy.to_string())
        .env("PROTECTED_ED25519", TEST_KEY)
        .env("WASM_HASH", "ab".repeat(32))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("cannot start the policy job");
    child.stdin.take().unwrap().write_all(input.to_string().as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "the policy job refused the input");
    serde_json::from_slice(&output.stdout).unwrap()
}

async fn view(contract: &near_api::Contract, network: &near_api::NetworkConfig, method: &str, args: Value) -> Value {
    contract.call_function(method, args).read_only().fetch_from(network).await.unwrap().data
}

async fn agent_info(contract: &near_api::Contract, network: &near_api::NetworkConfig, agent: &near_api::Account) -> Value {
    view(contract, network, "agent", json!({ "agent_id": agent.account_id() })).await
}

async fn balance_of(token: &near_api::Contract, network: &near_api::NetworkConfig, account_id: &str) -> String {
    view(token, network, "ft_balance_of", json!({ "account_id": account_id })).await.as_str().unwrap().to_string()
}

async fn status_of(contract: &near_api::Contract, network: &near_api::NetworkConfig, action_id: u64) -> String {
    view(contract, network, "action", json!({ "action_id": action_id })).await["status"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn agent_flow_end_to_end_on_sandbox() -> testresult::TestResult<()> {
    let wasm = std::fs::read(cargo_near_build::build_with_cli(Default::default())?)?;
    let token_wasm = std::fs::read(cargo_near_build::build_with_cli(cargo_near_build::BuildOpts {
        manifest_path: Some(concat!(env!("CARGO_MANIFEST_DIR"), "/../demo-token/Cargo.toml").into()),
        ..Default::default()
    })?)?;
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let owner = create_subaccount(&sandbox, "owner.sandbox").await?;
    let agent = create_subaccount(&sandbox, "agent.sandbox").await?;
    let token = create_subaccount(&sandbox, "token.sandbox").await?.as_contract();
    let contract = create_subaccount(&sandbox, "ainek.sandbox").await?.as_contract();
    let signer = near_api::Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse().unwrap(),
    )?;
    near_api::Contract::deploy(contract.account_id().clone())
        .use_code(wasm)
        .with_init_call("new", json!({ "owner": owner.account_id() }))?
        .with_signer(signer.clone())
        .send_to(&network)
        .await?
        .assert_success();

    // The owner's methods need 1 yoctoNEAR: only a full-access key can attach it.
    let one_yocto = NearToken::from_yoctonear(1);
    // The token: the owner holds the supply, registers the contract and one receiver (NEP-145: an account
    // must be registered on a token before it can hold it) and gives the contract 1000 tokens to pay from.
    // `vendor1.sandbox` is in the policy's whitelist but not registered, so the token refuses to pay it.
    near_api::Contract::deploy(token.account_id().clone())
        .use_code(token_wasm)
        .with_init_call("new", json!({ "owner_id": owner.account_id(), "total_supply": "1000000000000" }))?
        .with_signer(signer.clone())
        .send_to(&network)
        .await?
        .assert_success();
    let as_owner = |target: &near_api::Contract, method: &str, args: Value, deposit: NearToken| {
        target
            .call_function(method, args)
            .transaction()
            .gas(near_api::NearGas::from_tgas(100))
            .deposit(deposit)
            .with_signer(owner.account_id().clone(), signer.clone())
            .send_to(&network)
    };
    for account_id in [contract.account_id().as_str(), "aibek.sandbox"] {
        as_owner(&token, "storage_deposit", json!({ "account_id": account_id }), NearToken::from_millinear(10))
            .await?
            .assert_success();
    }
    let funding = json!({ "receiver_id": contract.account_id(), "amount": "1000000000" });
    as_owner(&token, "ft_transfer", funding, one_yocto).await?.assert_success();

    // One key in the log, so that a model proof has an entry to point at.
    let verifier = create_subaccount(&sandbox, "v1.sandbox").await?;
    as_owner(&contract, "register_verifier", json!({ "account_id": verifier.account_id() }), one_yocto)
        .await?
        .assert_success();
    let mut entry = serde_json::from_str::<Value>(VECTORS)?["commits"]["entry_hash"]["input"].clone();
    entry["observed_at"] = json!(now_ms().to_string());
    contract
        .call_function("log_key", json!({ "entry": entry }))
        .transaction()
        .with_signer(verifier.account_id().clone(), signer.clone())
        .send_to(&network)
        .await?
        .assert_success();

    let policy = json!({
        "version": 1, "principal": owner.account_id(), "agent": agent.account_id(),
        "token_id": token.account_id(), "whitelist": ["aibek.sandbox", "vendor1.sandbox"],
        "caps": { "per_action": "500000000", "per_day": "2000000000" },
        "needs_approval_above": "300000000", "deny_new_receivers": true, "salt": "5a".repeat(32),
    });
    let action = |receiver: &str, amount: &str| {
        json!({ "kind": "ft_transfer", "token_id": token.account_id(), "receiver_id": receiver,
                "amount": amount, "memo": "October" })
    };
    let model_proof_commit = "cd".repeat(32);

    // What the agent service does: read spent_today from the contract, ask the job, propose.
    let decide = |action: Value, spent_today: String| {
        let input = json!({ "action": action, "model_proof_commit": model_proof_commit,
                            "spent_today": spent_today, "now": now_ms() });
        let output = policy_job(&policy, &input);
        json!({ "action": action, "model_proof_commit": model_proof_commit,
                "decision": output["decision"], "tee_signature": output["sig"] })
    };

    // The owner registers the agent with what the job reports about itself.
    let first = policy_job(
        &policy,
        &json!({ "action": action("aibek.sandbox", "1"), "model_proof_commit": model_proof_commit,
                 "spent_today": "0", "now": now_ms() }),
    );
    let registration = json!({
        "agent_id": agent.account_id(), "policy_hash": first["decision"]["policy_hash"],
        "policy_version": 1, "tee_pubkey": first["pubkey"], "token_id": token.account_id(),
    });
    contract
        .call_function("register_agent", registration.clone())
        .transaction()
        .with_signer(agent.account_id().clone(), signer.clone())
        .send_to(&network)
        .await?
        .assert_failure();
    as_owner(&contract, "register_agent", registration, one_yocto).await?.assert_success();

    // The agent works with a function-call key that can call `commit_proof` and `propose_action` and
    // nothing else. It cannot attach NEAR, so the agent account prepays storage once with its full-access key.
    let fc_secret = near_api::signer::generate_secret_key()?;
    let fc_signer = near_api::Signer::from_secret_key(fc_secret.clone())?;
    agent
        .add_key(
            near_api::types::AccessKeyPermission::FunctionCall(
                near_api::types::transaction::actions::FunctionCallPermission {
                    allowance: Some(NearToken::from_near(1)),
                    receiver_id: contract.account_id().to_string(),
                    method_names: vec!["commit_proof".into(), "propose_action".into()],
                },
            ),
            fc_secret.public_key(),
        )
        .with_signer(signer.clone())
        .send_to(&network)
        .await?
        .assert_success();
    contract
        .call_function("deposit_storage", ())
        .transaction()
        .deposit(NearToken::from_millinear(100))
        .with_signer(agent.account_id().clone(), signer.clone())
        .send_to(&network)
        .await?
        .assert_success();
    let propose = |args: Value| {
        contract
            .call_function("propose_action", args)
            .transaction()
            .gas(near_api::NearGas::from_tgas(100))
            .with_signer(agent.account_id().clone(), fc_signer.clone())
            .send_to(&network)
    };

    // The scoped key cannot approve or pause: NEAR itself refuses the transaction.
    let unpause = contract
        .call_function("unpause_agent", json!({ "agent_id": agent.account_id() }))
        .transaction()
        .with_signer(agent.account_id().clone(), fc_signer.clone())
        .send_to(&network)
        .await;
    assert!(unpause.is_err() || unpause.unwrap().is_failure(), "the scoped key must not reach other methods");

    let spent_today = || async {
        agent_info(&contract, &network, &agent).await["spent_today"].as_str().unwrap().to_string()
    };

    // ---- Deny: a receiver outside the whitelist. Recorded, nothing moves. ----------------------
    let denied = decide(action("mallory.sandbox", "1"), spent_today().await);
    assert_eq!(denied["decision"]["verdict"], "Deny");
    // Nothing can be proposed about a model proof that is not on chain; the agent commits it first. (The
    // very same call succeeds right after the commit, so the missing commit is what it failed on.)
    propose(denied.clone()).await?.assert_failure();
    contract
        .call_function("commit_proof", json!({ "commit": model_proof_commit, "kind": "model", "log_index": 0 }))
        .transaction()
        .with_signer(agent.account_id().clone(), fc_signer.clone())
        .send_to(&network)
        .await?
        .assert_success();
    propose(denied.clone()).await?.assert_success();
    assert_eq!(status_of(&contract, &network, 0).await, "Denied");
    // The same decision a second time is refused.
    propose(denied.clone()).await?.assert_failure();
    // The signed decision cannot be reused for another action...
    let mut other_action = denied.clone();
    other_action["action"]["receiver_id"] = json!("aibek.sandbox");
    propose(other_action).await?.assert_failure();
    // ...and cannot be edited into an Allow.
    let mut edited = decide(action("mallory.sandbox", "2"), spent_today().await);
    edited["decision"]["verdict"] = json!("Allow");
    propose(edited).await?.assert_failure();

    // ---- NeedsApproval: above the threshold. Waits for the owner, who rejects. ------------------
    let big = decide(action("aibek.sandbox", "400000000"), spent_today().await);
    assert_eq!(big["decision"]["verdict"], "NeedsApproval");
    propose(big).await?.assert_success();
    assert_eq!(status_of(&contract, &network, 1).await, "Pending");
    assert_eq!(agent_info(&contract, &network, &agent).await["spent_today"], "400000000");
    // A decision made for "nothing spent yet" no longer matches what the contract has counted.
    let stale = decide(action("aibek.sandbox", "100000000"), "0".into());
    assert_eq!(stale["decision"]["verdict"], "Allow");
    propose(stale).await?.assert_failure();
    // Only the owner decides.
    contract
        .call_function("approve", json!({ "action_id": 1 }))
        .transaction()
        .with_signer(agent.account_id().clone(), signer.clone())
        .send_to(&network)
        .await?
        .assert_failure();
    // Not even a key on the owner's own account, if it is a function-call key (wallets leave such keys
    // in the browser, for every method of the contract): it cannot attach the 1 yoctoNEAR.
    let stray_secret = near_api::signer::generate_secret_key()?;
    owner
        .add_key(
            near_api::types::AccessKeyPermission::FunctionCall(
                near_api::types::transaction::actions::FunctionCallPermission {
                    allowance: Some(NearToken::from_near(1)),
                    receiver_id: contract.account_id().to_string(),
                    method_names: vec![],
                },
            ),
            stray_secret.public_key(),
        )
        .with_signer(signer.clone())
        .send_to(&network)
        .await?
        .assert_success();
    let stray_signer = near_api::Signer::from_secret_key(stray_secret)?;
    for method in ["approve", "reject"] {
        contract
            .call_function(method, json!({ "action_id": 1 }))
            .transaction()
            .gas(near_api::NearGas::from_tgas(100))
            .with_signer(owner.account_id().clone(), stray_signer.clone())
            .send_to(&network)
            .await?
            .assert_failure();
    }
    assert_eq!(status_of(&contract, &network, 1).await, "Pending");
    as_owner(&contract, "reject", json!({ "action_id": 1 }), one_yocto).await?.assert_success();
    assert_eq!(status_of(&contract, &network, 1).await, "Rejected");
    assert_eq!(agent_info(&contract, &network, &agent).await["spent_today"], "0");

    // ---- Allow: the tokens move in the same transaction and the day's total keeps the amount. ----
    let small = decide(action("aibek.sandbox", "100000000"), spent_today().await);
    assert_eq!(small["decision"]["verdict"], "Allow");
    propose(small).await?.assert_success();
    assert_eq!(status_of(&contract, &network, 2).await, "Executed");
    assert_eq!(balance_of(&token, &network, "aibek.sandbox").await, "100000000");
    assert_eq!(agent_info(&contract, &network, &agent).await["spent_today"], "100000000");

    // ---- NeedsApproval, approved: nothing moves until the owner says so. ------------------------
    let big = decide(action("aibek.sandbox", "400000000"), spent_today().await);
    assert_eq!(big["decision"]["verdict"], "NeedsApproval");
    propose(big).await?.assert_success();
    assert_eq!(status_of(&contract, &network, 3).await, "Pending");
    assert_eq!(balance_of(&token, &network, "aibek.sandbox").await, "100000000");
    as_owner(&contract, "approve", json!({ "action_id": 3 }), one_yocto).await?.assert_success();
    assert_eq!(status_of(&contract, &network, 3).await, "Executed");
    assert_eq!(balance_of(&token, &network, "aibek.sandbox").await, "500000000");
    assert_eq!(balance_of(&token, &network, contract.account_id().as_str()).await, "500000000");
    assert_eq!(agent_info(&contract, &network, &agent).await["spent_today"], "500000000");

    // ---- Allow, but the token refuses (the receiver is not registered on it): the callback records
    // the failure and the amount leaves the daily total again. Nothing more moved. -----------------
    let refused = decide(action("vendor1.sandbox", "100000000"), spent_today().await);
    assert_eq!(refused["decision"]["verdict"], "Allow");
    propose(refused).await?.assert_success();
    assert_eq!(status_of(&contract, &network, 4).await, "Failed");
    assert_eq!(agent_info(&contract, &network, &agent).await["spent_today"], "500000000");
    assert_eq!(balance_of(&token, &network, contract.account_id().as_str()).await, "500000000");

    // ---- Stop button: a paused agent cannot propose. --------------------------------------------
    // The stop button needs no deposit.
    let no_deposit = NearToken::from_yoctonear(0);
    as_owner(&contract, "pause_agent", json!({ "agent_id": agent.account_id() }), no_deposit).await?.assert_success();
    assert_eq!(agent_info(&contract, &network, &agent).await["paused"], true);
    let while_paused = decide(action("aibek.sandbox", "100000000"), spent_today().await);
    assert_eq!(while_paused["decision"]["verdict"], "Allow");
    propose(while_paused.clone()).await?.assert_failure();
    // The pause was the only reason: the very same decision goes through once the owner lifts it.
    as_owner(&contract, "unpause_agent", json!({ "agent_id": agent.account_id() }), one_yocto).await?.assert_success();
    propose(while_paused).await?.assert_success();
    assert_eq!(status_of(&contract, &network, 5).await, "Executed");
    assert_eq!(balance_of(&token, &network, "aibek.sandbox").await, "600000000");

    Ok(())
}
