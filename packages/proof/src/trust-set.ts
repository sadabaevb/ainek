// The client-side trust policy (SPEC §7.1) as a viewer's own choice: which verifiers count and how many must agree.
// It comes back from browser storage, so it is validated here like any other input. Anything malformed is no choice at
// all, and the caller falls back to the site's default instead of to something weaker.
import { z } from 'zod';
import { evaluateKeyLog, type KeyLogVerdict } from './key-log.ts';
import type { KeyEntry } from './schema.ts';

/** NEAR account id rules: 2 to 64 characters, lowercase alphanumeric parts separated by `.`, `-` or `_`. */
export const NEAR_ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;

const Schema = z
  .object({
    verifiers: z.array(z.string().regex(NEAR_ACCOUNT)).max(100),
    /** Never below 1: a quorum of 0 would let a key through with no confirmation at all. */
    quorum: z.number().int().min(1),
  })
  .strict();
export type TrustSet = z.infer<typeof Schema>;

/** The stored JSON text of a choice. */
export function parseTrustSet(raw: string | null): TrustSet | null {
  if (!raw) return null;
  try {
    const parsed = Schema.safeParse(JSON.parse(raw));
    return parsed.success ? { ...parsed.data, verifiers: [...new Set(parsed.data.verifiers)] } : null;
  } catch {
    return null;
  }
}

/**
 * What to store for a change. A choice equal to the site default is no choice: null forgets it, so a later change of the
 * default reaches this viewer. The quorum is kept as asked even when the list falls short of it: the chat then refuses until
 * the viewer lowers it, because lowering it here would quietly weaken the policy when a verifier is unticked and ticked again.
 */
export function chooseTrust(next: TrustSet, siteDefault: TrustSet): TrustSet | null {
  const sameList = next.verifiers.length === siteDefault.verifiers.length && next.verifiers.every((v) => siteDefault.verifiers.includes(v));
  return sameList && next.quorum === siteDefault.quorum ? null : next;
}

export type TrustPreview = { kind: 'nobody' } | { kind: 'no-entries' } | { kind: 'checked'; key: string; verdict: KeyLogVerdict };

/**
 * What a trust set means right now, before any message: the chat's own check, run on the newest key from a verifier the viewer
 * counts (or from anyone, when nobody on the list wrote), because the model's key is known only after attestation.
 */
export function previewTrust(entries: readonly KeyEntry[], model: string, trust: TrustSet): TrustPreview {
  if (trust.verifiers.length === 0) return { kind: 'nobody' };
  const forModel = entries.filter((e) => e.model === model); // the contract answers newest first
  const newest = forModel.find((e) => trust.verifiers.includes(e.verifier)) ?? forModel[0];
  if (!newest) return { kind: 'no-entries' };
  return { kind: 'checked', key: newest.signing_address, verdict: evaluateKeyLog(entries, { model, signingAddress: newest.signing_address, trustedVerifiers: trust.verifiers, quorum: trust.quorum }) };
}
