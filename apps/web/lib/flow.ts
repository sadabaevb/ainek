// The Tier-1 client flow (SPEC §7.1), step by step, so the page can show each line as it happens:
//   verify evidence in the browser → fail-closed check against the public log → E2EE send →
//   fetch the signature → SDK byte-exact check → our proof (recomputed hashes, log binding, salted commit) → IndexedDB.
import {
  ModelProof,
  commitOf,
  evaluateKeyLog,
  parseSignedText,
  randomHex32,
  sha256Hex,
  verifyModelProof,
  type KeyEntry,
  type KeyLogVerdict,
  type VerifyReport,
} from '@ainek/proof';
import type { CompletionSignature, VerifiedGatewayAttestation } from '@nearai/inference-sdk';
import { getConfig } from './config';
import { fetchLatestKeys, type KeyLogSnapshot } from './key-log';
import {
  checkGatewayResponse,
  checkResponse,
  describeSdkError,
  fetchModelMetadata,
  fetchSignature,
  sendE2ee,
  sendPlain,
  verifyDeployment,
  verifyGateway,
  type Exchange,
  type PlainExchange,
  type VerifiedDeployment,
} from './nearai-browser';
import { putExchange } from './store';

export type StepId = 'metadata' | 'attestation' | 'key-log' | 'send' | 'signature' | 'sdk-check' | 'proof' | 'store';
export type StepStatus = 'running' | 'ok' | 'fail' | 'skipped';
export interface StepEvent {
  id: StepId;
  status: StepStatus;
  detail: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type ChatOutcome =
  | {
      kind: 'verified';
      reply: string;
      deployment: VerifiedDeployment;
      keyLog: KeyLogSnapshot;
      keyVerdict: KeyLogVerdict;
      logEntry: KeyEntry;
      exchange: Exchange;
      signature: CompletionSignature;
      proof: ModelProof;
      report: VerifyReport;
      stored: boolean;
    }
  | { kind: 'refused'; deployment: VerifiedDeployment; keyLog: KeyLogSnapshot; keyVerdict: KeyLogVerdict; seenKey: string }
  | { kind: 'non-tee'; reply: string; gateway: VerifiedGatewayAttestation; exchange: PlainExchange; signature: CompletionSignature; model: string }
  | { kind: 'failed'; step: StepId; reason: string };

const TAMPERED_KEY = 'ab'.repeat(32);

export async function runChat(params: { model: string; messages: ChatMessage[]; tamper: boolean; onStep: (e: StepEvent) => void }): Promise<ChatOutcome> {
  const { model, messages, tamper, onStep } = params;
  const step = (id: StepId, status: StepStatus, detail: string) => onStep({ id, status, detail });
  const cfg = await getConfig();

  // 0. Does this model support model attestation at all? (Incognito-tier models do not: SPEC §3.9.)
  step('metadata', 'running', `asking the gateway about ${model}`);
  let attestationSupported = true;
  try {
    const meta = await fetchModelMetadata(model);
    attestationSupported = meta.attestationSupported === true;
    step('metadata', 'ok', `${model}: provider ${String(meta.providerType)}, model attestation ${attestationSupported ? 'supported' : 'not supported'}`);
  } catch (err) {
    step('metadata', 'fail', describeSdkError(err));
    return { kind: 'failed', step: 'metadata', reason: describeSdkError(err) };
  }
  if (!attestationSupported) return nonTeeRoute(model, messages, step);

  // 1. Verify gateway and model evidence on this device.
  step('attestation', 'running', 'verifying Intel TDX quotes and NVIDIA GPU evidence in this browser (up to ~40 s cold)');
  let deployment: VerifiedDeployment;
  try {
    deployment = await verifyDeployment(model);
    const m = deployment.models;
    step('attestation', 'ok', `${deployment.tookMs === 0 ? 'cached' : `${(deployment.tookMs / 1000).toFixed(1)} s`}: gateway ${deployment.gateway.tcbStatus}; ${m.length} model report${m.length === 1 ? '' : 's'} ${m.map((x) => `${x.tcbStatus}/gpu ${x.gpuEvidence}`).join(', ')}`);
  } catch (err) {
    step('attestation', 'fail', describeSdkError(err));
    return { kind: 'failed', step: 'attestation', reason: describeSdkError(err) };
  }
  const modelAttestation = deployment.models.find((m) => m.signingPublicKey !== undefined) ?? deployment.models[0];
  if (!modelAttestation) return { kind: 'failed', step: 'attestation', reason: 'no model attestation returned' };

  // 2. Fail-closed: the attested signing key must be in the public log (compose hash shown, not enforced: DEV-NOTES 2026-11-02).
  step('key-log', 'running', `reading the public key log (${cfg.logSource})`);
  let keyLog: KeyLogSnapshot;
  try {
    keyLog = await fetchLatestKeys(model);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    step('key-log', 'fail', `log unavailable: ${reason}: not sent (fail-closed)`);
    return { kind: 'failed', step: 'key-log', reason };
  }
  const seenKey = tamper ? TAMPERED_KEY : modelAttestation.signer.signingAddress;
  const keyVerdict = evaluateKeyLog(keyLog.entries, { model, signingAddress: seenKey, trustedVerifiers: cfg.trustedVerifiers, quorum: cfg.quorum });
  if (keyVerdict.status !== 'ok') {
    step('key-log', 'fail', keyVerdict.detail);
    return { kind: 'refused', deployment, keyLog, keyVerdict, seenKey };
  }
  const logEntry = keyVerdict.matching[0] as KeyEntry;
  step('key-log', 'ok', `${keyVerdict.detail} (${keyLog.entries.length} entr${keyLog.entries.length === 1 ? 'y' : 'ies'} in window, source: ${keyLog.source})`);

  // 3. Encrypt to the verified key and send through the proxy.
  step('send', 'running', 'encrypting to the attested model key and sending');
  let exchange: Exchange;
  try {
    exchange = await sendE2ee({ model, messages, modelAttestation });
    step('send', 'ok', `completion ${exchange.completionId}, ${exchange.requestBody.length} B sent, ${exchange.responseBody.length} B received (ciphertext kept)`);
  } catch (err) {
    step('send', 'fail', describeSdkError(err));
    return { kind: 'failed', step: 'send', reason: describeSdkError(err) };
  }
  const reply = exchange.completion.choices[0]?.message.content ?? '';

  // 4. Signature from the gateway (the node that served the completion may answer late: retry).
  step('signature', 'running', 'fetching the completion signature');
  let signature: CompletionSignature;
  try {
    signature = await withRetry(() => fetchSignature(exchange.completionId), 4, 1500);
    step('signature', 'ok', `signature_kind ${signature.kind}, signer ${signature.signer.signingAddress.slice(0, 8)}…`);
  } catch (err) {
    step('signature', 'fail', describeSdkError(err));
    return { kind: 'failed', step: 'signature', reason: describeSdkError(err) };
  }

  // 5. SDK byte-exact check against the verified model signer.
  try {
    checkResponse(exchange, signature, deployment);
    step('sdk-check', 'ok', 'SDK: signature covers exactly these request and response bytes, signer is the attested model key');
  } catch (err) {
    step('sdk-check', 'fail', describeSdkError(err));
    return { kind: 'failed', step: 'sdk-check', reason: describeSdkError(err) };
  }

  // 6. Our proof: hashes recomputed from the kept bytes, bound to the log entry, salted commit for the chain.
  const signed = parseSignedText(signature.signedText);
  const salt = randomHex32();
  const payload = {
    v: 1 as const,
    kind: 'model' as const,
    completionId: exchange.completionId,
    model,
    signatureKind: signature.kind,
    signingAlgo: signature.signer.signingAlgo,
    signingAddress: signature.signer.signingAddress,
    signedText: signature.signedText,
    signature: signature.signature,
    requestSha256: sha256Hex(exchange.requestBody),
    responseSha256: sha256Hex(exchange.responseBody),
    e2ee: true,
    toolNames: [],
    logIndex: logEntry.index,
    verifier: logEntry.verifier,
    verifiedAt: deployment.verifiedAt,
  };
  const proof = ModelProof.parse({ ...payload, salt, commit: commitOf(salt, payload) });
  const report = verifyModelProof(proof, exchange.requestBody, exchange.responseBody, logEntry);
  if (!report.ok || signed.requestSha256 !== proof.requestSha256) {
    const failed = report.checks.filter((c) => c.status === 'fail').map((c) => `${c.id}: ${c.detail}`).join('; ');
    step('proof', 'fail', failed || 'signed text hashes differ from the kept bytes');
    return { kind: 'failed', step: 'proof', reason: failed };
  }
  step('proof', 'ok', `${report.checks.filter((c) => c.status === 'ok').length}/${report.checks.length} checks; commit ${proof.commit?.slice(0, 12)}… (salt stays on this device)`);

  // 7. Keep bytes + proof locally.
  let stored = false;
  try {
    await putExchange({ completionId: exchange.completionId, model, sentAt: exchange.sentAt, requestBody: exchange.requestBody, responseBody: exchange.responseBody, reply, proof, logEntry });
    stored = true;
    step('store', 'ok', 'raw bytes, proof and salt saved in this browser (IndexedDB)');
  } catch (err) {
    step('store', 'skipped', `could not save locally: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { kind: 'verified', reply, deployment, keyLog, keyVerdict, logEntry, exchange, signature, proof, report, stored };
}

async function nonTeeRoute(model: string, messages: ChatMessage[], step: (id: StepId, status: StepStatus, detail: string) => void): Promise<ChatOutcome> {
  step('attestation', 'running', 'verifying the gateway only (this model has no model attestation)');
  let gateway: VerifiedGatewayAttestation;
  try {
    gateway = await verifyGateway();
    step('attestation', 'ok', `gateway ${gateway.tcbStatus}; no model evidence exists for ${model}`);
  } catch (err) {
    step('attestation', 'fail', describeSdkError(err));
    return { kind: 'failed', step: 'attestation', reason: describeSdkError(err) };
  }
  step('key-log', 'skipped', 'no model key to look up: nothing to verify against the log');
  step('send', 'running', 'sending in plaintext (no model key to encrypt to)');
  let exchange: PlainExchange;
  try {
    exchange = await sendPlain({ model, messages });
    step('send', 'ok', `completion ${exchange.completionId} (plaintext over TLS to the gateway)`);
  } catch (err) {
    step('send', 'fail', describeSdkError(err));
    return { kind: 'failed', step: 'send', reason: describeSdkError(err) };
  }
  step('signature', 'running', 'fetching the completion signature');
  let signature: CompletionSignature;
  try {
    signature = await withRetry(() => fetchSignature(exchange.completionId), 4, 1500);
    step('signature', signature.kind === 'gateway' ? 'ok' : 'fail', `signature_kind ${signature.kind}`);
  } catch (err) {
    step('signature', 'fail', describeSdkError(err));
    return { kind: 'failed', step: 'signature', reason: describeSdkError(err) };
  }
  try {
    checkGatewayResponse(exchange, signature, gateway);
    step('sdk-check', 'ok', 'SDK: the gateway signed these bytes; this says nothing about where the model ran');
  } catch (err) {
    step('sdk-check', 'fail', describeSdkError(err));
  }
  step('proof', 'skipped', 'no model proof for a non-attested route');
  return { kind: 'non-tee', reply: exchange.completion.choices[0]?.message.content ?? '', gateway, exchange, signature, model };
}

async function withRetry<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
  throw last;
}
