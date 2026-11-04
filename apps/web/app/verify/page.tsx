'use client';
// Re-verify a proof yourself: from this browser's store (?id=), from a pasted proof JSON, or from a disclosure file
// (proof + raw bytes + log entry). Hashes are recomputed here; the log entry is re-read from the public log.
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { isDisclosure, parseDisclosure, verifyModelProof, type KeyEntry, type VerifyReport } from '@ainek/proof';
import { CheckList } from '@/components/checks';
import { describeError } from '@/lib/errors';
import { resolveLogEntry, type ResolvedEntry } from '@/lib/key-log';
import { explorerTxUrl, verificationCenterUrl } from '@/lib/links';
import { getExchange, listExchanges, type StoredExchange } from '@/lib/store';
import { useConfig } from '../providers';

interface Input {
  proof: unknown;
  requestBody?: Uint8Array;
  responseBody?: Uint8Array;
  /** Entry embedded in the input; the public log is still asked first, and a mismatch is reported. */
  embeddedEntry?: KeyEntry;
  origin: string;
}

interface Result {
  report: VerifyReport;
  origin: string;
  log: ResolvedEntry;
}

function VerifyInner() {
  const cfg = useConfig();
  const id = useSearchParams().get('id');
  const [text, setText] = useState('');
  const [input, setInput] = useState<Input | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [stored, setStored] = useState<StoredExchange[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    listExchanges().then(setStored).catch(() => undefined);
    if (!id) return;
    getExchange(id)
      .then((x) => {
        if (!x) setError(`no exchange ${id} in this browser's store`);
        else setInput({ proof: x.proof, requestBody: x.requestBody, responseBody: x.responseBody, embeddedEntry: x.logEntry, origin: 'this browser (IndexedDB)' });
      })
      .catch((e: unknown) => setError(describeError(e)));
  }, [id]);

  useEffect(() => {
    if (!input) return;
    let cancelled = false;
    resolveLogEntry(cfg, (input.proof as { logIndex?: unknown }).logIndex, input.embeddedEntry).then((log) => {
      if (!cancelled) setResult({ report: verifyModelProof(input.proof, input.requestBody, input.responseBody, log.entry), origin: input.origin, log });
    });
    return () => {
      cancelled = true;
    };
  }, [input, cfg]);

  function parsePasted() {
    setError('');
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isDisclosure(parsed)) {
        const d = parseDisclosure(parsed);
        setInput({ proof: d.proof, requestBody: d.requestBody, responseBody: d.responseBody, embeddedEntry: d.logEntry, origin: 'disclosure file (proof + raw bytes)' });
      } else {
        setInput({ proof: parsed, origin: 'pasted proof JSON (no raw bytes: hash checks skipped)' });
      }
    } catch (e) {
      setError(`not a proof or disclosure: ${describeError(e)}`);
    }
  }

  const proof = result?.report.proof;
  const ok = result !== null && result.report.ok && result.log.status !== 'fail';
  return (
    <main className="page">
      <h1>Verify a proof</h1>
      <p className="muted">Paste a proof, drop a disclosure file, or pick one of the exchanges this browser has kept. Hashes are recomputed here, the signature is checked here, and the log entry is re-read from the public log. Received a disclosure from someone else? <Link href="/auditor">/auditor</Link> says what it proves.</p>

      <div className="controls">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }} placeholder='{"v":1,"kind":"model",...}  or the "Disclose to auditor" file' />
        <div className="actions">
          <button type="button" className="btn primary" onClick={parsePasted} disabled={!text.trim()}>Verify</button>
          <label className="btn">
            Load file <input type="file" accept="application/json" style={{ display: 'none' }} onChange={(e) => void e.target.files?.[0]?.text().then(setText)} />
          </label>
        </div>
      </div>

      {stored.length > 0 && (
        <details>
          <summary>Exchanges kept in this browser ({stored.length})</summary>
          <ul className="mono">
            {stored.map((x) => (
              <li key={x.completionId}><a href={`/verify?id=${encodeURIComponent(x.completionId)}`}>{x.completionId}</a> · {x.model} · {x.sentAt.slice(0, 19)}</li>
            ))}
          </ul>
        </details>
      )}

      {error && <p className="card red">{error}</p>}

      {result && (
        <section className={`card ${ok ? '' : 'red'}`}>
          <h3>{ok ? '✓ Proof verified' : '✗ Proof failed'}</h3>
          <p className="muted small">source: {result.origin}; {result.log.detail}</p>
          <CheckList items={[{ id: 'log-entry', ...result.log }, ...result.report.checks]} />
          {proof && (
            <div className="actions">
              {proof.commitTx && <a className="btn" href={explorerTxUrl(cfg.explorer, proof.commitTx)} target="_blank" rel="noreferrer">Commit on nearblocks</a>}
              <a className="btn" href={verificationCenterUrl(proof)} target="_blank" rel="noreferrer">NEAR AI Verification Center</a>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={<main className="page"><p className="muted">Loading…</p></main>}>
      <VerifyInner />
    </Suspense>
  );
}
