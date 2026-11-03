// `pnpm demo:live [--record] [--message "…"]`: the Tier-1 flow from Node with the server-side API key.
// Mirror of apps/web/lib/flow.ts (same steps, same order; keep them in sync): verify gateway + model evidence
// (TLS pinned to the attested gateway), fail-closed check against the public log, one E2EE request with the exact
// bytes kept, signature, SDK byte-exact check, our proof, card. `--record` writes the exchange into docs/samples
// so the offline replay (`pnpm demo`) has an E2EE sample.
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  AttestationClient,
  DEFAULT_NEAR_AI_CLOUD_BASE_URL,
  NO_ALIASING_HEADER,
  createPinnedTlsFetch,
  findModelAttestationForSignature,
  getSdkError,
  prepareE2eeChatRequest,
  verifyGatewayAttestation,
  verifyModelAttestation,
  verifyModelResponse,
  type CompletionSignature,
  type TcbStatus,
} from '@nearai/inference-sdk/node';
import { ainekConfigFromEnv, buildModelProof, evaluateKeyLog, keyLogReader, shortHex as short, verifyModelProof, type KeyEntry, type ModelProof } from '@ainek/proof';
import { loadSampleLogEntry, samplesDir } from './evidence.ts';
import { FAIL, NA, OK, describe, head, line, markOf } from './term.ts';

const { values: flags } = parseArgs({ options: { record: { type: 'boolean', default: false }, message: { type: 'string', default: 'Reply with exactly three words.' } }, strict: false });
const record = flags.record === true;
const message = String(flags.message);

// Root .env (CLAUDE.md: secrets live in one file). Environment variables already set win.
const repoRoot = path.resolve(import.meta.dirname, '../../..');
if (!process.env.NEARAI_API_KEY && existsSync(path.join(repoRoot, '.env'))) process.loadEnvFile(path.join(repoRoot, '.env'));
const apiKey = process.env.NEARAI_API_KEY;
if (!apiKey) {
  console.error('NEARAI_API_KEY is not set (root .env). The offline replay needs no key: pnpm demo');
  process.exit(2);
}
const cfg = ainekConfigFromEnv(process.env);
const baseUrl = process.env.NEARAI_BASE_URL ?? DEFAULT_NEAR_AI_CLOUD_BASE_URL;
const { model } = cfg;
const SIGNING_ALGO = 'ed25519' as const;
const policy = { acceptedTcbStatuses: cfg.acceptedTcbStatuses as TcbStatus[] };

console.log(`Ainek live: ${model} via ${baseUrl}${record ? ' (recording to docs/samples)' : ''}`);
const client = new AttestationClient({ apiKey, baseUrl, headers: { [NO_ALIASING_HEADER]: 'true' } });

// 1–3. Gateway evidence, model evidence and the public log are independent: fetch and verify them together.
const t0 = performance.now();
const logPromise = loadLog(model);
logPromise.catch(() => undefined); // awaited in step 3; a rejection must not surface before then
const [gateway, models] = await Promise.all([
  client.fetchGatewayAttestation({ signingAlgo: SIGNING_ALGO }).then((f) => verifyGatewayAttestation({ attestation: f.attestation, clientBinding: f.clientBinding, policy })),
  client.fetchModelAttestations({ model, signingAlgo: SIGNING_ALGO }).then((f) => Promise.all(f.attestations.map((attestation) => verifyModelAttestation({ attestation, clientBinding: f.clientBinding, policy: { ...policy, gpuEvidence: 'required' } })))),
]);
const verifiedAt = new Date().toISOString();
const pinnedFetch = gateway.tlsBinding.kind === 'attested' ? createPinnedTlsFetch(gateway.tlsBinding.spkiFingerprint) : globalThis.fetch;
head('1. Gateway attestation');
line(OK, `TCB ${gateway.tcbStatus}, signer ${short(gateway.signer.signingAddress)}, TLS binding ${gateway.tlsBinding.kind}`);
head(`2. Model attestation: ${model}`);
const modelAttestation = models.find((m) => m.signingPublicKey !== undefined);
if (!modelAttestation?.signingPublicKey) throw new Error('no verified model attestation with an E2EE key');
line(OK, `${models.length} report(s) verified in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${models.map((m) => `${short(m.signer.signingAddress)} ${m.tcbStatus}/gpu ${m.gpuEvidence} compose ${short(m.deployment.runtimeMeasurements.composeHash ?? '')}`).join('; ')}`);

