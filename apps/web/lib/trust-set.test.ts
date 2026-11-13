// The viewer's own switch for the release rule (SPEC §7.5): what the store reads as "on", and that it can only add the rule.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { releaseRuleFor } from './config.ts';
import { ownReleaseRule, saveOwnReleaseRule } from './trust-set.ts';

const TESTNET = { network: 'testnet', contract: 'log.testnet' } as const;
const KEY = 'ainek.release-rule.v1.testnet.log.testnet';

/** A browser's storage and its window, as far as the store uses them. */
let kept: Map<string, string>;
let events: string[];
/** What the browser refuses: every use of storage (site data blocked), or only to change it. */
let refuses: false | 'all' | 'writes' = false;
const browser = globalThis as { localStorage?: unknown; window?: unknown };
const before = { localStorage: browser.localStorage, window: browser.window };

beforeEach(() => {
  kept = new Map();
  events = [];
  refuses = false;
  const guarded = <T>(writes: boolean, op: () => T): T => {
    if (refuses === 'all' || (writes && refuses === 'writes')) throw new DOMException('storage is off', 'SecurityError');
    return op();
  };
  browser.localStorage = {
    getItem: (key: string) => guarded(false, () => kept.get(key) ?? null),
    setItem: (key: string, value: string) => guarded(true, () => void kept.set(key, value)),
    removeItem: (key: string) => guarded(true, () => void kept.delete(key)),
  };
  browser.window = { dispatchEvent: (e: Event) => events.push(e.type) > 0 };
});
afterEach(() => {
  browser.localStorage = before.localStorage;
  browser.window = before.window;
});

test('the release switch: off until the viewer turns it on, kept per network and contract, told to other readers', () => {
  assert.equal(ownReleaseRule(TESTNET), false, 'no choice yet');
  assert.equal(saveOwnReleaseRule(TESTNET, true), true);
  assert.equal(ownReleaseRule(TESTNET), true);
  assert.deepEqual([...kept], [[KEY, '1']]);
  assert.equal(ownReleaseRule({ network: 'testnet', contract: 'another.testnet' }), false, 'a choice made for one contract says nothing about another');
  assert.equal(ownReleaseRule({ network: 'mainnet', contract: 'log.testnet' }), false);
  assert.equal(saveOwnReleaseRule(TESTNET, false), true);
  assert.deepEqual([ownReleaseRule(TESTNET), kept.size], [false, 0], 'turned off, nothing stays in the store');
  assert.equal(events.length, 2, 'every change is announced, so a chat open on the same page hears it');
});

test('the release switch: only the value the page writes turns it on', () => {
  for (const other of ['true', 'on', '0', '', ' 1', '{"on":true}']) {
    kept.set(KEY, other);
    assert.equal(ownReleaseRule(TESTNET), false, JSON.stringify(other));
  }
});

test('the release switch: a browser that keeps nothing still gets the stricter rule, for this page', () => {
  refuses = 'all';
  assert.equal(saveOwnReleaseRule(TESTNET, true), false, 'not kept, and the page is told');
  assert.equal(ownReleaseRule(TESTNET), true, 'asked for and honoured all the same');
  assert.equal(ownReleaseRule({ network: 'testnet', contract: 'another.testnet' }), false);
  assert.equal(events.length, 1, 'readers on this page hear of it');
  // Turned off again: nothing was kept, so nothing is left on, and there is nothing to report.
  assert.equal(saveOwnReleaseRule(TESTNET, false), true);
  assert.deepEqual([ownReleaseRule(TESTNET), events.length], [false, 2]);
});

test('the release switch: a rule the store still holds is not dropped on a write that did not happen', () => {
  kept.set(KEY, '1');
  refuses = 'writes';
  assert.equal(saveOwnReleaseRule(TESTNET, false), false, 'the page is told the choice did not take');
  assert.equal(ownReleaseRule(TESTNET), true);
  assert.equal(events.length, 0, 'nothing changed, so nothing is announced');
});

test('releaseRuleFor: the switch adds the rule and cannot take it away from a site that has it on', () => {
  const site = (requireLoggedRelease: boolean) => ({ requireLoggedRelease });
  assert.deepEqual([releaseRuleFor(site(false), false), releaseRuleFor(site(false), true), releaseRuleFor(site(true), false), releaseRuleFor(site(true), true)], [false, true, true, true]);
});
