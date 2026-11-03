'use client';
// The public key log as the client sees it: who logged which key for which model, and whether two trusted
// verifiers disagree (split view). Wallet login here adds the function-call key later used for commit_proof.
import { useEffect, useState } from 'react';
import { useNearWallet, type NearContextValue } from 'near-connect-hooks';
import { evaluateKeyLog, type KeyEntry } from '@ainek/proof';
import { getConfig } from '@/lib/config';
import type { PublicConfig } from '@/app/api/config/route';
import { fetchLatestKeys, type KeyLogSnapshot } from '@/lib/key-log';

type AccessKeyInfo = Awaited<ReturnType<NearContextValue['getAccessKeyList']>>['keys'][number];
const FC_KEY_ALLOWANCE = '250000000000000000000000'; // 0.25 NEAR of gas allowance for commit_proof calls

function short(hex: string): string {
  return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : hex;
}

export default function LogPage() {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [snap, setSnap] = useState<KeyLogSnapshot | null>(null);
  const [error, setError] = useState('');
  const { signedAccountId, signIn, signOut, getAccessKeyList, loading } = useNearWallet();
  const [keys, setKeys] = useState<AccessKeyInfo[]>([]);

  useEffect(() => {
    getConfig()
      .then(async (c) => {
        setCfg(c);
        setSnap(await fetchLatestKeys(c.model));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!signedAccountId) {
      setKeys([]);
      return;
    }
    getAccessKeyList(signedAccountId).then((r) => setKeys(r.keys)).catch(() => setKeys([]));
  }, [signedAccountId, getAccessKeyList]);

  const split = cfg && snap ? evaluateKeyLog(snap.entries, { model: cfg.model, signingAddress: '', trustedVerifiers: cfg.trustedVerifiers, quorum: cfg.quorum }) : null;

  async function connect() {
    if (!cfg) return;
    await signIn({
      addFunctionCallKey: { contractId: cfg.contract, allowMethods: { anyMethod: false, methodNames: ['commit_proof'] }, gasAllowance: { kind: 'limited', amount: FC_KEY_ALLOWANCE } },
    });
  }

  return (
    <main className="page">
      <h1>Public key log</h1>
      {cfg && (
        <p className="muted">
          Contract <span className="mono">{cfg.contract}</span> on {cfg.network}; trusted verifiers {cfg.trustedVerifiers.join(', ')}; quorum {cfg.quorum}.
          {snap?.source === 'sample' && ' Showing the recorded sample entry until the contract is deployed (AINEK_LOG_SOURCE=sample).'}
        </p>
      )}
      {error && <p className="card red">{error}</p>}
      {split?.status === 'split-view' && (
        <section className="card red">
          <h3>Split view</h3>
          <p>{split.detail}</p>
        </section>
      )}
      {snap && (
        <table>
          <thead>
            <tr><th>#</th><th>model</th><th>verifier</th><th>signing key</th><th>compose</th><th>TCB</th><th>observed</th></tr>
          </thead>
          <tbody>
            {snap.entries.map((e: KeyEntry) => (
              <tr key={e.index}>
                <td>{e.index}</td>
                <td className="mono">{e.model}</td>
                <td className="mono">{e.verifier}{cfg && !cfg.trustedVerifiers.includes(e.verifier) ? ' (not in trust set)' : ''}</td>
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
        <button type="button" className="btn primary" onClick={() => void connect()} disabled={loading || !cfg}>Connect wallet</button>
      )}
    </main>
  );
}
