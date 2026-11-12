import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KeyLogVerdict } from '@ainek/proof';
import { dict } from './i18n.ts';
import { refusalText } from './refusal.ts';

/** A refusal of the release rule as `withReleaseRule` returns it: the key verdict that passed, with the reason replaced. */
const refused = (over: Partial<KeyLogVerdict>): KeyLogVerdict => ({ status: 'not-logged', reason: 'absent', quorum: 2, confirmedBy: [], matching: [], untrusted: [], loggedByUntrusted: [], detail: '', ...over });

test('refusalText: every reason of the release rule has a card of its own, in both languages', () => {
  const reasons = ['unlogged-release', 'untied-log', 'unknown-release', 'shorter-log', 'release-below-quorum', 'rewritten-log', 'recent-mark'] as const;
  for (const t of [dict.en, dict.ru]) {
    const cards = reasons.map((reason) => refusalText(t, refused({ reason, releaseWait: { markedForMs: 0, waitMs: 60_000 } })));
    assert.equal(new Set(cards.map((c) => c.title)).size, reasons.length, 'no two reasons share a title');
    assert.ok(cards.every((c) => c.title && c.body), 'no card is empty');
  }
});

test('refusalText: the numbers on a card are the verdict\'s own', () => {
  // One verifier of the two required marked the log as it stands.
  assert.match(refusalText(dict.en, refused({ reason: 'release-below-quorum', confirmedBy: ['v1.testnet'] })).body, /as it stands: 1, required by this client: 2\.$/);
  // A state marked for 12 minutes and 59 seconds, for a client that waits an hour: the time is rounded down, so a state is
  // never shown as marked for longer than it is.
  const recent = refusalText(dict.en, refused({ reason: 'recent-mark', releaseWait: { markedForMs: 12 * 60_000 + 59_000, waitMs: 60 * 60_000 } })).body;
  assert.match(recent, /as it stands for 12 min, by their clocks and this device's/);
  assert.match(recent, /set to wait 60 min after a state of the enclave is marked/);
  // A verifier's clock ahead of this device's is not a negative time on the card.
  assert.match(refusalText(dict.en, refused({ reason: 'recent-mark', releaseWait: { markedForMs: -90_000, waitMs: 60_000 } })).body, /as it stands for 0 min/);
  // Marks with no readable time: the card says so and does not invent one.
  const unread = refusalText(dict.ru, refused({ reason: 'recent-mark', releaseWait: { waitMs: 30 * 60_000 } })).body;
  assert.match(unread, /нет времени, которое клиент может прочитать/);
  assert.match(unread, /ждать 30 мин/);
});
