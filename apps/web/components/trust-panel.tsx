'use client';
// The trust set as the viewer's own decision (SPEC §7.1): the log is open, and who counts is up to the client. Every change
// applies at once, and the preview runs the same check the chat runs, so the consequence is visible before any message.
import { useMemo, useState, type FormEvent } from 'react';
import { NEAR_ACCOUNT, clampQuorum, evaluateKeyLog, type KeyEntry, type TrustSet } from '@ainek/proof';
import { useConfig, useT, useTrust } from '@/app/providers';
import { observedUtc, short } from '@/lib/format';

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

export function TrustPanel({ entries, registered }: { entries: KeyEntry[] | null; registered: string[] }) {
  const cfg = useConfig();
  const { t } = useT();
  const tt = t.log.trust;
  const { custom, siteDefault, choose } = useTrust();
  const [draft, setDraft] = useState('');
  const [badDraft, setBadDraft] = useState(false);
  const selected = cfg.trustedVerifiers;

  const writers = useMemo(() => {
    const seen = new Map<string, { count: number; newest: KeyEntry }>();
    for (const e of entries ?? []) {
      const s = seen.get(e.verifier);
      if (s) s.count += 1; // the contract answers newest first, so the first entry per verifier stays the newest
      else seen.set(e.verifier, { count: 1, newest: e });
    }
    return seen;
  }, [entries]);
  const rows = [...new Set([...siteDefault.verifiers, ...registered, ...writers.keys(), ...selected])];

  /** A choice equal to the site default is no choice: it is forgotten, so a later change of the default still reaches this viewer. */
  const apply = (next: TrustSet) => {
    const quorum = clampQuorum(next.quorum, next.verifiers.length);
    choose(sameList(next.verifiers, siteDefault.verifiers) && quorum === siteDefault.quorum ? null : { verifiers: next.verifiers, quorum });
  };
  const toggle = (account: string) => apply({ verifiers: selected.includes(account) ? selected.filter((v) => v !== account) : [...selected, account], quorum: cfg.quorum });
  const add = (e: FormEvent) => {
    e.preventDefault();
    const account = draft.trim().toLowerCase();
    if (!NEAR_ACCOUNT.test(account)) {
      setBadDraft(true);
      return;
    }
    setBadDraft(false);
    setDraft('');
    if (!selected.includes(account)) apply({ verifiers: [...selected, account], quorum: cfg.quorum });
  };

  const preview = useMemo((): { ok: boolean; text: string } | null => {
    if (entries === null) return null;
    if (selected.length === 0) return { ok: false, text: tt.verdict.nobody };
    const newest = entries.find((e) => e.model === cfg.model);
    if (!newest) return { ok: false, text: tt.verdict.empty };
    const v = evaluateKeyLog(entries, { model: cfg.model, signingAddress: newest.signing_address, trustedVerifiers: selected, quorum: cfg.quorum });
    switch (v.reason) {
      case 'ok': return { ok: true, text: tt.verdict.ok(short(newest.signing_address), v.confirmedBy.join(', ')) };
      case 'below-quorum': return { ok: false, text: tt.verdict.belowQuorum(v.confirmedBy.length, cfg.quorum) };
      case 'untrusted-only': return { ok: false, text: tt.verdict.untrustedOnly(v.loggedByUntrusted.join(', ')) };
      case 'split-view': return { ok: false, text: tt.verdict.split };
      case 'absent': return { ok: false, text: tt.verdict.absent };
    }
  }, [entries, selected, cfg.model, cfg.quorum, tt]);

  const onlyWriter = writers.size === 1 ? [...writers.keys()][0] : undefined;
  return (
    <section className="card trust" id="trust">
      <div className="trust-head">
        <h2>{tt.title}</h2>
        <span className="muted small">{custom ? tt.state.custom : tt.state.site}</span>
      </div>
      <p className="muted small">{tt.intro}</p>
      <ul className="trust-list">
        {rows.map((account) => {
          const seen = writers.get(account);
          const tags = siteDefault.verifiers.includes(account) ? tt.tag.site : registered.includes(account) ? tt.tag.registered : writers.has(account) ? '' : tt.tag.added;
          return (
            <li key={account}>
              <label>
                <input type="checkbox" checked={selected.includes(account)} onChange={() => toggle(account)} />
                <span className="mono">{account}</span>
              </label>
              <span className="muted small">{[seen ? tt.seen(seen.count, observedUtc(seen.newest.observed_at)) : tt.notSeen, tags].filter(Boolean).join(' · ')}</span>
            </li>
          );
        })}
      </ul>
      <form className="trust-add" onSubmit={add}>
        <label htmlFor="trust-add-account" className="small">{tt.addLabel}</label>
        <div>
          <input id="trust-add-account" type="text" autoComplete="off" spellCheck={false} placeholder={tt.addPlaceholder} value={draft} aria-invalid={badDraft} onChange={(e) => { setDraft(e.target.value); setBadDraft(false); }} />
          <button type="submit" className="btn" disabled={!draft.trim()}>{tt.add}</button>
        </div>
        {badDraft && <p className="small trust-bad" role="alert">{tt.badAccount}</p>}
      </form>
      <div className="trust-quorum">
        <label htmlFor="trust-quorum" className="small">{tt.quorum}</label>
        <select id="trust-quorum" value={cfg.quorum} disabled={selected.length < 2} onChange={(e) => apply({ verifiers: selected, quorum: Number(e.target.value) })}>
          {Array.from({ length: Math.max(1, selected.length) }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        {custom && <button type="button" className="btn small" onClick={() => choose(null)}>{tt.reset}</button>}
      </div>
      {preview && <p className={`trust-verdict ${preview.ok ? 'ok' : 'fail'}`} role="status">{preview.text}</p>}
      <p className="muted small">{tt.verdictNote}</p>
      {onlyWriter && <p className="muted small">{tt.oneWriter(onlyWriter)}</p>}
      <p className="muted small">{tt.hostNote}</p>
    </section>
  );
}
