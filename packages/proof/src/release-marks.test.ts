import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checked, type Checked } from './checked.ts';
import { readRepoJson } from './fixtures.ts';
import { evaluateKeyLog } from './key-log.ts';
import { actionsHash, evaluateRelease, logMark, marksOf, releaseMark, releaseStanding, withReleaseRule, type AttestedReport } from './release-marks.ts';
import type { ManagerAction } from './release.ts';
import type { KeyEntry, RawReport } from './index.ts';

const FILE = 'prod/models.yaml';
const INSTANCE = '19aea1693533dc2d529db03e3f725f20bde8d66d';
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const up = (timestamp: string, fileSha256: string, file = FILE): ManagerAction => ({ action: 'compose_up', timestamp, commit: 'a'.repeat(40), file, file_sha256: fileSha256 });
const LOG: ManagerAction[] = [{ action: 'compose_manager_started', timestamp: '2026-11-01T09:00:00Z', image: 'org/manager@sha256:aa' }, up('2026-11-01T10:00:00Z', H1), { action: 'docker_restart', timestamp: '2026-11-01T11:00:00Z', container: 'nginx' }];
const entry = (index: number, verifier: string, marks: string[]): KeyEntry => ({ index, verifier, image_digests: [`sha256:${'d'.repeat(64)}`, ...marks] }) as unknown as KeyEntry;
/** An attested action log, tied to INSTANCE unless said otherwise. */
const at = (actions: ManagerAction[], instance: Checked<string> = checked.ok(INSTANCE)) => ({ actions, instance });

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
  const digest = `sha256:${'d'.repeat(64)}`;
  const read = marksOf([digest, ...marks, 'release:not-a-mark', 'log:19aea1693533dc2d:x:y']);
  assert.deepEqual(read.releases.map((r) => r.fileSha256), [H1]);
  assert.deepEqual(read.logs, [{ instance: '19aea1693533dc2d', length: 3, hash: actionsHash(LOG) }]);
  assert.deepEqual(read.digests, [digest, 'release:not-a-mark', 'log:19aea1693533dc2d:x:y'], 'whatever is not a well-formed mark is left with the digests');
});

test('evaluateRelease: the log exactly as a trusted verifier marked it passes; anything the enclave did since does not', () => {
  const logged = [entry(7, 'v1.testnet', [releaseMark(FILE, H1), logMark(INSTANCE, LOG)])];
  assert.deepEqual(evaluateRelease(logged, at(LOG)), { status: 'ok', confirmedBy: ['v1.testnet'], detail: 'the action log as it stands (3 actions) was marked by v1.testnet' });
  // The enclave has since deployed: from the same file, from another file, or by restarting its manager. The rule does not
  // read the action, so each of them is a log no verifier has checked.
  for (const next of [up('2026-11-02T10:00:00Z', H2), up('2026-11-02T10:00:00Z', H1, 'prod/another.yaml'), { action: 'compose_manager_started', timestamp: '2026-11-02T10:00:00Z', image: 'org/manager@sha256:bb' }, { action: 'docker_restart', timestamp: '2026-11-02T10:00:00Z', container: 'proxy' }]) {
    const since = evaluateRelease(logged, at([...LOG, next]));
    assert.equal(since.status, 'unknown-release', next.action);
    assert.match(since.detail, new RegExp(`has 1 action since entry #7 by v1\\.testnet marked it \\(the latest: ${next.action} at 2026-11-02T10:00:00Z\\)`));
  }
  // Once a verifier has looked again, the longer log passes, and the earlier mark of the same instance does not get in its way.
  const longer = [...LOG, up('2026-11-02T10:00:00Z', H2)];
  assert.equal(evaluateRelease([...logged, entry(8, 'v1.testnet', [releaseMark(FILE, H2), logMark(INSTANCE, longer)])], at(longer)).status, 'ok');
});

