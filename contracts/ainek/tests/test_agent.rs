//! Integration test of tier 2 (SPEC §4.3): the real policy job (`jobs/policy`, run natively here) decides
//! and signs, the agent submits with a function-call key that can only call `propose_action`, and the
//! real contract wasm in a local NEAR sandbox node checks the decision with the node's own
//! `ed25519_verify` and acts on it.
//!
//! Not covered here: a transfer that succeeds. There is no NEP-141 token in the sandbox, so the `Allow`
//! case ends `Failed` (the "token" account has no contract), which exercises the callback and the
//! give-back of the daily total. The success branch is covered by the unit tests in `src/agent.rs`.

use std::io::Write;
use std::process::{Command, Stdio};

mod common;

use common::{create_subaccount, now_ms};
use near_api::NearToken;
use near_sdk::serde_json::{self, json, Value};

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

async fn status_of(contract: &near_api::Contract, network: &near_api::NetworkConfig, action_id: u64) -> String {
    view(contract, network, "action", json!({ "action_id": action_id })).await["status"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn agent_flow_end_to_end_on_sandbox() -> testresult::TestResult<()> {
    let wasm = std::fs::read(cargo_near_build::build_with_cli(Default::default())?)?;
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let owner = create_subaccount(&sandbox, "owner.sandbox").await?;
    let agent = create_subaccount(&sandbox, "agent.sandbox").await?;
    // An account without a contract: every ft_transfer to it fails.
    let token = create_subaccount(&sandbox, "token.sandbox").await?;
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

    let policy = json!({
        "version": 1, "principal": owner.account_id(), "agent": agent.account_id(),
        "token_id": token.account_id(), "whitelist": ["aibek.sandbox"],
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
    contract
        .call_function("register_agent", registration)
        .transaction()
        .with_signer(owner.account_id().clone(), signer.clone())
        .send_to(&network)
        .await?
        .assert_success();

    // The agent works with a function-call key that can call `propose_action` and nothing else. It
    // cannot attach NEAR, so the agent account prepays storage once with its full-access key.
    let fc_secret = near_api::signer::generate_secret_key()?;
    let fc_signer = near_api::Signer::from_secret_key(fc_secret.clone())?;
    agent
        .add_key(
            near_api::types::AccessKeyPermission::FunctionCall(
                near_api::types::transaction::actions::FunctionCallPermission {
                    allowance: Some(NearToken::from_near(1)),
                    receiver_id: contract.account_id().to_string(),
                    method_names: vec!["propose_action".into()],
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

    // ---- Deny: a receiver outside the whitelist. Recorded, nothing moves. ----------------------
    let denied = decide(action("mallory.sandbox", "1"), "0".into());
    assert_eq!(denied["decision"]["verdict"], "Deny");
    propose(denied.clone()).await?.assert_success();
    assert_eq!(status_of(&contract, &network, 0).await, "Denied");
    // The same decision a second time is refused.
    propose(denied.clone()).await?.assert_failure();
    // The signed decision cannot be reused for another action...
    let mut other_action = denied.clone();
    other_action["action"]["receiver_id"] = json!("aibek.sandbox");
    propose(other_action).await?.assert_failure();
    // ...and cannot be edited into an Allow.
    let mut edited = decide(action("mallory.sandbox", "2"), "0".into());
    edited["decision"]["verdict"] = json!("Allow");
    propose(edited).await?.assert_failure();

    // ---- NeedsApproval: above the threshold. Waits for the owner, who rejects. ------------------
    let big = decide(action("aibek.sandbox", "400000000"), "0".into());
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
    contract
        .call_function("reject", json!({ "action_id": 1 }))
        .transaction()
        .with_signer(owner.account_id().clone(), signer.clone())
        .send_to(&network)
        .await?
        .assert_success();
    assert_eq!(status_of(&contract, &network, 1).await, "Rejected");
    assert_eq!(agent_info(&contract, &network, &agent).await["spent_today"], "0");

    // ---- Allow: the contract sends ft_transfer; this "token" has no contract, so it fails, the
    // callback records that and the amount leaves the daily total again. ---------------------------
    let small = decide(action("aibek.sandbox", "100000000"), "0".into());
    assert_eq!(small["decision"]["verdict"], "Allow");
    propose(small).await?.assert_success();
    assert_eq!(status_of(&contract, &network, 2).await, "Failed");
    assert_eq!(agent_info(&contract, &network, &agent).await["spent_today"], "0");

    // ---- Stop button: a paused agent cannot propose. --------------------------------------------
    contract
        .call_function("pause_agent", json!({ "agent_id": agent.account_id() }))
        .transaction()
        .with_signer(owner.account_id().clone(), signer.clone())
        .send_to(&network)
        .await?
        .assert_success();
    assert_eq!(agent_info(&contract, &network, &agent).await["paused"], true);
    propose(decide(action("aibek.sandbox", "100000000"), "0".into())).await?.assert_failure();

    Ok(())
}
