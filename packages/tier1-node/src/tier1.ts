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
  type InferenceChatCompletions,
  type TcbStatus,
  type VerifiedModelAttestation,
} from '@nearai/inference-sdk/node';
import { buildCheckedModelProof, composeHashOf, evaluateKeyLog, failurePhase, keyLogReader, latestKeysFor, parseChatCompletion, proofEntryOf, requireE2eeVersion, shortHex as short, withRetry, type AinekConfig, type KeyEntry, type KeyLogVerdict, type ModelProof, type Tier1StepId, type VerifyReport } from '@ainek/proof';
import { describeSdkError } from './errors.ts';
import { sdkRetryable } from './retry.ts';

const SIGNING_ALGO = 'ed25519' as const;
/** No step may wait longer: a long-running service handles messages one at a time, and the SDK's pinned requests have no timeout of their own. Well above the slowest step seen (attestation 40 s, reply 23 s). */
const STEP_TIMEOUT_MS = 120_000;

/** The shared step ids (TIER1_STEPS in @ainek/proof); `store` and `commit` belong to the browser (IndexedDB, wallet). */
export type StepId = Tier1StepId;

/** True when a failure at `step` happened before the request left this process. */
export function nothingSent(step: StepId): boolean {
  return failurePhase(step) === 'not-sent';
}

export interface StepEvent {
  id: StepId;
  status: 'ok' | 'fail';
  /** Never carries plaintext from the model: a server may log it. */
  detail: string;
  ms: number;
}
/** Milliseconds per step, only for the steps that ran. `key-log` is the RPC read itself, which overlaps `attestation`, so the steps add up to more than the whole run. */
export type Timings = Partial<Record<StepId, number>>;
export interface RunStats {
  timings: Timings;
  totalMs: number;
  /** SDK-retryable failures retried on the way. */
  retries: number;
}

// ---- the chat request: OpenAI's Chat Completions shapes as the SDK types them. Under E2EE the SDK encrypts message contents, function
// tools, the named function in `tool_choice` and the tool calls in the reply; every other field travels in the clear. So this is an
// allowlist, in the type and again at runtime (chatBody): `response_format` would show the gateway a JSON schema naming the fields of
// the answer (structured output goes through a function tool), `metadata`, `user`, `stop`, `prediction` and custom tools would carry
// content in the clear, and `n` would give choices nobody reads. `temperature` and `max_tokens` are in the clear and say nothing.
type CreateBody = Parameters<InferenceChatCompletions['create']>[0];
export type ChatMessage = CreateBody['messages'][number];
export type ChatTool = Extract<NonNullable<CreateBody['tools']>[number], { type: 'function' }>;
export interface ChatInput {
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: 'none' | 'auto' | 'required' | Extract<NonNullable<CreateBody['tool_choice']>, { type: 'function' }>;
  temperature?: number;
  max_tokens?: number;
}
export type ChatCompletion = Extract<Awaited<ReturnType<InferenceChatCompletions['create']>>, { object: 'chat.completion' }>;
export type ToolCall = NonNullable<ChatCompletion['choices'][number]['message']['tool_calls']>[number];

/** The request body: the listed fields and nothing else, whatever the object carries at runtime (a variable gets no excess-property check). A tool the SDK would forward in the clear stops here, before anything is sent. */
export function chatBody(model: string, chat: ChatInput): string {
  const { messages, tools, tool_choice, temperature, max_tokens } = chat;
  for (const tool of tools ?? []) if (tool.type !== 'function' || !tool.function?.name) throw new Error('only named function tools are encrypted under E2EE: refusing to send this request');
  if (typeof tool_choice === 'object' && tool_choice.type !== 'function') throw new Error('only a named function tool_choice is encrypted under E2EE: refusing to send this request');
  return JSON.stringify({ model, stream: false, messages, tools, tool_choice, temperature, max_tokens });
}

/** The tools offered to the model, by name: what the proof records as `toolNames` (SPEC §5.1). */
export function toolNamesOf(chat: Pick<ChatInput, 'tools'>): string[] {
  return (chat.tools ?? []).map((t) => t.function.name);
}

