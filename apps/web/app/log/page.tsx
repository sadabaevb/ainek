'use client';
// The public key log as the client sees it: who logged which key for which model, and whether two trusted
// verifiers disagree (split view). Wallet login here asks for the function-call key later used for commit_proof.
import { useEffect, useState } from 'react';
import { useNearWallet, type NearContextValue } from 'near-connect-hooks';
import { ANY_AGE_NS, LOG_WINDOW_NS, findSplitView, type KeyEntry } from '@ainek/proof';
import { RedCard } from '@/components/red-card';
import { StackTable, type Column } from '@/components/stack-table';
import { TrustPanel } from '@/components/trust-panel';
import { describeError } from '@/lib/errors';
import { fill } from '@/lib/fill';
import { hoursSince, observedUtc, short } from '@/lib/format';
import { keyLogFor } from '@/lib/key-log';
import { useConfig, useT, useTrust } from '../providers';

type AccessKeyInfo = Awaited<ReturnType<NearContextValue['getAccessKeyList']>>['keys'][number];

const WINDOW_HOURS = Number(LOG_WINDOW_NS) / 3_600_000_000_000;

interface LogWindow {
  entries: KeyEntry[];
  /** The newest entry for the model regardless of age, looked up only when the window is empty to say how stale the log is: undefined while that lookup is in flight or failed, null when the log has none. */
  newest?: KeyEntry | null;
}

export default function LogPage() {
  const cfg = useConfig();
  const { trust } = useTrust();
  const { t } = useT();
  const tl = t.log;
  const [log, setLog] = useState<LogWindow | null>(null);
  const [error, setError] = useState('');
  /** Null until the contract answers: an unanswered view must not read as "nobody is registered". */
  const [registered, setRegistered] = useState<string[] | null>(null);
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
    reader.verifiers().then(setRegistered).catch(() => undefined); // only widens the list of choices: without it the log's own verifiers are still there
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

  const split = log ? findSplitView(log.entries, cfg.model, trust.verifiers) : null;
  const c = tl.columns;
  const columns: Column<KeyEntry>[] = [
    { label: c.index, cell: (e) => e.index },
    { label: c.model, cell: (e) => e.model, className: 'mono' },
    { label: c.verifier, cell: (e) => (trust.verifiers.includes(e.verifier) ? e.verifier : `${e.verifier} ${tl.notTrusted}`), className: 'mono' },
    { label: c.key, cell: (e) => short(e.signing_address), className: 'mono' },
    { label: c.compose, cell: (e) => short(e.compose_hash), className: 'mono' },
    { label: c.tcb, cell: (e) => e.tcb_status },
    { label: c.observed, cell: (e) => observedUtc(e.observed_at) },
  ];

  return (
    <main className="page">
      <h1>{tl.title}</h1>
      <p className="muted">
        {fill(tl.intro(cfg.network), { contract: <span className="mono">{cfg.contract}</span> })}
        {cfg.logSource === 'sample' && ` ${tl.sampleNote}`}
      </p>
      {error && <RedCard title={error} />}
      {split && <RedCard title={tl.split} body={split.detail} />}
      {log && (log.entries.length === 0 ? (
        <section className="card">
          <h3>{tl.emptyTitle(WINDOW_HOURS, cfg.model)}</h3>
          <p>
            {tl.emptyBody}
            {log.newest !== undefined && ` ${log.newest ? tl.newest(log.newest.index, log.newest.verifier, observedUtc(log.newest.observed_at), hoursSince(log.newest.observed_at)) : tl.none}`}
          </p>
        </section>
      ) : (
        <StackTable columns={columns} rows={log.entries} rowKey={(e) => String(e.index)} />
      ))}

      <TrustPanel entries={log?.entries ?? null} registered={registered} />

      <h2>{tl.wallet}</h2>
      <p className="muted small">{fill(tl.walletNote, { method: <span className="mono">commit_proof</span> })}</p>
      {signedAccountId ? (
        <>
          <p>{tl.connectedAs} <span className="mono">{signedAccountId}</span></p>
          <details>
            <summary>{tl.accessKeys(keys.length)}</summary>
            <ul className="mono">
              {keys.map((k) => {
                const p = k.access_key.permission;
                const fc = typeof p === 'object' && p !== null && 'FunctionCall' in p ? p.FunctionCall : null;
                return <li key={k.public_key}>{k.public_key.slice(0, 20)}… · {fc ? `FunctionCall on ${fc.receiver_id}, methods [${fc.method_names.join(', ') || 'all'}]` : 'FullAccess'}</li>;
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
