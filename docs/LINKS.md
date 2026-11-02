# Links — everything Claude Code and we need, in one place

## Hackathon
- Site: https://nearhackathon.com/ · Rules for agents: https://nearhackathon.com/HACKATHON.md
- Submission form: https://nearhackathon.com/#apply · API: POST https://nearhackathon.com/api/applications
- Discord: https://discord.gg/nearprotocol

## NEAR AI Cloud (inference, attestation, E2EE)
- Docs index for agents: https://docs.near.ai/llms.txt
- Quickstart: https://docs.near.ai/cloud/quickstart.md · Models & prices: https://near.ai/models · https://docs.near.ai/cloud/models.md
- Private inference: https://docs.near.ai/cloud/private-inference.md
- Verification overview: https://docs.near.ai/cloud/verification/index.md
- Gateway attestation: https://docs.near.ai/cloud/verification/cloud-api/gateway-attestation.md
- Model attestations: https://docs.near.ai/cloud/verification/cloud-api/model-attestations.md
- Response signatures: https://docs.near.ai/cloud/verification/cloud-api/response-signatures.md
- Signature verification reference: https://docs.near.ai/cloud/verification/reference/response-signature-verification.md
- Quote / nonce / signer binding: https://docs.near.ai/cloud/verification/reference/quote-nonce-signer.md
- Verification policy (fail-closed rules): https://docs.near.ai/cloud/verification/reference/verification-policy.md
- TLS binding: https://docs.near.ai/cloud/verification/cloud-api/tls.md · Image provenance: https://docs.near.ai/cloud/verification/cloud-api/image-provenance.md
- Verification Center (receipt URL format): https://docs.near.ai/cloud/verification/verification-center.md · https://cloud.near.ai/verify
- E2EE chat completions: https://docs.near.ai/cloud/guides/e2ee-chat-completions.md
- OpenAI compatibility: https://docs.near.ai/cloud/guides/openai-compatibility.md · Stateless responses: https://docs.near.ai/cloud/guides/stateless-responses.md
- Specialized endpoints (PII classify/redact, embeddings): https://docs.near.ai/cloud/guides/specialized-endpoints.md
- JS SDK: https://github.com/nearai/inference-sdk/blob/main/js/README.md · API reference: https://github.com/nearai/inference-sdk/blob/main/js/docs/api-reference.md
- Browser verification guide: https://github.com/nearai/inference-sdk/blob/main/js/docs/verification-guide.md
- npm: https://registry.npmjs.org/@nearai/inference-sdk
- Reference verifier (Node): https://github.com/near-examples/nearai-cloud-verification-example
- Reference verifier (Py+TS): https://github.com/nearai/nearai-cloud-verifier
- Intel Trust Authority integration: https://near.ai/blog/near-ai-cloud-integrates-intel-trust-authority
- Blog (context): https://near.ai/blog · "Zero Data Retention Isn't Enough" (Oct 22 2026): https://near.ai/blog/zero-data-retention-isnt-enough

## NEAR protocol & tooling
- Docs index for agents: https://docs.near.org/llms.txt · Docs MCP: https://docs.near.org/mcp
- Tools for AI agents (skills, MCP): https://docs.near.org/getting-started/tools-for-ai.md · Skills repo: https://github.com/near/agent-skills
- Your First Web3 App (React/Next.js): https://docs.near.org/web3-apps/quickstart.md
- Access keys (full-access vs function-call): https://docs.near.org/protocol/access-keys · Accounts: https://docs.near.org/protocol/account-id
- NEP-297 events: https://github.com/near/NEPs/blob/master/neps/nep-0297.md · NEP-413 signed messages: https://github.com/near/NEPs/blob/master/neps/nep-0413.md
- Meta transactions (NEP-366): https://docs.near.org/chain-abstraction/meta-transactions
- Fungible tokens (NEP-141): https://docs.near.org/primitives/ft/ft.md · Standard: https://docs.near.org/primitives/ft/standard.md
- Rust SDK: https://docs.near.org/tools/sdk.md · near-workspaces, cargo-near — via docs MCP
- near-api-js: https://registry.npmjs.org/near-api-js · near-kit: https://kit.near.tools/llms.txt
- NEAR MCP server (on-chain tools, keys local): https://github.com/nearai/near-mcp
- Explorer: https://testnet.nearblocks.io · RPC providers: https://docs.near.org/api/rpc/providers
- Shade Agents (deprecated Apr 19 2026 — do not use): https://docs.near.org/ai/shade-agents/introduction

## OutLayer (attested compute, policy job)
- Getting started: https://app.outlayer.ai/docs/getting-started · WASI: https://app.outlayer.ai/docs/wasi
- HTTPS API: https://app.outlayer.ai/docs/https-api · NEAR integration: https://app.outlayer.ai/docs/near-integration
- TEE attestation: https://app.outlayer.ai/docs/tee-attestation · Secrets: https://app.outlayer.ai/docs/secrets
- SDK: https://app.outlayer.ai/docs/sdk · Examples: https://app.outlayer.ai/docs/examples · Pricing: https://app.outlayer.ai/docs/pricing
- Agent Custody (alternative, TS SDK alpha): https://app.outlayer.ai/docs/agent-custody · https://github.com/out-layer/sdk-js
- Claude skills: https://github.com/out-layer/skills · Example app: https://github.com/out-layer/private-dao-example
- API spec: https://github.com/out-layer/api-spec

## NEAR Intents (stretch only)
- Docs index: https://docs.near-intents.org/llms.txt · 1Click quickstart: https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/introduction.md
- Confidential Intents: https://docs.near-intents.org/integration/market-makers/confidential-intents.md · https://www.near.org/blog/confidential-intents

## Evidence for README (the "why now")
- Brave Leo E2EE (Oct 15 2026): https://brave.com/blog/browser-ai-e2ee/
- Independent monitor (0/95 end-to-end): https://confidentialinference.net/attestation
- Miller registry & assessments: https://amiller.github.io/awesome-private-inference · https://amiller.github.io/awesome-private-inference/assessments.html
- Lit Vincent (proofs not published): https://blockworks.com/news/lit-protocol-vincent-ai-agents
- Spark Money (no on-chain registries of agent constraints): https://www.spark.money/research/ai-agent-wallet-policy-architecture
- ERC-8004 (privacy not addressed): https://erc-8004.quicknode.com/learn/what-is-erc-8004
- NEAR Business (Oct 21 2026): https://www.coingabbar.com/en/near-protocol-news-near-business-launch-today-lifts-price
- Prior-art to cite and differentiate from (0G hackathon): https://hackquest.io/projects/Sworn · https://hackquest.io/projects/Meru · https://hackquest.io/projects/Ivaronix
