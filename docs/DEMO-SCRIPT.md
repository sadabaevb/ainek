# Demo video script — 90 seconds, English, screen recording + voice

Record on Nov 12–13 after the feature freeze. One take per scene, stitched. Show real testnet transactions.
Open with the problem, not with us.

| Time | On screen | Voice-over |
| --- | --- | --- |
| 0:00–0:10 | Three quotes on a plain slide: NEAR Verification Center "cannot recompute hashes", Brave "no public log of TEE keys yet", confidentialinference.net "0 of 95 end-to-end verified" | "Every private AI says: we run in a TEE, trust us. Nobody lets you check." |
| 0:10–0:22 | Ainek chat. Type: "pay aibek.testnet 300 for October". DevTools network tab: request body is ciphertext, headers `X-Model-Pub-Key`, `X-Encrypt-All-Fields` | "Ainek is a glass box. The request is encrypted to the model's attested key — our server and NEAR's gateway see only ciphertext." |
| 0:22–0:35 | Before sending: green indicator "key …a3f1 — in public log since Nov 3, confirmed by 2 verifiers". Then `pnpm demo:tamper`: key swapped → red modal "not in log — not sent". `/log` page with entries from v1 and v2 | "Before anything leaves the browser, the model's key is checked against a public log on NEAR written by independent verifiers. Wrong key — nothing is sent. That log is what Brave says is missing." |
| 0:35–0:50 | Response arrives. Proof card: rows ✓ model, ✓ Intel TDX, ✓ NVIDIA, ✓ key #42 in log, ✓ hashes match signature, ✓ E2EE incl. tool calls, "on NEAR: only hash …". Click "Re-verify yourself" → `/verify` recomputes | "Every answer is signed inside the enclave over the hash of the request and the response. We keep the bytes and recompute them locally — the step NEAR's own verifier can't do. On-chain goes a salted hash, nothing else." |
| 0:50–1:08 | Telegram: agent replies "Allowed by policy v3 — executed", nearblocks shows `action_executed` with policy hash and no amount in the event. Second message: "pay newguy.testnet 5000" → "Needs approval" with buttons → Reject. nearblocks: `action_denied` | "The agent only proposes. Its policy — whitelist, caps, approval threshold — is evaluated inside an Intel TDX enclave, the decision is signed by a key born in that enclave, and the NEAR contract checks the signature before moving money. Publicly: 'approved by policy v3'. Not the amount, not the recipient." |
| 1:08–1:18 | `pnpm demo:stop` → `DeleteKey` tx; agent tries again → on-chain error | "Stop button: revoke the agent's key. One transaction. It can't act anymore, no matter what the model says." |
| 1:18–1:30 | `/trust` table "who sees what"; last slide: metrics + "What we do not claim" (3 lines) + repo link | "Here is exactly who sees what — and what we don't claim: attested deployment, not verified weights; retention isn't provable. Everything else, you can check yourself. Ainek, built at NEAR Hackathon." |

X post text (draft): "We built Ainek at NEAR HACKATHON — a glass box for private AI agents on @NEARProtocol: public key log
for NEAR AI Cloud TEEs (fail-closed client), re-checkable proofs for every answer, and agent policy decisions signed
inside Intel TDX and enforced by a NEAR contract. Repo + 90s demo ↓ #NEARHackathon"
