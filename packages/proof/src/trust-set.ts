// The client-side trust policy (SPEC §7.1) as a viewer's own choice: which verifiers count and how many must agree.
// It comes back from browser storage, so it is validated here like any other input. Anything malformed is no choice at
// all, and the caller falls back to the site's default instead of to something weaker.
import { z } from 'zod';

/** NEAR account id rules: 2 to 64 characters, lowercase alphanumeric parts separated by `.`, `-` or `_`. */
export const NEAR_ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;

export const TrustSet = z
  .object({
    verifiers: z.array(z.string().regex(NEAR_ACCOUNT)).max(100),
    /** Never below 1: a quorum of 0 would let a key through with no confirmation at all. */
    quorum: z.number().int().min(1),
  })
  .strict();
export type TrustSet = z.infer<typeof TrustSet>;

export function parseTrustSet(value: unknown): TrustSet | null {
  const parsed = TrustSet.safeParse(value);
  return parsed.success ? { ...parsed.data, verifiers: [...new Set(parsed.data.verifiers)] } : null;
}

/** The highest quorum a list of this size can meet; an empty list still needs 1, so it refuses everything. */
export const clampQuorum = (quorum: number, verifierCount: number): number => Math.max(1, Math.min(quorum, verifierCount));
