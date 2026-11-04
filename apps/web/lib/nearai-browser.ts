// NEAR AI SDK in the browser (generic entry), manual flow from the verification guide: verify evidence,
// encrypt to the verified model key, send through our byte-exact proxy, keep the exact bytes, verify the
// signature later. Nothing here touches the API key: /api/nearai adds it server-side.
import {
  AttestationClient,
  NO_ALIASING_HEADER,
  findModelAttestationForSignature,
  getSdkError,
  prepareE2eeChatRequest,
  verifyGatewayAttestation,
  verifyGatewayResponse,
  verifyModelAttestation,
  verifyModelResponse,
  type CompletionSignature,
  type ModelMetadata,
  type TcbStatus,
  type VerifiedGatewayAttestation,
  type VerifiedModelAttestation,
} from '@nearai/inference-sdk';
import { getDeployment, putDeployment } from './store';

const SIGNING_ALGO = 'ed25519' as const;
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AttestationPolicy {
  acceptedTcbStatuses: TcbStatus[];
}

export interface VerifiedDeployment {
  gateway: VerifiedGatewayAttestation;
  models: VerifiedModelAttestation[];
  verifiedAt: string;
  /** Milliseconds the full verification took in this browser (0 when served from cache). */
  tookMs: number;
}

export interface Exchange {
  completionId: string;
  /** Exact bytes sent and received (ciphertext when E2EE): what the signer hashed. */
  requestBody: Uint8Array;
  responseBody: Uint8Array;
  reply: string;
  sentAt: string;
}

function baseUrl(): string {
  if (typeof window === 'undefined') throw new Error('browser-only');
  return `${window.location.origin}/api/nearai/v1`;
}

let attestationClient: AttestationClient | null = null;
function client(): AttestationClient {
  attestationClient ??= new AttestationClient({ baseUrl: baseUrl(), headers: { [NO_ALIASING_HEADER]: 'true' } });
  return attestationClient;
}

class Cache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();
  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.value : undefined;
  }
  /** `at` lets a value rehydrated from IndexedDB keep its original verification time, so the TTL is counted once. */
  set(key: string, value: T, at = Date.now()): T {
    this.entries.set(key, { value, at });
    return value;
  }
}
const metadataCache = new Cache<ModelMetadata>();
const gatewayCache = new Cache<VerifiedGatewayAttestation>();
const deploymentCache = new Cache<VerifiedDeployment>();

/** Retries only what the SDK marks retryable (Intel PCS collateral hiccups, NRAS/transport 5xx, a signature not yet on this node). */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 1500): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || getSdkError(err)?.retryable !== true) throw err;
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
}

/** Metadata only (no cryptographic check): tells whether the model supports model attestation at all. Static per model, cached. */
export async function fetchModelMetadata(model: string): Promise<ModelMetadata> {
  return metadataCache.get(model) ?? metadataCache.set(model, await withRetry(() => client().fetchModelMetadata(model)));
}

/** Gateway evidence verified on this device (no-TLS layout: a browser cannot observe the TLS peer). Cached 60 min. */
export async function verifyGateway(policy: AttestationPolicy): Promise<VerifiedGatewayAttestation> {
  const cached = gatewayCache.get('gateway');
  if (cached) return cached;
  const gateway = await withRetry(async () => {
    const fetched = await client().fetchGatewayAttestation({ signingAlgo: SIGNING_ALGO });
    return verifyGatewayAttestation({ attestation: fetched.attestation, clientBinding: fetched.clientBinding, policy });
  });
  return gatewayCache.set('gateway', gateway);
}

function verifyModels(model: string, policy: AttestationPolicy): Promise<VerifiedModelAttestation[]> {
  return withRetry(async () => {
    const fetched = await client().fetchModelAttestations({ model, signingAlgo: SIGNING_ALGO });
    if (fetched.attestations.length === 0) throw new Error(`gateway returned no model attestation for ${model}`);
    return Promise.all(
      fetched.attestations.map((attestation) => verifyModelAttestation({ attestation, clientBinding: fetched.clientBinding, policy: { ...policy, gpuEvidence: 'required' } })),
    );
  });
}

/** Gateway + every model report, verified on this device (TDX via dcap-qvl, GPU via NRAS). The two legs are independent in the browser (no TLS pinning), so they run in parallel. Cached 60 min in memory and in IndexedDB (same TTL the SDK uses), so a reload does not repeat the cold check. */
export async function verifyDeployment(model: string, policy: AttestationPolicy): Promise<VerifiedDeployment> {
  const policyKey = policyKeyOf(policy);
  const cacheKey = `${model}|${policyKey}`;
  if (!deploymentCache.get(cacheKey)) {
    const stored = await getDeployment(model, policyKey).catch(() => undefined);
    const at = stored ? Date.parse(stored.verifiedAt) : Number.NaN;
    if (stored && Date.now() - at < CACHE_TTL_MS) {
      deploymentCache.set(cacheKey, stored, at);
      if (!gatewayCache.get('gateway')) gatewayCache.set('gateway', stored.gateway, at); // never replace a fresher entry
    }
  }
  const cached = deploymentCache.get(cacheKey);
  if (cached) return { ...cached, tookMs: 0 };
  const t0 = performance.now();
  const [gateway, models] = await Promise.all([verifyGateway(policy), verifyModels(model, policy)]);
  const verified = deploymentCache.set(cacheKey, { gateway, models, verifiedAt: new Date().toISOString(), tookMs: Math.round(performance.now() - t0) });
  putDeployment(model, policyKey, verified).catch(() => undefined); // best effort
  return verified;
}

