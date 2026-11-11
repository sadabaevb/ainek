import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { proofFragment, proofFromFragment } from './proof-link.ts';

const sample = readFileSync(path.resolve(import.meta.dirname, '../../../docs/samples/disclosure.sample.json'), 'utf8');

test('a disclosure survives the link byte for byte, and the fragment is URL-safe', async () => {
  const fragment = await proofFragment(sample);
  assert.match(fragment, /^d=[A-Za-z0-9_-]+$/);
  assert.equal(await proofFromFragment(fragment), sample);
  assert.equal(await proofFromFragment(`#${fragment}`), sample);
  assert.ok(fragment.length < sample.length, `deflated: ${fragment.length} of ${sample.length} characters`);
});

test('another fragment is not a proof link; a damaged or oversized one is an error, not a verdict', async () => {
  assert.equal(await proofFromFragment(''), null);
  assert.equal(await proofFromFragment('#section'), null);
  await assert.rejects(proofFromFragment('d=!!!'));
  await assert.rejects(proofFromFragment('d=AAAA'));
  const bomb = await proofFragment('0'.repeat(2_000_000));
  await assert.rejects(proofFromFragment(bomb), /more than a proof/);
  await assert.rejects(proofFromFragment(`d=${'A'.repeat(200_001)}`), /too long/);
});
