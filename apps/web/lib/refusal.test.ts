import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KeyLogVerdict } from '@ainek/proof';
import { dict } from './i18n.ts';
import { refusalText } from './refusal.ts';

/** A refusal of the release rule as `withReleaseRule` returns it: the key verdict that passed, with the reason replaced. */
const refused = (over: Partial<KeyLogVerdict>): KeyLogVerdict => ({ status: 'not-logged', reason: 'absent', quorum: 2, confirmedBy: [], matching: [], untrusted: [], loggedByUntrusted: [], detail: '', ...over });

test('refusalText: every reason of the release rule has a card of its own, in both languages', () => {
  const reasons = ['unlogged-release', 'untied-log', 'unknown-release', 'shorter-log', 'release-below-quorum', 'rewritten-log', 'young-release'] as const;
  for (const t of [dict.en, dict.ru]) {
    const cards = reasons.map((reason) => refusalText(t, refused({ reason, releaseAge: { ms: 0, minMs: 60_000 } })));
    assert.equal(new Set(cards.map((c) => c.title)).size, reasons.length, 'no two reasons share a title');
    assert.ok(cards.every((c) => c.title && c.body), 'no card is empty');
  }
});

test('refusalText: the numbers on a card are the verdict\'s own', () => {
  // One verifier of the two required marked the log as it stands.
  assert.match(refusalText(dict.en, refused({ reason: 'release-below-quorum', confirmedBy: ['v1.testnet'] })).body, /as it stands: 1, required by this client: 2\.$/);
  // A release first marked 12 minutes and 59 seconds before the check, by a client that waits an hour: the age is rounded
  // down, so a release is never shown as older than it is.
  const young = refusalText(dict.en, refused({ reason: 'young-release', releaseAge: { ms: 12 * 60_000 + 59_000, minMs: 60 * 60_000 } })).body;
  assert.match(young, /first marked the release that serves the model 12 min before this check/);
  assert.match(young, /only 60 min after it first appears/);
  // A verifier's clock ahead of this device's is not a negative age on the card.
  assert.match(refusalText(dict.en, refused({ reason: 'young-release', releaseAge: { ms: -90_000, minMs: 60_000 } })).body, / 0 min before this check/);
  // No entry names the release: the card says so and does not invent an age.
  const unnamed = refusalText(dict.ru, refused({ reason: 'young-release', releaseAge: { minMs: 30 * 60_000 } })).body;
  assert.match(unnamed, /не называют релиз/);
  assert.match(unnamed, /ждать 30 мин/);
});