/** Stable text for the policy a verification ran under; the cache treats a different policy as a miss. */
function policyKeyOf(policy: AttestationPolicy): string {
  return JSON.stringify({ tcb: [...policy.acceptedTcbStatuses].sort(), gpuEvidence: 'required' });
}

// No Accept-Encoding here: browsers drop it as a forbidden header; the proxy asks upstream for identity itself.
function chatRequest(model: string, messages: ChatMessage[]): Request {
  return new Request(`${baseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [NO_ALIASING_HEADER]: 'true' },
    body: JSON.stringify({ model, messages, stream: false }),
  });
}

async function toExchange(requestBody: Uint8Array, rawResponse: Response, decrypted: Response): Promise<Exchange> {
  const [responseBytes, plaintext] = await Promise.all([rawResponse.arrayBuffer(), decrypted.text()]);
  const completion = JSON.parse(plaintext) as { id: string; choices: Array<{ message: { content: string | null } }> };
  return { completionId: completion.id, requestBody, responseBody: new Uint8Array(responseBytes), reply: completion.choices[0]?.message.content ?? '', sentAt: new Date().toISOString() };
}

async function httpError(response: Response): Promise<Error> {
  return new Error(`chat completion failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
}

/** Encrypt to the verified model key, send through the proxy, decrypt; keep the exact bytes for the proof. */
/** Everything that happens before the request leaves the browser: the E2EE key check and the encryption. */
export interface PreparedE2ee {
  prepared: Awaited<ReturnType<typeof prepareE2eeChatRequest>>;
  requestBody: Uint8Array;
}

export async function prepareE2ee(model: string, messages: ChatMessage[], modelAttestation: VerifiedModelAttestation): Promise<PreparedE2ee> {
  if (modelAttestation.signingPublicKey === undefined) throw new Error('verified model report has no E2EE public key');
  const prepared = await prepareE2eeChatRequest({
    request: chatRequest(model, messages),
    modelKey: { signingAlgo: modelAttestation.signer.signingAlgo, publicKey: modelAttestation.signingPublicKey },
  });
  return { prepared, requestBody: new Uint8Array(await prepared.request.clone().arrayBuffer()) };
}

/** From here on the message has left the browser: send through the proxy, keep the exact bytes, decrypt the reply. */
export async function transmitE2ee({ prepared, requestBody }: PreparedE2ee): Promise<Exchange> {
  const encrypted = await fetch(prepared.request);
  if (!encrypted.ok) throw await httpError(encrypted); // error bodies are plain JSON, not ciphertext
  return toExchange(requestBody, encrypted.clone(), await prepared.decryptResponse(encrypted));
}

/** Plaintext request for the user-chosen Incognito model (no model attestation): no E2EE is possible, only a gateway signature. */
export async function sendPlain(model: string, messages: ChatMessage[]): Promise<Exchange> {
  const request = chatRequest(model, messages);
  const requestBody = new Uint8Array(await request.clone().arrayBuffer());
  const response = await fetch(request);
  if (!response.ok) throw await httpError(response);
  return toExchange(requestBody, response.clone(), response);
}

/** The signature is cached on the node that served the completion, so a lookup can land elsewhere for a moment: the SDK marks that retryable. */
export function fetchSignature(completionId: string): Promise<CompletionSignature> {
  return withRetry(() => client().fetchCompletionSignature({ completionId, signingAlgo: SIGNING_ALGO }), 4);
}

/** SDK byte-exact check against the verified model signer; returns the matching report. Throws on any mismatch, including a non-TEE signature kind. */
export function checkResponse(exchange: Exchange, signature: CompletionSignature, deployment: VerifiedDeployment): VerifiedModelAttestation {
  const attestation = findModelAttestationForSignature({ attestations: deployment.models, signature });
  verifyModelResponse({ requestBody: exchange.requestBody, responseBody: exchange.responseBody, signature, attestation });
  return attestation;
}

/** Gateway-only check for the non-TEE route: proves the gateway signed these bytes, not where the model ran. */
export function checkGatewayResponse(exchange: Exchange, signature: CompletionSignature, gateway: VerifiedGatewayAttestation): void {
  verifyGatewayResponse({ requestBody: exchange.requestBody, responseBody: exchange.responseBody, signature, attestation: gateway });
}
