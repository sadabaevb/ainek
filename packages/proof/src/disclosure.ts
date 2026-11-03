// Selective disclosure (SPEC §5.1, "Раскрыть аудитору"): one exchange's proof, its log entry and the exact
// bytes, in one JSON file an auditor can feed to /verify, /auditor or the replay demo. The bytes are the E2EE
// ciphertext as sent/received: the plaintext is never part of a disclosure.
import { z } from 'zod';
import { KeyEntry, ModelProof } from './schema.ts';

export const Disclosure = z
  .object({
    v: z.literal(1),
    kind: z.literal('disclosure'),
    proof: ModelProof,
    logEntry: KeyEntry,
    rawRequestBase64: z.string(),
    rawResponseBase64: z.string(),
    disclosedAt: z.iso.datetime(),
    note: z.string().optional(),
  })
  .strict();
export type Disclosure = z.infer<typeof Disclosure>;

export interface DisclosedExchange {
  proof: ModelProof;
  logEntry: KeyEntry;
  requestBody: Uint8Array;
  responseBody: Uint8Array;
}

const NOTE = 'Selective disclosure of ONE exchange: lets an auditor recompute the hashes and the salted commit. The raw bytes are the E2EE ciphertext as sent/received; no plaintext is included.';

export function toDisclosure(x: DisclosedExchange): Disclosure {
  return Disclosure.parse({
    v: 1,
    kind: 'disclosure',
    proof: x.proof,
    logEntry: x.logEntry,
    rawRequestBase64: bytesToBase64(x.requestBody),
    rawResponseBase64: bytesToBase64(x.responseBody),
    disclosedAt: new Date().toISOString(),
    note: NOTE,
  });
}

export function parseDisclosure(value: unknown): DisclosedExchange {
  const d = Disclosure.parse(value);
  return { proof: d.proof, logEntry: d.logEntry, requestBody: base64ToBytes(d.rawRequestBase64), responseBody: base64ToBytes(d.rawResponseBase64) };
}

export function isDisclosure(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'disclosure';
}

// btoa/atob exist in browsers and in Node >= 16; chunked to stay under the argument limit of String.fromCharCode.
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
