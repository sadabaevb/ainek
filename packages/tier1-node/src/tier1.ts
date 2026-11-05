// The Tier-1 sequence from Node with a server-side API key, shared by `demo:live`, `demo:metrics` and the agent service.
// Mirror of apps/web/lib/flow.ts (same steps, same order, the step ids of TIER1_STEPS in @ainek/proof; keep the two in
// sync): the model must support model attestation, gateway + model evidence verified here, the public log read meanwhile,
// fail-closed check of the attested key, one E2EE request with the exact bytes kept, the signature, the SDK byte-exact
// check and our proof. On purpose unlike the browser: no relay (direct to NEAR AI), the chat request TLS-pinned to the
// attested gateway (a browser cannot observe the TLS peer), nothing cached between calls (every call is a cold first
// message). The on-chain commit is not here: it needs a key, and whose key depends on the caller.
import {
  AttestationClient,
  NO_ALIASING_HEADER,
  createPinnedTlsFetch,
  findModelAttestationForSignature,
  prepareE2eeChatRequest,
  verifyGatewayAttestation,
  verifyModelAttestation,
  verifyModelResponse,
  type CompletionSignature,
  type TcbStatus,
  type VerifiedModelAttestation,
} from '@nearai/inference-sdk/node';
import { buildModelProof, evaluateKeyLog, failurePhase, keyLogReader, shortHex as short, verifyModelProof, type AinekConfig, type KeyEntry, type KeyLogVerdict, type ModelProof, type Tier1StepId, type VerifyReport } from '@ainek/proof';
import { describeSdkError } from './errors.ts';
import { withRetry } from './retry.ts';

export const SIGNING_ALGO = 'ed25519' as const;

/** The shared step ids (TIER1_STEPS in @ainek/proof); `store` and `commit` belong to the browser (IndexedDB, wallet). */
export type StepId = Tier1StepId;

/** True when a failure at `step` happened before the request left this process. */
export function nothingSent(step: StepId): boolean {
  return failurePhase(step) === 'not-sent';
}

export interface StepEvent {
  id: StepId;
  status: 'ok' | 'fail';
  detail: string;
  ms: number;
}
/** Milliseconds per step, only for the steps that ran. `key-log` is the RPC read itself, which overlaps `attestation`, so the steps add up to more than the whole run. */
export type Timings = Partial<Record<StepId, number>>;

