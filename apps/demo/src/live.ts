// `pnpm demo:live [--record] [--message "…"]`: the Tier-1 flow from Node with the server-side API key.
// Verify gateway + model evidence (TLS pinned to the attested gateway), send one E2EE request, keep the exact
// bytes, fetch the signature, run the SDK byte-exact check and our proof, print the card.
// `--record` writes the exchange into docs/samples so the offline replay (`pnpm demo`) has an E2EE sample.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
} from '@nearai/inference-sdk/node';
import { KeyEntry, buildModelProof, evaluateKeyLog, shortHex as short, verifyModelProof, type ModelProof } from '@ainek/proof';

const args = process.argv.slice(2);
const record = args.includes('--record');
const message = args[args.indexOf('--message') + 1] && args.includes('--message') ? (args[args.indexOf('--message') + 1] as string) : 'Reply with exactly three words.';

// Root .env (CLAUDE.md: secrets live in one file). Environment variables already set win.
const repoRoot = (() => {
  let dir = import.meta.dirname;
  while (!existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('pnpm-workspace.yaml not found');
    dir = parent;
  }
  return dir;
})();
if (!process.env.NEARAI_API_KEY && existsSync(path.join(repoRoot, '.env'))) process.loadEnvFile(path.join(repoRoot, '.env'));
const apiKey = process.env.NEARAI_API_KEY;
if (!apiKey) {
  console.error('NEARAI_API_KEY is not set (root .env). The offline replay needs no key: pnpm demo');
  process.exit(2);
}
const baseUrl = process.env.NEARAI_BASE_URL ?? DEFAULT_NEAR_AI_CLOUD_BASE_URL;
const model = process.env.NEARAI_MODEL ?? 'z-ai/glm-5.3-flash';
const SIGNING_ALGO = 'ed25519' as const;
const policy = { acceptedTcbStatuses: ['UpToDate' as const] };
const samplesDir = path.join(repoRoot, 'docs', 'samples');

const OK = '✓';
const FAIL = '✗';
const NA = '—';
function head(title: string): void { console.log(`\n${title}`); }
function line(mark: string, text: string): void { console.log(`  ${mark} ${text}`); }
function describe(err: unknown): string {
  const sdk = getSdkError(err);
  return sdk ? `${sdk.name} ${sdk.failure.code}` : err instanceof Error ? err.message : String(err);
}

console.log(`Ainek live: ${model} via ${baseUrl}${record ? ' (recording to docs/samples)' : ''}`);
const client = new AttestationClient({ apiKey, baseUrl, headers: { [NO_ALIASING_HEADER]: 'true' } });

// 1. Gateway evidence, TLS pinned to the attested peer (Node can observe the certificate).
head('1. Gateway attestation');
const t0 = performance.now();
const fetchedGateway = await client.fetchGatewayAttestation({ signingAlgo: SIGNING_ALGO });
const gateway = await verifyGatewayAttestation({ attestation: fetchedGateway.attestation, clientBinding: fetchedGateway.clientBinding, policy });
const pinnedFetch = gateway.tlsBinding.kind === 'attested' ? createPinnedTlsFetch(gateway.tlsBinding.spkiFingerprint) : globalThis.fetch;
line(OK, `TCB ${gateway.tcbStatus}, signer ${short(gateway.signer.signingAddress)}, TLS binding ${gateway.tlsBinding.kind}`);

// 2. Model evidence.
head(`2. Model attestation: ${model}`);
const fetchedModels = await client.fetchModelAttestations({ model, signingAlgo: SIGNING_ALGO });
const models = await Promise.all(fetchedModels.attestations.map((attestation) => verifyModelAttestation({ attestation, clientBinding: fetchedModels.clientBinding, policy: { ...policy, gpuEvidence: 'required' } })));
const modelAttestation = models.find((m) => m.signingPublicKey !== undefined);
if (!modelAttestation?.signingPublicKey) throw new Error('no verified model attestation with an E2EE key');
const verifiedAt = new Date().toISOString();
line(OK, `${models.length} report(s) verified in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${models.map((m) => `${short(m.signer.signingAddress)} ${m.tcbStatus}/gpu ${m.gpuEvidence} compose ${short(m.deployment.runtimeMeasurements.composeHash ?? '')}`).join('; ')}`);

// 3. Fail-closed against the public log (contract when configured, else the recorded sample entry).
head('3. Public key log');
const logEntries = await loadLog(model);
const verdict = evaluateKeyLog(logEntries.entries, { model, signingAddress: modelAttestation.signer.signingAddress, trustedVerifiers: logEntries.trusted, quorum: Number(process.env.AINEK_QUORUM ?? '1') || 1 });
if (verdict.status !== 'ok') {
  line(FAIL, `${verdict.detail} (source: ${logEntries.source})`);
  console.log('\nResult: REFUSED. Nothing was sent.');
  process.exit(1);
}
const logEntry = verdict.matching[0] as KeyEntry;
line(OK, `key #${logEntry.index} logged by ${verdict.confirmedBy.join(', ')} (source: ${logEntries.source})`);

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
for (const c of report.checks) line(c.status === 'ok' ? OK : c.status === 'fail' ? FAIL : NA, `proof.${c.id}: ${c.detail}`);
line(NA, 'commit on NEAR: not in this mode (the web client commits with the wallet; the salt stays with the proof)');

