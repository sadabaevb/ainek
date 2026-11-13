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
  const key = keyOf(cfg);
  if (next && !parseTrustSet(JSON.stringify(next))) return false;
  try {
    if (next) localStorage.setItem(key, JSON.stringify(next));
    else localStorage.removeItem(key);
  } catch {
    return false;
  }
  window.dispatchEvent(new Event(CHANGED));
  return true;
}

/**
 * The viewer's own switch for the release rule (SPEC §7.5): on, the chat also refuses when the verifiers they trust have
 * not marked the enclave's action log as it stands. It can only add the rule: a site that has it on keeps it on whatever
 * is stored here (`releaseRuleFor` in config.ts).
 */
export function useOwnReleaseRule(cfg: Scope): boolean {
  return useSyncExternalStore(subscribe, () => ownReleaseRule(cfg), () => false);
}

/** What the store holds right now. A browser that refuses storage has no switch: the site's setting applies. */
export function ownReleaseRule(cfg: Scope): boolean {
  return read(releaseKeyOf(cfg)) === RELEASE_ON;
}

/** False when the browser refused to keep the choice: the switch then stays where it was, and the caller says so. */
export function saveOwnReleaseRule(cfg: Scope, on: boolean): boolean {
  const key = releaseKeyOf(cfg);
  try {
    if (on) localStorage.setItem(key, RELEASE_ON);
    else localStorage.removeItem(key);
  } catch {
    return false;
  }
  window.dispatchEvent(new Event(CHANGED));
  return true;
}
