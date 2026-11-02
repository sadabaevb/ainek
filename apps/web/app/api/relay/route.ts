// Relay (day-1 spike version). The browser never sees the NEAR AI API key: it posts a plain message
// here, the server verifies the model's attestation, sends the request end-to-end encrypted to the
// attested model key, verifies the response signature, and returns the answer plus the raw verification
// result. NOTE: in this spike the *server* encrypts and decrypts, so the relay sees plaintext. The real
// relay (SPEC §3.4) must only forward ciphertext; moving encryption into the browser is the Tier-1
// client session's job. Nothing from the request body is logged here, on purpose.
import { NextResponse } from 'next/server';
import {
  InferenceClient,
  NO_ALIASING_HEADER,
  getSdkError,
  type AttestationVerificationResult,
} from '@nearai/inference-sdk/node';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MODEL = process.env.NEARAI_MODEL ?? 'z-ai/glm-5.3-flash';
const MAX_MESSAGE_CHARS = 4000;

/**
 * What the relay returns to the browser.
 * `signatureKind` is what the route detector (SPEC §3.9) keys on: 'provider_tee' means the bytes were
 * signed inside the model enclave; 'gateway' means only the gateway TEE signed them and nothing proves
 * which model produced the answer — the card must show that in red.
 */
export type RelayResponse = {
  completionId: string;
  model: string;
  content: string;
  signedText: string | null;
  signature: string | null;
  signingAddress: string | null;
  signingAlgo: 'ed25519' | 'ecdsa' | null;
  signatureKind: 'provider_tee' | 'gateway' | null;
  verified: boolean;
  /** SDK failure code when `verified` is false, e.g. `signature.invalid`. */
  failure?: string;
  timingsMs: { verify: number; chat: number; verifyResponse: number };
  attestation: AttestationSummary;
};

type AttestationSummary = {
  verifiedAt: number;
  gateway: { signingAddress: string; tcbStatus: string; tlsBinding: string; composeHash: string | null };
  models: Array<{
    signingAddress: string;
    signingPublicKey: string | null;
    tcbStatus: string;
    gpuEvidence: string;
    composeHash: string | null;
  }>;
};

// One client per server process. It caches the verified attestation for 60 minutes (SDK default), so only
// the first request pays for dcap-qvl + NVIDIA NRAS (7–15 s measured); later requests reuse it.
let client: InferenceClient | undefined;

function getClient(): InferenceClient {
  if (client) return client;
  const apiKey = process.env.NEARAI_API_KEY;
  if (!apiKey) throw new Error('NEARAI_API_KEY is not set. Copy .env.example to .env at the repo root.');
  client = new InferenceClient({
    apiKey,
    baseUrl: process.env.NEARAI_BASE_URL, // undefined -> SDK default https://cloud-api.near.ai/v1
    signingAlgo: 'ed25519', // explicit: the gateway, model and signature endpoints have different defaults
    e2ee: true, // encrypt request fields to the model key taken from the *verified* attestation
    headers: { [NO_ALIASING_HEADER]: 'true' }, // fail instead of silently serving an alias of the model id
    modelVerification: { policy: { gpuEvidence: 'required' } }, // a model without GPU evidence is not "TEE"
  });
  return client;
}

function summarizeAttestation(a: AttestationVerificationResult): AttestationSummary {
  return {
    verifiedAt: a.verifiedAt,
    gateway: {
      signingAddress: a.gateway.signer.signingAddress,
      tcbStatus: a.gateway.tcbStatus,
      tlsBinding: a.gateway.tlsBinding.kind,
      composeHash: a.gateway.deployment.runtimeMeasurements.composeHash ?? null,
    },
    models: a.models.map((m) => ({
      signingAddress: m.signer.signingAddress,
      signingPublicKey: m.signingPublicKey ?? null,
      tcbStatus: m.tcbStatus,
      gpuEvidence: m.gpuEvidence,
      composeHash: m.deployment.runtimeMeasurements.composeHash ?? null,
    })),
  };
}