// ---- the chat request (OpenAI-compatible; under E2EE the SDK encrypts message contents, function tools and tool calls) ----
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export interface FunctionTool {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}
export type ToolChoice = 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
export interface ChatInput {
  messages: ChatMessage[];
  tools?: FunctionTool[];
  tool_choice?: ToolChoice;
  temperature?: number;
  max_tokens?: number;
}
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
/** The decrypted completion, the parts the callers read. */
export interface ChatCompletion {
  id: string;
  choices: Array<{ message: { content: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }>;
}

// ---- the public log ----
export interface LogRead {
  entries: KeyEntry[];
  source: string;
}
export type ReadLog = (model: string) => Promise<LogRead>;
/** The contract log over JSON-RPC, what the browser reads too (an unreachable contract fails the run before sending, never a silent fallback). */
export function contractLog(cfg: Pick<AinekConfig, 'rpcUrl' | 'contract'>): ReadLog {
  const reader = keyLogReader(cfg.rpcUrl, cfg.contract);
  return async (model) => ({ entries: await reader.latestKeys(model), source: `contract ${cfg.contract} via ${new URL(cfg.rpcUrl).host}` });
}

// ---- outcomes ----
export interface Verified {
  kind: 'verified';
  /** The model report whose key signed the reply. */
  signer: VerifiedModelAttestation;
  verifiedAt: string;
  entries: KeyEntry[];
  logSource: string;
  logEntry: KeyEntry;
  completionId: string;
  completion: ChatCompletion;
  /** The assistant text, '' when the model answered with tool calls only. */
  reply: string;
  requestBody: Uint8Array;
  responseBody: Uint8Array;
  signature: CompletionSignature;
  proof: ModelProof;
  report: VerifyReport;
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
  chat: ChatInput;
  onStep?: (event: StepEvent) => void;
  /** Where the log comes from; the contract by default. The demo passes the recorded sample entry when AINEK_LOG_SOURCE=sample. */
  readLog?: ReadLog;
}

/** One cold run of the Tier-1 sequence. Never throws after it starts: a step that fails ends the run as `failed` at that step; a key the log does not confirm ends it as `refused`. */
export async function runTier1({ apiKey, cfg, chat, onStep = () => undefined, readLog }: Tier1Params): Promise<Tier1Outcome> {
  if (!readLog && cfg.logSource !== 'contract') throw new Error(`AINEK_LOG_SOURCE=${cfg.logSource}: pass readLog (this package reads only the contract)`);
  const loadLog = readLog ?? contractLog(cfg);
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
  // `timings` is copied: the parallel log read may still land after a run that failed at attestation, and that run must not grow a number for a step it never reached.
  const done = <O extends Verified | Refused | Failed>(outcome: O): O & { timings: Timings; totalMs: number; retries: number } => ({ ...outcome, timings: { ...timings }, totalMs: performance.now() - t0, retries });

  try {
    // 0. The chosen model must support model attestation: never a silent downgrade to plaintext.
    await step(
      'metadata',
      async () => {
        const meta = await retrying(() => client.fetchModelMetadata(model));
        if (meta.attestationSupported !== true) throw new Error(`${model} reports no model attestation (provider ${String(meta.providerType)}): refusing to send in plaintext`);
        return meta;
      },
      (m) => `${model}: provider ${String(m.providerType)}, model attestation supported`,
    );

    // 1. Gateway and model evidence, verified here; the public log is read meanwhile (independent; the send waits for both).
    const tLog = performance.now();
    const logPromise = loadLog(model).then((log) => {
      timings['key-log'] = performance.now() - tLog;
      return log;
    });
    logPromise.catch(() => undefined); // awaited in step 2; a rejection must not surface before then
    const { gateway, models, modelAttestation, modelPublicKey, pinnedFetch } = await step(
      'attestation',
      async () => {
        const [gateway, models] = await Promise.all([
          retrying(() => client.fetchGatewayAttestation({ signingAlgo: SIGNING_ALGO }).then((f) => verifyGatewayAttestation({ attestation: f.attestation, clientBinding: f.clientBinding, policy }))),
          retrying(() => client.fetchModelAttestations({ model, signingAlgo: SIGNING_ALGO }).then((f) => Promise.all(f.attestations.map((attestation) => verifyModelAttestation({ attestation, clientBinding: f.clientBinding, policy: { ...policy, gpuEvidence: 'required' } }))))),
        ]);
        // Node can observe the TLS peer: a gateway report without the TLS binding means the chat request could not be pinned, so stop.
        if (gateway.tlsBinding.kind !== 'attested') throw new Error(`gateway TLS binding is ${gateway.tlsBinding.kind}: the chat request cannot be pinned to the attested gateway`);
        const modelAttestation = models.find((m) => m.signingPublicKey !== undefined);
        const modelPublicKey = modelAttestation?.signingPublicKey; // its own const: the narrowing has to survive into the encrypt step's closure
        if (!modelAttestation || !modelPublicKey) throw new Error('no verified model attestation with an E2EE key');
        return { gateway, models, modelAttestation, modelPublicKey, pinnedFetch: createPinnedTlsFetch(gateway.tlsBinding.spkiFingerprint) };
      },
      (a) => `gateway TCB ${a.gateway.tcbStatus}, signer ${short(a.gateway.signer.signingAddress)}, TLS binding ${a.gateway.tlsBinding.kind}; ${a.models.length} model report${a.models.length === 1 ? '' : 's'}: ${a.models.map((m) => `${short(m.signer.signingAddress)} ${m.tcbStatus}/gpu ${m.gpuEvidence} compose ${short(m.deployment.runtimeMeasurements.composeHash ?? '')}`).join('; ')}`,
    );
    const verifiedAt = new Date().toISOString();

    // 2. Fail-closed: the attested signing key must be in the public log (compose hash shown, not enforced: DEV-NOTES 2026-11-02).
    running = 'key-log';
    stepStart = tLog;
    const { entries, source: logSource } = await logPromise.catch((err: unknown) => {
      throw new Error(`public log unavailable (${describeSdkError(err)})`);
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
            body: JSON.stringify({ model, stream: false, ...chat }),
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
        return { responseBody: new Uint8Array(bytes), completion: JSON.parse(plaintext) as ChatCompletion };
      },
      (r) => `completion ${r.completion.id}: ${requestBody.length} B ciphertext sent, ${r.responseBody.length} B received; reply: ${JSON.stringify(replyOf(r.completion))}`,
    );

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
    return done({ kind: 'verified', signer, verifiedAt, entries, logSource, logEntry, completionId: completion.id, completion, reply: replyOf(completion), requestBody, responseBody, signature, proof, report });
  } catch (err) {
    const reason = describeSdkError(err);
    onStep({ id: running, status: 'fail', detail: reason, ms: performance.now() - stepStart });
    return done({ kind: 'failed', step: running, reason });
  }
}

/** The assistant's text; a tool-call-only answer has none. */
export function replyOf(completion: ChatCompletion): string {
  return completion.choices[0]?.message.content ?? '';
}

/** The function calls the model made, in order; empty for a plain text answer. */
export function toolCallsOf(completion: ChatCompletion): ToolCall[] {
  return completion.choices[0]?.message.tool_calls ?? [];
}
