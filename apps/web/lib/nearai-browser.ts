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
  type VerifiedGatewayAttestation,
  type VerifiedModelAttestation,
} from '@nearai/inference-sdk';

export const MODEL = process.env.NEXT_PUBLIC_NEARAI_MODEL ?? 'z-ai/glm-5.3-flash';
const SIGNING_ALGO = 'ed25519' as const;
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface VerifiedDeployment {
  model: string;
  gateway: VerifiedGatewayAttestation;
  models: VerifiedModelAttestation[];
  verifiedAt: string;
  /** Milliseconds the full verification took in this browser (0 when served from cache). */
  tookMs: number;
}

export interface Exchange {
  completionId: string;
  /** Exact encrypted bytes sent and received: what the model TEE hashed and signed. */
  requestBody: Uint8Array;
  responseBody: Uint8Array;
  /** Decrypted completion (OpenAI chat shape). */
  completion: { id: string; choices: Array<{ message: { content: string | null } }> };
  modelAttestation: VerifiedModelAttestation;
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

const deploymentCache = new Map<string, VerifiedDeployment>();
let gatewayCache: { gateway: VerifiedGatewayAttestation; verifiedAt: number } | null = null;

/** Metadata only (no cryptographic check): tells whether the model supports model attestation at all. */
export function fetchModelMetadata(model: string): Promise<ModelMetadata> {
  return client().fetchModelMetadata(model);
}

/** Gateway evidence verified on this device (no-TLS layout: a browser cannot observe the TLS peer). Cached 60 min. */
export async function verifyGateway({ force = false } = {}): Promise<VerifiedGatewayAttestation> {
  if (gatewayCache && !force && Date.now() - gatewayCache.verifiedAt < CACHE_TTL_MS) return gatewayCache.gateway;
  const fetchedGateway = await client().fetchGatewayAttestation({ signingAlgo: SIGNING_ALGO });
  const gateway = await verifyGatewayAttestation({
    attestation: fetchedGateway.attestation,
    clientBinding: fetchedGateway.clientBinding,
    policy: { acceptedTcbStatuses: ['UpToDate'] },
  });
  gatewayCache = { gateway, verifiedAt: Date.now() };
  return gateway;
}

/** Gateway + every model report, verified on this device (TDX via dcap-qvl, GPU via NRAS). Cached 60 min in memory. */
export async function verifyDeployment(model: string, { force = false } = {}): Promise<VerifiedDeployment> {
  const cached = deploymentCache.get(model);
  if (cached && !force && Date.now() - Date.parse(cached.verifiedAt) < CACHE_TTL_MS) return { ...cached, tookMs: 0 };
  const t0 = performance.now();
  const c = client();
  const gateway = await verifyGateway({ force });
  const fetchedModels = await c.fetchModelAttestations({ model, signingAlgo: SIGNING_ALGO });
  if (fetchedModels.attestations.length === 0) throw new Error(`gateway returned no model attestation for ${model}`);
  const models = await Promise.all(
    fetchedModels.attestations.map((attestation) =>
      verifyModelAttestation({
        attestation,
        clientBinding: fetchedModels.clientBinding,
        policy: { acceptedTcbStatuses: ['UpToDate'], gpuEvidence: 'required' },
      }),
    ),
  );
  const result: VerifiedDeployment = { model, gateway, models, verifiedAt: new Date().toISOString(), tookMs: Math.round(performance.now() - t0) };
  deploymentCache.set(model, result);
  return result;
}

/** Encrypt to the verified model key, send through the proxy, decrypt; keep the exact bytes for the proof. */
export async function sendE2ee(params: { model: string; messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>; modelAttestation: VerifiedModelAttestation }): Promise<Exchange> {
  const { model, messages, modelAttestation } = params;
  if (modelAttestation.signingPublicKey === undefined) throw new Error('verified model report has no E2EE public key');
  const plain = new Request(`${baseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', [NO_ALIASING_HEADER]: 'true' },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  const prepared = await prepareE2eeChatRequest({
    request: plain,
    modelKey: { signingAlgo: modelAttestation.signer.signingAlgo, publicKey: modelAttestation.signingPublicKey },
  });
  const requestBody = new Uint8Array(await prepared.request.clone().arrayBuffer());
  const encrypted = await fetch(prepared.request);
  const forVerification = encrypted.clone();
  const decrypted = await prepared.decryptResponse(encrypted);
  if (!decrypted.ok) throw new Error(`chat completion failed: HTTP ${decrypted.status} ${(await decrypted.text()).slice(0, 200)}`);
  const [responseBytes, plaintext] = await Promise.all([forVerification.arrayBuffer(), decrypted.text()]);
  const completion = JSON.parse(plaintext) as Exchange['completion'];
  return { completionId: completion.id, requestBody, responseBody: new Uint8Array(responseBytes), completion, modelAttestation, sentAt: new Date().toISOString() };
}

/** Plaintext request for models without model attestation (Incognito tier): no E2EE is possible, only a gateway signature. */
export async function sendPlain(params: { model: string; messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> }): Promise<PlainExchange> {
  const request = new Request(`${baseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', [NO_ALIASING_HEADER]: 'true' },
    body: JSON.stringify({ model: params.model, messages: params.messages, stream: false }),
  });
  const requestBody = new Uint8Array(await request.clone().arrayBuffer());
  const response = await fetch(request);
  const responseBody = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) throw new Error(`chat completion failed: HTTP ${response.status} ${new TextDecoder().decode(responseBody).slice(0, 200)}`);
  const completion = JSON.parse(new TextDecoder().decode(responseBody)) as Exchange['completion'];
  return { completionId: completion.id, requestBody, responseBody, completion, sentAt: new Date().toISOString() };
}

export interface PlainExchange {
  completionId: string;
  requestBody: Uint8Array;
  responseBody: Uint8Array;
  completion: Exchange['completion'];
  sentAt: string;
}

export async function fetchSignature(completionId: string): Promise<CompletionSignature> {
  return client().fetchCompletionSignature({ completionId, signingAlgo: SIGNING_ALGO });
}

/** SDK byte-exact check: the model TEE signer must match and the hashes must be of these exact bytes. Throws on failure. */
export function checkResponse(exchange: Exchange, signature: CompletionSignature, deployment: VerifiedDeployment): void {
  if (signature.kind !== 'provider_tee') throw new Error(`signature_kind is ${signature.kind}: not signed inside the model TEE`);
  const attestation = findModelAttestationForSignature({ attestations: deployment.models, signature });
  verifyModelResponse({ requestBody: exchange.requestBody, responseBody: exchange.responseBody, signature, attestation });
}

/** Gateway-only check for the non-TEE route: proves the gateway signed these bytes, not where the model ran. */
export function checkGatewayResponse(exchange: PlainExchange, signature: CompletionSignature, gateway: VerifiedGatewayAttestation): void {
  if (signature.kind !== 'gateway') throw new Error(`unexpected signature_kind ${signature.kind} for a gateway-only model`);
  verifyGatewayResponse({ requestBody: exchange.requestBody, responseBody: exchange.responseBody, signature, attestation: gateway });
}

export function describeSdkError(err: unknown): string {
  const sdk = getSdkError(err);
  if (sdk) {
    const retryable = 'retryable' in sdk.failure && sdk.failure.retryable === true;
    return `${sdk.name} ${sdk.failure.code}${retryable ? ' (retryable)' : ''}`;
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
