// `pnpm demo:metrics [--runs N] [--out <file>]`: N live Tier-1 runs for the README metrics table (ROADMAP: the Nov 10–11 run).
// Every run does what the chat does, from Node with the server-side API key, with nothing cached between runs: fresh gateway
// and model attestation, the public-log check with the honest key and with a swapped one, one E2EE exchange, the signature,
// the byte-exact check and our proof. Timings and outcomes go to a JSON file; a markdown table is printed for the README.
// The on-chain commit is not part of a run (it needs a wallet); its cost is a constant measured once (see docs/DEV-NOTES.md).
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  AttestationClient,
  NO_ALIASING_HEADER,
  createPinnedTlsFetch,
  findModelAttestationForSignature,
  prepareE2eeChatRequest,
  verifyGatewayAttestation,
  verifyModelAttestation,
  verifyModelResponse,
  type TcbStatus,
} from '@nearai/inference-sdk/node';
import { ainekConfigFromEnv, buildModelProof, evaluateKeyLog, keyLogReader, verifyModelProof, type KeyEntry } from '@ainek/proof';
import { FAIL, OK, describe, line } from './term.ts';

const { values: flags } = parseArgs({ options: { runs: { type: 'string', default: '10' }, out: { type: 'string', default: 'docs/metrics.json' } }, strict: false });
const runs = Number(flags.runs);
if (!Number.isInteger(runs) || runs < 1) usage('--runs must be a positive integer');
const outFile = path.resolve(process.env.INIT_CWD ?? process.cwd(), String(flags.out));

// Root .env (CLAUDE.md: secrets live in one file); loadEnvFile never overrides variables already set, so the shell wins.
const repoRoot = path.resolve(import.meta.dirname, '../../..');
if (existsSync(path.join(repoRoot, '.env'))) process.loadEnvFile(path.join(repoRoot, '.env'));
const apiKey: string = process.env.NEARAI_API_KEY ?? usage('NEARAI_API_KEY is not set (root .env)');
const cfg = ainekConfigFromEnv(process.env);
if (cfg.logSource !== 'contract') usage('metrics need the live log (AINEK_LOG_SOURCE=contract)');
const { model, nearaiBaseUrl: baseUrl } = cfg;
const SIGNING_ALGO = 'ed25519' as const;
const policy = { acceptedTcbStatuses: cfg.acceptedTcbStatuses as TcbStatus[] };
const SWAPPED_KEY = 'ab'.repeat(32); // what `--tamper` and the chat's switch show the client instead of the attested key
const PROMPT = 'Reply with the single word: ok.';
const log = keyLogReader(cfg.rpcUrl, cfg.contract);

/** One run, every number in milliseconds. `outcome` is what the chat would have shown. */
interface Run {
  n: number;
  attestMs: number;
  logMs: number;
  honestLogged: boolean;
  swappedRefused: boolean;
  replyMs: number;
  signatureMs: number;
  totalMs: number;
  bytesSent: number;
  bytesReceived: number;
  outcome: 'verified' | 'refused' | 'failed';
  error?: string;
}

async function runOnce(n: number): Promise<Run> {
  const client = new AttestationClient({ apiKey, baseUrl, headers: { [NO_ALIASING_HEADER]: 'true' } }); // new client: no cache carries over
  const run: Run = { n, attestMs: 0, logMs: 0, honestLogged: false, swappedRefused: false, replyMs: 0, signatureMs: 0, totalMs: 0, bytesSent: 0, bytesReceived: 0, outcome: 'failed' };
  const tStart = performance.now();
  try {
    const meta = await client.fetchModelMetadata(model);
    if (meta.attestationSupported !== true) throw new Error(`${model} reports no model attestation`);

    const tAttest = performance.now();
    const [gateway, models] = await Promise.all([
      client.fetchGatewayAttestation({ signingAlgo: SIGNING_ALGO }).then((f) => verifyGatewayAttestation({ attestation: f.attestation, clientBinding: f.clientBinding, policy })),
      client.fetchModelAttestations({ model, signingAlgo: SIGNING_ALGO }).then((f) => Promise.all(f.attestations.map((attestation) => verifyModelAttestation({ attestation, clientBinding: f.clientBinding, policy: { ...policy, gpuEvidence: 'required' } })))),
    ]);
    run.attestMs = performance.now() - tAttest;
    const verifiedAt = new Date().toISOString();
    if (gateway.tlsBinding.kind !== 'attested') throw new Error(`gateway TLS binding is ${gateway.tlsBinding.kind}`);
    const modelAttestation = models.find((m) => m.signingPublicKey !== undefined);
    if (!modelAttestation?.signingPublicKey) throw new Error('no verified model attestation with an E2EE key');

    const tLog = performance.now();
    const entries = await log.latestKeys(model);
    run.logMs = performance.now() - tLog;
    const query = { model, trustedVerifiers: cfg.trustedVerifiers, quorum: cfg.quorum };
    const honest = evaluateKeyLog(entries, { ...query, signingAddress: modelAttestation.signer.signingAddress });
    const swapped = evaluateKeyLog(entries, { ...query, signingAddress: SWAPPED_KEY });
    run.honestLogged = honest.status === 'ok';
    run.swappedRefused = swapped.status !== 'ok';
    if (honest.status !== 'ok') {
      run.outcome = 'refused';
      run.error = honest.detail;
      return run;
    }
    const logEntry = honest.matching[0] as KeyEntry;

    const plain = new Request(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', [NO_ALIASING_HEADER]: 'true' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: PROMPT }], stream: false }),
    });
    const prepared = await prepareE2eeChatRequest({ request: plain, modelKey: { signingAlgo: modelAttestation.signer.signingAlgo, publicKey: modelAttestation.signingPublicKey } });
    const requestBody = new Uint8Array(await prepared.request.clone().arrayBuffer());
    const tReply = performance.now();
    const encrypted = await createPinnedTlsFetch(gateway.tlsBinding.spkiFingerprint)(prepared.request);
    if (!encrypted.ok) throw new Error(`chat completion failed: HTTP ${encrypted.status}`);
    const forVerification = encrypted.clone();
    const decrypted = await prepared.decryptResponse(encrypted);
    const [responseBytes, plaintext] = await Promise.all([forVerification.arrayBuffer(), decrypted.text()]);
    run.replyMs = performance.now() - tReply;
    const responseBody = new Uint8Array(responseBytes);
    run.bytesSent = requestBody.length;
    run.bytesReceived = responseBody.length;
    const completion = JSON.parse(plaintext) as { id: string };

    const tSig = performance.now();
    const signature = await client.fetchCompletionSignature({ completionId: completion.id, signingAlgo: SIGNING_ALGO });
    run.signatureMs = performance.now() - tSig;
    const signer = findModelAttestationForSignature({ attestations: models, signature });
    verifyModelResponse({ requestBody, responseBody, signature, attestation: signer });
    const proof = buildModelProof({ completionId: completion.id, model, signature, requestBody, responseBody, logEntry, verifiedAt, e2ee: true });
    const report = verifyModelProof(proof, requestBody, responseBody, logEntry);
    run.outcome = report.ok ? 'verified' : 'failed';
    if (!report.ok) run.error = report.checks.filter((c) => c.status === 'fail').map((c) => `${c.id}: ${c.detail}`).join('; ');
  } catch (err) {
    run.error = describe(err);
  }
  run.totalMs = performance.now() - tStart;
  return run;
}

