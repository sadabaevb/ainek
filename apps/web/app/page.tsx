'use client';

// Day-1 skeleton (no design yet): one input, the model's answer, and the raw verification result
// returned by the relay. The real chat with the proof card comes in the Tier-1 client session.
import { useState, type FormEvent } from 'react';

type RelayResult = Record<string, unknown>;

export default function Home() {
  const [message, setMessage] = useState('Reply with exactly two words.');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RelayResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/relay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const json = (await res.json()) as RelayResult;
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`);
      setResult(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Ainek — relay spike</h1>
      <form onSubmit={onSubmit}>
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          style={{ width: '70%' }}
          disabled={busy}
        />{' '}
        <button type="submit" disabled={busy || !message.trim()}>
          {busy ? 'verifying + asking…' : 'send'}
        </button>
      </form>
      {error && <p style={{ color: 'crimson' }}>error: {error}</p>}
      {result && (
        <>
          <h2>answer</h2>
          <p>{String(result.content ?? '')}</p>
          <h2>verification (raw)</h2>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{JSON.stringify(result, null, 2)}</pre>
        </>
      )}
    </main>
  );
}
