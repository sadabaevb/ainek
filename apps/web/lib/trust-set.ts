// What the viewer asks of the key log, kept in this browser per network and contract: their own trust set, and their own
// switch for the release rule. Both are read through an external store so that the server render and the first client
// render agree (no choice yet), and so a change on /log reaches a chat open in another tab. A browser that refuses storage
// simply keeps the site default.
import { useMemo, useSyncExternalStore } from 'react';
import { parseTrustSet, type TrustSet } from '@ainek/proof';
import type { PublicConfig } from './config';

type Scope = Pick<PublicConfig, 'network' | 'contract'>;

const CHANGED = 'ainek:trust-set-changed';
const keyOf = (cfg: Scope): string => `ainek.trust.v1.${cfg.network}.${cfg.contract}`;
const releaseKeyOf = (cfg: Scope): string => `ainek.release-rule.v1.${cfg.network}.${cfg.contract}`;
/** The only value that turns the viewer's release rule on: anything else in the store reads as no choice. */
const RELEASE_ON = '1';
/**
 * Switches the browser refused to keep, turned on all the same until the page is reloaded: asking for a stricter check
 * needs no storage to be honoured. Other tabs do not hear of it.
 */
const heldHere = new Set<string>();

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** `null` removes the key. False when the browser refused: nothing changed, so nothing is announced. */
function write(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return false;
  }
  window.dispatchEvent(new Event(CHANGED));
  return true;
}

export function useCustomTrust(cfg: Scope): TrustSet | null {
  const key = keyOf(cfg);
  const raw = useSyncExternalStore(subscribe, () => read(key), () => null);
  return useMemo(() => parseTrustSet(raw), [raw]);
}

/**
 * `null` forgets the choice, so the site default applies again. False when nothing changed: the browser refused, or the value
 * would not survive being read back (a site verifier that is no valid account, too long a list), and the caller says so.
 */
export function saveCustomTrust(cfg: Scope, next: TrustSet | null): boolean {
  const text = next && JSON.stringify(next);
  if (text && !parseTrustSet(text)) return false;
  return write(keyOf(cfg), text);
}

/**
 * The viewer's own switch for the release rule (SPEC §7.5): on, the chat also refuses when the verifiers they trust have
 * not marked the enclave's action log as it stands. It can only add the rule: a site that has it on keeps it on whatever
 * is stored here (`releaseRuleFor` in config.ts).
 */
export function useOwnReleaseRule(cfg: Scope): boolean {
  return useSyncExternalStore(subscribe, () => ownReleaseRule(cfg), () => false);
}

/** What the viewer asked for: kept in the store, or held by this page when the browser would not keep it. */
export function ownReleaseRule(cfg: Scope): boolean {
  const key = releaseKeyOf(cfg);
  return heldHere.has(key) || read(key) === RELEASE_ON;
}

/**
 * False when the browser did not keep the choice and the caller has something to say. Turned on, the rule then holds for
 * this page only. Turned off, it is still on, because the store still says so: a rule is never dropped on a write that
 * did not happen.
 */
export function saveOwnReleaseRule(cfg: Scope, on: boolean): boolean {
  const key = releaseKeyOf(cfg);
  const was = ownReleaseRule(cfg);
  const saved = write(key, on ? RELEASE_ON : null);
  if (on && !saved) heldHere.add(key);
  else heldHere.delete(key);
  const now = ownReleaseRule(cfg);
  if (!saved && was !== now) window.dispatchEvent(new Event(CHANGED)); // `write` announces only what it stored
  return saved || (!on && !now);
}
