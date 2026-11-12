import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeFilesOf, firstDeployments, firstRuntimeEvent, isCommitId, isPlainTag, isRepoPath, managerStartOf, releasesFor, sameInstance, spanText, timeOf, type ManagerAction } from './release.ts';

const FILE = 'prod/models.yaml';
const up = (timestamp: string, commit: string, services?: string[], extra: Partial<ManagerAction> = {}): ManagerAction => ({ action: 'compose_up', timestamp, commit, file: FILE, tag: `v-${commit}`, file_sha256: commit.repeat(8).slice(0, 64).toUpperCase(), ...(services ? { services } : {}), ...extra });

const LOG: ManagerAction[] = [
  { action: 'compose_manager_started', timestamp: '2026-10-21T02:44:29.846652109+00:00', container: 'compose-manager', image: 'org/manager@sha256:aa' },
  up('2026-10-21T02:57:00+00:00', 'aaaaaaaa'), // no services: the whole file
  up('2026-10-21T03:10:00+00:00', 'aaaaaaaa', ['proxy-a']),
  up('2026-10-24T01:00:00+00:00', 'bbbbbbbb', ['engine-b']), // another service: the proxy keeps running aaaaaaaa
  { action: 'docker_restart', timestamp: '2026-10-24T01:05:00+00:00', container: 'nginx' },
  up('2026-10-25T00:00:00+00:00', 'aaaaaaaa', ['proxy-a']),
  up('2026-11-01T00:00:00+00:00', 'cccccccc', ['proxy-a', 'engine-b']),
  { action: 'compose_up', timestamp: '2026-11-02T00:00:00+00:00', commit: 'dddddddd', file: 'prod/other.yaml' },
  up('2026-11-03T00:00:00+00:00', 'aaaaaaaa', ['proxy-a']), // back to an old commit
  { action: 'compose_manager_started', timestamp: '2026-11-12T06:37:54+00:00', container: 'compose-manager', image: 'org/manager@sha256:bb' },
];

test('releasesFor: one release per run of a commit that covered the service; other services and files do not split or join it', () => {
  const releases = releasesFor(LOG, { file: FILE, service: 'proxy-a' });
  assert.deepEqual(releases.map((r) => [r.commit, r.deployedAt.slice(0, 10)]), [
    ['aaaaaaaa', '2026-10-21'], // three compose_up actions of this commit in a row: one release, dated by the first
    ['cccccccc', '2026-11-01'],
    ['aaaaaaaa', '2026-11-03'],
  ]);
  assert.equal(releases[0]?.tag, 'v-aaaaaaaa');
  assert.equal(releases[0]?.fileSha256, 'aaaaaaaa'.repeat(8), 'the recorded hash, lower-cased');
  assert.equal(releases.at(-1)?.commit, 'aaaaaaaa', 'a rollback is a release of its own');
});

test('releasesFor: a service the log never brought up has no releases; an action without a commit is not one', () => {
  assert.deepEqual(releasesFor([{ action: 'compose_up', timestamp: '2026-11-01T00:00:00Z', file: FILE, services: ['x'] }], { file: FILE, service: 'x' }), []);
  assert.deepEqual(releasesFor(LOG, { file: 'prod/other.yaml', service: 'proxy-a' }).map((r) => r.commit), ['dddddddd'], 'no service list covers every service of that file');
  assert.equal(releasesFor(LOG, { file: FILE, service: 'engine-b' }).length, 3);
});

test('composeFilesOf: the files in order of last use, each with its latest commit', () => {
  assert.deepEqual(composeFilesOf(LOG).map((f) => [f.file, f.commit]), [[FILE, 'aaaaaaaa'], ['prod/other.yaml', 'dddddddd']]);
  assert.equal(composeFilesOf(LOG)[1]?.fileSha256, undefined);
});

test('managerStartOf: the last start the log records', () => {
  assert.deepEqual(managerStartOf(LOG), { image: 'org/manager@sha256:bb', startedAt: '2026-11-12T06:37:54+00:00' });
  assert.equal(managerStartOf([]), undefined);
});

