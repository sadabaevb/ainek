// `pnpm demo:live [--record] [--disclose <file>] [--message "…"]`: the Tier-1 flow from Node with the server-side API key.
// Mirror of apps/web/lib/flow.ts (same steps, same order; keep them in sync): verify gateway + model evidence
// (TLS pinned to the attested gateway), fail-closed check against the public log, one E2EE request with the exact
// bytes kept, signature, SDK byte-exact check, our proof, card. `--record` writes the exchange into docs/samples
// so the offline replay (`pnpm demo`) has an E2EE sample. `--disclose <file>` writes the "Disclose to auditor" file of this
// run (SPEC §5.4), the same bytes a proof card downloads, for /auditor and /verify.
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  AttestationClient,
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
import { ainekConfigFromEnv, buildModelProof, evaluateKeyLog, keyLogReader, normalizeHex, shortHex as short, toDisclosure, verifyModelProof, type KeyEntry, type ModelProof } from '@ainek/proof';
import { loadSampleLogEntry, samplesDir } from './evidence.ts';
import { FAIL, NA, OK, describe, head, line, markOf } from './term.ts';

const { values: flags } = parseArgs({ options: { record: { type: 'boolean', default: false }, disclose: { type: 'string' }, message: { type: 'string', default: 'Reply with exactly three words.' } }, strict: false });
const record = flags.record === true;
const message = String(flags.message);
// `--disclose` needs a file; parseArgs (strict: false) would otherwise swallow the next flag as the value or yield `true` for a bare one.
if (flags.disclose !== undefined && (typeof flags.disclose !== 'string' || flags.disclose.startsWith('-'))) usage('--disclose needs a file path');
// INIT_CWD is where pnpm ran: the repo root for `pnpm demo:live` (the root script nests a second pnpm), the shell's directory for
// `pnpm -F demo live`. An absolute path works from anywhere.
const discloseFile = typeof flags.disclose === 'string' ? path.resolve(process.env.INIT_CWD ?? process.cwd(), flags.disclose) : '';
if (discloseFile && !existsSync(path.dirname(discloseFile))) usage(`--disclose: directory ${path.dirname(discloseFile)} does not exist`);

// Root .env (CLAUDE.md: secrets live in one file). loadEnvFile never overrides variables already set, so the shell wins.
const repoRoot = path.resolve(import.meta.dirname, '../../..');
if (existsSync(path.join(repoRoot, '.env'))) process.loadEnvFile(path.join(repoRoot, '.env'));
const apiKey = process.env.NEARAI_API_KEY;
if (!apiKey) {
  console.error('NEARAI_API_KEY is not set (root .env). The offline replay needs no key: pnpm demo');
  process.exit(2);
}
const cfg = ainekConfigFromEnv(process.env);
// A disclosure binds the proof to the log entry it embeds; the recorded sample entry is one no auditor can confirm on-chain.
if (discloseFile && cfg.logSource === 'sample') usage('--disclose needs the contract log (AINEK_LOG_SOURCE=contract): a proof bound to the sample entry cannot be audited');
const { model, nearaiBaseUrl: baseUrl } = cfg;
const SIGNING_ALGO = 'ed25519' as const;
const policy = { acceptedTcbStatuses: cfg.acceptedTcbStatuses as TcbStatus[] }; // validated in ainekConfigFromEnv; same names as the SDK's

console.log(`Ainek live: ${model} via ${baseUrl}${record ? ' (recording to docs/samples)' : ''}`);
const client = new AttestationClient({ apiKey, baseUrl, headers: { [NO_ALIASING_HEADER]: 'true' } });

// 0. The chosen model must support model attestation (flow.ts step 0): never a silent downgrade to plaintext.
head(`0. Model metadata: ${model}`);
const meta = await withRetry(() => client.fetchModelMetadata(model));
if (meta.attestationSupported !== true) refuse(`${model} reports no model attestation (provider ${String(meta.providerType)}): refusing to send in plaintext`);
line(OK, `provider ${String(meta.providerType)}, model attestation supported`);

