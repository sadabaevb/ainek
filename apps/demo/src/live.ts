// `pnpm demo:live [--record] [--disclose <file>] [--message "…"]`: the Tier-1 flow from Node with the server-side API key
// (the sequence is @ainek/tier1-node, shared with demo:metrics and the agent), printed step by step, then the proof card. `--record` writes the
// exchange into docs/samples so the offline replay (`pnpm demo`) has an E2EE sample. `--disclose <file>` writes the
// "Disclose to auditor" file of this run (SPEC §5.4), the same bytes a proof card downloads, for /auditor and /verify.
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildCheckedModelProof, composeHashOf, normalizeHex, shortHex as short, toDisclosure, type ModelProof } from '@ainek/proof';
import { contractLog, nothingSent, replyOf, runTier1, type StepId, type Verified } from '@ainek/tier1-node';
import { loadLiveEnv } from './env.ts';
import { loadSampleLogEntry, samplesDir } from './evidence.ts';
import { FAIL, NA, OK, exitFlushed, head, line, markOf, seconds } from './term.ts';

const { values: flags } = parseArgs({ options: { record: { type: 'boolean', default: false }, disclose: { type: 'string' }, message: { type: 'string', default: 'Reply with exactly three words.' } }, strict: false });
const record = flags.record === true;
const message = String(flags.message);
// `--disclose` needs a file; parseArgs (strict: false) would otherwise swallow the next flag as the value or yield `true` for a bare one.
if (flags.disclose !== undefined && (typeof flags.disclose !== 'string' || flags.disclose.startsWith('-'))) usage('--disclose needs a file path');
// INIT_CWD is where pnpm ran: the repo root for `pnpm demo:live` (the root script nests a second pnpm), the shell's directory for
// `pnpm -F demo live`. An absolute path works from anywhere.
const discloseFile = typeof flags.disclose === 'string' ? path.resolve(process.env.INIT_CWD ?? process.cwd(), flags.disclose) : '';
if (discloseFile && !existsSync(path.dirname(discloseFile))) usage(`--disclose: directory ${path.dirname(discloseFile)} does not exist`);

const env = loadLiveEnv();
const apiKey: string = env.apiKey ?? usage('NEARAI_API_KEY is not set (root .env). The offline replay needs no key: pnpm demo');
const { cfg } = env;
// A disclosure embeds the log entry as the chain returns it at that moment; sample mode never reads the chain.
if (discloseFile && cfg.logSource === 'sample') usage('--disclose needs the contract log (AINEK_LOG_SOURCE=contract): the disclosure embeds the entry read from the chain');
const { model, nearaiBaseUrl: baseUrl } = cfg;

console.log(`Ainek live: ${model} via ${baseUrl}${record ? ' (recording to docs/samples)' : ''}`);
const HEADS: Partial<Record<StepId, string>> = { metadata: `0. Model metadata: ${model}`, attestation: '1–2. Gateway and model attestation', 'key-log': '3. Public key log', encrypt: '4. E2EE request', signature: '5. Signature and proof' };
const outcome = await runTier1({
  apiKey,
  cfg,
  chat: { messages: [{ role: 'user', content: message }] },
  // The recorded sample entry only when AINEK_LOG_SOURCE=sample asks for it explicitly; the trust set comes from the shared config either way.
  readLog: cfg.logSource === 'sample' ? async () => ({ entries: [loadSampleLogEntry()], source: 'sample (docs/samples/key-entry.sample.json, AINEK_LOG_SOURCE=sample)' }) : contractLog(cfg),
  onStep: (e) => {
    const title = HEADS[e.id];
    if (title) head(title);
    if (e.status === 'ok') line(OK, `${e.detail} (${seconds(e.ms)})`);
    else line(FAIL, nothingSent(e.id) ? `${e.detail} (nothing was sent)` : e.detail);
  },
});
if (outcome.kind === 'verified') {
  printVerified(outcome);
} else {
  // REFUSED is the fail-closed rule (the key is not in the log); anything else that stopped the run before the send is a failure, but still nothing left this process.
  if (outcome.kind === 'failed' && outcome.unverifiedCompletion) line(NA, `reply as it came, NOT verified: ${JSON.stringify(replyOf(outcome.unverifiedCompletion))}`);
  console.log(outcome.kind === 'refused' ? '\nResult: REFUSED. Nothing was sent.' : nothingSent(outcome.step) ? '\nResult: FAILED before sending. Nothing was sent.' : '\nResult: FAILED.');
  if (record || discloseFile) console.log('nothing written: the run did not verify');
}
await exitFlushed(outcome.kind === 'verified' ? 0 : 1);