head('3. Public key log');
const log = await logPromise.catch((err: unknown) => {
  line(FAIL, `public log unavailable (${describe(err)}): not sent (fail-closed)`);
  console.log('\nResult: REFUSED. Nothing was sent.');
  return process.exit(1);
});
const verdict = evaluateKeyLog(log.entries, { model, signingAddress: modelAttestation.signer.signingAddress, trustedVerifiers: log.trusted, quorum: cfg.quorum });
if (verdict.status !== 'ok') {
  line(FAIL, `${verdict.detail} (source: ${log.source})`);
  console.log('\nResult: REFUSED. Nothing was sent.');
  process.exit(1);
}
const logEntry = verdict.matching[0] as KeyEntry;
line(OK, `key #${logEntry.index} logged by ${verdict.confirmedBy.join(', ')} (source: ${log.source})`);

// 4. E2EE request with the exact bytes kept.
head('4. E2EE request');
const plain = new Request(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', [NO_ALIASING_HEADER]: 'true' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: message }], stream: false }),
});
const prepared = await prepareE2eeChatRequest({ request: plain, modelKey: { signingAlgo: modelAttestation.signer.signingAlgo, publicKey: modelAttestation.signingPublicKey } });
const requestBody = new Uint8Array(await prepared.request.clone().arrayBuffer());
const encrypted = await pinnedFetch(prepared.request);
if (!encrypted.ok) throw new Error(`chat completion failed: HTTP ${encrypted.status} ${(await encrypted.text()).slice(0, 200)}`);
const forVerification = encrypted.clone();
const decrypted = await prepared.decryptResponse(encrypted);
const [responseBytes, plaintext] = await Promise.all([forVerification.arrayBuffer(), decrypted.text()]);
const responseBody = new Uint8Array(responseBytes);
const completion = JSON.parse(plaintext) as { id: string; choices: Array<{ message: { content: string | null } }> };
const reply = completion.choices[0]?.message.content ?? '';
line(OK, `completion ${completion.id}: ${requestBody.length} B ciphertext sent, ${responseBody.length} B received; reply: ${JSON.stringify(reply)}`);

// 5. Signature + SDK byte-exact check + our proof.
head('5. Signature and proof');
const signature = await withRetry(() => client.fetchCompletionSignature({ completionId: completion.id, signingAlgo: SIGNING_ALGO }));
const signer = findModelAttestationForSignature({ attestations: models, signature });
verifyModelResponse({ requestBody, responseBody, signature, attestation: signer });
line(OK, `SDK: ${signature.kind} signature over these exact bytes, signer ${short(signature.signer.signingAddress)} = attested model key`);
const proof = buildModelProof({ completionId: completion.id, model, signature, requestBody, responseBody, logEntry, verifiedAt, e2ee: true });
const report = verifyModelProof(proof, requestBody, responseBody, logEntry);
for (const c of report.checks) line(markOf(c.status), `proof.${c.id}: ${c.detail}`);
line(NA, 'commit on NEAR: not in this mode (the web client commits with the wallet; the salt stays with the proof)');

