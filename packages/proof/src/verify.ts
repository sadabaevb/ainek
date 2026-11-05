// verifyModelProof: everything the user's own device can re-check without trusting us (SPEC §5.1 rules).
// Returns a step-by-step report; the proof card and /verify render it line by line.
import { commitOf } from './commit.ts';
import { normalizeHex, sha256Hex } from './hash.ts';
import { KeyEntry, ModelProof } from './schema.ts';
import { parseSignedText } from './signed-text.ts';
import { verifySignedText } from './signature.ts';

export type CheckStatus = 'ok' | 'fail' | 'skipped';

export interface Check {
  id: CheckId;
  status: CheckStatus;
  detail: string;
}

export type CheckId =
  | 'schema'
  | 'route'
  | 'signed-text'
  | 'request-hash'
  | 'response-hash'
  | 'signature'
  | 'key-in-log'
  | 'commit'
  | 'log-entry' // the chain re-read of the entry the proof points at (resolveLogEntry)
  | 'on-chain-commit' // the proof_commit record (checkProofCommit)
  // action proofs: the policy decision (checkPolicyOutput in policy.ts)
  | 'decision-signature'
  | 'decision-key'
  | 'wasm-hash'
  | 'action-commit'
  | 'model-proof-commit'
  | 'decision-expiry';

export interface VerifyReport {
  /** True only when no check failed. Skipped checks (no raw bytes given) do not make it false. */
  ok: boolean;
  checks: Check[];
  proof: ModelProof | null;
}

export function verifyModelProof(
  proofInput: unknown,
  rawRequest: Uint8Array | string | undefined,
  rawResponse: Uint8Array | string | undefined,
  logEntry: unknown,
): VerifyReport {
  const checks: Check[] = [];
  const push = (id: CheckId, status: CheckStatus, detail: string) => checks.push({ id, status, detail });

  const parsed = ModelProof.safeParse(proofInput);
  if (!parsed.success) {
    push('schema', 'fail', `proof does not match SPEC §5.1: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return { ok: false, checks, proof: null };
  }
  const proof = parsed.data;
  push('schema', 'ok', 'proof matches the ModelProof schema (SPEC §5.1)');

  // 1. Route: only a signature made inside the model TEE counts (SPEC §3.9).
  if (proof.signatureKind === 'provider_tee') {
    push('route', 'ok', 'signed inside the model TEE (signature_kind = provider_tee)');
  } else {
    push('route', 'fail', `signature_kind is "${proof.signatureKind}": the answer went through a non-attested route; privacy is contractual only`);
  }

  // 2. Signed text: model and the two hashes the TEE signed must be the ones the proof claims.
  let signed: ReturnType<typeof parseSignedText> | null = null;
  try {
    signed = parseSignedText(proof.signedText);
    const problems: string[] = [];
    if (signed.model !== proof.model) problems.push(`model in signed text is ${signed.model ?? '(none)'}, proof says ${proof.model}`);
    if (signed.requestSha256 !== proof.requestSha256) problems.push('requestSha256 differs from signed text');
    if (signed.responseSha256 !== proof.responseSha256) problems.push('responseSha256 differs from signed text');
    push('signed-text', problems.length === 0 ? 'ok' : 'fail', problems.length === 0 ? 'signed text carries this model and these hashes' : problems.join('; '));
  } catch (err) {
    push('signed-text', 'fail', (err as Error).message);
  }

  // 3. Hashes recomputed from the raw bytes the user kept.
  hashCheck('request-hash', rawRequest, proof.requestSha256, 'request');
  hashCheck('response-hash', rawResponse, proof.responseSha256, 'response');

  // 4. The signature itself, locally.
  const sig = verifySignedText({
    signedText: proof.signedText,
    signature: proof.signature,
    signingAddress: proof.signingAddress,
    signingAlgo: proof.signingAlgo,
  });
  push('signature', sig.ok ? 'ok' : 'fail', sig.detail);

  // 5. Fail-closed: the signer must be the key an independent verifier logged on NEAR.
  keyInLog(logEntry, proof);

  // 6. If the proof was committed, the commit must be reproducible from salt + payload.
  if (proof.salt !== undefined && proof.commit !== undefined) {
    const recomputed = commitOf(proof.salt, proof);
    push('commit', recomputed === proof.commit ? 'ok' : 'fail', recomputed === proof.commit ? `commit ${proof.commit.slice(0, 12)}… reproduced from salt + proof` : 'commit does not match sha256(salt || canonical proof)');
  } else {
    push('commit', 'skipped', 'proof not committed yet (no salt/commit)');
  }

  return { ok: checks.every((c) => c.status !== 'fail'), checks, proof };

  function hashCheck(id: CheckId, raw: Uint8Array | string | undefined, expected: string, what: string): void {
    if (raw === undefined) {
      push(id, 'skipped', `raw ${what} bytes not provided; hash taken from the proof`);
      return;
    }
    const actual = sha256Hex(raw);
    push(id, actual === expected ? 'ok' : 'fail', actual === expected ? `sha256(raw ${what}) matches the signed hash` : `sha256(raw ${what}) = ${actual.slice(0, 12)}…, signed hash = ${expected.slice(0, 12)}…`);
  }

  function keyInLog(entryInput: unknown, p: ModelProof): void {
    if (entryInput === null || entryInput === undefined) {
      push('key-in-log', 'fail', 'no public log entry for this key: not sent (fail-closed)');
      return;
    }
    const entry = KeyEntry.safeParse(entryInput);
    if (!entry.success) {
      push('key-in-log', 'fail', `log entry does not match SPEC §4.1: ${entry.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      return;
    }
    const e = entry.data;
    const problems: string[] = [];
    if (normalizeHex(e.signing_address) !== normalizeHex(p.signingAddress)) problems.push('signing_address differs from the logged key');
    if (e.signing_algo !== p.signingAlgo) problems.push('signing_algo differs');
    if (e.model !== p.model) problems.push(`log entry is for ${e.model}, proof is for ${p.model}`);
    if (e.index !== p.logIndex) problems.push(`proof points at log index ${p.logIndex}, entry has index ${e.index}`);
    if (e.verifier !== p.verifier) problems.push(`entry was logged by ${e.verifier}, proof says ${p.verifier}`);
    push('key-in-log', problems.length === 0 ? 'ok' : 'fail', problems.length === 0 ? `key #${e.index} logged by ${e.verifier} (tcb ${e.tcb_status})` : problems.join('; '));
  }
}

/** A report with checks made outside verifyModelProof folded in (the chain re-read, the on-chain commit); `ok` is recomputed. */
export function withChecks(report: VerifyReport, ...extra: Check[]): VerifyReport {
  const checks = [...report.checks, ...extra];
  return { ...report, checks, ok: checks.every((c) => c.status !== 'fail') };
}
