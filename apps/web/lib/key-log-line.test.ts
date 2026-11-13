import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logMark, type KeyEntry, type ManagerAction } from '@ainek/proof';
import { withKeyLog, type KeyLogContext } from './key-log-line.ts';
import type { ReleaseCheck } from './release.ts';

const MODEL = 'vendor/model-a';
const KEY = 'ab'.repeat(32);
const INSTANCE = '19aea1693533dc2d529db03e3f725f20bde8d66d';
const events = [{ imr: 3, event_type: 0x08000001, event: 'instance-id', event_payload: INSTANCE }];
const actions: ManagerAction[] = [
  { action: 'compose_up', timestamp: '2026-11-01T12:00:00Z', commit: 'a'.repeat(40), file: 'prod/models.yaml' },
  { action: 'compose_up', timestamp: '2026-11-03T10:00:00Z', commit: 'b'.repeat(40), file: 'prod/models.yaml' },
];
/** A verified report as the rule reads it: the key, an action log, and one instance named by both quotes. */
const report = { signer: { signingAddress: KEY }, deployment: { appCompose: '{}', composeManager: { actions } }, report: { eventLog: events, composeManagerAttestation: { eventLog: events } } } as unknown as Parameters<typeof withKeyLog>[1];
/** A release check that held, as the chain gives it. */
const check: ReleaseCheck = { status: 'ok', failures: [], unchecked: [], retry: false, history: [], lines: [{ status: 'ok', text: 'release serving the model: v0.0.2' }] };
const entry = (marks: string[]): KeyEntry => ({ index: 7, model: MODEL, verifier: 'v1.testnet', signing_address: KEY, compose_hash: 'c0'.repeat(32), observed_at: String(Date.parse('2026-11-12T08:00:00Z')), image_digests: [`sha256:${'d'.repeat(64)}`, ...marks] }) as unknown as KeyEntry;
const log = (entries: KeyEntry[], over: Partial<KeyLogContext> = {}): KeyLogContext => ({ entries, trust: { verifiers: ['v1.testnet'], quorum: 1 }, rule: { withLauncher: false, waitMs: 0 }, enforced: false, ...over });

/** The moment of the release check: two hours after the entries of these tests were observed. */
const AT = Date.parse('2026-11-12T10:00:00Z');

test('withKeyLog: the key log\'s standing is one more line under the release check', () => {
  // Today's log: the key is there, no entry marks an action log. The line says so, and the check's own verdict stands.
  const unmarked = withKeyLog(check, report, MODEL, log([entry([])]), AT);
  assert.deepEqual(unmarked.lines.slice(0, -1), check.lines);
  assert.deepEqual(unmarked.lines.at(-1), { status: 'skipped', text: "key log: none of the 1 log entry for this key and launcher carries a mark of the enclave's action log (the release rule is off: this client sends all the same; with it on, by the switch \"Stricter\" in the chat, it would not)" });
  assert.deepEqual([unmarked.status, unmarked.failures], ['ok', []]);
  // A verifier that writes marks, and the log as it stood then: a check mark on the line.
  const marked = [entry([logMark(INSTANCE, actions)])];
  assert.deepEqual(withKeyLog(check, report, MODEL, log(marked), AT).lines.at(-1), { status: 'ok', text: 'key log: the action log as it stands (2 actions) is marked by v1.testnet since 2026-11-12 08:00 UTC' });
  // Entries of a verifier the viewer does not trust say nothing here, and neither does a quorum the log does not meet.
  assert.match(withKeyLog(check, report, MODEL, log(marked, { trust: { verifiers: ['someone-else.testnet'], quorum: 1 } }), AT).lines.at(-1)?.text ?? '', /^key log: no log entry vouches for this key and launcher, so none marks the enclave's action log/);
  assert.match(withKeyLog(check, report, MODEL, log(marked, { trust: { verifiers: ['v1.testnet', 'v2.testnet'], quorum: 2 } }), AT).lines.at(-1)?.text ?? '', /^key log: only 1 of 2 required verifiers marked/);
  // A wait is measured at the moment of the check, not when the page happens to draw the line again.
  const waiting = log(marked, { rule: { withLauncher: false, waitMs: 180 * 60_000 } });
  assert.match(withKeyLog(check, report, MODEL, waiting, AT).lines.at(-1)?.text ?? '', /since 2026-11-12 08:00 UTC, 120 min before this check; this client waits 180 min/);
  assert.equal(withKeyLog(check, report, MODEL, waiting, AT + 60 * 60_000).lines.at(-1)?.status, 'ok');
});

test('withKeyLog: the line never goes missing, and what refuses the chat fails the check', () => {
  // The page has no read of the key log at the moment: the line says so, and the check's own verdict stands.
  const unread = withKeyLog(check, report, MODEL, null, AT);
  assert.deepEqual([unread.status, unread.lines.at(-1)], ['ok', { status: 'skipped', text: 'key log: not read at the moment, so where it stands on this action log is not known' }]);
  // With the rule on, the chat does not send to a log nobody marked: the row is not green then.
  const enforced = withKeyLog(check, report, MODEL, log([entry([])], { enforced: true }), AT);
  assert.equal(enforced.status, 'fail');
  assert.match(enforced.failures.at(-1) ?? '', /^key log: none of the 1 log entry .*: this client does not send \(the release rule is on\)$/);
  assert.equal(withKeyLog(check, report, MODEL, log([entry([logMark(INSTANCE, actions)])], { enforced: true }), AT).status, 'ok', 'and green when the log is marked as it stands');
});

test('withKeyLog: a rewritten log fails the check whatever the setting', () => {
  // The verifier saw another first action than the one attested now.
  const seen = entry([logMark(INSTANCE, [{ action: 'compose_up', timestamp: '2026-10-30T00:00:00Z', commit: 'b'.repeat(40), file: 'prod/models.yaml' }])]);
  const rewritten = withKeyLog(check, report, MODEL, log([seen]), AT);
  assert.equal(rewritten.status, 'fail');
  assert.equal(rewritten.lines.at(-1)?.status, 'fail');
  assert.match(rewritten.failures.at(-1) ?? '', /^key log: the enclave's action log was rewritten: /);
  // A check that had already failed keeps its own failure first.
  const failed = withKeyLog({ ...check, status: 'fail', failures: ['the file of the release: hashes differ'] }, report, MODEL, log([seen]), AT);
  assert.deepEqual([failed.status, failed.failures.length, failed.failures[0]], ['fail', 2, 'the file of the release: hashes differ']);
  // The same verifier's entry for another launcher, while the entries for this key and launcher carry no mark at all:
  // still a rewrite, not "no marks".
  const elsewhere = { ...seen, index: 9, compose_hash: 'ee'.repeat(32) } as KeyEntry;
  const strict = log([{ ...entry([]), compose_hash: 'c0'.repeat(32) } as KeyEntry, elsewhere], { rule: { withLauncher: false, waitMs: 0 } });
  assert.equal(withKeyLog(check, report, MODEL, strict, AT).status, 'fail');
});
