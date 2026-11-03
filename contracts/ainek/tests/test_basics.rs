//! Integration test: deploys the real wasm into a local NEAR sandbox node and drives it the way
//! the verifier (change calls) and the client (view calls) will on testnet.

use near_api::{AccountId, NearToken};
use near_sdk::serde_json::{self, json, Value};

const VECTORS: &str = include_str!("../../../docs/test-vectors/canonical.json");

async fn create_subaccount(
    sandbox: &near_sandbox::Sandbox,
    name: &str,
) -> testresult::TestResult<near_api::Account> {
    let account_id: AccountId = name.parse().unwrap();
    sandbox
        .create_account(account_id.clone())
        .initial_balance(NearToken::from_near(10))
        .send()
        .await?;
    Ok(near_api::Account(account_id))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[tokio::test]
async fn key_log_end_to_end_on_sandbox() -> testresult::TestResult<()> {
    let wasm_path = cargo_near_build::build_with_cli(Default::default())?;
    let wasm = std::fs::read(wasm_path)?;

    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let owner = create_subaccount(&sandbox, "owner.sandbox").await?;
    let v1 = create_subaccount(&sandbox, "v1.sandbox").await?;
    let mallory = create_subaccount(&sandbox, "mallory.sandbox").await?;
    let contract = create_subaccount(&sandbox, "ainek.sandbox").await?.as_contract();
    // Sandbox-created accounts share the genesis key, so one signer works for all of them.
    let signer = near_api::Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse().unwrap(),
    )?;

    // Deploy and initialize in one transaction, as `cargo near deploy ... with-init-call` does.
    near_api::Contract::deploy(contract.account_id().clone())
        .use_code(wasm)
        .with_init_call("new", json!({ "owner": owner.account_id() }))?
        .with_signer(signer.clone())
        .send_to(&network)
        .await?
        .assert_success();

    // Empty log: head is null, latest_keys is empty — the client would refuse to send.
    let head: Value = contract.call_function("head", ()).read_only().fetch_from(&network).await?.data;
    assert!(head.is_null());

    // Only the owner registers verifiers.
    contract
        .call_function("register_verifier", json!({ "account_id": v1.account_id() }))
        .transaction()
        .with_signer(mallory.account_id().clone(), signer.clone())
        .send_to(&network)
        .await?
        .assert_failure();
    contract
        .call_function("register_verifier", json!({ "account_id": v1.account_id() }))
        .transaction()
        .with_signer(owner.account_id().clone(), signer.clone())
        .send_to(&network)
        .await?
        .assert_success();

    // The recorded KeyEntryInput from the shared vectors, observed "now" so it is inside a 24 h window.
    let doc: Value = serde_json::from_str(VECTORS)?;
    let mut input = doc["commits"]["entry_hash"]["input"].clone();
    input["observed_at"] = Value::String(now_ms().to_string());
    let model = input["model"].as_str().unwrap().to_string();

    // Only a registered verifier may log.
    contract
        .call_function("log_key", json!({ "entry": input }))
        .transaction()
        .with_signer(mallory.account_id().clone(), signer.clone())
        .send_to(&network)
        .await?
        .assert_failure();
    for _ in 0..2 {
        contract
            .call_function("log_key", json!({ "entry": input }))
            .transaction()
            .with_signer(v1.account_id().clone(), signer.clone())
            .send_to(&network)
            .await?
            .assert_success();
    }

    // The four views the client relies on (apps/demo check-contract).
    let head: Value = contract.call_function("head", ()).read_only().fetch_from(&network).await?.data;
    assert_eq!(head["index"], 1);
    assert_eq!(head["entry_hash"].as_str().unwrap().len(), 64);

    let since: Vec<Value> = contract
        .call_function("entries_since", json!({ "index": 0, "limit": 10 }))
        .read_only()
        .fetch_from(&network)
        .await?
        .data;
    assert_eq!(since.len(), 2);
    assert_eq!(since[0]["prev_hash"], "");
    assert_eq!(since[1]["prev_hash"], since[0]["entry_hash"]);
    assert_eq!(since[1]["verifier"], v1.account_id().to_string());
    assert!(since[1]["block_height"].as_u64().unwrap() > 0);
    // observed_at is a near-sdk U64: a decimal string, not a number.
    assert!(since[0]["observed_at"].is_string());

    let entry: Value = contract
        .call_function("entry", json!({ "index": 1 }))
        .read_only()
        .fetch_from(&network)
        .await?
        .data;
    assert_eq!(entry, since[1]);

    let latest: Vec<Value> = contract
        .call_function("latest_keys", json!({ "model": model, "max_age_ns": "86400000000000" }))
        .read_only()
        .fetch_from(&network)
        .await?
        .data;
    assert_eq!(latest.len(), 2, "both fresh entries for the model are current");
    assert_eq!(latest[0]["index"], 1, "newest first");

    let stale: Vec<Value> = contract
        .call_function("latest_keys", json!({ "model": model, "max_age_ns": "1" }))
        .read_only()
        .fetch_from(&network)
        .await?
        .data;
    assert!(stale.is_empty(), "a 1 ns window admits nothing: fail-closed on age");

    Ok(())
}