// 1–3. Gateway evidence, model evidence and the public log are independent: fetch and verify them together.
const t0 = performance.now();
const logPromise = loadLog(model);
logPromise.catch(() => undefined); // awaited in step 3; a rejection must not surface before then
const [gateway, models] = await Promise.all([
  withRetry(() => client.fetchGatewayAttestation({ signingAlgo: SIGNING_ALGO }).then((f) => verifyGatewayAttestation({ attestation: f.attestation, clientBinding: f.clientBinding, policy }))),
  withRetry(() => client.fetchModelAttestations({ model, signingAlgo: SIGNING_ALGO }).then((f) => Promise.all(f.attestations.map((attestation) => verifyModelAttestation({ attestation, clientBinding: f.clientBinding, policy: { ...policy, gpuEvidence: 'required' } }))))),
]);
const verifiedAt = new Date().toISOString();
head('1. Gateway attestation');
// Node can observe the TLS peer; a gateway report without the TLS binding means the chat request could not be pinned, so stop.
if (gateway.tlsBinding.kind !== 'attested') refuse(`gateway TLS binding is ${gateway.tlsBinding.kind}: the chat request cannot be pinned to the attested gateway`);
const pinnedFetch = createPinnedTlsFetch(gateway.tlsBinding.spkiFingerprint);
line(OK, `TCB ${gateway.tcbStatus}, signer ${short(gateway.signer.signingAddress)}, TLS binding ${gateway.tlsBinding.kind}`);
head(`2. Model attestation: ${model}`);
const modelAttestation = models.find((m) => m.signingPublicKey !== undefined);
if (!modelAttestation?.signingPublicKey) throw new Error('no verified model attestation with an E2EE key');
line(OK, `${models.length} report(s) verified in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${models.map((m) => `${short(m.signer.signingAddress)} ${m.tcbStatus}/gpu ${m.gpuEvidence} compose ${short(m.deployment.runtimeMeasurements.composeHash ?? '')}`).join('; ')}`);

head('3. Public key log');
const log = await logPromise.catch((err: unknown) => refuse(`public log unavailable (${describe(err)})`));
const verdict = evaluateKeyLog(log.entries, { model, signingAddress: modelAttestation.signer.signingAddress, trustedVerifiers: cfg.trustedVerifiers, quorum: cfg.quorum });
if (verdict.status !== 'ok') refuse(`${verdict.detail} (source: ${log.source})`);
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
console.log(`│ ${OK} Hardware: Intel TDX ${signer.tcbStatus}, NVIDIA GPU ${signer.gpuEvidence}; chat request pinned to the attested gateway`);
console.log(`│ ${OK} Key #${logEntry.index} in the public log, logged by ${logEntry.verifier} (${log.source})`);
console.log(`│ ${report.ok ? OK : FAIL} Request and response: hashes match the signature made inside the model TEE`);
console.log(`│ ${OK} End-to-end encryption: yes, encrypted to the attested model key`);
console.log(`│ ${NA} On NEAR: commit ${short(proof.commit ?? '')} computed, not sent in this mode`);
console.log(`└─ Result: ${report.ok ? 'VERIFIED' : 'FAILED'}`);

if (report.ok) {
  if (record) recordSamples({ completionId: completion.id, requestBody, responseBody, signature, reply });
  if (discloseFile) {
    writeJson(discloseFile, toDisclosure({ proof, logEntry, requestBody, responseBody }));
    console.log(`\ndisclosure written: ${discloseFile} (proof + salt + exact ciphertext bytes + log entry; keep it private, it is the file an auditor gets)`);
  }
} else if (record || discloseFile) console.log('\nnothing written: the run did not verify');
process.exit(report.ok ? 0 : 1);

// ---- helpers ----
/** A flag the run cannot proceed with: say so before any network call or spend. */
function usage(reason: string): never {
  console.error(`${reason}\nusage: pnpm demo:live [--record] [--disclose <file>] [--message "…"]`);
  return process.exit(2);
}