console.log('\n┌─ Ainek proof card ─ live ───────────────────────────────────────────');
console.log(`│ ${OK} Model: ${model}, attested deployment (compose ${short(signer.deployment.runtimeMeasurements.composeHash ?? '')})`);
console.log(`│ ${OK} Hardware: Intel TDX ${signer.tcbStatus}, NVIDIA GPU ${signer.gpuEvidence}, gateway TLS ${gateway.tlsBinding.kind}`);
console.log(`│ ${OK} Key #${logEntry.index} in the public log, logged by ${logEntry.verifier} (${log.source})`);
console.log(`│ ${report.ok ? OK : FAIL} Request and response: hashes match the signature made inside the model TEE`);
console.log(`│ ${OK} End-to-end encryption: yes, encrypted to the attested model key`);
console.log(`│ ${NA} On NEAR: commit ${short(proof.commit ?? '')} computed, not sent in this mode`);
console.log(`└─ Result: ${report.ok ? 'VERIFIED' : 'FAILED'}`);

if (record) recordSamples({ completionId: completion.id, requestBody, responseBody, signature, reply });
process.exit(report.ok ? 0 : 1);

// ---- helpers ----
/** Same as apps/web/lib/nearai-browser.ts withRetry: only SDK-retryable failures are retried. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || getSdkError(err)?.retryable !== true) throw err;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

/** The contract log with the configured trust set; the recorded sample entry only when AINEK_LOG_SOURCE=sample asks for it explicitly. An unreachable contract is a refusal, never a silent fallback. */
async function loadLog(modelId: string): Promise<{ entries: KeyEntry[]; trusted: string[]; source: string }> {
  if (cfg.logSource === 'sample') {
    const entry = loadSampleLogEntry();
    return { entries: [entry], trusted: [entry.verifier], source: 'sample (docs/samples/key-entry.sample.json, AINEK_LOG_SOURCE=sample)' };
  }
  return { entries: await keyLogReader(cfg.rpcUrl, cfg.contract).latestKeys(modelId), trusted: cfg.trustedVerifiers, source: `contract ${cfg.contract}` };
}

/** The offline replay verifies against the recorded sample log entry, so the recorded proof binds to it (fixed salt, placeholder tx). */
function proofBoundToSampleLog(x: { completionId: string; requestBody: Uint8Array; responseBody: Uint8Array; signature: CompletionSignature }): ModelProof {
  const proof = buildModelProof({ ...x, model, logEntry: loadSampleLogEntry(), verifiedAt, e2ee: true, salt: '0123456789abcdef'.repeat(4) });
  return { ...proof, commitTx: 'SAMPLE-not-committed' };
}

function recordSamples(x: { completionId: string; requestBody: Uint8Array; responseBody: Uint8Array; signature: CompletionSignature; reply: string }): void {
  const write = (name: string, data: string | Uint8Array) => writeFileSync(new URL(name, samplesDir), data);
  write('e2ee-chat-request.raw.json', x.requestBody);
  write('e2ee-chat-response.raw.json', x.responseBody);
  write('e2ee-signature.json', `${JSON.stringify({ text: x.signature.signedText, signature: x.signature.signature, signing_address: x.signature.signer.signingAddress, signing_algo: x.signature.signer.signingAlgo, signature_kind: x.signature.kind }, null, 2)}\n`);
  write('e2ee-plaintext.json', `${JSON.stringify({ _note: 'What the recording client sent and decrypted. NOT covered by the proof (which is over the ciphertext bytes): shown in the replay card for readability only.', model, prompt: message, reply: x.reply, completionId: x.completionId, recordedAt: new Date().toISOString() }, null, 2)}\n`);
  write('model-proof-e2ee.sample.json', `${JSON.stringify({ _note: 'SAMPLE model proof for the recorded E2EE exchange (e2ee-*.json). logIndex/verifier refer to key-entry.sample.json; salt is a fixed test value; commitTx is a placeholder.', proof: proofBoundToSampleLog(x) }, null, 2)}\n`);
  console.log('\nrecorded: e2ee-chat-request.raw.json, e2ee-chat-response.raw.json, e2ee-signature.json, e2ee-plaintext.json, model-proof-e2ee.sample.json');
}
