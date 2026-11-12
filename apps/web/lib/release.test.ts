import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '@ainek/proof';
import { checkRelease } from './release.ts';

// The chain itself is tested in @ainek/tier1-node. Here: what the page makes of it. The images are ones no build policy
// covers, so nothing reaches Sigstore, and GitHub is a fake.
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const MODEL = 'vendor/model-a';
const file = (digest: string) => `services:\n  proxy-a:\n    image: org/proxy@sha256:${digest}\n    environment:\n      - MODEL_NAME=${MODEL}\n`;
const FILES: Record<string, string> = { [A]: file('1'.repeat(64)), [B]: file('2'.repeat(64)) };
const TAGS: Record<string, string> = { 'v0.0.1': A, 'v0.0.2': B };
const up = (timestamp: string, commit: string, tag: string, fileSha256 = sha256Hex(FILES[commit] ?? '')) => ({ action: 'compose_up', timestamp, commit, tag, file: 'prod/models.yaml', file_sha256: fileSha256 });
const attestation = (actions: object[]) => ({ deployment: { appCompose: '{}', composeManager: { actions, tcbStatus: 'UpToDate' } }, report: {} }) as unknown as Parameters<typeof checkRelease>[0];
const github = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
  const { pathname, searchParams } = new URL(String(input));
  const text = pathname.includes('/contents/') ? FILES[searchParams.get('ref') ?? ''] : undefined;
  if (text) return new Response(text);
  const sha = TAGS[pathname.split('/commits/')[1] ?? ''];
  return sha ? Response.json({ sha, commit: { committer: { date: '2026-11-03T09:00:00Z' } } }) : new Response('{}', { status: 404 });
}) as typeof globalThis.fetch;

test('checkRelease: the release, its history newest first, and no green while something was not checked', async () => {
  const check = await checkRelease(attestation([up('2026-11-01T12:00:00Z', A, 'v0.0.1'), up('2026-11-03T10:00:00.5+00:00', B, 'v0.0.2')]), MODEL, github);
  assert.deepEqual(check.release, { name: 'v0.0.2', file: 'prod/models.yaml', deployedAt: '2026-11-03 10:00 UTC' });
  assert.deepEqual(check.history.map((r) => [r.name, r.deployedAt]), [['v0.0.2', '2026-11-03 10:00 UTC'], ['v0.0.1', '2026-11-01 12:00 UTC']]);
  // The file and the tag held; the image has no build policy and no event log came with the report: not green.
  assert.equal(check.status, 'skipped');
  assert.deepEqual(check.failures, []);
  assert.ok(check.unchecked.length > 0);
  assert.ok(check.lines.some((l) => l.status === 'ok' && l.text.includes('tag v0.0.2')));
});

test('checkRelease: an inspection is kept for the report it read, unless GitHub left something unanswered', async () => {
  let requests = 0;
  const counting = (answer: typeof globalThis.fetch) =>
    ((...args: Parameters<typeof globalThis.fetch>) => {
      requests += 1;
      return answer(...args);
    }) as typeof globalThis.fetch;
  // What stays unchecked here cannot change (no build policy for the image, no event logs): the inspection is kept,
  // and a second card over the same report asks GitHub nothing. Another report is another inspection.
  const report = attestation([up('2026-11-05T10:00:00Z', B, 'v0.0.2')]);
  const first = await checkRelease(report, MODEL, counting(github));
  const asked = requests;
  const second = await checkRelease(report, MODEL, counting(github));
  assert.deepEqual([first.retry, asked > 0, requests - asked, second.release?.name], [false, true, 0, 'v0.0.2']);
  await checkRelease(attestation([up('2026-11-05T10:00:00Z', B, 'v0.0.2')]), MODEL, counting(github));
  assert.equal(requests, 2 * asked, 'the same log in another report is read again');

  // GitHub not answering for the tag: said so, offered again, and not kept.
  const down = ((input: Parameters<typeof globalThis.fetch>[0]) => (String(input).includes('/commits/') ? Promise.resolve(new Response('{}', { status: 503 })) : github(input))) as typeof globalThis.fetch;
  const flaky = attestation([up('2026-11-05T10:00:00Z', B, 'v0.0.2')]);
  const unanswered = await checkRelease(flaky, MODEL, down);
  assert.deepEqual([unanswered.retry, unanswered.status], [true, 'skipped']);
  assert.ok(unanswered.unchecked.includes('the tag of the release (proxy-a)'));
  requests = 0;
  const retried = await checkRelease(flaky, MODEL, counting(github));
  assert.ok(requests > 0, 'asked again');
  assert.ok(!retried.unchecked.includes('the tag of the release (proxy-a)'));
});

test('checkRelease: a file that does not match is a failure; a report without an action log is not checked', async () => {
  const bad = await checkRelease(attestation([up('2026-11-03T10:00:00Z', B, 'v0.0.2', 'f'.repeat(64))]), MODEL, github);
  assert.equal(bad.status, 'fail');
  assert.match(bad.failures[0] ?? '', /^the file of the release \(proxy-a\): the public file hashes to /);
  assert.equal(bad.retry, false, 'a failure is an answer: asking again changes nothing');
  const none = await checkRelease({ deployment: { appCompose: '{}' }, report: {} } as unknown as Parameters<typeof checkRelease>[0], MODEL, github);
  assert.deepEqual([none.status, none.release, none.unresolved, none.retry], ['skipped', undefined, 'this model report carries no action log', false]);
});