console.log(`Ainek metrics: ${runs} live run(s) of ${model} via ${baseUrl}, log ${cfg.contract}`);
const results: Run[] = [];
for (let n = 1; n <= runs; n++) {
  const run = await runOnce(n);
  results.push(run);
  line(run.outcome === 'verified' ? OK : FAIL, `run ${n}: ${run.outcome} in ${s(run.totalMs)} (attest ${s(run.attestMs)}, log ${s(run.logMs)}, reply ${s(run.replyMs)}, signature ${s(run.signatureMs)}); swapped key refused: ${run.swappedRefused}${run.error ? `; ${run.error}` : ''}`);
}

const verified = results.filter((r) => r.outcome === 'verified');
const summary = {
  model,
  contract: cfg.contract,
  runs: results.length,
  verified: verified.length,
  refusedHonestKey: results.filter((r) => r.outcome === 'refused').length,
  failed: results.filter((r) => r.outcome === 'failed').length,
  swappedKeyRefused: results.filter((r) => r.swappedRefused).length,
  attestMs: stats(results.map((r) => r.attestMs)),
  logMs: stats(results.map((r) => r.logMs)),
  replyMs: stats(verified.map((r) => r.replyMs)),
  signatureMs: stats(verified.map((r) => r.signatureMs)),
  totalMs: stats(verified.map((r) => r.totalMs)),
  bytesSent: stats(verified.map((r) => r.bytesSent)),
  bytesReceived: stats(verified.map((r) => r.bytesReceived)),
  measuredAt: new Date().toISOString(),
};
writeFileSync(outFile, `${JSON.stringify({ summary, runs: results }, null, 2)}\n`);

console.log(`\n| Metric | Value (${results.length} runs) |\n| --- | --- |`);
console.log(`| Verified end to end | ${summary.verified} of ${summary.runs} |`);
console.log(`| Swapped key refused before sending | ${summary.swappedKeyRefused} of ${summary.runs} |`);
console.log(`| Honest key refused (log window empty or key unlogged) | ${summary.refusedHonestKey} |`);
console.log(`| Attestation (gateway + model, cold, in Node) | median ${s(summary.attestMs.median)}, max ${s(summary.attestMs.max)} |`);
console.log(`| Public log read (latest_keys view) | median ${s(summary.logMs.median)} |`);
console.log(`| E2EE round trip to the model | median ${s(summary.replyMs.median)}, max ${s(summary.replyMs.max)} |`);
console.log(`| Signature fetch | median ${s(summary.signatureMs.median)} |`);
console.log(`| Whole run | median ${s(summary.totalMs.median)}, max ${s(summary.totalMs.max)} |`);
console.log(`| Ciphertext per exchange | ${Math.round(summary.bytesSent.median)} B sent, ${Math.round(summary.bytesReceived.median)} B received |`);
console.log(`\nwritten: ${outFile}`);
process.exit(summary.verified === summary.runs ? 0 : 1);

function s(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
function stats(xs: number[]): { median: number; mean: number; max: number } {
  if (xs.length === 0) return { median: 0, mean: 0, max: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)] ?? 0, mean: xs.reduce((a, b) => a + b, 0) / xs.length, max: sorted[sorted.length - 1] ?? 0 };
}
function usage(reason: string): never {
  console.error(`${reason}\nusage: pnpm demo:metrics [--runs N] [--out <file>]`);
  process.exit(2);
}