test('evaluateRelease: no marks, another instance, a log that cannot be tied to the key', () => {
  // A verifier that does not write marks yet: the key and the launcher are logged, the action log is not.
  const unmarked = evaluateRelease([entry(7, 'v1.testnet', [])], at(LOG));
  assert.equal(unmarked.status, 'unlogged-release');
  assert.match(unmarked.detail, /none of the 1 log entry for this key and launcher carries a mark of the enclave's action log/);
  // A release mark alone is a name, not a check of this log.
  assert.equal(evaluateRelease([entry(7, 'v1.testnet', [releaseMark(FILE, H1)])], at(LOG)).status, 'unlogged-release');
  // Marks of another instance behind the same key and launcher say nothing about this one, whatever they are.
  const other = [entry(7, 'v1.testnet', [logMark('ff'.repeat(20), LOG)]), entry(8, 'v1.testnet', [logMark('ee'.repeat(20), [...LOG, ...LOG])])];
  const unseen = evaluateRelease(other, at(LOG));
  assert.equal(unseen.status, 'unknown-release');
  assert.match(unseen.detail, /no trusted verifier has marked the action log of this instance \(19aea1693533dc2d\)/);
  // The very log a verifier marked, but quoted by another instance than the key, or by none that is named: no mark vouches.
  const marked = [entry(7, 'v1.testnet', [logMark(INSTANCE, LOG)])];
  assert.deepEqual(evaluateRelease(marked, at(LOG, checked.failed('the log was quoted by instance aa, the signing key by instance bb'))), { status: 'untied-log', confirmedBy: [], detail: 'the action log cannot be tied to the enclave that holds the key: the log was quoted by instance aa, the signing key by instance bb' });
  assert.equal(evaluateRelease(marked, at(LOG, checked.skipped('an event log names no instance id'))).status, 'untied-log');
});

test('evaluateRelease: a quorum counts distinct verifiers that logged the log as it stands', () => {
  const marks = [releaseMark(FILE, H1), logMark(INSTANCE, LOG)];
  const one = [entry(7, 'v1.testnet', marks), entry(8, 'v1.testnet', marks)];
  const short = evaluateRelease(one, at(LOG), 2);
  assert.deepEqual([short.status, short.confirmedBy], ['release-below-quorum', ['v1.testnet']]);
  assert.match(short.detail, /only 1 of 2 required verifiers marked the action log as it stands/);
  assert.equal(evaluateRelease([...one, entry(9, 'v2.testnet', marks)], at(LOG), 2).status, 'ok');
  // A verifier that saw an earlier state of the log does not count for the log as it stands.
  assert.equal(evaluateRelease([...one, entry(9, 'v2.testnet', [logMark(INSTANCE, LOG.slice(0, 2))])], at(LOG), 2).status, 'release-below-quorum');
});

test('evaluateRelease: a log whose beginning is not what a verifier saw was rewritten; a shorter one is refused without that name', () => {
  const seen = [entry(7, 'v1.testnet', [releaseMark(FILE, H1), logMark(INSTANCE, LOG)])];
  // As long or longer, with an earlier action edited. An honest log begins with each of its earlier states, whenever those
  // were seen, so no timing explains this.
  const edited = [LOG[0] as ManagerAction, up('2026-11-01T10:00:00Z', H2), LOG[2] as ManagerAction, up('2026-11-02T10:00:00Z', H1)];
  const rewritten = evaluateRelease(seen, at(edited));
  assert.equal(rewritten.status, 'rewritten-log');
  assert.match(rewritten.detail, /the first 3 actions of the log attested now are not the ones entry #7 by v1\.testnet saw/);
  assert.equal(evaluateRelease(seen, at(edited.slice(0, 3))).status, 'rewritten-log', 'the same length, another content');
  // The exact log marked by one verifier does not excuse a rewritten beginning another one saw.
  assert.equal(evaluateRelease([entry(8, 'v2.testnet', [logMark(INSTANCE, edited)]), ...seen], at(edited)).status, 'rewritten-log');

  // Shorter than what a verifier saw. Either the log was cut, or this attestation was made before the verifier's entry and
  // the enclave has moved on. The lengths do not say which: refused, and not called a rewrite.
  const shorter = evaluateRelease(seen, at(LOG.slice(0, 2)));
  assert.equal(shorter.status, 'shorter-log');
  assert.match(shorter.detail, /entry #7 by v1\.testnet saw 3 actions from this instance and the log attested now has 2: this attestation is older than that entry, or the log was cut/);
  // A mark for exactly this shorter log does not outweigh the longer one: a verifier has seen the enclave move past it.
  assert.equal(evaluateRelease([entry(6, 'v1.testnet', [logMark(INSTANCE, LOG.slice(0, 2))]), ...seen], at(LOG.slice(0, 2))).status, 'shorter-log');
  // A provable rewrite is named even when a longer mark is there too.
  assert.equal(evaluateRelease([entry(9, 'v1.testnet', [logMark(INSTANCE, [...edited, ...edited])]), ...seen], at(edited)).status, 'rewritten-log');
});

test('evaluateRelease: an entry for another key or launcher can contradict the log, and cannot confirm it', () => {
  const vouching = [entry(7, 'v1.testnet', [logMark(INSTANCE, LOG)])];
  const longer = [...LOG, up('2026-11-02T10:00:00Z', H2)];
  // The instance kept its id while its launcher changed: under the other launcher a verifier saw the log two actions on.
  // The launcher is back and the log is back to three actions. The entries for this launcher alone would say ok.
  const elsewhere = entry(9, 'v1.testnet', [logMark(INSTANCE, [...longer, up('2026-11-03T10:00:00Z', H1)])]);
  assert.equal(evaluateRelease(vouching, at(LOG)).status, 'ok');
  assert.equal(evaluateRelease(vouching, at(LOG), 1, [...vouching, elsewhere]).status, 'shorter-log');
  // The same for a beginning that differs from what was seen under the other launcher.
  const edited = [LOG[0] as ManagerAction, up('2026-11-01T10:00:00Z', H2), LOG[2] as ManagerAction];
  assert.equal(evaluateRelease([entry(7, 'v1.testnet', [logMark(INSTANCE, edited)])], at(edited), 1, [entry(9, 'v1.testnet', [logMark(INSTANCE, LOG)])]).status, 'rewritten-log');
  // What it saw there does not confirm the log here: the mark must come with an entry for this key and launcher.
  const onlyElsewhere = evaluateRelease([entry(7, 'v1.testnet', [logMark(INSTANCE, LOG.slice(0, 2))])], at(LOG), 1, [entry(9, 'v2.testnet', [logMark(INSTANCE, LOG)])]);
  assert.deepEqual([onlyElsewhere.status, onlyElsewhere.confirmedBy], ['unknown-release', []]);
});

// The recorded entry #0 and the launcher it was logged for, as a verifier that writes marks would have logged it.
const { entry: recorded } = readRepoJson<{ entry: KeyEntry }>('docs/samples/key-entry.sample.json');
const APP_COMPOSE = readRepoJson<RawReport>('docs/samples/attestation-report.json').model_attestations[0]?.info.tcb_info.app_compose ?? '';
const events = (instance: string) => [{ imr: 3, event_type: 0x08000001, event: 'instance-id', event_payload: instance }];
/** A verified model report as the rule reads it: the recorded key and launcher, an action log, the instance each quote names. */
const reportOf = (actions: ManagerAction[] | undefined, over: { key?: string; appCompose?: string; logInstance?: string } = {}): AttestedReport => ({
  signer: { signingAddress: over.key ?? recorded.signing_address },
  deployment: { appCompose: over.appCompose ?? APP_COMPOSE, ...(actions ? { composeManager: { actions } } : {}) },
  report: { eventLog: events(INSTANCE), ...(actions ? { composeManagerAttestation: { eventLog: events(over.logInstance ?? INSTANCE) } } : {}) },
});

test('withReleaseRule: on top of a key that passed, for every report that carries the key; a key that did not pass is returned as it is', () => {
  const query = { model: recorded.model, signingAddress: recorded.signing_address, trustedVerifiers: [recorded.verifier], quorum: 1 };
  const entries = [{ ...recorded, image_digests: [...recorded.image_digests, releaseMark(FILE, H1), logMark(INSTANCE, LOG)] }];
  const key = evaluateKeyLog(entries, { ...query, composeHash: recorded.compose_hash });
  assert.equal(key.status, 'ok');
  const rule = (reports: AttestedReport[], withLauncher = true) => withReleaseRule(key, entries, query, reports, withLauncher);
  const deployed = [...LOG, up('2026-11-02T10:00:00Z', H2)];

  assert.equal(rule([reportOf(LOG)]), key, 'the logged log: the key verdict stands');
  assert.equal(rule([reportOf(LOG, { key: recorded.signing_address.toUpperCase() })]), key, 'the key is matched as hex, whatever its case');
  // What the rule says about one report, in its own words: `pnpm demo:attest` prints this.
  assert.deepEqual(releaseStanding(entries, query, reportOf(LOG), true), { status: 'ok', confirmedBy: [recorded.verifier], detail: `the action log as it stands (3 actions) was marked by ${recorded.verifier}` });
  // Two replicas behind the key: one has deployed since the verifier looked, and that refuses the message.
  const refused = rule([reportOf(LOG), reportOf(deployed)]);
  assert.deepEqual([refused.status, refused.reason], ['not-logged', 'unknown-release']);
  assert.match(refused.detail, /: not sent \(fail-closed\)$/);
  assert.deepEqual(refused.matching, key.matching, 'what vouched for the key is kept for the card');
  // The report of another key in the same answer is not this key's business.
  assert.equal(rule([reportOf(deployed, { key: 'ee'.repeat(32) }), reportOf(LOG)]), key);
  // No report for this key, so no action log that could be tied to it.
  assert.equal(rule([reportOf(LOG, { key: 'ee'.repeat(32) })]).reason, 'untied-log');
  assert.equal(rule([]).reason, 'untied-log');
  // What a trusted verifier logged under another launcher still binds this instance's log: there it saw four actions.
  // A verifier outside the trust set saying the same is not heard.
  const elsewhere = (verifier: string) => ({ ...recorded, index: 9, verifier, compose_hash: 'cd'.repeat(32), image_digests: [...recorded.image_digests, logMark(INSTANCE, deployed)] });
  assert.equal(withReleaseRule(key, [...entries, elsewhere(recorded.verifier)], query, [reportOf(LOG)], true).reason, 'shorter-log');
  assert.equal(withReleaseRule(key, [...entries, elsewhere('stranger.testnet')], query, [reportOf(LOG)], true), key);
  // A launcher no entry vouches for has no action log logged either. When the client does not ask for the launcher to be
  // logged, every entry for the key may vouch.
  assert.equal(rule([reportOf(LOG, { appCompose: 'another launcher' })]).reason, 'unlogged-release');
  assert.equal(rule([reportOf(LOG, { appCompose: 'another launcher' })], false), key);
  // A rewritten log.
  assert.equal(rule([reportOf([LOG[0] as ManagerAction, up('2026-11-01T10:00:00Z', H2), LOG[2] as ManagerAction])]).reason, 'rewritten-log');
  // The log was quoted by another instance than the key: it is not this enclave's record, whatever it says.
  const foreign = rule([reportOf(LOG, { logInstance: 'ff'.repeat(20) })]);
  assert.deepEqual([foreign.reason, foreign.detail], ['untied-log', `the action log cannot be tied to the enclave that holds the key: the log was quoted by instance ${'ff'.repeat(20)}, the signing key by instance ${INSTANCE}: not sent (fail-closed)`]);
  // A report with no action log at all.
  const bare = rule([reportOf(undefined)]);
  assert.deepEqual([bare.reason, bare.detail], ['untied-log', 'the action log cannot be tied to the enclave that holds the key: the attested report carries no action log: not sent (fail-closed)']);
  // A key the log does not hold stays refused for its own reason.
  const absent = evaluateKeyLog(entries, { ...query, signingAddress: 'ab'.repeat(32) });
  assert.equal(withReleaseRule(absent, entries, query, [reportOf(LOG)], true), absent);
});