console.log('\n┌─ Ainek proof card ─ live ───────────────────────────────────────────');
console.log(`│ ${OK} Model: ${model}, attested deployment (compose ${short(signer.deployment.runtimeMeasurements.composeHash ?? '')})`);
console.log(`│ ${OK} Hardware: Intel TDX ${signer.tcbStatus}, NVIDIA GPU ${signer.gpuEvidence}, gateway TLS ${gateway.tlsBinding.kind}`);
console.log(`│ ${OK} Key #${logEntry.index} in the public log, logged by ${logEntry.verifier} (${logEntries.source})`);
console.log(`│ ${report.ok ? OK : FAIL} Request and response: hashes match the signature made inside the model TEE`);
console.log(`│ ${OK} End-to-end encryption: yes, encrypted to the attested model key`);
console.log(`│ ${NA} On NEAR: commit ${short(proof.commit ?? '')} computed, not sent in this mode`);
console.log(`└─ Result: ${report.ok ? 'VERIFIED' : 'FAILED'}`);

if (record) recordSamples({ proof, requestBody, responseBody, signature, reply });
process.exit(report.ok ? 0 : 1);

// ---- helpers ----
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

/** The contract log with the configured trust set, or the recorded sample entry trusted on its own verifier (it is a fixture). */
async function loadLog(modelId: string): Promise<{ entries: KeyEntry[]; trusted: string[]; source: string }> {
  const sample = () => {
    const entry = KeyEntry.parse((JSON.parse(readFileSync(path.join(samplesDir, 'key-entry.sample.json'), 'utf8')) as { entry: unknown }).entry);
    return { entries: [entry], trusted: [entry.verifier], source: 'sample (docs/samples/key-entry.sample.json)' };
  };
  const trusted = (process.env.AINEK_TRUSTED_VERIFIERS ?? 'ainek-dev-dastan.testnet').split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env.AINEK_LOG_SOURCE === 'sample') return sample();
  const contract = process.env.AINEK_CONTRACT ?? 'ainek-log-dastan.testnet';
  const rpc = process.env.NEAR_RPC_URL ?? 'https://rpc.testnet.near.org';
  try {
    const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: 'latest_keys', args_base64: Buffer.from(JSON.stringify({ model: modelId, max_age_ns: '86400000000000' })).toString('base64') } }) });
    const json = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: unknown };
    if (!json.result?.result || json.result.error) throw new Error(json.result?.error ?? JSON.stringify(json.error));
    return { entries: KeyEntry.array().parse(JSON.parse(Buffer.from(json.result.result).toString('utf8'))), trusted, source: `contract ${contract}` };
  } catch (err) {
    line(NA, `contract log unavailable (${describe(err)}); falling back to the recorded sample entry`);
    return sample();
  }
}

function recordSamples(x: { proof: ModelProof; requestBody: Uint8Array; responseBody: Uint8Array; signature: CompletionSignature; reply: string }): void {
  const sampleEntry = KeyEntry.parse((JSON.parse(readFileSync(path.join(samplesDir, 'key-entry.sample.json'), 'utf8')) as { entry: unknown }).entry);
  const write = (name: string, data: string | Uint8Array) => writeFileSync(path.join(samplesDir, name), data);
  write('e2ee-chat-request.raw.json', x.requestBody);
  write('e2ee-chat-response.raw.json', x.responseBody);
  write('e2ee-signature.json', `${JSON.stringify({ text: x.signature.signedText, signature: x.signature.signature, signing_address: x.signature.signer.signingAddress, signing_algo: x.signature.signer.signingAlgo, signature_kind: x.signature.kind }, null, 2)}\n`);
  write('e2ee-plaintext.json', `${JSON.stringify({ _note: 'What the recording client sent and decrypted. NOT covered by the proof (which is over the ciphertext bytes): shown in the replay card for readability only.', model, prompt: message, reply: x.reply, completionId: x.proof.completionId, recordedAt: new Date().toISOString() }, null, 2)}\n`);
  // The offline replay checks against the recorded sample log entry, so the recorded proof binds to it, with a fixed salt.
  const salt = '0123456789abcdef'.repeat(4);
  const proof = buildModelProof({ completionId: x.proof.completionId, model, signature: x.signature, requestBody: x.requestBody, responseBody: x.responseBody, logEntry: sampleEntry, verifiedAt, e2ee: true, salt });
  write('model-proof-e2ee.sample.json', `${JSON.stringify({ _note: 'SAMPLE model proof for the recorded E2EE exchange (e2ee-*.json). logIndex/verifier refer to key-entry.sample.json; salt is a fixed test value; commitTx is a placeholder.', proof: { ...proof, commitTx: 'SAMPLE-not-committed' } }, null, 2)}\n`);
  console.log('\nrecorded: e2ee-chat-request.raw.json, e2ee-chat-response.raw.json, e2ee-signature.json, e2ee-plaintext.json, model-proof-e2ee.sample.json');
}
