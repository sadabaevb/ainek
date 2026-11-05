// The Tier-1 sequence from Node with the server-side API key, shared by `demo:live` and `demo:metrics`.
// Mirror of apps/web/lib/flow.ts (same steps, same order, same step ids; keep the two in sync): the model must support model
// attestation, gateway + model evidence verified here, the public log read meanwhile, fail-closed check of the attested key,
// one E2EE request with the exact bytes kept, the signature, the SDK byte-exact check and our proof. On purpose unlike the
// browser: no relay (direct to NEAR AI), the chat request TLS-pinned to the attested gateway (a browser cannot observe the
// TLS peer), nothing cached between calls (every call is a cold first message). The on-chain commit is not here: it needs
// a wallet.
import { existsSync } from 'node:fs';
import path from 'node:path';
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
  type VerifiedGatewayAttestation,
  type VerifiedModelAttestation,
} from '@nearai/inference-sdk/node';
import { ainekConfigFromEnv, buildModelProof, evaluateKeyLog, keyLogReader, shortHex as short, verifyModelProof, type AinekConfig, type KeyEntry, type KeyLogVerdict, type ModelProof } from '@ainek/proof';
import { loadSampleLogEntry } from './evidence.ts';
import { describe } from './term.ts';

export const SIGNING_ALGO = 'ed25519' as const;

/** The steps of flow.ts up to the proof; `store` and `commit` belong to the browser (IndexedDB, wallet). */
export type StepId = 'metadata' | 'attestation' | 'key-log' | 'encrypt' | 'send' | 'signature' | 'sdk-check' | 'proof';
const STEP_ORDER: readonly StepId[] = ['metadata', 'attestation', 'key-log', 'encrypt', 'send', 'signature', 'sdk-check', 'proof'];

/** True when a failure at `step` happened before the request left this process: the fail-closed cases. */
export function nothingSent(step: StepId): boolean {
  return STEP_ORDER.indexOf(step) < STEP_ORDER.indexOf('send');
}

export interface StepEvent {
  id: StepId;
  status: 'ok' | 'fail';
  detail: string;
  ms: number;
}
/** Milliseconds per step, only for the steps that ran. `key-log` is the RPC read itself, which overlaps `attestation`, so the steps add up to more than the whole run. */
export type Timings = Partial<Record<StepId, number>>;

export interface Verified {
  kind: 'verified';
  gateway: VerifiedGatewayAttestation;
  models: VerifiedModelAttestation[];
  /** The report whose key signed the reply. */
  signer: VerifiedModelAttestation;
  verifiedAt: string;
  entries: KeyEntry[];
  logSource: string;
  logEntry: KeyEntry;
  verdict: KeyLogVerdict;
  completionId: string;
  reply: string;
  requestBody: Uint8Array;
  responseBody: Uint8Array;
  signature: CompletionSignature;
  proof: ModelProof;
  report: ReturnType<typeof verifyModelProof>;
}
/** The attested key is not in the public log: nothing was sent (the entries are kept so a caller can test other keys against the same read). */
export interface Refused {
  kind: 'refused';
  step: 'key-log';
  reason: string;
  entries: KeyEntry[];
  logSource: string;
  verdict: KeyLogVerdict;
}
export interface Failed {
  kind: 'failed';
  step: StepId;
  reason: string;
}
export type Tier1Outcome = (Verified | Refused | Failed) & { timings: Timings; totalMs: number; retries: number };

export interface Tier1Params {
  apiKey: string;
  cfg: AinekConfig;
  message: string;
  onStep?: (event: StepEvent) => void;
}

/** The root .env (CLAUDE.md: secrets live in one file) and the shared config. loadEnvFile never overrides variables already set, so the shell wins. */
export function loadLiveEnv(): { apiKey: string | undefined; cfg: AinekConfig } {
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  if (existsSync(path.join(repoRoot, '.env'))) process.loadEnvFile(path.join(repoRoot, '.env'));
  return { apiKey: process.env.NEARAI_API_KEY || undefined, cfg: ainekConfigFromEnv(process.env) };
}

