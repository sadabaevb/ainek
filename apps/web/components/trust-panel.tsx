'use client';
// The trust set as the viewer's own decision (SPEC §7.1): the log is open, and who counts is up to the client. Every change
// applies at once, and the preview runs the same check the chat runs, so the consequence is visible before any message.
import { useState, type FormEvent } from 'react';
import { NEAR_ACCOUNT, chooseTrust, findSplitView, marksActionLog, previewTrust, type KeyEntry, type TrustSet } from '@ainek/proof';
import { useConfig, useT, useTrust } from '@/app/providers';
import { observedUtc, short } from '@/lib/format';
import { refusalText } from '@/lib/refusal';
import { saveCustomTrust } from '@/lib/trust-set';

export function TrustPanel({ entries, registered }: { /** Null until the log answers. */ entries: KeyEntry[] | null; /** Null until the contract answers. */ registered: string[] | null }) {
  const cfg = useConfig();
  const { t } = useT();
  const tt = t.log.trust;
  const { trust, isCustom, releaseRule } = useTrust();
  const [draft, setDraft] = useState('');
  const [badDraft, setBadDraft] = useState(false);
  const [notSaved, setNotSaved] = useState(false);
  const siteDefault = cfg.siteTrust;
  const selected = trust.verifiers;

  // `marked`: the verifier's newest entry that carries a mark of an action log. Any of its entries in the window counts,
  // as it does for the rule: a verifier writes one entry per replica, and the last of a round need not be a marked one.
  type Writer = { count: number; newest: KeyEntry; marked?: KeyEntry };
  const writers = new Map<string, Writer>();
  for (const e of entries ?? []) {
    const seen: Writer = writers.get(e.verifier) ?? { count: 0, newest: e }; // the contract answers newest first, so the first entry per verifier stays the newest
    seen.count += 1;
    if (!seen.marked && marksActionLog(e)) seen.marked = e;
    writers.set(e.verifier, seen);
  }
  const rows = [...new Set([...siteDefault.verifiers, ...(registered ?? []), ...writers.keys(), ...selected])];

  const save = (next: TrustSet | null) => setNotSaved(!saveCustomTrust(cfg, next));
  const apply = (verifiers: string[], quorum = trust.quorum) => save(chooseTrust({ verifiers, quorum }, siteDefault));
  const toggle = (account: string) => apply(selected.includes(account) ? selected.filter((v) => v !== account) : [...selected, account]);
  const add = (e: FormEvent) => {
    e.preventDefault();
    const account = draft.trim().toLowerCase();
    if (!NEAR_ACCOUNT.test(account)) {
      setBadDraft(true);
      return;
    }
    setBadDraft(false);
    setDraft('');
    if (!selected.includes(account)) apply([...selected, account]);
  };
  const tagOf = (account: string): string | undefined => {
    if (siteDefault.verifiers.includes(account)) return tt.tag.site;
    if (registered?.includes(account)) return tt.tag.registered;
    return registered === null || writers.has(account) ? undefined : tt.tag.added; // until the contract answers, "added by you" is not known
  };

  const preview = entries && previewTrust(entries, cfg.model, trust, cfg.requireLoggedDeployment);
  const previewText = (): string | null => {
    if (!preview) return null;
    if (preview.kind === 'nobody') return tt.verdict.nobody;
    if (preview.kind === 'no-entries') return tt.verdict.empty;
    const v = preview.verdict;
    if (v.status !== 'ok') return `${tt.verdict.refuse} ${refusalText(t, v).body}`;
    if (!releaseRule) return tt.verdict.send(short(preview.key), v.confirmedBy.join(', '));
    return unmarked ? `${tt.verdict.refuse} ${t.refusedNoReleaseBody}` : tt.verdict.sendIfMarked(short(preview.key), v.confirmedBy.join(', '));
  };
  const keyPasses = preview?.kind === 'checked' && preview.verdict.status === 'ok';
  // The release rule needs an attestation, which a preview does not have. What the log alone says: when no entry that
  // vouches for the key carries a mark of an action log, the chat refuses whatever attests (`unlogged-release`).
  const unmarked = releaseRule && preview?.kind === 'checked' && !preview.verdict.matching.some(marksActionLog);
  // Green only for what the preview can promise: with the rule on, a key that passes is not yet a message that goes.
  const tone = !keyPasses || unmarked ? 'fail' : releaseRule ? 'open' : 'ok';

  const onlyWriter = writers.size === 1 ? [...writers.keys()][0] : undefined;
  // Unticking one side clears the chat's refusal, so the disagreement stays on screen even then.
  const hiddenSplit = entries && !findSplitView(entries, cfg.model, selected) ? findSplitView(entries, cfg.model, [...writers.keys()]) : null;
  const quorumOptions = Math.max(1, selected.length, trust.quorum);
  return (
    <section className="card trust" id="trust">
      <div className="trust-head">
        <h2>{tt.title}</h2>
        <span className="muted small">{isCustom ? tt.state.custom : tt.state.site}</span>
      </div>
      <p className="muted small">{tt.intro}</p>
      <ul className="trust-list">
        {rows.map((account) => {
          const seen = writers.get(account);
          const activity = entries === null ? null : seen ? tt.seen(seen.count, observedUtc(seen.newest.observed_at)) : tt.notSeen;
          // Only a verifier that marks the enclave's action log can satisfy the release rule (SPEC §7.5); the time says how fresh its word is.
          const marks = seen?.marked ? tt.marks(observedUtc(seen.marked.observed_at)) : null;
          return (
            <li key={account}>
              <label>
                <input type="checkbox" checked={selected.includes(account)} onChange={() => toggle(account)} />
                <span className="mono">{account}</span>
              </label>
              <span className="muted small">{[activity, marks, tagOf(account)].filter(Boolean).join(' · ')}</span>
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
        <select id="trust-quorum" value={trust.quorum} disabled={quorumOptions < 2} onChange={(e) => apply(selected, Number(e.target.value))}>
          {Array.from({ length: quorumOptions }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        {isCustom && <button type="button" className="btn small" onClick={() => save(null)}>{tt.reset}</button>}
      </div>
      {notSaved && <p className="small trust-bad" role="alert">{tt.notSaved}</p>}
      {preview && <p className={`trust-verdict ${tone}`} role="status">{previewText()}</p>}
      <p className="muted small">{tt.verdictNote}{cfg.requireLoggedDeployment && ` ${tt.verdictNoteDeployment}`}{releaseRule && ` ${tt.verdictNoteRelease}`}</p>
      {hiddenSplit && <p className="small" role="status">{tt.hiddenSplit(hiddenSplit.verifierA, hiddenSplit.verifierB)}</p>}
      {onlyWriter && <p className="muted small">{tt.oneWriter(onlyWriter)}</p>}
      <p className="muted small">{tt.hostNote}</p>
    </section>
  );
}
