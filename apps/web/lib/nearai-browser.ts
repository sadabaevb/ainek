// NEAR AI SDK in the browser (generic entry), manual flow from the verification guide: verify evidence,
// encrypt to the verified model key, send through our byte-exact proxy, keep the exact bytes, verify the
// signature later. Nothing here touches the API key: /api/nearai adds it server-side.
import {
  AttestationClient,
  NO_ALIASING_HEADER,
  findModelAttestationForSignature,
  prepareE2eeChatRequest,
  verifyGatewayAttestation,
  verifyGatewayResponse,
  verifyModelAttestation,
  verifyModelResponse,
  type CompletionSignature,
  type ModelMetadata,
  type VerifiedGatewayAttestation,
  type VerifiedModelAttestation,
} from '@nearai/inference-sdk';

const SIGNING_ALGO = 'ed25519' as const;
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
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
  set(key: string, value: T): T {
    this.entries.set(key, { value, at: Date.now() });
    return value;
  }
}
const metadataCache = new Cache<ModelMetadata>();
const gatewayCache = new Cache<VerifiedGatewayAttestation>();
const deploymentCache = new Cache<VerifiedDeployment>();

/** Metadata only (no cryptographic check): tells whether the model supports model attestation at all. Static per model, cached. */
export async function fetchModelMetadata(model: string): Promise<ModelMetadata> {
  return metadataCache.get(model) ?? metadataCache.set(model, await client().fetchModelMetadata(model));
}

/** Gateway evidence verified on this device (no-TLS layout: a browser cannot observe the TLS peer). Cached 60 min. */
export async function verifyGateway(): Promise<VerifiedGatewayAttestation> {
  const cached = gatewayCache.get('gateway');
  if (cached) return cached;
  const fetched = await client().fetchGatewayAttestation({ signingAlgo: SIGNING_ALGO });
  const gateway = await verifyGatewayAttestation({ attestation: fetched.attestation, clientBinding: fetched.clientBinding, policy: { acceptedTcbStatuses: ['UpToDate'] } });
  return gatewayCache.set('gateway', gateway);
}

async function verifyModels(model: string): Promise<VerifiedModelAttestation[]> {
  const fetched = await client().fetchModelAttestations({ model, signingAlgo: SIGNING_ALGO });
  if (fetched.attestations.length === 0) throw new Error(`gateway returned no model attestation for ${model}`);
  return Promise.all(
    fetched.attestations.map((attestation) =>
      verifyModelAttestation({ attestation, clientBinding: fetched.clientBinding, policy: { acceptedTcbStatuses: ['UpToDate'], gpuEvidence: 'required' } }),
    ),
  );
}

/** Gateway + every model report, verified on this device (TDX via dcap-qvl, GPU via NRAS). The two legs are independent in the browser (no TLS pinning), so they run in parallel. Cached 60 min. */
export async function verifyDeployment(model: string): Promise<VerifiedDeployment> {
  const cached = deploymentCache.get(model);
  if (cached) return { ...cached, tookMs: 0 };
  const t0 = performance.now();
  const [gateway, models] = await Promise.all([verifyGateway(), verifyModels(model)]);
  return deploymentCache.set(model, { gateway, models, verifiedAt: new Date().toISOString(), tookMs: Math.round(performance.now() - t0) });
}

function chatRequest(model: string, messages: ChatMessage[]): Request {
  return new Request(`${baseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', [NO_ALIASING_HEADER]: 'true' },
    body: JSON.stringify({ model, messages, stream: false }),
  });
}

async function toExchange(requestBody: Uint8Array, rawResponse: Response, decrypted: Response): Promise<Exchange> {
  const [responseBytes, plaintext] = await Promise.all([rawResponse.arrayBuffer(), decrypted.text()]);
  if (!decrypted.ok) throw new Error(`chat completion failed: HTTP ${decrypted.status} ${plaintext.slice(0, 200)}`);
  const completion = JSON.parse(plaintext) as { id: string; choices: Array<{ message: { content: string | null } }> };
  return { completionId: completion.id, requestBody, responseBody: new Uint8Array(responseBytes), reply: completion.choices[0]?.message.content ?? '', sentAt: new Date().toISOString() };
}

/** Encrypt to the verified model key, send through the proxy, decrypt; keep the exact bytes for the proof. */
export async function sendE2ee(model: string, messages: ChatMessage[], modelAttestation: VerifiedModelAttestation): Promise<Exchange> {
  if (modelAttestation.signingPublicKey === undefined) throw new Error('verified model report has no E2EE public key');
  const prepared = await prepareE2eeChatRequest({
    request: chatRequest(model, messages),
    modelKey: { signingAlgo: modelAttestation.signer.signingAlgo, publicKey: modelAttestation.signingPublicKey },
  });
  const requestBody = new Uint8Array(await prepared.request.clone().arrayBuffer());
  const encrypted = await fetch(prepared.request);
  return toExchange(requestBody, encrypted.clone(), await prepared.decryptResponse(encrypted));
}

/** Plaintext request for models without model attestation (Incognito tier): no E2EE is possible, only a gateway signature. */
export async function sendPlain(model: string, messages: ChatMessage[]): Promise<Exchange> {
  const request = chatRequest(model, messages);
  const requestBody = new Uint8Array(await request.clone().arrayBuffer());
  const response = await fetch(request);
  return toExchange(requestBody, response.clone(), response);
}

/** The signature is cached on the node that served the completion, so a lookup can land elsewhere for a moment: retry. */
export async function fetchSignature(completionId: string, attempts = 4): Promise<CompletionSignature> {
  for (let i = 1; ; i++) {
    try {
      return await client().fetchCompletionSignature({ completionId, signingAlgo: SIGNING_ALGO });
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
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
