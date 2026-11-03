// The Tier-1 client flow (SPEC §7.1) as a list of steps the page shows live:
//   verify evidence in the browser → fail-closed check against the public log → E2EE send →
//   fetch the signature → SDK byte-exact check → our proof (recomputed hashes, log binding, salted commit) → IndexedDB.
import { buildModelProof, evaluateKeyLog, verifyModelProof, type KeyEntry, type KeyLogVerdict, type ModelProof, type VerifyReport } from '@ainek/proof';
import type { CompletionSignature, VerifiedGatewayAttestation, VerifiedModelAttestation } from '@nearai/inference-sdk';
import type { PublicConfig } from './config';
import { describeError } from './errors';
import { keyLogFor } from './key-log';
import {
  checkGatewayResponse,
  checkResponse,
  fetchModelMetadata,
  fetchSignature,
  sendE2ee,
  sendPlain,
  verifyDeployment,
  verifyGateway,
  type ChatMessage,
  type Exchange,
  type VerifiedDeployment,
} from './nearai-browser';
import { putExchange } from './store';
import { seconds, short } from './format';

export type { ChatMessage } from './nearai-browser';
export type StepId = 'metadata' | 'attestation' | 'key-log' | 'send' | 'signature' | 'sdk-check' | 'proof' | 'store';
export type StepStatus = 'running' | 'ok' | 'fail' | 'skipped';
export interface StepEvent {
  id: StepId;
  status: StepStatus;
  detail: string;
}

/** Steps that run after the message has left the device: a failure there is "reply not provable", not "nothing was sent". */
export const STEPS_AFTER_SEND: ReadonlySet<StepId> = new Set<StepId>(['signature', 'sdk-check', 'proof', 'store']);

export type ChatOutcome =
  | {
      kind: 'verified';
      reply: string;
      deployment: VerifiedDeployment;
      modelAttestation: VerifiedModelAttestation;
      logSource: 'contract' | 'sample';
      keyVerdict: KeyLogVerdict;
      logEntry: KeyEntry;
      exchange: Exchange;
      proof: ModelProof;
      report: VerifyReport;
    }
  | { kind: 'refused'; deployment: VerifiedDeployment; logSource: 'contract' | 'sample'; entriesInWindow: number; keyVerdict: KeyLogVerdict; seenKey: string }
  | { kind: 'non-tee'; reply: string; gateway: VerifiedGatewayAttestation; exchange: Exchange; signature: CompletionSignature; model: string }
  /** `reply` is present when the failure happened after the model had already answered. */
  | { kind: 'failed'; step: StepId; reason: string; reply?: string };

const TAMPERED_KEY = 'ab'.repeat(32);

class StepFailed extends Error {
  constructor(readonly step: StepId, readonly reason: string) {
    super(reason);
  }
}

type Emit = (e: StepEvent) => void;

function fail(emit: Emit, id: StepId, reason: string): never {
  emit({ id, status: 'fail', detail: reason });
  throw new StepFailed(id, reason);
}

/** Runs one step: emits running (when given), then ok with `okDetail(result)`, or fail and aborts the flow. */
async function runStep<T>(emit: Emit, id: StepId, running: string | null, fn: () => Promise<T>, okDetail: (value: T) => string): Promise<T> {
  if (running !== null) emit({ id, status: 'running', detail: running });
  let value: T;
  try {
    value = await fn();
  } catch (err) {
    return fail(emit, id, describeError(err));
  }
  emit({ id, status: 'ok', detail: okDetail(value) });
  return value;
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  tamper: boolean;
  onStep: Emit;
}

export async function runChat(cfg: PublicConfig, params: ChatParams): Promise<ChatOutcome> {
  const sent: { reply?: string } = {};
  try {
    return await (params.model === cfg.incognitoModel ? nonTeeRoute(cfg, params, sent) : teeRoute(cfg, params, sent));
  } catch (err) {
    if (err instanceof StepFailed) return { kind: 'failed', step: err.step, reason: err.reason, ...(sent.reply === undefined ? {} : { reply: sent.reply }) };
    throw err;
  }
}

