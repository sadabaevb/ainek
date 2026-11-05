//! Ainek policy job for OutLayer (SPEC §3.5, §6): decides whether the agent's action fits the owner's policy and
//! signs the decision with a key that exists only inside the TEE.
//!
//! stdin:  {"action": Action, "model_proof_commit": "<hex>", "spent_today": "<U128>", "now": <unix ms>}
//! stdout: {"decision": Decision, "sig": "<base64>", "pubkey": "<hex>", "wasm_hash": "<hex>"}   (<= 900 bytes)
//!
//! WASI P1: the binary only has stdin, stdout and env — no network, no filesystem, so the code has nowhere to
//! send or store the policy. OutLayer passes secrets as environment variables:
//!   POLICY_JSON        the owner's policy (§6.1). Never printed, never on-chain; only its hash is public.
//!   PROTECTED_ED25519  `ed25519:<base58 seed>`, generated inside the TEE. Only the public key is printed.
//!   WASM_HASH          sha256 of this build, set at deploy time next to the other two (docs/DEPLOY.md). A WASI P1
//!                      module cannot hash itself; the field is outside the signature, and the authority on which
//!                      build ran is OutLayer's attestation, not this echo.
//!
//! The input is public (it sits in the `execution_requested` event on NEAR), so nothing secret may go through
//! stdin. Any malformed input, policy or key ends the job with an error and no decision: fail closed.

mod canonical;

use base64::Engine;
use canonical::canonical_json;
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};

/// A decision is valid for ten minutes after the `now` it was made for (§6.2).
const DECISION_LIFETIME_MS: u64 = 600_000;
/// OutLayer returns at most this much of stdout to the caller.
const MAX_OUTPUT_BYTES: usize = 900;

