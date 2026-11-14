# Stretch (Dastan, Nov 10-11, only if the status is green): a second provider in the log

> Translated from Russian on Nov 14, 2026. The original is in this file's git history.

---

Read services/verifier and SPEC §3.2, §4.1. The task is a Venice adapter for the verifier, so that the log contains the keys of two
providers and the thesis becomes "a public log for the whole private-AI industry".

1. Read https://docs.venice.ai/overview/privacy.md and https://docs.venice.ai/guides/features/tee-e2ee-models.md:
   the endpoint `/api/v1/tee/attestation` (a 32-byte nonce, `intel_quote`, `nvidia_payload`, `signing_key`) and
   `/api/v1/tee/signature`. A Venice API key and a small balance are needed.
2. In the verifier, factor out a provider-independent core (dcap-qvl, NRAS, signature check) and an interface `ProviderAdapter`
   { fetchReport(nonce, model), parseKey(report), fetchSignature(id) }. The `nearai` implementation already exists; add `venice`.
3. `KeyEntryInput.model` for Venice carries the provider prefix (`venice:<model>`); no changes to the contract are needed.
4. One run gives entries in the log from two providers; a screenshot for the README; a section "Adding a provider" in the README.
If it does not work out within a day, roll it back and leave it in the README as a next step with a description of the adapter interface.
