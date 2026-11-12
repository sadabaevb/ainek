import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checked } from './checked.ts';
import { readRepoJson } from './fixtures.ts';
import { evaluateKeyLog } from './key-log.ts';
import { actionsHash, attestedLogsOf, evaluateRelease, logMark, marksOf, releaseMark, withReleaseRule } from './release-marks.ts';
import type { ManagerAction } from './release.ts';
import type { KeyEntry, RawReport } from './index.ts';

const FILE = 'prod/models.yaml';
const INSTANCE = '19aea1693533dc2d529db03e3f725f20bde8d66d';
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const up = (timestamp: string, fileSha256: string, file = FILE): ManagerAction => ({ action: 'compose_up', timestamp, commit: 'a'.repeat(40), file, file_sha256: fileSha256 });
const LOG: ManagerAction[] = [{ action: 'compose_manager_started', timestamp: '2026-11-01T09:00:00Z', image: 'org/manager@sha256:aa' }, up('2026-11-01T10:00:00Z', H1), { action: 'docker_restart', timestamp: '2026-11-01T11:00:00Z', container: 'nginx' }];
const entry = (index: number, verifier: string, marks: string[]): KeyEntry => ({ index, verifier, image_digests: [`sha256:${'d'.repeat(64)}`, ...marks] }) as unknown as KeyEntry;

test('actionsHash: the form the enclave quotes, checked against a recorded report', () => {
  const manager = readRepoJson<RawReport>('docs/samples/attestation-report.json').model_attestations[0]?.compose_manager_attestation;
  assert.ok(manager, 'the recording carries an action log');
  assert.equal(actionsHash(manager.actions as ManagerAction[]), manager.actions_hash);
  // Field order does not matter, an added action does.
  assert.equal(actionsHash([{ timestamp: 't', action: 'a' }]), actionsHash([{ action: 'a', timestamp: 't' }]));
  assert.notEqual(actionsHash(LOG), actionsHash(LOG.slice(0, -1)));
});

test('marks: what a verifier writes, within the 128 bytes the contract allows, and read back apart from image digests', () => {
  const long = `prod/${'A-very-long-compose-file-name-'.repeat(8)}.yaml`;
  const marks = [releaseMark(long, H1.toUpperCase()), logMark(INSTANCE, LOG)];
  assert.match(marks[0] ?? '', /^release:[0-9a-f]{16}:1{64}$/);
  assert.equal(marks[1], `log:19aea1693533dc2d:3:${actionsHash(LOG)}`);
  assert.ok(marks.every((mark) => new TextEncoder().encode(mark).length <= 128));
  const read = marksOf([`sha256:${'d'.repeat(64)}`, ...marks, 'release:not-a-mark', 'log:19aea1693533dc2d:x:y']);
  assert.deepEqual(read.releases.map((r) => r.fileSha256), [H1]);
  assert.deepEqual(read.logs, [{ instance: '19aea1693533dc2d', length: 3, hash: actionsHash(LOG) }]);
});

test('evaluateRelease: the log exactly as a trusted verifier marked it passes; anything the enclave did since does not', () => {
  const logged = [entry(7, 'v1.testnet', [releaseMark(FILE, H1), logMark(INSTANCE, LOG)])];
  assert.deepEqual(evaluateRelease(logged, { actions: LOG, instance: INSTANCE }), { status: 'ok', confirmedBy: ['v1.testnet'], detail: 'the action log as it stands (3 actions) was checked and logged by v1.testnet' });
  // The enclave has since deployed: from the same file, from another file, or by restarting its manager. The rule does not
  // read the action, so each of them is a log no verifier has checked.
  for (const next of [up('2026-11-02T10:00:00Z', H2), up('2026-11-02T10:00:00Z', H1, 'prod/another.yaml'), { action: 'compose_manager_started', timestamp: '2026-11-02T10:00:00Z', image: 'org/manager@sha256:bb' }, { action: 'docker_restart', timestamp: '2026-11-02T10:00:00Z', container: 'proxy' }]) {
    const since = evaluateRelease(logged, { actions: [...LOG, next], instance: INSTANCE });
    assert.equal(since.status, 'unknown-release', next.action);
    assert.match(since.detail, new RegExp(`has 1 action since entry #7 by v1\\.testnet saw it \\(the latest: ${next.action} at 2026-11-02T10:00:00Z\\)`));
  }
  // Once a verifier has looked again, the longer log passes, and the earlier mark of the same instance does not get in its way.
  const longer = [...LOG, up('2026-11-02T10:00:00Z', H2)];
  assert.equal(evaluateRelease([...logged, entry(8, 'v1.testnet', [releaseMark(FILE, H2), logMark(INSTANCE, longer)])], { actions: longer, instance: INSTANCE }).status, 'ok');
});