/** Fail-closed exit: prints the reason as a ✗ line and the REFUSED result. */
function refuse(reason: string): never {
  line(FAIL, `${reason}: not sent (fail-closed)`);
  console.log('\nResult: REFUSED. Nothing was sent.');
  return process.exit(1);
}

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

/** The contract log, or the recorded sample entry only when AINEK_LOG_SOURCE=sample asks for it explicitly (the trust set comes from the shared config in both cases). An unreachable contract is a refusal, never a silent fallback. */
async function loadLog(modelId: string): Promise<{ entries: KeyEntry[]; source: string }> {
  if (cfg.logSource === 'sample') return { entries: [loadSampleLogEntry()], source: 'sample (docs/samples/key-entry.sample.json, AINEK_LOG_SOURCE=sample)' };
  return { entries: await keyLogReader(cfg.rpcUrl, cfg.contract).latestKeys(modelId), source: `contract ${cfg.contract}` };
}

/** The offline replay verifies against the recorded sample log entry, so the recorded proof binds to it (fixed salt, placeholder tx). Refuses when the live signer is not the sample's key or the result would not verify, so a key rotation cannot poison the fixtures. */
function proofBoundToSampleLog(x: { completionId: string; requestBody: Uint8Array; responseBody: Uint8Array; signature: CompletionSignature }): ModelProof {
  const sampleEntry = loadSampleLogEntry();
  if (normalizeHex(sampleEntry.signing_address) !== normalizeHex(x.signature.signer.signingAddress)) throw new Error(`live signer ${short(x.signature.signer.signingAddress)} differs from the sample log entry key ${short(sampleEntry.signing_address)}: re-record attestation-report.json and key-entry.sample.json first`);
  const proof = buildModelProof({ ...x, model, logEntry: sampleEntry, verifiedAt, e2ee: true, salt: '0123456789abcdef'.repeat(4) });
  const check = verifyModelProof(proof, x.requestBody, x.responseBody, sampleEntry);
  if (!check.ok) throw new Error(`recorded proof does not verify: ${check.checks.filter((c) => c.status === 'fail').map((c) => c.detail).join('; ')}`);
  return { ...proof, commitTx: 'SAMPLE-not-committed' };
}

function recordSamples(x: { completionId: string; requestBody: Uint8Array; responseBody: Uint8Array; signature: CompletionSignature; reply: string }): void {
  const bound = proofBoundToSampleLog(x); // throws before anything is written
  const at = (name: string) => new URL(name, samplesDir);
  writeFileSync(at('e2ee-chat-request.raw.json'), x.requestBody);
  writeFileSync(at('e2ee-chat-response.raw.json'), x.responseBody);
  writeJson(at('e2ee-signature.json'), { text: x.signature.signedText, signature: x.signature.signature, signing_address: x.signature.signer.signingAddress, signing_algo: x.signature.signer.signingAlgo, signature_kind: x.signature.kind });
  writeJson(at('e2ee-plaintext.json'), { _note: 'What the recording client sent and decrypted. NOT covered by the proof (which is over the ciphertext bytes): shown in the replay card for readability only.', model, prompt: message, reply: x.reply, completionId: x.completionId, recordedAt: new Date().toISOString() });
  writeJson(at('model-proof-e2ee.sample.json'), { _note: 'SAMPLE model proof for the recorded E2EE exchange (e2ee-*.json). logIndex/verifier refer to key-entry.sample.json; salt is a fixed test value; commitTx is a placeholder.', proof: bound });
  console.log('\nrecorded: e2ee-chat-request.raw.json, e2ee-chat-response.raw.json, e2ee-signature.json, e2ee-plaintext.json, model-proof-e2ee.sample.json');
}

/** Pretty JSON with a trailing newline, the way every file in docs/samples is written. */
function writeJson(file: string | URL, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
