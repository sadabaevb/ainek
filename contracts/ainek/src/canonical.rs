//! Canonical JSON (SPEC §6.2): the one byte-exact serialisation hashed on both sides.
//! Must match `packages/proof/src/canonical.ts`; vectors in `docs/test-vectors/canonical.json`.
//!
//! Why not just `serde_json::to_string(&Value)`: near-sdk's dependency tree turns on serde_json's
//! `preserve_order` feature, so `Value::Object` keeps insertion order instead of sorting keys.
//! Cargo feature unification makes that apply to our crate too, so we sort explicitly here.

use near_sdk::serde_json::{self, Value};

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
                return Err(format!("{path}: only integers are allowed as JSON numbers (got {n})"));
            };
            if i.abs() > MAX_SAFE_INTEGER {
                return Err(format!("{path}: integer {i} is outside the safe range (2^53-1)"));
            }
            out.push_str(&i.to_string());
        }
        // serde_json escapes exactly like JSON.stringify: `"` `\` \b \f \n \r \t, other control
        // characters as lowercase \u00xx; `/` and non-ASCII stay raw.
        Value::String(s) => out.push_str(&serde_json::to_string(s).expect("string is serializable")),
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
    use near_sdk::env;

    const VECTORS: &str = include_str!("../../../docs/test-vectors/canonical.json");

    #[test]
    fn matches_shared_test_vectors_byte_for_byte() {
        let doc: Value = serde_json::from_str(VECTORS).unwrap();
        let vectors = doc["vectors"].as_array().unwrap();
        assert!(vectors.len() >= 10, "vector file looks truncated");
        for v in vectors {
            let name = v["name"].as_str().unwrap();
            let canonical = canonical_json(&v["input"]).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(canonical, v["canonical"].as_str().unwrap(), "canonical bytes differ: {name}");
            let digest = hex::encode(env::sha256(canonical.as_bytes()));
            assert_eq!(digest, v["sha256"].as_str().unwrap(), "sha256 differs: {name}");
        }
    }

    #[test]
    fn rejects_floats_and_unsafe_integers() {
        // If these were accepted, Rust and JS would hash different bytes for the same document.
        assert!(canonical_json(&serde_json::json!({"x": 1.5})).is_err());
        assert!(canonical_json(&serde_json::json!({"x": 9007199254740992u64})).is_err());
        assert!(canonical_json(&serde_json::json!({"x": 9007199254740991u64})).is_ok());
    }
}
