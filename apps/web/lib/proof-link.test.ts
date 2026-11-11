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
  await assert.rejects(proofFragment('0'.repeat(2_000_000)), /too long for a link/);
  // A link made elsewhere that inflates past the limit: 1.5 MB of zeros deflates to a few hundred characters.
  const deflated = new Uint8Array(await new Response(new Blob(['0'.repeat(1_500_000)]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  await assert.rejects(proofFromFragment(`d=${Buffer.from(deflated).toString('base64url')}`), /more than a proof/);
  await assert.rejects(proofFromFragment(`d=${'A'.repeat(200_001)}`), /too long/);
});
