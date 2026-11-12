# Ainek against six obligations

[Private Inference Beat](https://amiller.github.io/awesome-private-inference/assessments.html) reviews confidential-inference
routes on six obligations: hardware, session, code, operator access, downstream and updates. It asks for exact client and
workload versions, proof records and "reproducible negative controls" before it calls a route verified. This page puts
Ainek's client through the same six, for the route it uses: NEAR AI Cloud, end-to-end encryption through the gateway.

It is our own reading, not the registry's assessment. The obligations are summarised in our words; the registry's wording
is on its page. Each section says what the client checks, the command that shows it, the change that must be refused,
and what stays open. Nothing here is audited.

Versions: `@nearai/inference-sdk` 0.3.0, E2EE v3, model `z-ai/glm-5.3-flash`, as run on Nov 12, 2026.

```bash
pnpm demo:controls     # offline, no key: 15 changes to the recorded evidence, each of which must be refused
pnpm demo:attest       # network, no key: the live evidence, the key log, the release behind the key
pnpm demo:reply-key    # needs NEARAI_API_KEY: a hop swaps the reply key in transit and must get no reply
pnpm test              # the unit tests named below
```

`pnpm demo:controls` prints one line per change, under the same six headings, and exits 0 only when the unchanged
recording was accepted and every change was refused for the reason its control names. The same table runs as tests
(`apps/demo/src/controls.test.ts`). The lines it marks "—" are not controls: they say where the control for that part
is, or that there is none.

## 1. Hardware

Is the platform evidence authentic, and inside a policy the client set?

- **Checked.** The SDK verifies the Intel TDX quote of the gateway and of the model against Intel's collateral. Node asks
  Intel itself; the browser fetches the same signed collateral through NEAR AI's proxies. The TCB status must be one the
  client accepts (`AINEK_ACCEPTED_TCB`, by default `UpToDate` only), a debug enclave is refused by the SDK, and NVIDIA GPU
  evidence is required and checked through NRAS.
- **Shown by.** `pnpm demo:attest` live; `pnpm demo` on the recording, with Intel's collateral and NVIDIA's verdict
  recorded next to it.
- **Must be refused.** `pnpm demo:controls`, section 1: one byte of the quote changed; a policy that does not accept the
  quote's TCB status; the GPU evidence removed.
- **Open.** No allowlist of measurements: any dstack image whose quote verifies is accepted, and the key log records what
  verifiers saw, not what should run.

## 2. Session

Are the recipient of the prompt, the key the reply is encrypted to, and the freshness bound to this exchange?

- **Checked.** The prompt is encrypted to the model's key taken from a report verified for a nonce the client chose. That
  key, together with the launcher the enclave attested, must be in the public log within the last 24 hours, written by
  verifiers the viewer trusts, or nothing is sent. E2EE v3 binds the reply key into every encrypted request field. From
  Node the request goes over a connection pinned to the attested gateway's TLS key.
- **Shown by.** `pnpm demo:live`; the chat.
- **Must be refused.** `pnpm demo:controls`, section 2: a report served again to a client that sent another nonce; an
  old quote under a report that names the new nonce; another signing key than the quote binds; a key no trusted verifier
  logged (also `pnpm demo:tamper` and `/?tamper=1`). Live, `pnpm demo:reply-key`: a
  hop that swaps the reply key in transit got HTTP 400 `Decryption failed` on Nov 12, with and without the version header
  rewritten to 2 (`docs/samples/reply-key-control.json`). Our relay refuses a request to the attested model that is not
  complete E2EE v3 (`relay-guard.test.ts`).
- **Open.** The browser reuses a verified report for up to 60 minutes. The browser cannot see the TLS peer, so there the
  request is not pinned: it is encrypted, and our relay sees ciphertext and metadata. The reply-key control is one model
  on one day. A hop that controls the page the client is served from is outside all of this.

## 3. Code

Does what was measured resolve to source somebody can read, and is it the code that serves the model?

- **Checked.** In Node only, `pnpm demo:attest` step 5. The launcher's compose hash is taken from the app compose the
  quote's MRCONFIGID binds. The enclave's action log is authenticated against a quote of its own, and that quote must name
  the same CVM instance as the key's. The latest release for the model's service is followed to a file in
  `nearai/cvm-compose-files` (sha256 compared), to the repository's tag, and to the signed build provenance of the proxy
  image, which names a source commit. Compose Manager's image is checked the same way and compared with the one the
  measured compose starts.
- **Must be refused.** `pnpm demo:controls`, section 3: one character added to the app compose; an event added to the
  RTMR3 event log; an action removed from the action log. `pnpm test` (`release.test.ts`, against a fake GitHub): a file
  that does not match the recorded hash; a tag moved to another commit or missing; an image with no build proof; the log
  of another replica; a path that would leave the repository.
- **Open.** Signed provenance is not a reproducible build. The engine image has no build policy and the weights are only
  named. The action log is a record, not a measurement: a release leaves the measurements as they were, and the proxy
  holds the socket that quotes the log. The browser, the key log and the proofs do not read the action log yet.
  Nobody approves a release: the most a log could say is that verifiers saw it.

## 4. Operator access

What can the operator change without changing what is measured?

- **Checked.** Nothing is constrained. `pnpm demo:attest` prints two settings it reads from the measured launcher compose:
  the image Compose Manager starts as, and the minimum age it demands of a tag before running it.
- **What that compose shows** (the CVM that answered on Nov 12; `docs/DEV-NOTES.md`): 18 environment variables the
  operator sets outside the measurement; a minimum tag age that falls back to zero; any tag of the public compose
  repository can be deployed through Compose Manager's API; the proxy that serves the model runs privileged and holds
  the quote socket. On the dstack image those CVMs report, a container with that socket can append events to the RTMR3 log, which is
  why Ainek takes the compose hash from the MRCONFIGID-bound text and not from the event.
- **Must be refused.** No control: there is nothing here that Ainek refuses.
- **Open.** All of it. We have not traced what the proxy logs or where telemetry goes; `pnpm demo:attest` names the
  release and its source commit, and we have not audited either.

## 5. Downstream

Is the answer bound to the request, the model that was asked for and the key that was verified?

- **Checked.** The enclave signs the model id with `sha256(request)` and `sha256(response)`. The client keeps the exact
  bytes, recomputes both hashes and checks the signature under the attested key, which must be the logged one. Requests
  carry `x-no-aliasing`, so the gateway may not serve another model under the name. An answer signed by the gateway and
  not by the model enclave is shown as a red card. The release chain finds the model's service by its `MODEL_NAME`.
- **Shown by.** `pnpm demo`; `/verify` with a proof; the proof card.
- **Must be refused.** `pnpm demo:controls`, section 5: one bit of the response changed; the signature presented under
  another key; a gateway-signed answer; a proof whose key is not in the log. The same in `verify.test.ts`.
- **Open.** Replicas of a model share one signing key, and the gateway picks one per connection: the replica that answers
  may be another than the one that attested. The engine behind the proxy and the weights are not bound to the answer. The
  gateway is attested, and its own release is not followed.

## 6. Updates

Can the client refuse a change until somebody it trusts has approved it?

- **Checked.** A launcher configuration no trusted verifier logged in the last 24 hours is refused, on by default since
  Nov 11. Who counts is the viewer's choice on `/log`: the trust set and the quorum, not ours.
- **Must be refused.** `pnpm demo:controls`, section 6, and `/?tamper=deployment`: the right key, logged with another
  launcher than the one attested. `key-log.test.ts` (`unknown deployment`).
- **Open.** A new release of the serving containers behind the same launcher is not refused: this is the finding of
  Nov 12. A rollback is not refused either; `pnpm demo:attest` shows it as a release. A minimum time a release must have
  been public is not enforced. "Logged by a verifier" means seen, not reviewed.

## What would close the open items

In the order we would take them: the release in the key log and a client that refuses one no trusted verifier logged; a
minimum public age for a release, set by the viewer; the action log's length and hash in the key log, so that a later log
can be checked to continue an earlier one; the same chain in the browser; a proof that names the release that answered.
None of that makes the action log a measurement. That needs the releases in the enclave's measurements, which is NEAR
AI's to build.
