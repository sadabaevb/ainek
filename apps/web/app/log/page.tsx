'use client';

// Day-1 NEAR quickstart on the page that will later become the key-log explorer (SPEC §3.3).
// Dastan's contract is not deployed yet, so this talks to the docs' example contract:
//   view   get_greeting  — free, no wallet, answered by an RPC node from the latest state
//   change set_greeting  — a signed transaction; the wallet (or the function-call key it added at
//                          login) signs it, the network executes it and charges gas
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNearWallet, type NearContextValue } from 'near-connect-hooks';

const CONTRACT = 'hello.near-examples.testnet'; // placeholder until ainek.testnet exists
const EXPLORER = 'https://testnet.nearblocks.io';

// 0.25 NEAR gas allowance for the function-call key the wallet adds at login (docs' default).
const FC_KEY_ALLOWANCE = '250000000000000000000000';

// Access-key list as near-api-js returns it through the hook (nonce is a bigint there).
type AccessKeyInfo = Awaited<ReturnType<NearContextValue['getAccessKeyList']>>['keys'][number];

function functionCallPermission(key: AccessKeyInfo): { receiver_id: string; method_names: string[] } | null {
  const permission = key.access_key.permission;
  if (typeof permission === 'object' && 'FunctionCall' in permission) return permission.FunctionCall;
  return null;
}

export default function LogPage() {
  const { loading, network, signedAccountId, signIn, signOut, viewFunction, callFunctionRaw, getAccessKeyList } =
    useNearWallet();

  const [greeting, setGreeting] = useState<string | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [keys, setKeys] = useState<AccessKeyInfo[] | null>(null);
  const [newGreeting, setNewGreeting] = useState('Hello from Ainek');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // View call: no wallet needed, runs on every visit.
  const refreshGreeting = useCallback(async () => {
    try {
      const value = (await viewFunction({ contractId: CONTRACT, method: 'get_greeting', args: {} })) as string;
      setGreeting(value);
      setViewError(null);
    } catch (err) {
      setViewError(err instanceof Error ? err.message : String(err));
    }
  }, [viewFunction]);

  useEffect(() => {
    void refreshGreeting();
  }, [refreshGreeting]);

  // After login, list the account's access keys so the function-call key is visible.
  useEffect(() => {
    if (!signedAccountId) {
      setKeys(null);
      return;
    }
    getAccessKeyList(signedAccountId)
      .then((list) => setKeys(list.keys))
      .catch(() => setKeys(null));
  }, [signedAccountId, getAccessKeyList]);

  async function connect() {
    setError(null);
    try {
      // Ask the wallet to also add a function-call key limited to set_greeting on CONTRACT:
      // later calls to that method are signed locally without a wallet popup.
      await signIn({
        addFunctionCallKey: {
          contractId: CONTRACT,
          allowMethods: { anyMethod: false, methodNames: ['set_greeting'] },
          gasAllowance: { kind: 'limited', amount: FC_KEY_ALLOWANCE },
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onSetGreeting(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setTxHash(null);
    try {
      const outcome = await callFunctionRaw({
        contractId: CONTRACT,
        method: 'set_greeting',
        args: { greeting: newGreeting },
        gas: '30000000000000', // 30 TGas
        deposit: '0',
      });
      setTxHash(outcome.transaction.hash);
      await refreshGreeting();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const fcKeys = (keys ?? []).filter((k) => functionCallPermission(k)?.receiver_id === CONTRACT);

  return (
    <main>
      <h1>/log — NEAR wallet spike ({network})</h1>
      <p>
        Placeholder contract <code>{CONTRACT}</code> until <code>ainek.testnet</code> is deployed.{' '}
        <a href={`${EXPLORER}/address/${CONTRACT}`} target="_blank" rel="noreferrer">
          explorer
        </a>
      </p>

      <h2>view call: get_greeting</h2>
      {viewError ? <p style={{ color: 'crimson' }}>view error: {viewError}</p> : <p>{greeting ?? 'loading…'}</p>}

      <h2>wallet</h2>
      {loading ? (
        <p>initialising wallet connector…</p>
      ) : signedAccountId ? (
        <p>
          signed in as <b>{signedAccountId}</b>{' '}
          <button type="button" onClick={() => void signOut()}>
            disconnect
          </button>
        </p>
      ) : (
        <button type="button" onClick={() => void connect()}>
          Connect wallet
        </button>
      )}
      {signedAccountId && keys && (
        <p>
          access keys on this account: {keys.length}; function-call keys for {CONTRACT}: {fcKeys.length}
          {fcKeys.map((k) => (
            <span key={String(k.public_key)}>
              <br />
              <code>{String(k.public_key)}</code> → methods {JSON.stringify(functionCallPermission(k)?.method_names ?? [])}
            </span>
          ))}
        </p>
      )}

      <h2>change call: set_greeting</h2>
      <form onSubmit={onSetGreeting}>
        <input value={newGreeting} onChange={(e) => setNewGreeting(e.target.value)} disabled={busy || !signedAccountId} />{' '}
        <button type="submit" disabled={busy || !signedAccountId || !newGreeting.trim()}>
          {busy ? 'sending…' : 'set greeting'}
        </button>
        {!signedAccountId && <span> (connect a wallet first)</span>}
      </form>
      {txHash && (
        <p>
          tx <code>{txHash}</code>{' '}
          <a href={`${EXPLORER}/txns/${txHash}`} target="_blank" rel="noreferrer">
            open on nearblocks
          </a>
        </p>
      )}
      {error && <p style={{ color: 'crimson' }}>error: {error}</p>}
    </main>
  );
}
