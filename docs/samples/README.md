# Samples (recorded 2026-11-02, Bektur, day-1 spike)

Raw bytes captured from NEAR AI Cloud for `z-ai/glm-5.3-flash` with `signing_algo=ed25519`. They feed the
offline replay mode (`pnpm demo`, SPEC §3.8) and the `packages/proof` tests. No API keys inside: the only keys
are the *public* signing keys of the gateway and model TEEs, which is the whole point of the files.

| File | What it is | How it was produced |
| --- | --- | --- |
| `attestation-report.json` | `GET /v1/attestation/report?model=z-ai/glm-5.3-flash&signing_algo=ed25519&nonce=fe7956b4…de55`, verbatim (317 KB) | header `x-no-aliasing: true`; the same nonce is echoed in `request_nonce` and bound into the TDX quote and the NVIDIA payload |
| `chat-request.raw.json` | exact request body bytes of one `POST /v1/chat/completions` (no E2EE, `stream: false`) | `Accept-Encoding: identity` |
| `chat-response.raw.json` | exact response body bytes (1038 B) | these bytes, not a re-serialised object, are what the model TEE hashed |
| `signature.json` | `GET /v1/signature/7556638665c34ec6ac6cb69579bd8ef2?model=…&signing_algo=ed25519` | `signature_kind: provider_tee`, `text = model:sha256(req):sha256(resp)`, signature = 64 bytes hex |
| `key-entry.sample.json` | **real** `KeyEntry` (SPEC §4.1): entry #0 of `ainek-log-dastan.testnet`, read with the view `entry({"index": 0})` on Nov 8 and stored as returned; logged by `ainek-dev-dastan.testnet` from `attestation-report.json` | the offline replay's public log; `pnpm test` ties it to the on-chain record in `docs/test-vectors/canonical.json`, `pnpm -F demo check-contract` to the live entry #0; `ita_jwt_hash` and `nras_result_hash` are empty because those tokens were not recorded on Nov 2 |
| `model-proof.sample.json` | **sample** `ModelProof` (SPEC §5.1) assembled from `signature.json` + the raw bytes, with a fixed test salt and its `commit` | `commitTx` is a placeholder: nothing was committed on-chain; `pnpm -F @ainek/proof test` verifies it end to end |
| `e2ee-chat-request.raw.json`, `e2ee-chat-response.raw.json` | exact bytes of one **E2EE** exchange (2026-11-03, `pnpm demo:live --record`): request fields encrypted to the attested model key, response fields encrypted to the client's ephemeral key | these ciphertext bytes are what the model TEE hashed and signed; nobody but the recording client could read them |
| `e2ee-signature.json` | `GET /v1/signature/8e20a4232d22466ebb01105193efd290`, `provider_tee` | same signer as the plaintext sample: one key per model |
| `e2ee-plaintext.json` | the prompt and the decrypted reply, as seen by the recording client | **not** covered by the proof; shown in the replay card for readability only |
| `model-proof-e2ee.sample.json` | **sample** `ModelProof` for the E2EE exchange, `e2ee: true`, bound to `key-entry.sample.json`, fixed salt | the replay card's "End-to-end encryption" line comes from this one |
| `disclosure.sample.json` | the "Disclose to auditor" file (SPEC §5.4) of one live exchange on 2026-11-04 (`pnpm demo:live --disclose docs/samples/disclosure.sample.json`): proof with salt and commit, the exact E2EE ciphertext bytes, the log entry #0 as read from `ainek-log-dastan.testnet` | exactly what a proof card downloads, no wrapper: load it on `/auditor` or `/verify`; `commitTx` absent because live mode does not commit; the plaintext is not in the file by design; embeds the chain's entry #0, so regenerate it after a contract redeploy |
| `action-proof.sample.json` | **real** `ActionProof` (SPEC §5.2) of action 4 on testnet, Nov 7: the `Deny` of 5000 AINEK to `newguy.testnet`, written by the agent service with its salt and commit | the "Use a real action proof" button on `/verify`. The salt opens only this action's commit, and the action's arguments and decision are public on-chain anyway |
| `intel-collateral.json` | Intel PCS collateral (TCB info, QE identity, CRLs, issuer chains; all public) for the three quotes in the report, keyed by `sha256(quote hex)`; recorded 2026-11-03 | lets `@phala/dcap-qvl` verify the quotes offline at `replay-manifest.nowSecs`; Intel rotates TCB info roughly monthly, so re-record if the replay starts failing on collateral validity |
| `nras-response.json` | NVIDIA NRAS verdict for the recorded `nvidia_payload`, verbatim (`[["JWT", overall], {"GPU-0": …}]`), recorded 2026-11-03 | NRAS re-attests a recorded payload; `eat_nonce` equals the report nonce; JWT lifetime 1 h, so the replay verifies it at its `iat` |
| `nvidia-jwks.json` | NVIDIA NRAS public keys (`/.well-known/jwks.json`), verbatim | the JWT above is checked against the key with `replay-manifest.nras.kid` |
| `replay-manifest.json` | when each piece of evidence was recorded and the instant the replay evaluates it at | freshness is not re-checked in replay; the demo prints that line explicitly |

Re-verify offline: `sha256(chat-request.raw.json)` and `sha256(chat-response.raw.json)` must equal the two hashes
in `signature.text`; the ed25519 signature over the UTF-8 bytes of `text` must verify under `signing_address`
(which, for ed25519, *is* the 32-byte public key); `signing_address` must equal
`model_attestations[0].signing_address` in `attestation-report.json`.

Freshness is not re-checkable from a recording (the nonce is ours but old, NRAS JWT `exp` is ~1 h) and the demo
marks it so. `gateway_attestation.vpc` carries NEAR AI's internal VPC hostname; it is outside the quote and is
left as received.

Attested facts observed at capture time: gateway `tcb_status=UpToDate`, model `tcb_status=UpToDate`, GPU
evidence verified via NRAS (`nvidia_payload.arch=HOPPER`, 8 GPUs; NRAS reports GH100, `secboot=true`, `dbgstat=disabled`), `tlsBinding=attested`.

The vectors in `docs/test-vectors/canonical.json` are hash inputs shared with the Rust tests. Their proof and entry still name the made-up `v1.ainek.testnet`, with commit `f415f768…`; the samples above are bound to the real entry #0 instead.
