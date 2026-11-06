//! Canonical JSON (SPEC §6.2): the one byte-exact form that is hashed and signed.
//!
//! Must match `packages/proof/src/canonical.ts`; shared vectors in `docs/test-vectors/canonical.json`. The writer
//! below is the same as `contracts/ainek/src/canonical.rs` (two crates, two targets, one algorithm; keep them
//! identical). Keys are sorted explicitly instead of relying on `serde_json::Value` being a `BTreeMap`: that holds
//! only while no dependency turns on serde_json's `preserve_order` feature, and a silent change of key order would
//! change every hash and signature.

use serde_json::Value;

/// Largest integer both JS (`Number.isSafeInteger`) and we accept as a JSON number.
const MAX_SAFE_INTEGER: i128 = 9_007_199_254_740_991;

pub fn canonical_json(value: &Value) -> Result<String, String> {
    let mut out = String::new();
    write(value, &mut out, "$")?;
    Ok(out)
}

fn write(value: &Value, out: &mut String, path: &str) -> Result<(), String> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            // Only safe integers: floats and bigger numbers print differently in JS and Rust.
            let i: i128 = if let Some(u) = n.as_u64() {
                u.into()
            } else if let Some(i) = n.as_i64() {
                i.into()
            } else {
                return Err(format!(
                    "{path}: only integers are allowed as JSON numbers (got {n})"
                ));
            };
            if i.abs() > MAX_SAFE_INTEGER {
                return Err(format!(
                    "{path}: integer {i} is outside the safe range (2^53-1)"
                ));
            }
            out.push_str(&i.to_string());
        }
        // serde_json escapes exactly like JSON.stringify: `"` `\` \b \f \n \r \t, other control
        // characters as lowercase \u00xx; `/` and non-ASCII stay raw.
        Value::String(s) => {
            out.push_str(&serde_json::to_string(s).expect("string is serializable"))
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, out, &format!("{path}[{i}]"))?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            // Rust `str` ordering is byte order == Unicode code point order, what the TS side uses.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).expect("key is serializable"));
                out.push(':');
                write(&map[key], out, &format!("{path}.{key}"))?;
            }
            out.push('}');
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    const VECTORS: &str = include_str!("../../../docs/test-vectors/canonical.json");

    /// Rust and TypeScript sign and hash the same bytes only if both reproduce every shared vector.
    #[test]
    fn reproduces_the_vectors_shared_with_typescript() {
        let file: Value = serde_json::from_str(VECTORS).unwrap();
        let vectors = file["vectors"].as_array().unwrap();
        assert!(vectors.len() >= 13, "vector file looks truncated");
        for v in vectors {
            let name = v["name"].as_str().unwrap();
            let canonical = canonical_json(&v["input"]).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(canonical, v["canonical"].as_str().unwrap(), "{name}");
            let digest = hex::encode(Sha256::digest(canonical.as_bytes()));
            assert_eq!(digest, v["sha256"].as_str().unwrap(), "{name}");
        }
    }

    /// JS prints 1e21 and 1.5 differently from Rust, so a signature over them would not verify on the other side.
    #[test]
    fn rejects_numbers_that_js_and_rust_print_differently() {
        for bad in [
            r#"{"x":1.5}"#,
            r#"{"x":1e21}"#,
            r#"{"x":9007199254740992}"#,
            r#"{"x":[{"y":-9007199254740992}]}"#,
        ] {
            let value: Value = serde_json::from_str(bad).unwrap();
            assert!(canonical_json(&value).is_err(), "{bad}");
        }
    }
}
