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

test('checkRelease: a file that does not match is a failure; a report without an action log is not checked', async () => {
  const bad = await checkRelease(attestation([up('2026-11-03T10:00:00Z', B, 'v0.0.2', 'f'.repeat(64))]), MODEL, github);
  assert.equal(bad.status, 'fail');
  assert.match(bad.failures[0] ?? '', /^the file of the release \(proxy-a\): the public file hashes to /);
  const none = await checkRelease({ deployment: { appCompose: '{}' }, report: {} } as unknown as Parameters<typeof checkRelease>[0], MODEL, github);
  assert.deepEqual([none.status, none.release, none.unresolved], ['skipped', undefined, 'this model report carries no action log']);
});
