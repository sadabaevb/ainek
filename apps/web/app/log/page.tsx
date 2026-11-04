'use client';
// The public key log as the client sees it: who logged which key for which model, and whether two trusted
// verifiers disagree (split view). Wallet login here adds the function-call key later used for commit_proof.
import { useEffect, useState } from 'react';
import { useNearWallet, type NearContextValue } from 'near-connect-hooks';
import { ANY_AGE_NS, LOG_WINDOW_NS, findSplitView, type KeyEntry } from '@ainek/proof';
import { describeError } from '@/lib/errors';
import { hoursSince, observedUtc, short } from '@/lib/format';
import { keyLogFor } from '@/lib/key-log';
import { useConfig, useT } from '../providers';

type AccessKeyInfo = Awaited<ReturnType<NearContextValue['getAccessKeyList']>>['keys'][number];

const WINDOW_HOURS = Number(LOG_WINDOW_NS) / 3_600_000_000_000;

interface LogWindow {
  entries: KeyEntry[];
  /** The newest entry for the model regardless of age, looked up only when the window is empty to say how stale the log is: undefined while that lookup is in flight or failed, null when the log has none. */
  newest?: KeyEntry | null;
}

export default function LogPage() {
  const cfg = useConfig();
  const { t } = useT();
  const tl = t.log;
  const [log, setLog] = useState<LogWindow | null>(null);
  const [error, setError] = useState('');
  const { signedAccountId, getAccessKeyList } = useNearWallet();
  const [keys, setKeys] = useState<AccessKeyInfo[]>([]);

  useEffect(() => {
    const reader = keyLogFor(cfg);
    reader
      .latestKeys(cfg.model)
      .then((entries) => {
        setLog({ entries }); // the window (and the explanation card) first; the staleness lookup must not delay or hide it
        if (entries.length === 0) {
          reader
            .latestKeys(cfg.model, ANY_AGE_NS)
            .then((all) => setLog({ entries, newest: all[0] ?? null }))
            .catch(() => undefined);
        }
      })
      .catch((e: unknown) => setError(describeError(e)));
  }, [cfg]);

  useEffect(() => {
    if (!signedAccountId) {
      setKeys([]);
      return;
    }
    getAccessKeyList(signedAccountId).then((r) => setKeys(r.keys)).catch(() => setKeys([]));
    // getAccessKeyList is rebuilt on every provider render; the account id is the only real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedAccountId]);

  const split = log ? findSplitView(log.entries, cfg.model, cfg.trustedVerifiers) : null;
  const c = tl.columns;

  return (
    <main className="page">
      <h1>{tl.title}</h1>
      <p className="muted">
        {tl.contract} <span className="mono">{cfg.contract}</span> {tl.introRest(cfg.network, cfg.trustedVerifiers.join(', '), cfg.quorum)}
        {cfg.logSource === 'sample' && ` ${tl.sampleNote}`}
      </p>
      {error && <p className="card red">{error}</p>}
      {split && (
        <section className="card red">
          <h3>{tl.split}</h3>
          <p>{split.detail}</p>
        </section>
      )}
      {log && (log.entries.length === 0 ? (
        <section className="card">
          <h3>{tl.emptyTitle(WINDOW_HOURS, cfg.model)}</h3>
          <p>
            {tl.emptyBody}
            {log.newest && ` ${tl.newest(log.newest.index, log.newest.verifier, observedUtc(log.newest.observed_at), hoursSince(log.newest.observed_at))}`}
            {log.newest === null && ` ${tl.none}`}
          </p>
        </section>
      ) : (
        <table className="stack">
          <thead>
            <tr><th>{c.index}</th><th>{c.model}</th><th>{c.verifier}</th><th>{c.key}</th><th>{c.compose}</th><th>{c.tcb}</th><th>{c.observed}</th></tr>
          </thead>
          <tbody>
            {log.entries.map((e) => (
              <tr key={e.index}>
                <td data-label={c.index}>{e.index}</td>
                <td className="mono" data-label={c.model}>{e.model}</td>
                <td className="mono" data-label={c.verifier}>{e.verifier}{cfg.trustedVerifiers.includes(e.verifier) ? '' : tl.notTrusted}</td>
                <td className="mono" data-label={c.key}>{short(e.signing_address)}</td>
                <td className="mono" data-label={c.compose}>{short(e.compose_hash)}</td>
                <td data-label={c.tcb}>{e.tcb_status}</td>
                <td data-label={c.observed}>{observedUtc(e.observed_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}

      <h2>{tl.wallet}</h2>
      <p className="muted small">{tl.walletBefore} <span className="mono">commit_proof</span> {tl.walletAfter}</p>
      {signedAccountId ? (
        <>
          <p>{tl.connectedAs} <span className="mono">{signedAccountId}</span></p>
          <details>
            <summary>{tl.accessKeys(keys.length)}</summary>
            <ul className="mono">
              {keys.map((k) => {
                const p = k.access_key.permission;
                const fc = typeof p === 'object' && p !== null && 'FunctionCall' in p ? p.FunctionCall : null;
                return <li key={k.public_key}>{k.public_key.slice(0, 20)}… · {fc ? `FunctionCall on ${fc.receiver_id}, methods [${fc.method_names.join(', ')}]` : 'FullAccess'}</li>;
              })}
            </ul>
          </details>
        </>
      ) : (
        <p className="muted">{tl.noWallet}</p>
      )}
    </main>
  );
}
