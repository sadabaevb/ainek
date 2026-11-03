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
| `key-entry.sample.json` | **sample** `KeyEntry` (SPEC §4.1) as a verifier would log it from `attestation-report.json`; not read from the chain | real: model, signing keys, `compose_hash`, `image_digests`, nonce, `report_hash`; placeholders: index 0, `prev_hash ""`, `nras_result_hash ""`, `block_height 0`; `entry_hash` per `packages/proof` |
| `model-proof.sample.json` | **sample** `ModelProof` (SPEC §5.1) assembled from `signature.json` + the raw bytes, with a fixed test salt and its `commit` | `commitTx` is a placeholder: nothing was committed on-chain; `pnpm -F @ainek/proof test` verifies it end to end |
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
