'use client';
// The public key log as the client sees it: who logged which key for which model, and whether two trusted
// verifiers disagree (split view). Wallet login here adds the function-call key later used for commit_proof.
import { useEffect, useState } from 'react';
import { useNearWallet, type NearContextValue } from 'near-connect-hooks';
import { findSplitView, type KeyEntry } from '@ainek/proof';
import { describeError } from '@/lib/errors';
import { short } from '@/lib/format';
import { keyLogFor } from '@/lib/key-log';
import { useConfig } from '../providers';

type AccessKeyInfo = Awaited<ReturnType<NearContextValue['getAccessKeyList']>>['keys'][number];
const FC_KEY_ALLOWANCE = '250000000000000000000000'; // 0.25 NEAR of gas allowance for commit_proof calls

export default function LogPage() {
  const cfg = useConfig();
  const [entries, setEntries] = useState<KeyEntry[] | null>(null);
  const [error, setError] = useState('');
  const { signedAccountId, signIn, signOut, getAccessKeyList, loading } = useNearWallet();
  const [keys, setKeys] = useState<AccessKeyInfo[]>([]);

  useEffect(() => {
    keyLogFor(cfg).latestKeys(cfg.model).then(setEntries).catch((e: unknown) => setError(describeError(e)));
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

  const split = entries ? findSplitView(entries, cfg.model, cfg.trustedVerifiers) : null;

  const connect = () =>
    signIn({ addFunctionCallKey: { contractId: cfg.contract, allowMethods: { anyMethod: false, methodNames: ['commit_proof'] }, gasAllowance: { kind: 'limited', amount: FC_KEY_ALLOWANCE } } });

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
      {entries && (
        <table>
          <thead>
            <tr><th>#</th><th>model</th><th>verifier</th><th>signing key</th><th>compose</th><th>TCB</th><th>observed</th></tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.index}>
                <td>{e.index}</td>
                <td className="mono">{e.model}</td>
                <td className="mono">{e.verifier}{cfg.trustedVerifiers.includes(e.verifier) ? '' : ' (not in trust set)'}</td>
                <td className="mono">{short(e.signing_address)}</td>
                <td className="mono">{short(e.compose_hash)}</td>
                <td>{e.tcb_status}</td>
                <td>{new Date(Number(e.observed_at)).toISOString().slice(0, 16).replace('T', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ fontSize: '1.1rem', marginTop: '2rem' }}>Wallet</h2>
      <p className="muted small">Logging in adds a function-call key limited to <span className="mono">commit_proof</span> on the contract, so the chat can commit salted proof hashes without asking the wallet each time.</p>
      {signedAccountId ? (
        <>
          <p>Connected as <span className="mono">{signedAccountId}</span> <button type="button" className="btn small" onClick={() => void signOut()}>Disconnect</button></p>
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
        <button type="button" className="btn primary" onClick={() => void connect()} disabled={loading}>Connect wallet</button>
      )}
    </main>
  );
}