// ---- helpers ----
/** The proof checks, the card, then the files `--record` and `--disclose` asked for. */
function printVerified(v: Verified & { totalMs: number }): void {
  line(NA, `reply: ${JSON.stringify(replyOf(v.completion))}`);
  for (const c of v.report.checks) line(markOf(c.status), `proof.${c.id}: ${c.detail}`);
  line(NA, 'commit on NEAR: not in this mode (the web client commits with the wallet; the salt stays with the proof)');
  const { signer, logEntry, logSource, proof } = v;
  console.log('\n┌─ Ainek proof card ─ live ───────────────────────────────────────────');
  const compose = composeHashOf(signer.deployment);
  console.log(`│ ${OK} Model: ${model}, attested deployment (compose ${short(compose)})`);
  console.log(`│ ${OK} Hardware: Intel TDX ${signer.tcbStatus}, NVIDIA GPU ${signer.gpuEvidence}; chat request pinned to the attested gateway`);
  console.log(`│ ${OK} Key #${logEntry.index} in the public log, logged by ${logEntry.verifier} (${logSource})${normalizeHex(logEntry.compose_hash) === compose ? '' : '; this entry has another compose, the attested one is not in the log window'}`);
  console.log(`│ ${OK} Request and response: hashes match the signature made inside the model TEE`);
  console.log(`│ ${OK} End-to-end encryption: yes, encrypted to the attested model key`);
  console.log(`│ ${NA} On NEAR: commit ${short(proof.commit ?? '')} computed, not sent in this mode`);
  console.log(`└─ Result: VERIFIED in ${seconds(v.totalMs)}`);
  if (record) recordSamples(v);
  if (discloseFile) {
    writeJson(discloseFile, toDisclosure({ proof, logEntry, requestBody: v.requestBody, responseBody: v.responseBody }));
    console.log(`\ndisclosure written: ${discloseFile} (proof + salt + exact ciphertext bytes + log entry; keep it private, it is the file an auditor gets)`);
  }
}

/** A flag the run cannot proceed with: say so before any network call or spend. */
function usage(reason: string): never {
  console.error(`${reason}\nusage: pnpm demo:live [--record] [--disclose <file>] [--message "…"]`);
  return process.exit(2);
}

/** The offline replay verifies against the recorded sample log entry, so the recorded proof binds to it (fixed salt, placeholder tx). Refuses when the live signer is not the sample's key or the result would not verify, so a key rotation cannot poison the fixtures. */
function proofBoundToSampleLog(v: Verified): ModelProof {
  const sampleEntry = loadSampleLogEntry();
  if (normalizeHex(sampleEntry.signing_address) !== normalizeHex(v.signature.signer.signingAddress)) throw new Error(`live signer ${short(v.signature.signer.signingAddress)} differs from the sample log entry key ${short(sampleEntry.signing_address)}: re-record attestation-report.json and key-entry.sample.json first`);
  try {
    const { proof } = buildCheckedModelProof({ completionId: v.completion.id, model, signature: v.signature, requestBody: v.requestBody, responseBody: v.responseBody, logEntry: sampleEntry, verifiedAt: v.proof.verifiedAt, e2ee: true, toolNames: v.proof.toolNames, salt: '0123456789abcdef'.repeat(4) });
    return { ...proof, commitTx: 'SAMPLE-not-committed' };
  } catch (err) {
    throw new Error(`recorded proof does not verify: ${(err as Error).message}`);
  }
}

function recordSamples(v: Verified): void {
  const bound = proofBoundToSampleLog(v); // throws before anything is written
  const at = (name: string) => new URL(name, samplesDir);
  writeFileSync(at('e2ee-chat-request.raw.json'), v.requestBody);
  writeFileSync(at('e2ee-chat-response.raw.json'), v.responseBody);
  writeJson(at('e2ee-signature.json'), { text: v.signature.signedText, signature: v.signature.signature, signing_address: v.signature.signer.signingAddress, signing_algo: v.signature.signer.signingAlgo, signature_kind: v.signature.kind });
  writeJson(at('e2ee-plaintext.json'), { _note: 'What the recording client sent and decrypted. NOT covered by the proof (which is over the ciphertext bytes): shown in the replay card for readability only.', model, prompt: message, reply: replyOf(v.completion), completionId: v.completion.id, recordedAt: new Date().toISOString() });
  writeJson(at('model-proof-e2ee.sample.json'), { _note: 'SAMPLE model proof for the recorded E2EE exchange (e2ee-*.json). logIndex/verifier refer to key-entry.sample.json; salt is a fixed test value; commitTx is a placeholder.', proof: bound });
  console.log('\nrecorded: e2ee-chat-request.raw.json, e2ee-chat-response.raw.json, e2ee-signature.json, e2ee-plaintext.json, model-proof-e2ee.sample.json');
}

/** Pretty JSON with a trailing newline, the way every file in docs/samples is written. */
function writeJson(file: string | URL, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
