'use client';
// The public key log as the client sees it: who logged which key for which model, and whether two trusted
// verifiers disagree (split view). Wallet login here adds the function-call key later used for commit_proof.
import { useEffect, useState } from 'react';
import { useNearWallet, type NearContextValue } from 'near-connect-hooks';
import { ANY_AGE_NS, LOG_WINDOW_NS, findSplitView, type KeyEntry } from '@ainek/proof';
import { describeError } from '@/lib/errors';
import { hoursSince, observedUtc, short } from '@/lib/format';
import { keyLogFor } from '@/lib/key-log';
import { useConfig } from '../providers';

type AccessKeyInfo = Awaited<ReturnType<NearContextValue['getAccessKeyList']>>['keys'][number];

const WINDOW_HOURS = Number(LOG_WINDOW_NS) / 3_600_000_000_000;

interface LogWindow {
  entries: KeyEntry[];
  /** The newest entry for the model regardless of age, looked up only when the window is empty to say how stale the log is: undefined while that lookup is in flight or failed, null when the log has none. */
  newest?: KeyEntry | null;
}

export default function LogPage() {
  const cfg = useConfig();
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

  return (
    <main className="page">
      <h1>Public key log</h1>
      <p className="muted">
        Contract <span className="mono">{cfg.contract}</span> on {cfg.network}; trusted verifiers {cfg.trustedVerifiers.join(', ')}; quorum {cfg.quorum}.
        {cfg.logSource === 'sample' && ' Showing the recorded sample entry until the contract is deployed (AINEK_LOG_SOURCE=sample).'}
      </p>
      {error && <p className="card red">{error}</p>}
      {split && (
        <section className="card red">
          <h3>Split view</h3>
          <p>{split.detail}</p>
        </section>
      )}
      {log && (log.entries.length === 0 ? (
        <section className="card">
          <h3>No entry younger than {WINDOW_HOURS} hours for {cfg.model}</h3>
          <p>
            The client trusts only entries in that window, so the chat refuses to send until a verifier logs a fresh one. That is the fail-closed rule working, not an outage.
            {log.newest && <> Newest entry for this model: #{log.newest.index} by {log.newest.verifier}, observed {observedUtc(log.newest.observed_at)} ({hoursSince(log.newest.observed_at)} h ago).</>}
            {log.newest === null && <> The log has no entry for this model at all.</>}
          </p>
        </section>
      ) : (
        <table>
          <thead>
            <tr><th>#</th><th>model</th><th>verifier</th><th>signing key</th><th>compose</th><th>TCB</th><th>observed</th></tr>
          </thead>
          <tbody>
            {log.entries.map((e) => (
              <tr key={e.index}>
                <td>{e.index}</td>
                <td className="mono">{e.model}</td>
                <td className="mono">{e.verifier}{cfg.trustedVerifiers.includes(e.verifier) ? '' : ' (not in trust set)'}</td>
                <td className="mono">{short(e.signing_address)}</td>
                <td className="mono">{short(e.compose_hash)}</td>
                <td>{e.tcb_status}</td>
                <td>{observedUtc(e.observed_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}

      <h2>Wallet</h2>
      <p className="muted small">Connecting (top right) adds a function-call key limited to <span className="mono">commit_proof</span> on the contract, so the chat can commit salted proof hashes without asking the wallet each time.</p>
      {signedAccountId ? (
        <>
          <p>Connected as <span className="mono">{signedAccountId}</span></p>
          <details>
            <summary>Access keys ({keys.length})</summary>
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
        <p className="muted">No wallet connected.</p>
      )}
    </main>
  );
}
