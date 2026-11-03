import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, compareCodePoints, CanonicalError } from './canonical.ts';
import { sha256Hex } from './hash.ts';
import { readRepoJson } from './fixtures.ts';

interface Vector { name: string; input: unknown; canonical: string; sha256: string }
const doc = readRepoJson<{ vectors: Vector[] }>('docs/test-vectors/canonical.json');

for (const v of doc.vectors) {
  test(`vector: ${v.name}`, () => {
    const canonical = canonicalJson(v.input);
    assert.equal(canonical, v.canonical);
    assert.equal(sha256Hex(canonical), v.sha256);
  });
}

test('vectors cover the cases the Rust side must match', () => {
  assert.ok(doc.vectors.length >= 13);
});

test('-0 becomes 0', () => {
  assert.equal(canonicalJson({ x: -0 }), '{"x":0}');
});

test('undefined members are omitted, undefined array items become null', () => {
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJson([1, undefined, 2]), '[1,null,2]');
});

test('rejects floats, non-finite numbers, bigints and non-plain objects', () => {
  for (const bad of [{ x: 1.5 }, { x: 1e21 }, { x: Number.NaN }, { x: Number.POSITIVE_INFINITY }, { x: 123n }, { x: new Date(0) }, { x: new Map() }, { x: () => 1 }]) {
    assert.throws(() => canonicalJson(bad), CanonicalError);
  }
});

test('compareCodePoints orders like UTF-8 bytes, unlike default sort', () => {
  const keys = ['😀', 'ﬁ', 'z'];
  assert.deepEqual([...keys].sort(compareCodePoints), ['z', 'ﬁ', '😀']);
  assert.deepEqual([...keys].sort(), ['z', '😀', 'ﬁ']); // UTF-16 order: the trap we avoid
  assert.equal(compareCodePoints('a', 'a'), 0);
  assert.ok(compareCodePoints('a', 'ab') < 0);
});
