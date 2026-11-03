// Canonical JSON: the one byte-exact serialisation that both sides hash and sign.
//
// The same bytes must come out of `packages/proof/src/canonical.ts` (TS: client, verifier, agent) and
// `jobs/policy/src/canonical.rs` / the contract (Rust). Rules, chosen so that plain `serde_json` on a
// `serde_json::Value` (BTreeMap keys, `preserve_order` feature OFF) produces them without custom code:
//   - object keys sorted by Unicode code point (== UTF-8 byte order == Rust `BTreeMap<String, _>`);
//     NOTE: JS `Array.prototype.sort()` compares UTF-16 code units, which differs for astral characters,
//     so we sort by code point explicitly;
//   - no whitespace anywhere;
//   - strings escaped like JSON.stringify / serde_json: `"`, `\`, \b \f \n \r \t, other controls as
//     lowercase \u00xx; `/` and non-ASCII are NOT escaped (raw UTF-8);
//   - numbers: only safe integers (|n| <= 2^53-1) are allowed. Floats and big numbers are rejected: JS
//     and Rust print them differently (`1e+21` vs `1e21`). Put u128 amounts and u64 timestamps in strings,
//     exactly as near-sdk's U128/U64 do;
//   - arrays keep their order; `undefined` inside an array becomes `null` (as JSON.stringify does);
//   - object properties whose value is `undefined` are omitted (Rust: `skip_serializing_if`);
//   - only plain objects, arrays, strings, booleans, numbers and null; anything else throws.
// Test vectors: docs/test-vectors/canonical.json (cross-checked against Python's
// `json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False)`, which follows the same rules).

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export class CanonicalError extends Error {
  override readonly name = 'CanonicalError';
}

export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

/** UTF-8 bytes of the canonical form; this is what gets hashed and signed. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalError(
          `${path}: only safe integers are allowed as JSON numbers (got ${String(value)}); ` +
            'encode amounts, timestamps and fractions as strings',
        );
      }
      return value === 0 ? '0' : String(value); // normalises -0 to 0
    case 'object': {
      if (Array.isArray(value)) {
        const items = value.map((item, i) => serialize(item === undefined ? null : item, `${path}[${i}]`));
        return `[${items.join(',')}]`;
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        const name = (proto as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
        throw new CanonicalError(`${path}: only plain objects are allowed (got ${name})`);
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort(compareCodePoints);
      const members = keys.map((k) => `${JSON.stringify(k)}:${serialize(record[k], `${path}.${k}`)}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new CanonicalError(`${path}: unsupported value of type ${typeof value}`);
  }
}

/** Orders strings by Unicode code point, i.e. the same order as comparing their UTF-8 bytes. */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done && y.done) return 0;
    if (x.done) return -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0) as number;
    const cy = y.value.codePointAt(0) as number;
    if (cx !== cy) return cx - cy;
  }
}