/// SPEC §6.1, strictly: a misspelt or missing field is an error, not a default.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    /// u32 like `policy_version` in the contract (§4.3): a larger number could be signed but never submitted.
    version: u32,
    #[serde(rename = "principal")]
    _principal: String,
    #[serde(rename = "agent")]
    _agent: String,
    token_id: String,
    whitelist: Vec<String>,
    caps: Caps,
    needs_approval_above: String,
    deny_new_receivers: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Caps {
    per_action: String,
    per_day: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    /// Kept as raw JSON as well: `action_commit` must cover exactly what the caller sent.
    action: Value,
    model_proof_commit: String,
    spent_today: String,
    now: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Action {
    kind: String,
    token_id: String,
    receiver_id: String,
    amount: String,
    #[serde(rename = "memo")]
    _memo: String,
}

#[derive(Debug, PartialEq, Serialize)]
enum Verdict {
    Allow,
    Deny,
    NeedsApproval,
}

/// SPEC §4.3. U64 travels as a decimal string, as near-sdk serialises it.
#[derive(Serialize)]
struct Decision {
    verdict: Verdict,
    policy_hash: String,
    policy_version: u32,
    action_commit: String,
    model_proof_commit: String,
    nonce: String,
    expires_at: String,
}

struct Secrets<'a> {
    policy_json: &'a str,
    signing_key: &'a str,
    wasm_hash: &'a str,
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A near-sdk U128 exactly as near-sdk prints it: decimal digits, no sign, no leading zeros. `str::parse` alone
/// would take "+5" and "007"; the contract re-serialises the amount, so "007" would hash to a different
/// `action_commit` there and the signed decision could never be used.
fn parse_u128(s: &str, what: &str) -> Result<u128, String> {
    let digits = !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits || (s.len() > 1 && s.starts_with('0')) {
        return Err(format!("{what} is not a decimal string"));
    }
    s.parse()
        .map_err(|_| format!("{what} does not fit in 128 bits"))
}

/// The policy logic of §6.2. Errors (never an Allow) for anything that cannot be read as a number.
fn decide(policy: &Policy, action: &Action, spent_today: u128) -> Result<Verdict, String> {
    let amount = parse_u128(&action.amount, "action.amount")?;
    let per_action = parse_u128(&policy.caps.per_action, "policy caps.per_action")?;
    let per_day = parse_u128(&policy.caps.per_day, "policy caps.per_day")?;
    let approval_above = parse_u128(&policy.needs_approval_above, "policy needs_approval_above")?;

    // Not a transfer of the policy's token. A zero amount is refused by every NEP-141 token anyway.
    if action.kind != "ft_transfer" || action.token_id != policy.token_id || amount == 0 {
        return Ok(Verdict::Deny);
    }
    // A receiver outside the whitelist is denied outright when the owner said so; otherwise a human decides.
    let known_receiver = policy.whitelist.iter().any(|r| r == &action.receiver_id);
    if !known_receiver && policy.deny_new_receivers {
        return Ok(Verdict::Deny);
    }
    if amount > per_action {
        return Ok(Verdict::Deny);
    }
    // An overflowing sum is over any cap.
    if spent_today
        .checked_add(amount)
        .is_none_or(|total| total > per_day)
    {
        return Ok(Verdict::Deny);
    }
    Ok(if !known_receiver || amount > approval_above {
        Verdict::NeedsApproval
    } else {
        Verdict::Allow
    })
}

/// `ed25519:<base58>` of the 32-byte seed (what OutLayer generates) or of seed || public key (NEAR's format).
/// Error texts never contain the value.
fn signing_key(value: &str) -> Result<SigningKey, String> {
    let body = value.strip_prefix("ed25519:").unwrap_or(value);
    let bytes = bs58::decode(body)
        .into_vec()
        .map_err(|_| "PROTECTED_ED25519 is not base58".to_string())?;
    if bytes.len() != 32 && bytes.len() != 64 {
        return Err("PROTECTED_ED25519 must decode to 32 or 64 bytes".into());
    }
    let seed: [u8; 32] = bytes[..32].try_into().expect("length checked above");
    let key = SigningKey::from_bytes(&seed);
    if bytes.len() == 64 && bytes[32..] != key.verifying_key().to_bytes() {
        return Err("PROTECTED_ED25519: the public half does not match the seed".into());
    }
    Ok(key)
}

/// The whole job as a pure function of stdin and the secrets: the same input always gives the same output.
fn run(stdin: &str, secrets: &Secrets) -> Result<String, String> {
    // Error texts may end up in a public job log, so serde's messages (which can quote values) are not passed on
    // for the policy.
    let policy_value: Value = serde_json::from_str(secrets.policy_json)
        .map_err(|_| "POLICY_JSON is not valid JSON".to_string())?;
    let policy = Policy::deserialize(&policy_value)
        .map_err(|_| "POLICY_JSON does not match the policy schema (SPEC §6.1)".to_string())?;
    let policy_hash = sha256_hex(
        canonical_json(&policy_value)
            .map_err(|_| "POLICY_JSON holds a number that is not a safe integer".to_string())?
            .as_bytes(),
    );
    // Trimmed: the secrets are locked to the build, so a stray newline from a shell would cost a redeploy.
    let wasm_hash = secrets.wasm_hash.trim();
    if !is_hex64(wasm_hash) {
        return Err("WASM_HASH must be 64 lowercase hex characters".into());
    }
    let key = signing_key(secrets.signing_key.trim())?;

    let input: Input = serde_json::from_str(stdin).map_err(|e| format!("input: {e}"))?;
    let action = Action::deserialize(&input.action).map_err(|e| format!("input.action: {e}"))?;
    if !is_hex64(&input.model_proof_commit) {
        return Err("input.model_proof_commit must be 64 lowercase hex characters".into());
    }
    let spent_today = parse_u128(&input.spent_today, "input.spent_today")?;
    let expires_at = input
        .now
        .checked_add(DECISION_LIFETIME_MS)
        .ok_or("input.now is out of range")?;

    let action_commit = sha256_hex(canonical_json(&input.action)?.as_bytes());
    let decision = Decision {
        verdict: decide(&policy, &action, spent_today)?,
        policy_hash,
        policy_version: policy.version,
        // `now` and `spent_today` come from the agent, the party this policy restrains, and are not fields of the
        // decision. Folding them into the nonce lets the contract recompute it from its own clock and its own
        // tally, and refuse a decision that was made for a made-up "nothing spent yet".
        nonce: sha256_hex(
            format!("{action_commit}:{}:{}", input.now, input.spent_today).as_bytes(),
        ),
        action_commit,
        model_proof_commit: input.model_proof_commit,
        expires_at: expires_at.to_string(),
    };
    let decision = serde_json::to_value(&decision).map_err(|e| e.to_string())?;
    let signature = key.sign(canonical_json(&decision)?.as_bytes());

    let output = canonical_json(&serde_json::json!({
        "decision": decision,
        "sig": base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
        "pubkey": hex::encode(key.verifying_key().to_bytes()),
        "wasm_hash": wasm_hash,
    }))?;
    if output.len() > MAX_OUTPUT_BYTES {
        return Err(format!(
            "output is {} bytes, over the {MAX_OUTPUT_BYTES}-byte limit",
            output.len()
        ));
    }
    Ok(output)
}

fn secret(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("{name} is not set (docs/DEPLOY.md)"))
}