async function teeRoute(cfg: PublicConfig, { model, messages, tamper, onStep: emit }: ChatParams, sent: { reply?: string }): Promise<ChatOutcome> {
  const policy = { acceptedTcbStatuses: cfg.acceptedTcbStatuses };

  // 0. The user chose the private model: it must support model attestation, otherwise nothing is sent (never a silent downgrade to plaintext).
  const meta = await runStep(emit, 'metadata', `asking the gateway about ${model}`, () => fetchModelMetadata(model), (m) => `${model}: provider ${String(m.providerType)}, model attestation ${m.attestationSupported === true ? 'supported' : 'not supported'}`);
  if (meta.attestationSupported !== true) fail(emit, 'metadata', `${model} reports no model attestation: refusing to send in plaintext (fail-closed)`);

  // 1. Verify gateway and model evidence on this device; read the log meanwhile (independent, the send waits for both).
  const log = keyLogFor(cfg);
  const keyLogPromise = log.latestKeys(model);
  keyLogPromise.catch(() => undefined); // awaited below; avoid an unhandled rejection if attestation fails first
  const deployment = await runStep(emit, 'attestation', 'verifying Intel TDX quotes and NVIDIA GPU evidence in this browser (up to ~40 s cold)', () => verifyDeployment(model, policy), (d) => `${d.tookMs === 0 ? 'cached' : seconds(d.tookMs)}: gateway ${d.gateway.tcbStatus}; ${d.models.length} model report${d.models.length === 1 ? '' : 's'} ${d.models.map((x) => `${x.tcbStatus}/gpu ${x.gpuEvidence}`).join(', ')}`);
  const modelAttestation = deployment.models.find((m) => m.signingPublicKey !== undefined) ?? deployment.models[0];
  if (!modelAttestation) fail(emit, 'attestation', 'no model attestation returned');

  // 2. Fail-closed: the attested signing key must be in the public log (compose hash shown, not enforced: DEV-NOTES 2026-11-02).
  const entries = await runStep(emit, 'key-log', `reading the public key log (${log.source})`, () => keyLogPromise, (e) => `${e.length} entr${e.length === 1 ? 'y' : 'ies'} in window (source: ${log.source})`);
  const seenKey = tamper ? TAMPERED_KEY : modelAttestation.signer.signingAddress;
  const keyVerdict = evaluateKeyLog(entries, { model, signingAddress: seenKey, trustedVerifiers: cfg.trustedVerifiers, quorum: cfg.quorum });
  if (keyVerdict.status !== 'ok') {
    emit({ id: 'key-log', status: 'fail', detail: keyVerdict.detail });
    return { kind: 'refused', deployment, logSource: log.source, entriesInWindow: entries.length, keyVerdict, seenKey };
  }
  const logEntry = keyVerdict.matching[0] as KeyEntry;
  emit({ id: 'key-log', status: 'ok', detail: `${keyVerdict.detail} (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in window, source: ${log.source})` });

  // 3. Encrypt to the verified key and send through the proxy.
  const exchange = await runStep(emit, 'send', 'encrypting to the attested model key and sending', () => sendE2ee(model, messages, modelAttestation), (x) => `completion ${x.completionId}, ${x.requestBody.length} B sent, ${x.responseBody.length} B received (ciphertext kept)`);
  sent.reply = exchange.reply;

  // 4. Signature from the gateway, 5. SDK byte-exact check against the verified model signer.
  const signature = await runStep(emit, 'signature', 'fetching the completion signature', () => fetchSignature(exchange.completionId), (s) => `signature_kind ${s.kind}, signer ${short(s.signer.signingAddress)}`);
  const signer = await runStep(emit, 'sdk-check', null, async () => checkResponse(exchange, signature, deployment), () => 'SDK: signature covers exactly these request and response bytes, signer is the attested model key');

  // 6. Our proof: hashes recomputed from the kept bytes, bound to the log entry, salted commit for the chain.
  const { proof, report } = await runStep(emit, 'proof', null, async () => {
    const proof = buildModelProof({ completionId: exchange.completionId, model, signature, requestBody: exchange.requestBody, responseBody: exchange.responseBody, logEntry, verifiedAt: deployment.verifiedAt, e2ee: true });
    const report = verifyModelProof(proof, exchange.requestBody, exchange.responseBody, logEntry);
    if (!report.ok) throw new Error(report.checks.filter((c) => c.status === 'fail').map((c) => `${c.id}: ${c.detail}`).join('; '));
    return { proof, report };
  }, ({ proof, report }) => `${report.checks.filter((c) => c.status === 'ok').length}/${report.checks.length} checks; commit ${proof.commit?.slice(0, 12)}… (salt stays on this device)`);

  // 7. Keep bytes + proof locally (best effort: a private window may refuse).
  try {
    await putExchange({ completionId: exchange.completionId, model, sentAt: exchange.sentAt, requestBody: exchange.requestBody, responseBody: exchange.responseBody, reply: exchange.reply, proof, logEntry });
    emit({ id: 'store', status: 'ok', detail: 'raw bytes, proof and salt saved in this browser (IndexedDB)' });
  } catch (err) {
    emit({ id: 'store', status: 'skipped', detail: `could not save locally: ${describeError(err)}` });
  }

  return { kind: 'verified', reply: exchange.reply, deployment, modelAttestation: signer, logSource: log.source, keyVerdict, logEntry, exchange, proof, report };
}

/** The user picked the Incognito model (SPEC §3.9): no model evidence, no E2EE; plaintext goes through our proxy and the gateway, and the card says so. */
async function nonTeeRoute(cfg: PublicConfig, { model, messages, onStep: emit }: ChatParams, sent: { reply?: string }): Promise<ChatOutcome> {
  const policy = { acceptedTcbStatuses: cfg.acceptedTcbStatuses };
  const meta = await runStep(emit, 'metadata', `asking the gateway about ${model}`, () => fetchModelMetadata(model), (m) => `${model}: provider ${String(m.providerType)}, model attestation ${m.attestationSupported === true ? 'supported' : 'not supported'}`);
  if (meta.attestationSupported === true) return teeRoute(cfg, { model, messages, tamper: false, onStep: emit }, sent); // it is attested after all: use the real path
  const gateway = await runStep(emit, 'attestation', 'verifying the gateway only (this model has no model attestation)', () => verifyGateway(policy), (g) => `gateway ${g.tcbStatus}; no model evidence exists for ${model}`);
  emit({ id: 'key-log', status: 'skipped', detail: 'no model key to look up: nothing to verify against the log' });
  const exchange = await runStep(emit, 'send', 'sending in plaintext through our proxy (no model key to encrypt to)', () => sendPlain(model, messages), (x) => `completion ${x.completionId} (plaintext through our proxy and the gateway)`);
  sent.reply = exchange.reply;
  const signature = await runStep(emit, 'signature', 'fetching the completion signature', () => fetchSignature(exchange.completionId), (s) => `signature_kind ${s.kind}`);
  await runStep(emit, 'sdk-check', null, async () => checkGatewayResponse(exchange, signature, gateway), () => 'SDK: the gateway signed these bytes; this says nothing about where the model ran');
  emit({ id: 'proof', status: 'skipped', detail: 'no model proof for a non-attested route' });
  return { kind: 'non-tee', reply: exchange.reply, gateway, exchange, signature, model };
}