test('evaluateRelease: no marks, another instance, no instance', () => {
  // A verifier that does not write marks yet: the key and the launcher are logged, the action log is not.
  const unmarked = evaluateRelease([entry(7, 'v1.testnet', [])], { actions: LOG, instance: INSTANCE });
  assert.equal(unmarked.status, 'unlogged-release');
  assert.match(unmarked.detail, /none of the 1 log entry for this key and launcher records a check of the enclave's action log/);
  // A release mark alone is a name, not a check of this log.
  assert.equal(evaluateRelease([entry(7, 'v1.testnet', [releaseMark(FILE, H1)])], { actions: LOG, instance: INSTANCE }).status, 'unlogged-release');
  // Marks of another instance behind the same key and launcher say nothing about this one, whatever they are.
  const other = [entry(7, 'v1.testnet', [logMark('ff'.repeat(20), LOG)]), entry(8, 'v1.testnet', [logMark('ee'.repeat(20), [...LOG, ...LOG])])];
  const unseen = evaluateRelease(other, { actions: LOG, instance: INSTANCE });
  assert.equal(unseen.status, 'unknown-release');
  assert.match(unseen.detail, /no trusted verifier has logged the action log of this instance \(19aea1693533dc2d\)/);
  // An event log that names no instance: the log cannot be matched to a mark.
  assert.equal(evaluateRelease([entry(7, 'v1.testnet', [logMark(INSTANCE, LOG)])], { actions: LOG }).status, 'unknown-release');
});

test('evaluateRelease: a quorum counts distinct verifiers that logged the log as it stands', () => {
  const marks = [releaseMark(FILE, H1), logMark(INSTANCE, LOG)];
  const one = [entry(7, 'v1.testnet', marks), entry(8, 'v1.testnet', marks)];
  const short = evaluateRelease(one, { actions: LOG, instance: INSTANCE }, 2);
  assert.deepEqual([short.status, short.confirmedBy], ['unknown-release', ['v1.testnet']]);
  assert.match(short.detail, /only 1 of 2 required verifiers/);
  assert.equal(evaluateRelease([...one, entry(9, 'v2.testnet', marks)], { actions: LOG, instance: INSTANCE }, 2).status, 'ok');
  // A verifier that saw an earlier state of the log does not count for the log as it stands.
  assert.equal(evaluateRelease([...one, entry(9, 'v2.testnet', [logMark(INSTANCE, LOG.slice(0, 2))])], { actions: LOG, instance: INSTANCE }, 2).status, 'unknown-release');
});

test('evaluateRelease: a log that does not continue what a verifier saw was rewritten', () => {
  const seen = [entry(7, 'v1.testnet', [releaseMark(FILE, H1), logMark(INSTANCE, LOG)])];
  // Shorter than what was seen.
  const shorter = evaluateRelease(seen, { actions: LOG.slice(0, 2), instance: INSTANCE });
  assert.equal(shorter.status, 'rewritten-log');
  assert.match(shorter.detail, /entry #7 by v1\.testnet saw 3 actions from this instance; the log attested now has 2/);
  // As long or longer, with an earlier action edited.
  const edited = [LOG[0] as ManagerAction, up('2026-11-01T10:00:00Z', H2), LOG[2] as ManagerAction, up('2026-11-02T10:00:00Z', H1)];
  assert.equal(evaluateRelease(seen, { actions: edited, instance: INSTANCE }).status, 'rewritten-log');
  // The exact log logged by one verifier does not excuse a rewritten prefix another one saw.
  const both = [entry(8, 'v2.testnet', [logMark(INSTANCE, edited)]), ...seen];
  assert.equal(evaluateRelease(both, { actions: edited, instance: INSTANCE }).status, 'rewritten-log');
});

test('withReleaseRule: on top of a key that passed, per attested report; a key that did not pass is returned as it is', () => {
  // The recorded entry #0, as a verifier that writes marks would have logged it.
  const { entry: recorded } = readRepoJson<{ entry: KeyEntry }>('docs/samples/key-entry.sample.json');
  const query = { model: recorded.model, signingAddress: recorded.signing_address, trustedVerifiers: [recorded.verifier], quorum: 1 };
  const entries = [{ ...recorded, image_digests: [...recorded.image_digests, releaseMark(FILE, H1), logMark(INSTANCE, LOG)] }];
  const key = evaluateKeyLog(entries, { ...query, composeHash: recorded.compose_hash });
  assert.equal(key.status, 'ok');
  const report = { composeHash: recorded.compose_hash, actions: LOG, instance: checked.ok(INSTANCE) };
  assert.equal(withReleaseRule(key, entries, query, [report]), key, 'the logged log: the key verdict stands');
  // Two replicas behind the key: one has deployed since the verifier looked, and that refuses the message.
  const refused = withReleaseRule(key, entries, query, [report, { ...report, actions: [...LOG, up('2026-11-02T10:00:00Z', H2)] }]);
  assert.deepEqual([refused.status, refused.reason], ['not-logged', 'unknown-release']);
  assert.match(refused.detail, /: not sent \(fail-closed\)$/);
  assert.deepEqual(refused.matching, key.matching, 'what vouched for the key is kept for the card');
  // A launcher no entry vouches for has no action log logged either.
  assert.equal(withReleaseRule(key, entries, query, [{ ...report, composeHash: 'cd'.repeat(32) }]).reason, 'unlogged-release');
  // No report with an action log at all, and a rewritten log.
  assert.equal(withReleaseRule(key, entries, query, []).reason, 'unlogged-release');
  assert.equal(withReleaseRule(key, entries, query, [{ ...report, actions: LOG.slice(0, 1) }]).reason, 'rewritten-log');
  // The log was quoted by another instance than the key: it is not this enclave's record, whatever it says.
  const foreign = withReleaseRule(key, entries, query, [{ ...report, instance: checked.failed('the log was quoted by instance aa, the signing key by instance bb') }]);
  assert.deepEqual([foreign.reason, foreign.detail], ['unknown-release', 'the log was quoted by instance aa, the signing key by instance bb: not sent (fail-closed)']);
  // No instance id in an event log: nothing to match a mark to.
  assert.equal(withReleaseRule(key, entries, query, [{ ...report, instance: checked.skipped('an event log names no instance id') }]).reason, 'unknown-release');
  // A key the log does not hold stays refused for its own reason.
  const absent = evaluateKeyLog(entries, { ...query, signingAddress: 'ab'.repeat(32) });
  assert.equal(withReleaseRule(absent, entries, query, [report]), absent);
});

test('attestedLogsOf: the reports that carry the key, each with its launcher, its action log and the instance both quotes name', () => {
  const events = (instance: string) => [{ imr: 3, event_type: 0x08000001, event: 'instance-id', event_payload: instance }];
  const report = (key: string, appCompose: string, actions?: ManagerAction[], logInstance = INSTANCE) => ({ signer: { signingAddress: key }, deployment: { appCompose, ...(actions ? { composeManager: { actions } } : {}) }, report: { eventLog: events(INSTANCE), ...(actions ? { composeManagerAttestation: { eventLog: events(logInstance) } } : {}) } });
  const logs = attestedLogsOf([report('AA', 'one', LOG), report('bb', 'two', LOG), report('aa', 'three'), report('aa', 'four', LOG, 'ff'.repeat(20))], 'aa', true);
  assert.deepEqual(logs.map((l) => [l.actions.length, l.instance.status]), [[3, 'ok'], [0, 'skipped'], [3, 'fail']]);
  assert.deepEqual(logs[0]?.instance, checked.ok(INSTANCE));
  assert.match(logs[0]?.composeHash ?? '', /^[0-9a-f]{64}$/);
  assert.deepEqual(attestedLogsOf([report('aa', 'one', LOG)], 'aa', false).map((l) => l.composeHash), [undefined], 'without the launcher rule every entry for the key may vouch');
});