/** A promise that gives up: what it was waiting for is abandoned, and the run ends `failed` at that step. */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000} s`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** An observer of the run must not be able to change its outcome: a throw or a rejection from it goes nowhere. */
export function observed(onStep: (event: StepEvent) => void): (event: StepEvent) => void {
  return (event) => {
    try {
      void Promise.resolve(onStep(event)).catch(() => undefined);
    } catch {
      // ignored: see above
    }
  };
}
/** The assistant's text; a tool-call-only answer has none. */
export function replyOf(completion: ChatCompletion): string {
  return completion.choices[0]?.message.content ?? '';
}
/** The function calls the model made, in order, with their JSON argument text; empty for a plain text answer. */
export function functionCallsOf(completion: ChatCompletion): Array<{ id: string; name: string; arguments: string }> {
  return (completion.choices[0]?.message.tool_calls ?? []).flatMap((t) => (t.type === 'function' ? [{ id: t.id, name: t.function.name, arguments: t.function.arguments }] : []));
}

// ---- the public log ----
/** Reads the log for `model`; `signal` is aborted when the run fails before the read is needed, so a reader should stop then. */
export type ReadLog = (model: string, signal: AbortSignal) => Promise<{ entries: KeyEntry[]; source: string }>;
/** The contract log over JSON-RPC, what the browser reads too (an unreachable contract fails the run before sending, never a silent fallback). */
export function contractLog(cfg: Pick<AinekConfig, 'rpcUrl' | 'contract' | 'trustedVerifiers'>): ReadLog {
  const reader = keyLogReader(cfg.rpcUrl, cfg.contract);
  return async (model, signal) => ({ entries: await latestKeysFor(reader, model, cfg.trustedVerifiers, undefined, signal), source: `contract ${cfg.contract} via ${new URL(cfg.rpcUrl).host}` });
}


// ---- outcomes ----
export interface Verified {
  kind: 'verified';
  /** The model report whose key signed the reply. */
  signer: VerifiedModelAttestation;
  entries: KeyEntry[];
  logSource: string;
  logEntry: KeyEntry;
  /** The decrypted reply as the model sent it (text, tool calls, usage). */
  completion: ChatCompletion;
  /** The exact ciphertext bytes the proof hashes. */
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
  /** The model answered, but a later step failed: the answer as it came, not verified. Set only for steps after `send`. */
  unverifiedCompletion?: ChatCompletion;
}
export type Tier1Outcome = (Verified | Refused | Failed) & RunStats;

export interface Tier1Params {
  apiKey: string;
  cfg: AinekConfig;
  chat: ChatInput;
  /** Where the log comes from: `contractLog(cfg)` for everything real; the demo passes the recorded entry #0 when AINEK_LOG_SOURCE=sample. Required, so no caller can trust a recording by default. */
  readLog: ReadLog;
  onStep?: (event: StepEvent) => void;
}

/** One cold run of the Tier-1 sequence. Never throws: a step that fails ends the run as `failed` at that step; a key the log does not confirm ends it as `refused`. */
export async function runTier1({ apiKey, cfg, chat, readLog, onStep: rawOnStep = () => undefined }: Tier1Params): Promise<Tier1Outcome> {
  const onStep = observed(rawOnStep);
  const { model, nearaiBaseUrl: baseUrl } = cfg;
  const policy = { acceptedTcbStatuses: cfg.acceptedTcbStatuses as TcbStatus[] }; // validated in ainekConfigFromEnv; same names as the SDK's
  // AttestationClient caches no evidence; staying off the SDK's InferenceClient (which caches attestation for 60 min) is what makes every run re-fetch and re-verify it. HTTP connections may still be reused between runs: its plain GETs go through the global fetch.
  const client = new AttestationClient({ apiKey, baseUrl, headers: { [NO_ALIASING_HEADER]: 'true' } });
  const timings: Timings = {};
  let retries = 0;
  // Once the run has returned, nothing of it may go on: no new retries of a leg still in flight, and the log read is abandoned.
  const runOver = new AbortController();
  const retrying = <T>(fn: () => Promise<T>, attempts = 3) => withRetry(fn, { retryable: (err) => !runOver.signal.aborted && sdkRetryable(err), attempts, onRetry: () => void retries++ });
  const t0 = performance.now();
  let running: StepId = 'metadata';
  let stepStart = t0;
  /** Runs one step, times it and reports it; a throw ends the run as `failed` at this step. */
  const step = async <T>(id: StepId, fn: () => Promise<T>, detail: (value: T) => string): Promise<T> => {
    running = id;
    stepStart = performance.now();
    const value = await withDeadline(fn(), STEP_TIMEOUT_MS, `the ${id} step`);
    timings[id] = performance.now() - stepStart;
    onStep({ id, status: 'ok', detail: detail(value), ms: timings[id] });
    return value;
  };
  const done = <O extends Verified | Refused | Failed>(outcome: O): O & RunStats => {
    runOver.abort();
    return { ...outcome, timings, totalMs: performance.now() - t0, retries };
  };
  let answered: ChatCompletion | undefined; // for a failure after the send: the reply as it came

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
    const logPromise = Promise.resolve()
      .then(() => readLog(model, runOver.signal)) // a reader that throws synchronously still fails the key-log step, not this one
      .then(
        (log) => ({ ok: true as const, ...log, ms: performance.now() - tLog }),
        (err: unknown) => ({ ok: false as const, err, ms: performance.now() - tLog }), // never rejects: awaited only in step 2
      );
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
      (a) => `gateway TCB ${a.gateway.tcbStatus}, signer ${short(a.gateway.signer.signingAddress)}, TLS binding ${a.gateway.tlsBinding.kind}; ${a.models.length} model report${a.models.length === 1 ? '' : 's'}: ${a.models.map((m) => `${short(m.signer.signingAddress)} ${m.tcbStatus}/gpu ${m.gpuEvidence} compose ${short(composeHashOf(m.deployment))}`).join('; ')}`,
    );
    const verifiedAt = new Date().toISOString();

    // 2. Fail-closed: the attested signing key must be in the public log, and with the deployment check on, logged with the attested compose.
    running = 'key-log';
    const log = await logPromise;
    stepStart = performance.now() - log.ms; // the read was timed by its own promise; it overlapped attestation
    if (!log.ok) throw new Error(`public log unavailable (${describeSdkError(log.err)})`);
    const { entries, source: logSource, ms: logMs } = log;
    timings['key-log'] = logMs;
    const attestedCompose = composeHashOf(modelAttestation.deployment);
    const verdict = evaluateKeyLog(entries, { model, signingAddress: modelAttestation.signer.signingAddress, trustedVerifiers: cfg.trustedVerifiers, quorum: cfg.quorum, composeHash: cfg.requireLoggedDeployment ? attestedCompose : undefined });
    if (verdict.status !== 'ok') {
      onStep({ id: 'key-log', status: 'fail', detail: `${verdict.detail} (source: ${logSource})`, ms: logMs });
      return done({ kind: 'refused', step: 'key-log', reason: verdict.detail, entries, logSource, verdict });
    }
    const logEntry = proofEntryOf(verdict, attestedCompose);
    onStep({ id: 'key-log', status: 'ok', detail: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in window; key #${logEntry.index} logged by ${verdict.confirmedBy.join(', ')}${cfg.requireLoggedDeployment ? ' with the attested deployment' : '; deployment check off'} (source: ${logSource})`, ms: logMs });

    // 3. Encrypt to the attested model key, keeping the exact bytes that will be hashed.
    const prepared = await step(
      'encrypt',
      async () => {
        const request = await prepareE2eeChatRequest({
          request: new Request(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', [NO_ALIASING_HEADER]: 'true' },
            body: chatBody(model, chat),
            signal: AbortSignal.timeout(STEP_TIMEOUT_MS), // closes the socket; the step's own deadline only stops waiting for it
          }),
          modelKey: { signingAlgo: modelAttestation.signer.signingAlgo, publicKey: modelPublicKey },
        });
        requireE2eeVersion(request.request.headers);
        return request;
      },
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
        answered = parseChatCompletion(plaintext) as unknown as ChatCompletion;
        return { responseBody: new Uint8Array(bytes), completion: answered };
      },
      (r) => `completion ${r.completion.id}: ${requestBody.length} B ciphertext sent, ${r.responseBody.length} B received, ${functionCallsOf(r.completion).length} tool call(s)`,
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
      async () => buildCheckedModelProof({ completionId: completion.id, model, signature, requestBody, responseBody, logEntry, verifiedAt, e2ee: true, toolNames: toolNamesOf(chat) }),
      (x) => `${x.report.checks.length} checks pass; commit ${short(x.proof.commit ?? '')}`,
    );
    return done({ kind: 'verified', signer, entries, logSource, logEntry, completion, requestBody, responseBody, signature, proof, report });
  } catch (err) {
    const reason = describeSdkError(err);
    onStep({ id: running, status: 'fail', detail: reason, ms: performance.now() - stepStart });
    return done({ kind: 'failed', step: running, reason, ...(answered ? { unverifiedCompletion: answered } : {}) });
  }
}
