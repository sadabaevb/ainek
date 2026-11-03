//! Spike B (docs/prompts/day1-rust-spikes.md): the smallest OutLayer job.
//! stdin:  {"action":{"amount":"300"},"cap":"500"}
//! stdout: {"verdict":"Allow"} or {"verdict":"Deny"}
//!
//! WASI P1: the binary only has stdin, stdout, env and randomness — no network, no filesystem.
//! That is the whole point for the policy job (SPEC §3.5): the code has nowhere to send or
//! store its input. The full policy (whitelist, caps, signature) lands in session 4 (SPEC §6).

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
}

fn decide(input: &Input) -> Result<&'static str, String> {
    let amount: u128 = input
        .action
        .amount
        .parse()
        .map_err(|e| format!("bad amount: {e}"))?;
    let cap: u128 = input.cap.parse().map_err(|e| format!("bad cap: {e}"))?;
    Ok(if amount <= cap { "Allow" } else { "Deny" })
}

fn main() {
    let mut raw = String::new();
    io::stdin()
        .read_to_string(&mut raw)
        .expect("failed to read stdin");
    let input: Input = serde_json::from_str(&raw).expect("input is not valid JSON");

    let out = Output {
        verdict: decide(&input).expect("cannot decide"),
    };
    // Output must be <= 900 bytes (OutLayer/NEAR limit) and must be flushed explicitly:
    // without flush the WASI runtime may exit before stdout is written.
    print!("{}", serde_json::to_string(&out).unwrap());
    io::stdout().flush().unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
