# Session 3 (Bektur, Nov 4-6): fail-closed client, proof, card, /verify, /log

> Translated from Russian on Nov 14, 2026. The original is in this file's git history.

---

Read CLAUDE.md, docs/SPEC.md §3.3, §3.4, §5, §7.1, §8 and docs/DEV-NOTES.md. We implement Tier 1 on the client.
Dastan's contract: `ainek.testnet`, the ABI in SPEC §4.1-4.2 (view methods `latest_keys`, `entry`, `head`).

**`packages/proof`:**
- zod schemas `ModelProof`, `ActionProof` from SPEC §5; `canonicalJson()` with the same test vectors as in
  `docs/test-vectors/canonical.json`; `sha256Hex(bytes)`; `parseSignedText()`; `verifyModelProof(proof, rawRequest, rawResponse, logEntry)`:
  recompute the hashes, compare with `signedText`, check the signature (ed25519 through tweetnacl; ecdsa: EIP-191 recover through ethers),
  compare `signingAddress` with `logEntry.signing_address`; `commitOf(saltHex, proof)`.

**Client verification and fail-closed (`apps/web`):**
1. The browser build of `@nearai/inference-sdk` (root entry): `verifyModelAttestation` with the polyfills per the verification-guide;
   the NRAS POST through `app/api/nras/route.ts` (a simple proxy). Cache the result for 60 min in memory + IndexedDB.
2. Before sending: take `signing_address` and `compose_hash` from the verified report → view `latest_keys(model, 24h)` →
   the rule from SPEC §7.1 (there is an entry with the same key and compose hash; there are no conflicting sets from different verifiers).
   If not: a modal "The key is not in the public log: the message was not sent" with details. If yes: a green indicator "key #N, verifiers: v1, v2".
3. Sending through the relay with E2EE: the client encrypts by itself (`prepareE2eeChatRequest` or `InferenceClient` in the browser with `e2ee: true`
   and the API key **only through the relay**: we do not give the key to the browser; if the SDK requires a key on the client, the relay substitutes
   Authorization, and the encryption stays on the client). `X-Model-Pub-Key` comes from the verified report. The raw bytes of the request and
   the response (`Accept-Encoding: identity`) go to IndexedDB.
4. After the response: `GET /v1/signature/{id}?signing_algo=ed25519` through the relay → `verifyModelProof` → `ModelProof` → a 32-byte salt →
   `commit_proof(commit, "model", logIndex)` with the user's FC key (the wallet login adds the key on `ainek.testnet`,
   method `commit_proof`) → the card.

**Pages:**
- `/` chat + the proof card per SPEC §5.3: rows with statuses, buttons "Re-check it yourself" (opens /verify with the proof),
  "Open in Verification Center" (`https://cloud.near.ai/verify?model=…#receipt=<base64url JSON>`: the format from
  docs.near.ai/cloud/verification/verification-center.md), "Disclose to an auditor" (export of the proof + salt + raw bytes to a file).
- `/verify`: paste proof JSON (and optionally the raw bytes) → a step-by-step verification report, a link to nearblocks for `commitTx`.
- `/log`: a table of the log's entries by model, who wrote them, when; a split-view banner if two verifiers have different
  keys within the same window (use the script `split-view-demo` from session 2).
- `/trust`: the table from SPEC §8 as it is.
- `/auditor` (can come later): upload the disclosure file → recompute the commit → compare with `proof_commit` on-chain.

**Demo mode:** `pnpm demo:tamper`: an environment variable replaces `signing_address` before the comparison → the client refuses.

Design: calm, without crypto aesthetics; statuses ✓/✗ large; technical details in expandable blocks.
Mobile layout is mandatory. The card's texts are in English (the judges), with an RU switch.

**Additionally (SPEC §3.8-3.9, §7.3):**
- Route detector: if `signature_kind !== 'provider_tee'` or there is no model attestation, a red card "the response went through a
  non-attested model; privacy only by contract". For the demo add a model switch to the Incognito tier (for example
  `anthropic/claude-sonnet-5` through the gateway): one request there in the video.
- Replay mode: `pnpm demo` without keys on `docs/samples/` (reports, signed responses, raw bytes, proofs); offline verification
  plus view calls of the log; `pnpm demo:live` with a key; `pnpm demo:tamper`: key replacement and refusal. This is the main entry point for
  AI screening: make it first, before the nice UI.