/** Same rule as apps/web/lib/nearai-browser.ts: only failures the SDK marks retryable (Intel collateral hiccups, NRAS/transport 5xx, a signature not yet on this node) are retried, with a growing pause. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, onRetry: () => void = () => undefined): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || getSdkError(err)?.retryable !== true) throw err;
      onRetry();
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

/** One cold run of the Tier-1 sequence. Never throws: a step that fails ends the run as `failed` at that step; a key the log does not confirm ends it as `refused`. */
export async function runTier1({ apiKey, cfg, message, onStep = () => undefined }: Tier1Params): Promise<Tier1Outcome> {
  const { model, nearaiBaseUrl: baseUrl } = cfg;
  const policy = { acceptedTcbStatuses: cfg.acceptedTcbStatuses as TcbStatus[] }; // validated in ainekConfigFromEnv; same names as the SDK's
  const client = new AttestationClient({ apiKey, baseUrl, headers: { [NO_ALIASING_HEADER]: 'true' } }); // a new client every run: nothing cached from an earlier one
  const timings: Timings = {};
  let retries = 0;
  const retrying = <T>(fn: () => Promise<T>, attempts?: number) => withRetry(fn, attempts, () => void retries++);
  const t0 = performance.now();
  let running: StepId = 'metadata';
  let stepStart = t0;
  /** Runs one step, times it and reports it; a throw ends the run as `failed` at this step. */
  const step = async <T>(id: StepId, fn: () => Promise<T>, detail: (value: T) => string): Promise<T> => {
    running = id;
    stepStart = performance.now();
    const value = await fn();
    timings[id] = performance.now() - stepStart;
    onStep({ id, status: 'ok', detail: detail(value), ms: timings[id] });
    return value;
  };
  const done = <O extends Verified | Refused | Failed>(outcome: O): O & { timings: Timings; totalMs: number; retries: number } => ({ ...outcome, timings, totalMs: performance.now() - t0, retries });

  try {
    // 0. The chosen model must support model attestation: never a silent downgrade to plaintext.
    const meta = await step('metadata', () => retrying(() => client.fetchModelMetadata(model)), (m) => `${model}: provider ${String(m.providerType)}, model attestation ${m.attestationSupported === true ? 'supported' : 'not supported'}`);
    if (meta.attestationSupported !== true) throw new Error(`${model} reports no model attestation: refusing to send in plaintext`);

    // 1. Gateway and model evidence, verified here; the public log is read meanwhile (independent; the send waits for both).
    const tLog = performance.now();
    const logPromise = loadLog(cfg).then((log) => {
      timings['key-log'] = performance.now() - tLog;
      return log;
    });
    logPromise.catch(() => undefined); // awaited in step 2; a rejection must not surface before then
    const [gateway, models] = await step(
      'attestation',
      () =>
        Promise.all([
          retrying(() => client.fetchGatewayAttestation({ signingAlgo: SIGNING_ALGO }).then((f) => verifyGatewayAttestation({ attestation: f.attestation, clientBinding: f.clientBinding, policy }))),
          retrying(() => client.fetchModelAttestations({ model, signingAlgo: SIGNING_ALGO }).then((f) => Promise.all(f.attestations.map((attestation) => verifyModelAttestation({ attestation, clientBinding: f.clientBinding, policy: { ...policy, gpuEvidence: 'required' } }))))),
        ]),
      ([g, ms]) => `gateway TCB ${g.tcbStatus}, signer ${short(g.signer.signingAddress)}, TLS binding ${g.tlsBinding.kind}; ${ms.length} model report${ms.length === 1 ? '' : 's'}: ${ms.map((m) => `${short(m.signer.signingAddress)} ${m.tcbStatus}/gpu ${m.gpuEvidence} compose ${short(m.deployment.runtimeMeasurements.composeHash ?? '')}`).join('; ')}`,
    );
    const verifiedAt = new Date().toISOString();
    // Node can observe the TLS peer: a gateway report without the TLS binding means the chat request could not be pinned, so stop.
    if (gateway.tlsBinding.kind !== 'attested') throw new Error(`gateway TLS binding is ${gateway.tlsBinding.kind}: the chat request cannot be pinned to the attested gateway`);
    const modelAttestation = models.find((m) => m.signingPublicKey !== undefined);
    const modelPublicKey = modelAttestation?.signingPublicKey; // its own const: the narrowing has to survive into the encrypt step's closure
    if (!modelAttestation || !modelPublicKey) throw new Error('no verified model attestation with an E2EE key');
    const pinnedFetch = createPinnedTlsFetch(gateway.tlsBinding.spkiFingerprint);

    // 2. Fail-closed: the attested signing key must be in the public log (compose hash shown, not enforced: DEV-NOTES 2026-11-02).
    running = 'key-log';
    stepStart = tLog;
    const { entries, source: logSource } = await logPromise.catch((err: unknown) => {
      throw new Error(`public log unavailable (${describe(err)})`);
    });
    const verdict = evaluateKeyLog(entries, { model, signingAddress: modelAttestation.signer.signingAddress, trustedVerifiers: cfg.trustedVerifiers, quorum: cfg.quorum });
    if (verdict.status !== 'ok') {
      onStep({ id: 'key-log', status: 'fail', detail: `${verdict.detail} (source: ${logSource})`, ms: timings['key-log'] ?? 0 });
      return done({ kind: 'refused', step: 'key-log', reason: verdict.detail, entries, logSource, verdict });
    }
    const logEntry = verdict.matching[0] as KeyEntry;
    onStep({ id: 'key-log', status: 'ok', detail: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in window; key #${logEntry.index} logged by ${verdict.confirmedBy.join(', ')} (source: ${logSource})`, ms: timings['key-log'] ?? 0 });

    // 3. Encrypt to the attested model key, keeping the exact bytes that will be hashed.
    const prepared = await step(
      'encrypt',
      () =>
        prepareE2eeChatRequest({
          request: new Request(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', [NO_ALIASING_HEADER]: 'true' },
            body: JSON.stringify({ model, messages: [{ role: 'user', content: message }], stream: false }),
          }),
          modelKey: { signingAlgo: modelAttestation.signer.signingAlgo, publicKey: modelPublicKey },
        }),
      () => `encrypted to the attested model key ${short(modelAttestation.signer.signingAddress)}`,
    );
    const requestBody = new Uint8Array(await prepared.request.clone().arrayBuffer());

    // 4. Send over the pinned connection; keep the ciphertext reply bytes, decrypt a clone.
    const { responseBody, completion } = await step(
      'send',
      async () => {
        const encrypted = await pinnedFetch(prepared.request);
        if (!encrypted.ok) throw new Error(`chat completion failed: HTTP ${encrypted.status} ${(await encrypted.text()).slice(0, 200)}`);
        const forVerification = encrypted.clone();
        const decrypted = await prepared.decryptResponse(encrypted);
        const [bytes, plaintext] = await Promise.all([forVerification.arrayBuffer(), decrypted.text()]);
        return { responseBody: new Uint8Array(bytes), completion: JSON.parse(plaintext) as { id: string; choices: Array<{ message: { content: string | null } }> } };
      },
      (r) => `completion ${r.completion.id}: ${requestBody.length} B ciphertext sent, ${r.responseBody.length} B received; reply: ${JSON.stringify(r.completion.choices[0]?.message.content ?? '')}`,
    );
    const reply = completion.choices[0]?.message.content ?? '';

    // 5. The signature made inside the model TEE, the SDK's byte-exact check, our proof.
    const signature = await step('signature', () => retrying(() => client.fetchCompletionSignature({ completionId: completion.id, signingAlgo: SIGNING_ALGO }), 4), (s) => `${s.kind} signature by ${short(s.signer.signingAddress)}`);
    const signer = await step(
      'sdk-check',
      async () => {
        const attestation = findModelAttestationForSignature({ attestations: models, signature });
        verifyModelResponse({ requestBody, responseBody, signature, attestation });
        return attestation;
      },
      () => 'SDK: the signature verifies over these exact bytes under the attested model key',
    );
    const { proof, report } = await step(
      'proof',
      async () => {
        const p = buildModelProof({ completionId: completion.id, model, signature, requestBody, responseBody, logEntry, verifiedAt, e2ee: true });
        const r = verifyModelProof(p, requestBody, responseBody, logEntry);
        if (!r.ok) throw new Error(r.checks.filter((c) => c.status === 'fail').map((c) => `${c.id}: ${c.detail}`).join('; '));
        return { proof: p, report: r };
      },
      (x) => `${x.report.checks.length} checks pass; commit ${short(x.proof.commit ?? '')}`,
    );
    return done({ kind: 'verified', gateway, models, signer, verifiedAt, entries, logSource, logEntry, verdict, completionId: completion.id, reply, requestBody, responseBody, signature, proof, report });
  } catch (err) {
    const reason = describe(err);
    onStep({ id: running, status: 'fail', detail: reason, ms: performance.now() - stepStart });
    return done({ kind: 'failed', step: running, reason });
  }
}

/** The contract log, or the recorded sample entry only when AINEK_LOG_SOURCE=sample asks for it explicitly (the trust set comes from the shared config in both cases). An unreachable contract is a failure before sending, never a silent fallback. */
async function loadLog(cfg: AinekConfig): Promise<{ entries: KeyEntry[]; source: string }> {
  if (cfg.logSource === 'sample') return { entries: [loadSampleLogEntry()], source: 'sample (docs/samples/key-entry.sample.json, AINEK_LOG_SOURCE=sample)' };
  return { entries: await keyLogReader(cfg.rpcUrl, cfg.contract).latestKeys(cfg.model), source: `contract ${cfg.contract} via ${new URL(cfg.rpcUrl).host}` };
}
