// The viewer's own trust set, kept in this browser per network and contract. It is read through an external store so that
// the server render and the first client render agree (no choice yet), and so a change on /log reaches a chat open in
// another tab. A browser that refuses storage simply keeps the site default.
import { useMemo, useSyncExternalStore } from 'react';
import { parseTrustSet, type TrustSet } from '@ainek/proof';
import type { PublicConfig } from './config';

type Scope = Pick<PublicConfig, 'network' | 'contract'>;

const CHANGED = 'ainek:trust-set-changed';
const keyOf = (cfg: Scope): string => `ainek.trust.v1.${cfg.network}.${cfg.contract}`;

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

/** `null` forgets the choice, so the site default applies again. */
export function saveCustomTrust(cfg: Scope, next: TrustSet | null): void {
  const key = keyOf(cfg);
  try {
    if (next) localStorage.setItem(key, JSON.stringify(next));
    else localStorage.removeItem(key);
  } catch {
    return; // storage refused: nothing changed, and the page keeps showing what still applies
  }
  window.dispatchEvent(new Event(CHANGED));
}