test('timeOf and spanText: nanosecond timestamps parse, spans read as a person would say them', () => {
  assert.equal(timeOf('2026-11-12T07:09:50.927460466+00:00'), Date.parse('2026-11-12T07:09:50.927Z'));
  assert.equal(timeOf('2026-11-12T04:55:11Z'), Date.parse('2026-11-12T04:55:11Z'));
  assert.deepEqual([36_000, 11 * 60_000, (2 * 60 + 14) * 60_000, (3 * 24 + 10) * 3_600_000, -5].map(spanText), ['36 s', '11 min', '2 h 14 min', '3 d 10 h', '0 s']);
  assert.ok(Number.isNaN(timeOf('yesterday')));
  assert.equal(spanText(Number.NaN), 'an unknown time');
});

test('isCommitId, isRepoPath, isPlainTag: what the log names is checked before it goes into a URL', () => {
  assert.ok(isCommitId('efc1618e8d0901a25ba302df4ea3112dad134328'));
  for (const bad of ['efc1618e8d', 'g'.repeat(40), `${'a'.repeat(40)}/..`, '']) assert.equal(isCommitId(bad), false, bad);
  assert.ok(isRepoPath('prod/small-models.yaml'));
  for (const bad of ['../../../other/repo/contents/x.yaml', 'prod/../x.yaml', './x.yaml', 'prod//x.yaml', '/x.yaml', '']) assert.equal(isRepoPath(bad), false, bad);
  assert.ok(isPlainTag('v0.0.565'));
  // All hex is refused: GitHub would read it as a commit id, and a commit of any fork resolves under the parent's name.
  for (const bad of ['a'.repeat(40), 'deadbeef', '..', '.hidden', 'v1/../x', 'v 1', '']) assert.equal(isPlainTag(bad), false, bad);
});

test('firstDeployments: every commit of the file once, at its first compose_up, whatever services it named', () => {
  const firsts = firstDeployments(LOG, FILE);
  assert.deepEqual(firsts.map((r) => [r.commit, r.deployedAt.slice(0, 10)]), [['aaaaaaaa', '2026-10-21'], ['bbbbbbbb', '2026-10-24'], ['cccccccc', '2026-11-01']]);
  assert.deepEqual(firstDeployments(LOG, 'prod/none.yaml'), []);
});

test('firstRuntimeEvent: the first RTMR3 runtime event of a name, from an array or its JSON text; a later one of the same name is not it', () => {
  const RUNTIME = 0x08000001;
  const log = [
    { imr: 0, event_type: 4, event: '', event_payload: 'aa' },
    { imr: 3, event_type: RUNTIME, event: 'instance-id', event_payload: 'A8A2' },
    { imr: 3, event_type: RUNTIME, event: 'system-ready', event_payload: '' },
    { imr: 3, event_type: RUNTIME, event: 'instance-id', event_payload: 'ffff' }, // appended by a container after boot
    { imr: 1, event_type: RUNTIME, event: 'os-image-hash', event_payload: 'bb' }, // not RTMR3
  ];
  assert.equal(firstRuntimeEvent(log, 'instance-id'), 'a8a2');
  assert.equal(firstRuntimeEvent(JSON.stringify(log), 'instance-id'), 'a8a2');
  assert.equal(firstRuntimeEvent(log, 'system-ready'), '');
  assert.equal(firstRuntimeEvent(log, 'os-image-hash'), undefined);
  for (const none of [undefined, null, 'not json', '{}', [null, 7, 'x']]) assert.equal(firstRuntimeEvent(none, 'instance-id'), undefined);
});

test('sameInstance: the log must be quoted by the CVM instance that quoted the signing key, not by another replica', () => {
  const events = (instance: string) => [{ imr: 3, event_type: 0x08000001, event: 'instance-id', event_payload: instance }];
  assert.deepEqual(sameInstance(events('a8a2'), JSON.stringify(events('A8A2'))), { status: 'ok', value: 'a8a2' });
  assert.deepEqual(sameInstance(events('a8a2'), events('b7b1')), { status: 'fail', why: 'the log was quoted by instance b7b1, the signing key by instance a8a2' });
  assert.equal(sameInstance(events('a8a2'), undefined).status, 'skipped');
  assert.equal(sameInstance([], events('a8a2')).status, 'skipped');
});