fn try_main() -> Result<String, String> {
    let mut stdin = String::new();
    io::stdin()
        .read_to_string(&mut stdin)
        .map_err(|e| format!("cannot read stdin: {e}"))?;
    let (policy_json, signing_key, wasm_hash) = (
        secret("POLICY_JSON")?,
        secret("PROTECTED_ED25519")?,
        secret("WASM_HASH")?,
    );
    run(
        &stdin,
        &Secrets {
            policy_json: &policy_json,
            signing_key: &signing_key,
            wasm_hash: &wasm_hash,
        },
    )
}

fn main() {
    match try_main() {
        Ok(output) => {
            // Flushed explicitly: without it the WASI runtime may exit before stdout is written.
            print!("{output}");
            io::stdout().flush().expect("cannot write stdout");
        }
        Err(error) => {
            eprintln!("ainek-policy: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    const SEED: [u8; 32] = [7u8; 32];
    const WASM_HASH: &str = "abababababababababababababababababababababababababababababababab";
    const COMMIT: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
    const NOW: u64 = 1_762_200_000_000;

    /// The policy of SPEC §6.1: 500 per action, 2000 per day, approval above 300 (6 decimals).
    fn policy_json(deny_new_receivers: bool) -> String {
        format!(
            r#"{{"version":3,"principal":"owner.ainek.testnet","agent":"agent.ainek.testnet","token_id":"token.ainek.testnet",
            "whitelist":["aibek.testnet","vendor1.testnet"],"caps":{{"per_action":"500000000","per_day":"2000000000"}},
            "needs_approval_above":"300000000","deny_new_receivers":{deny_new_receivers}}}"#
        )
    }

    fn key_value() -> String {
        format!("ed25519:{}", bs58::encode(SEED).into_string())
    }

    fn action(receiver: &str, amount: &str) -> Action {
        Action {
            kind: "ft_transfer".into(),
            token_id: "token.ainek.testnet".into(),
            receiver_id: receiver.into(),
            amount: amount.into(),
            _memo: "October".into(),
        }
    }

    fn verdict(
        deny_new_receivers: bool,
        receiver: &str,
        amount: &str,
        spent_today: u128,
    ) -> Verdict {
        let policy: Policy = serde_json::from_str(&policy_json(deny_new_receivers)).unwrap();
        decide(&policy, &action(receiver, amount), spent_today).unwrap()
    }

    fn input(receiver: &str, amount: &str, spent_today: &str) -> String {
        format!(
            r#"{{"action":{{"kind":"ft_transfer","token_id":"token.ainek.testnet","receiver_id":"{receiver}","amount":"{amount}","memo":"October"}},"model_proof_commit":"{COMMIT}","spent_today":"{spent_today}","now":{NOW}}}"#
        )
    }

    fn run_with(stdin: &str, policy_json: &str) -> Result<String, String> {
        run(
            stdin,
            &Secrets {
                policy_json,
                signing_key: &key_value(),
                wasm_hash: WASM_HASH,
            },
        )
    }

    #[test]
    fn small_payment_to_a_whitelisted_receiver_is_allowed() {
        assert_eq!(
            verdict(true, "aibek.testnet", "100000000", 0),
            Verdict::Allow
        );
        // The approval threshold is "above", so exactly 300 still goes through on its own.
        assert_eq!(
            verdict(true, "aibek.testnet", "300000000", 0),
            Verdict::Allow
        );
    }

    #[test]
    fn above_the_approval_threshold_a_human_decides() {
        assert_eq!(
            verdict(true, "aibek.testnet", "300000001", 0),
            Verdict::NeedsApproval
        );
        assert_eq!(
            verdict(true, "aibek.testnet", "500000000", 0),
            Verdict::NeedsApproval
        );
    }

    #[test]
    fn over_the_per_action_cap_is_denied_not_sent_for_approval() {
        // A cap is a hard limit: the owner's approval must not be able to lift it.
        assert_eq!(
            verdict(true, "aibek.testnet", "500000001", 0),
            Verdict::Deny
        );
    }

    #[test]
    fn the_daily_cap_counts_what_was_already_spent() {
        assert_eq!(
            verdict(true, "aibek.testnet", "100000000", 1_900_000_000),
            Verdict::Allow
        );
        assert_eq!(
            verdict(true, "aibek.testnet", "100000001", 1_900_000_000),
            Verdict::Deny
        );
        // A sum that overflows u128 is over any cap, not a wrap-around back to zero.
        assert_eq!(
            verdict(true, "aibek.testnet", "1", u128::MAX),
            Verdict::Deny
        );
    }

    #[test]
    fn a_receiver_outside_the_whitelist_never_gets_an_allow() {
        // deny_new_receivers: refused outright, however small the amount.
        assert_eq!(verdict(true, "mallory.testnet", "1", 0), Verdict::Deny);
        // Without it the owner is asked, even below the approval threshold...
        assert_eq!(
            verdict(false, "mallory.testnet", "1", 0),
            Verdict::NeedsApproval
        );
        // ...and the caps still hold.
        assert_eq!(
            verdict(false, "mallory.testnet", "500000001", 0),
            Verdict::Deny
        );
    }

    #[test]
    fn another_token_or_another_kind_of_action_is_denied() {
        let policy: Policy = serde_json::from_str(&policy_json(true)).unwrap();
        let mut other_token = action("aibek.testnet", "1");
        other_token.token_id = "other.testnet".into();
        assert_eq!(decide(&policy, &other_token, 0).unwrap(), Verdict::Deny);
        let mut other_kind = action("aibek.testnet", "1");
        other_kind.kind = "ft_transfer_call".into();
        assert_eq!(decide(&policy, &other_kind, 0).unwrap(), Verdict::Deny);
    }

    #[test]
    fn unreadable_numbers_end_in_an_error_never_in_an_allow() {
        let policy: Policy = serde_json::from_str(&policy_json(true)).unwrap();
        for amount in [
            "3e2",
            "-1",
            "+5",
            "",
            "1.0",
            "340282366920938463463374607431768211456",
        ] {
            assert!(
                decide(&policy, &action("aibek.testnet", amount), 0).is_err(),
                "{amount:?}"
            );
        }
        assert!(run_with(&input("aibek.testnet", "1", "lots"), &policy_json(true)).is_err());
    }

    /// The agent supplies `spent_today` and `now` itself. They are bound into the nonce so that the contract, which
    /// keeps its own tally and clock, can tell a decision made for the real numbers from one made for invented ones.
    #[test]
    fn the_nonce_binds_what_the_agent_claimed_about_time_and_spending() {
        let nonce = |stdin: String| -> String {
            let out: Value =
                serde_json::from_str(&run_with(&stdin, &policy_json(true)).unwrap()).unwrap();
            out["decision"]["nonce"].as_str().unwrap().to_string()
        };
        let honest = nonce(input("aibek.testnet", "100000000", "1900000000"));
        assert_ne!(honest, nonce(input("aibek.testnet", "100000000", "0")));
        let a_millisecond_later = input("aibek.testnet", "100000000", "1900000000")
            .replace(&NOW.to_string(), &(NOW + 1).to_string());
        assert_ne!(honest, nonce(a_millisecond_later));
        assert_eq!(
            honest,
            nonce(input("aibek.testnet", "100000000", "1900000000"))
        );
    }

    /// The contract parses the amount and prints it again before hashing the action. An amount it would print
    /// differently must not get a signed decision at all; a zero transfer is refused by the token.
    #[test]
    fn amounts_the_contract_would_reprint_or_the_token_would_refuse_get_no_allow() {
        let policy = policy_json(true);
        assert!(run_with(&input("aibek.testnet", "0300000000", "0"), &policy).is_err());
        assert!(run_with(&input("aibek.testnet", "1", "00"), &policy).is_err());
        assert_eq!(verdict(true, "aibek.testnet", "0", 0), Verdict::Deny);
    }

    /// A typo in the owner's policy must stop the job, not silently relax the policy.
    #[test]
    fn a_policy_with_a_misspelt_missing_or_oversized_field_is_refused() {
        let good = input("aibek.testnet", "1", "0");
        let policy = policy_json(true);
        let refused = |broken: String| run_with(&good, &broken).is_err();
        assert!(!refused(policy.clone()));
        assert!(refused(
            policy.replace("deny_new_receivers", "deny_new_receiver")
        ));
        assert!(refused(policy.replace(
            r#""deny_new_receivers":true"#,
            r#""deny_new_receivers":true,"deny_new_receiver":false"#
        )));
        assert!(refused(
            policy.replace(r#""principal":"owner.ainek.testnet","#, "")
        ));
        assert!(refused(policy.replace(
            r#""per_day":"2000000000""#,
            r#""per_day":"2000000000","per_week":"1""#
        )));
        // policy_version is u32 in the contract: a decision with a larger one could never be submitted.
        assert!(refused(
            policy.replace(r#""version":3"#, r#""version":4294967296"#)
        ));
    }

    /// What the contract and the agent rely on (SPEC §4.3, §6.2): every field of the decision is derived as
    /// specified, and the signature verifies over canonical_bytes(decision) under the printed public key.
    #[test]
    fn the_decision_is_derived_as_specified_and_signed_over_its_canonical_bytes() {
        let stdin = input("aibek.testnet", "300000000", "0");
        let raw = run_with(&stdin, &policy_json(true)).unwrap();
        let out: Value = serde_json::from_str(&raw).unwrap();
        let d = &out["decision"];

        assert_eq!(d["verdict"], "Allow");
        assert_eq!(d["policy_version"], 3);
        let policy: Value = serde_json::from_str(&policy_json(true)).unwrap();
        assert_eq!(
            d["policy_hash"],
            sha256_hex(canonical_json(&policy).unwrap().as_bytes())
        );
        let sent: Value = serde_json::from_str(&stdin).unwrap();
        let action_commit = sha256_hex(canonical_json(&sent["action"]).unwrap().as_bytes());
        assert_eq!(d["action_commit"], action_commit);
        assert_eq!(d["model_proof_commit"], COMMIT);
        assert_eq!(
            d["nonce"],
            sha256_hex(format!("{action_commit}:{NOW}:0").as_bytes())
        );
        assert_eq!(d["expires_at"], (NOW + 600_000).to_string());
        assert_eq!(out["wasm_hash"], WASM_HASH);

        let pubkey: [u8; 32] = hex::decode(out["pubkey"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(
            pubkey,
            SigningKey::from_bytes(&SEED).verifying_key().to_bytes()
        );
        let sig = base64::engine::general_purpose::STANDARD
            .decode(out["sig"].as_str().unwrap())
            .unwrap();
        let signed = canonical_json(d).unwrap();
        VerifyingKey::from_bytes(&pubkey)
            .unwrap()
            .verify(signed.as_bytes(), &Signature::from_slice(&sig).unwrap())
            .unwrap();
    }

    /// `action_commit` is what the contract recomputes in propose_action, so it must match the vector TypeScript
    /// is tested against, whatever order the caller's keys came in.
    #[test]
    fn action_commit_matches_the_shared_vector() {
        let vectors: Value =
            serde_json::from_str(include_str!("../../../docs/test-vectors/canonical.json"))
                .unwrap();
        let v = &vectors["commits"]["action_commit"];
        let stdin = serde_json::json!({ "action": v["action"], "model_proof_commit": COMMIT, "spent_today": "0", "now": NOW }).to_string();
        let out: Value =
            serde_json::from_str(&run_with(&stdin, &policy_json(false)).unwrap()).unwrap();
        assert_eq!(out["decision"]["action_commit"], v["sha256"]);
    }

    /// The agent and the contract are written against these outputs (docs/test-vectors/policy-decision.json).
    /// A change in any derived field or in the signed bytes must show up here first.
    #[test]
    fn reproduces_the_recorded_outputs_byte_for_byte() {
        let file: Value = serde_json::from_str(include_str!(
            "../../../docs/test-vectors/policy-decision.json"
        ))
        .unwrap();
        let cases = file["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 4);
        for case in cases {
            let secrets = Secrets {
                policy_json: &file["policy"].to_string(),
                signing_key: file["protected_ed25519"].as_str().unwrap(),
                wasm_hash: file["wasm_hash"].as_str().unwrap(),
            };
            let output = run(&case["input"].to_string(), &secrets).unwrap();
            assert_eq!(
                output,
                canonical_json(&case["output"]).unwrap(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn the_same_input_always_gives_the_same_output() {
        let stdin = input("aibek.testnet", "400000000", "100");
        assert_eq!(
            run_with(&stdin, &policy_json(true)).unwrap(),
            run_with(&stdin, &policy_json(true)).unwrap()
        );
        // The policy hash covers the policy's content, not how its JSON happened to be laid out.
        let reordered = r#"{"deny_new_receivers":true,"needs_approval_above":"300000000","caps":{"per_day":"2000000000","per_action":"500000000"},
            "whitelist":["aibek.testnet","vendor1.testnet"],"token_id":"token.ainek.testnet","agent":"agent.ainek.testnet","principal":"owner.ainek.testnet","version":3}"#;
        assert_eq!(
            run_with(&stdin, reordered).unwrap(),
            run_with(&stdin, &policy_json(true)).unwrap()
        );
    }

    #[test]
    fn the_output_fits_outlayers_900_bytes_at_its_longest() {
        // The longest verdict, the largest version the contract takes, the largest timestamp canonical JSON allows.
        let policy = policy_json(false).replace(r#""version":3"#, r#""version":4294967295"#);
        let stdin =
            input("mallory.testnet", "1", "0").replace(&NOW.to_string(), "9007199254740991");
        let out = run_with(&stdin, &policy).unwrap();
        assert!(out.contains("NeedsApproval"));
        assert!(out.len() <= MAX_OUTPUT_BYTES, "{} bytes", out.len());
    }

    /// The point of running in a TEE: nothing about the policy or the key leaves except the hash and the public key.
    #[test]
    fn neither_the_policy_nor_the_key_leaks_into_the_output_or_the_errors() {
        let key = key_value();
        let secret_key_text = key.strip_prefix("ed25519:").unwrap();
        let out = run_with(&input("aibek.testnet", "1", "0"), &policy_json(true)).unwrap();
        for secret in [
            secret_key_text,
            "vendor1.testnet",
            "2000000000",
            "500000000",
            "owner.ainek.testnet",
        ] {
            assert!(!out.contains(secret), "{secret} leaked into the output");
        }
        let broken_policy =
            policy_json(true).replace(r#""per_day":"2000000000""#, r#""per_day":"2000000000x""#);
        let error = run_with(&input("aibek.testnet", "1", "0"), &broken_policy).unwrap_err();
        assert!(!error.contains("2000000000"), "{error}");
        let truncated_policy = &policy_json(true)[..120];
        let error = run_with(&input("aibek.testnet", "1", "0"), truncated_policy).unwrap_err();
        assert!(
            !error.contains("aibek") && !error.contains("owner"),
            "{error}"
        );
        let error = run(
            &input("aibek.testnet", "1", "0"),
            &Secrets {
                policy_json: &policy_json(true),
                signing_key: "ed25519:not-base58-0OIl",
                wasm_hash: WASM_HASH,
            },
        )
        .unwrap_err();
        assert!(!error.contains("0OIl"), "{error}");
    }

    #[test]
    fn malformed_input_or_secrets_produce_no_decision() {
        let good = input("aibek.testnet", "1", "0");
        let policy = policy_json(true);
        // An unknown field is refused rather than silently left out of what gets signed.
        assert!(run_with(
            &good.replace(r#""memo":"October""#, r#""memo":"October","extra":1"#),
            &policy
        )
        .is_err());
        assert!(run_with(&good.replace(COMMIT, "xyz"), &policy).is_err());
        assert!(run_with(
            &good.replace(&NOW.to_string(), "18446744073709551615"),
            &policy
        )
        .is_err());
        assert!(run_with("", &policy).is_err());
        assert!(run_with(&good, r#"{"version":3}"#).is_err());
        let secrets = |signing_key: &str, wasm_hash: &str| {
            run(
                &good,
                &Secrets {
                    policy_json: &policy,
                    signing_key,
                    wasm_hash,
                },
            )
        };
        assert!(secrets("ed25519:abc", WASM_HASH).is_err());
        assert!(secrets("", WASM_HASH).is_err());
        let near_format_with_wrong_public_half = bs58::encode([7u8; 64]).into_string();
        assert!(secrets(&near_format_with_wrong_public_half, WASM_HASH).is_err());
        let key = key_value();
        assert!(secrets(&key, "ABAB").is_err());
        assert!(secrets(&key, WASM_HASH).is_ok());
        // A newline picked up from a shell must not cost a redeploy of build-locked secrets.
        assert!(secrets(&format!("{key}\n"), &format!("{WASM_HASH}\n")).is_ok());
    }
}
