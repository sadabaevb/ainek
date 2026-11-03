# @ainek/proof

Shared TypeScript for everything that gets hashed, signed or checked locally (SPEC §3.7, §4.1–4.3, §5, §6.2).
Used by the web client (proof card, `/verify`, replay mode), the verifier and the agent. No build step: source
TS is the entry point; Node 24 runs it directly, Next.js transpiles it via `transpilePackages`.

```
pnpm -F @ainek/proof test        # node:test, 34 tests, runs on docs/samples + docs/test-vectors
pnpm -F @ainek/proof typecheck
```

| Export | What it does |
| --- | --- |
| `canonicalJson(value)` / `canonicalBytes(value)` | the one deterministic serialisation both sides hash (rules in `src/canonical.ts`, vectors in `docs/test-vectors/canonical.json`) |
| `sha256Hex(bytes \| string)`, `hexToBytes`, `bytesToHex`, `randomHex32` | hashing/byte helpers that work in Node and browsers |
| `parseSignedText(text)` | splits NEAR AI's `model:reqHash:respHash` (or `reqHash:respHash` for gateway signatures) |
| `verifySignedText({signedText, signature, signingAddress, signingAlgo})` | ed25519 via tweetnacl, ecdsa via ethers EIP-191 recover |
| `commitOf(saltHex, proof)`, `proofPayload(proof)` | `sha256(salt ‖ canonical(proof without salt/commit/commitTx))` — what goes on-chain |
| `actionCommitOf(action)`, `entryHashOf(prevHash, input, verifier)` | the contract-side hashes, so the client can re-check them |
| `verifyModelProof(proof, rawRequest?, rawResponse?, logEntry)` | the 8-line report behind the proof card: schema, route, signed text, both hashes, signature, key-in-log (fail-closed), commit |
| zod schemas `ModelProof`, `ActionProof`, `Action`, `Decision`, `KeyEntryInput`, `KeyEntry`, `SignatureResponse` | field names exactly as in SPEC; camelCase for proofs, snake_case for contract types |

## Matching the Rust side (Dastan)

The contract (`entry_hash`) and the policy job (`canonical_bytes(decision)`, `action_commit`) must produce the same
bytes as `canonicalJson`. With `serde_json` this is free as long as the `preserve_order` feature is **off**
(check: `cargo tree -e features -i serde_json | grep preserve_order` must print nothing):

```rust
let canonical = serde_json::to_string(&serde_json::to_value(&input)?)?; // Value::Object is a BTreeMap → sorted, no spaces
```

Do not serialise the struct directly (`to_string(&input)`): that keeps field declaration order. Keep `U64`/`U128` as
near-sdk's string-encoded types, never `u64`/`u128` in JSON. Then assert against every entry in
`docs/test-vectors/canonical.json` (`vectors[].canonical` + `sha256`, and `commits.{action_commit,proof_commit,entry_hash}`)
in a unit test; the file is the contract between the two languages.

Conventions encoded here that SPEC leaves implicit (flagged in DEV-NOTES 2026-11-03, confirm at sync):
`entry_hash` concatenates three UTF-8 strings (`prev_hash` as hex text, genesis `""`); `image_digests` keep the
`sha256:` prefix from the compose file; the commit covers the proof without its envelope fields.
