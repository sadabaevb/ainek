//! Integration test: deploys the real wasm into a local NEAR sandbox node and calls it the same
//! way near-cli / near-api-js would on testnet.

use near_api::{AccountId, NearToken};
use near_sdk::serde_json::json;

#[derive(near_sdk::serde::Deserialize, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct Head {
    pub index: u64,
    pub entry: String,
}

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

#[tokio::test]
async fn log_key_then_head_on_sandbox() -> testresult::TestResult<()> {
    let wasm_path = cargo_near_build::build_with_cli(Default::default())?;
    let wasm = std::fs::read(wasm_path)?;

    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let verifier = create_subaccount(&sandbox, "v1.sandbox").await?;
    let contract = create_subaccount(&sandbox, "ainek.sandbox").await?.as_contract();
    // Sandbox-created accounts share the genesis key, so one signer works for all of them.
    let signer = near_api::Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse().unwrap(),
    )?;

    // No init call: the contract state starts from `Default`.
    near_api::Contract::deploy(contract.account_id().clone())
        .use_code(wasm)
        .without_init_call()
        .with_signer(signer.clone())
        .send_to(&network)
        .await?
        .assert_success();

    let empty: Option<Head> = contract
        .call_function("head", ())
        .read_only()
        .fetch_from(&network)
        .await?
        .data;
    assert_eq!(empty, None);

    for entry in ["key-a", "key-b"] {
        contract
            .call_function("log_key", json!({ "entry": entry }))
            .transaction()
            .with_signer(verifier.account_id().clone(), signer.clone())
            .send_to(&network)
            .await?
            .assert_success();
    }

    let head: Option<Head> = contract
        .call_function("head", ())
        .read_only()
        .fetch_from(&network)
        .await?
        .data;
    assert_eq!(head, Some(Head { index: 1, entry: "key-b".into() }));

    Ok(())
}