// Intel's collateral service (PCS) flakes now and then; the SDK marks such failures `retryable`
// (seen once on 2026-11-02 as quote.collateral_unavailable, gone a minute later). Retry those only.
async function verifyWithRetry(c: InferenceClient, model: string): Promise<AttestationVerificationResult> {
  const attempts = 3;
  for (let i = 1; ; i++) {
    try {
      return await c.verify(model);
    } catch (err) {
      const sdk = getSdkError(err);
      if (!sdk?.retryable || i === attempts) throw err;
      console.warn(`[relay] verify attempt ${i}/${attempts} failed with retryable ${sdk.failure.code}; retrying`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

function describeError(err: unknown): string {
  const sdk = getSdkError(err);
  if (sdk) {
    // Structured failure + cause chain to the server log only (no request content is in there).
    console.error('[relay] sdk failure', JSON.stringify(sdk.toJSON()), sdk.cause ?? '');
    return `${sdk.name}: ${sdk.failure.code}`;
  }
  console.error('[relay] error', err);
  return err instanceof Error ? err.message : String(err);
}

export async function POST(req: Request): Promise<NextResponse<RelayResponse | { error: string }>> {
  let message = '';
  try {
    const body = (await req.json()) as { message?: unknown };
    if (typeof body.message === 'string') message = body.message.trim();
  } catch {
    // fall through to the 400 below
  }
  if (!message) return NextResponse.json({ error: 'body must be { "message": string }' }, { status: 400 });
  if (message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json({ error: `message longer than ${MAX_MESSAGE_CHARS} chars` }, { status: 413 });
  }

  try {
    const c = getClient();

    // 1. Attestation: TDX quote (dcap-qvl), NVIDIA NRAS, report_data binds nonce + signing key,
    //    MRCONFIGID = sha256(app_compose), RTMR3 replay. Throws (VerificationError) on any failure.
    const t0 = performance.now();
    const attestation = await verifyWithRetry(c, MODEL);
    const verifyMs = Math.round(performance.now() - t0);

    // 2. One chat completion, fields encrypted to the verified model key; the SDK keeps the exact
    //    request/response bytes for step 3 and decrypts the answer for us.
    const t1 = performance.now();
    const completion = await c.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: message }],
      stream: false,
    });
    const chatMs = Math.round(performance.now() - t1);
    const content = completion.choices[0]?.message.content ?? '';

    const base = {
      completionId: completion.id,
      model: completion.model,
      content,
      attestation: summarizeAttestation(attestation),
    };

    // 3. Fetch GET /v1/signature/{id}, recompute sha256 over the retained bytes, verify the signature
    //    against the signer from the attestation used for this very request.
    const t2 = performance.now();
    try {
      const vr = await c.verifyResponse(completion.id);
      const result: RelayResponse = {
        ...base,
        signedText: vr.signature.signedText,
        signature: vr.signature.signature,
        signingAddress: vr.signature.signer.signingAddress,
        signingAlgo: vr.signature.signer.signingAlgo,
        signatureKind: vr.signatureKind,
        verified: true,
        timingsMs: { verify: verifyMs, chat: chatMs, verifyResponse: Math.round(performance.now() - t2) },
      };
      return NextResponse.json(result);
    } catch (err) {
      const result: RelayResponse = {
        ...base,
        signedText: null,
        signature: null,
        signingAddress: null,
        signingAlgo: null,
        signatureKind: null,
        verified: false,
        failure: describeError(err),
        timingsMs: { verify: verifyMs, chat: chatMs, verifyResponse: Math.round(performance.now() - t2) },
      };
      return NextResponse.json(result);
    }
  } catch (err) {
    // Attestation or transport failed: nothing was (or should have been) sent to the model.
    return NextResponse.json({ error: describeError(err) }, { status: 502 });
  }
}
