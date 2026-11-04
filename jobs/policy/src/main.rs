//! Spike B (docs/prompts/day1-rust-spikes.md): the smallest OutLayer job.
//! stdin:  {"action":{"amount":"300"},"cap":"500"}
//! stdout: {"verdict":"Allow"} or {"verdict":"Deny"}
//!
//! WASI P1: the binary only has stdin, stdout, env and randomness — no network, no filesystem.
//! That is the whole point for the policy job (SPEC §3.5): the code has nowhere to send or
//! store its input. The full policy (whitelist, caps, signature) lands in session 4 (SPEC §6).
//!
//! Question (г) of the spike: when a `PROTECTED_SIGNING_KEY:ed25519` secret generated inside the
//! TEE is attached to the run, what does the env var contain, and can the job sign with it?
//! If the variable is present, the output also carries `key`: the value's shape (never the
//! value), the derived public key and a signature over a fixed message we verify offline.

use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

#[derive(Deserialize)]
struct Input {
    action: Action,
    /// Amounts are decimal strings (U128 convention from near-sdk), never JSON numbers.
    cap: String,
}

#[derive(Deserialize)]
struct Action {
    amount: String,
}

#[derive(Serialize)]
struct Output {
    verdict: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    key: Option<KeyProbe>,
}

/// What we learn about the injected key without ever printing it.
#[derive(Serialize)]
struct KeyProbe {
    len: usize,
    /// Text before the first ':' when the value has one (NEAR keys look like "ed25519:<base58>").
    prefix: Option<String>,
    /// Which decodings yield bytes, and how many: "hex=64", "b58=32", ...
    decodings: Vec<String>,
    /// Which decoding we used to sign, or why none worked.
    used: String,
    public_key: Option<String>,
    /// hex(ed25519 signature over `SIGNED_MESSAGE`), verifiable offline with the public key.
    signature: Option<String>,
}

const SIGNED_MESSAGE: &[u8] = b"ainek spike B";

fn decide(input: &Input) -> Result<&'static str, String> {
    let amount: u128 = input
        .action
        .amount
        .parse()
        .map_err(|e| format!("bad amount: {e}"))?;
    let cap: u128 = input.cap.parse().map_err(|e| format!("bad cap: {e}"))?;
    Ok(if amount <= cap { "Allow" } else { "Deny" })
}

/// Try the encodings OutLayer could plausibly use; take the first that gives 32 (seed) or
/// 64 (seed || public key, NEAR convention) bytes.
fn probe_key(value: &str) -> KeyProbe {
    use base64::Engine;
    let (prefix, body) = match value.split_once(':') {
        Some((p, rest)) => (Some(p.to_string()), rest),
        None => (None, value),
    };
    let candidates: Vec<(&str, Option<Vec<u8>>)> = vec![
        ("hex", hex::decode(body).ok()),
        ("b58", bs58::decode(body).into_vec().ok()),
        ("b64", base64::engine::general_purpose::STANDARD.decode(body).ok()),
        ("raw", Some(body.as_bytes().to_vec())),
    ];
    let decodings = candidates
        .iter()
        .filter_map(|(name, bytes)| bytes.as_ref().map(|b| format!("{name}={}", b.len())))
        .collect();
    let mut probe = KeyProbe { len: value.len(), prefix, decodings, used: "none".into(), public_key: None, signature: None };
    for (name, bytes) in candidates {
        let Some(bytes) = bytes else { continue };
        if bytes.len() != 32 && bytes.len() != 64 {
            continue;
        }
        let seed: [u8; 32] = bytes[..32].try_into().unwrap();
        let signing = SigningKey::from_bytes(&seed);
        let pk = signing.verifying_key().to_bytes();
        // 64 bytes in NEAR format = seed || public key; say whether the tail matches.
        let tail = if bytes.len() == 64 {
            if bytes[32..] == pk { ",tail=pubkey" } else { ",tail=other" }
        } else {
            ""
        };
        probe.used = format!("{name}{tail}");
        probe.public_key = Some(hex::encode(pk));
        probe.signature = Some(hex::encode(signing.sign(SIGNED_MESSAGE).to_bytes()));
        break;
    }
    probe
}

fn main() {
    let mut raw = String::new();
    io::stdin()
        .read_to_string(&mut raw)
        .expect("failed to read stdin");
    let input: Input = serde_json::from_str(&raw).expect("input is not valid JSON");

    let out = Output {
        verdict: decide(&input).expect("cannot decide"),
        key: std::env::var("PROTECTED_SIGNING_KEY").ok().map(|v| probe_key(&v)),
    };
    // Output must be <= 900 bytes (OutLayer/NEAR limit) and must be flushed explicitly:
    // without flush the WASI runtime may exit before stdout is written.
    print!("{}", serde_json::to_string(&out).unwrap());
    io::stdout().flush().unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    fn input(amount: &str, cap: &str) -> Input {
        Input {
            action: Action { amount: amount.into() },
            cap: cap.into(),
        }
    }

    #[test]
    fn allows_at_or_below_cap() {
        assert_eq!(decide(&input("300", "500")).unwrap(), "Allow");
        assert_eq!(decide(&input("500", "500")).unwrap(), "Allow");
    }

    #[test]
    fn denies_above_cap() {
        assert_eq!(decide(&input("501", "500")).unwrap(), "Deny");
    }

    #[test]
    fn rejects_non_numeric_amount() {
        // Fail closed: an unparseable amount is an error, never an Allow.
        assert!(decide(&input("3e2", "500")).is_err());
    }

    #[test]
    fn probe_signs_with_near_style_and_hex_keys_and_never_echoes_the_value() {
        let seed = [7u8; 32];
        let pk = SigningKey::from_bytes(&seed).verifying_key();
        let mut near = seed.to_vec();
        near.extend_from_slice(pk.as_bytes());
        let near_value = format!("ed25519:{}", bs58::encode(&near).into_string());

        for value in [near_value.as_str(), &hex::encode(seed)] {
            let p = probe_key(value);
            assert_eq!(p.public_key.as_deref(), Some(hex::encode(pk.as_bytes()).as_str()));
            let json = serde_json::to_string(&p).unwrap();
            let sig = Signature::from_slice(&hex::decode(p.signature.unwrap()).unwrap()).unwrap();
            VerifyingKey::from_bytes(pk.as_bytes()).unwrap().verify(SIGNED_MESSAGE, &sig).unwrap();
            assert!(!json.contains(value.split(':').last().unwrap()), "secret leaked into output");
        }
        assert_eq!(probe_key(&near_value).used, "b58,tail=pubkey");
        assert_eq!(probe_key("not-a-key").used, "none");
    }
}
