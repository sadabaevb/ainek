'use client';
// Re-verify a proof yourself: from this browser's store (?id=), from a pasted proof JSON, or from a disclosure file
// (proof + raw bytes + log entry). Hashes are recomputed here; the log entry is re-read from the public log.
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { verifyModelProof, type KeyEntry, type ModelProof, type VerifyReport } from '@ainek/proof';
import { getConfig } from '@/lib/config';
import { fetchEntry } from '@/lib/key-log';
import { getExchange, listExchanges, type StoredExchange } from '@/lib/store';

interface Input {
  proof: unknown;
  requestBody?: Uint8Array;
  responseBody?: Uint8Array;
  logEntryHint?: KeyEntry;
  origin: string;
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function VerifyInner() {
  const params = useSearchParams();
  const id = params.get('id');
  const [text, setText] = useState('');
  const [input, setInput] = useState<Input | null>(null);
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [logNote, setLogNote] = useState('');
  const [stored, setStored] = useState<StoredExchange[]>([]);
  const [explorer, setExplorer] = useState('https://testnet.nearblocks.io');
  const [error, setError] = useState('');

  useEffect(() => {
    getConfig().then((c) => setExplorer(c.explorer)).catch(() => undefined);
    listExchanges().then(setStored).catch(() => undefined);
    if (id) {
      getExchange(id)
        .then((x) => {
          if (!x) setError(`no exchange ${id} in this browser's store`);
          else setInput({ proof: x.proof, requestBody: x.requestBody, responseBody: x.responseBody, logEntryHint: x.logEntry, origin: 'this browser (IndexedDB)' });
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }
  }, [id]);

  useEffect(() => {
    if (!input) return;
    let cancelled = false;
    (async () => {
      const proof = input.proof as Partial<ModelProof>;
      let entry: KeyEntry | null = null;
      let note = '';
      if (typeof proof.logIndex === 'number') {
        try {
          entry = await fetchEntry(proof.logIndex);
          note = entry ? `log entry #${proof.logIndex} re-read from the public log` : `log entry #${proof.logIndex} not found in the public log`;
        } catch (e) {
          note = `public log unavailable (${e instanceof Error ? e.message : String(e)})`;
        }
      }
      if (!entry && input.logEntryHint) {
        entry = input.logEntryHint;
        note += `${note ? '; ' : ''}using the entry embedded in the input (weaker: not re-read from the chain)`;
      }
      if (cancelled) return;
      setLogNote(note);
      setReport(verifyModelProof(input.proof, input.requestBody, input.responseBody, entry));
    })();
    return () => {
      cancelled = true;
    };
  }, [input]);

  function parsePasted() {
    setError('');
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed['proof'] && typeof parsed['rawRequestBase64'] === 'string' && typeof parsed['rawResponseBase64'] === 'string') {
        setInput({
          proof: parsed['proof'],
          requestBody: fromBase64(parsed['rawRequestBase64']),
          responseBody: fromBase64(parsed['rawResponseBase64']),
          ...(parsed['logEntry'] ? { logEntryHint: parsed['logEntry'] as KeyEntry } : {}),
          origin: 'disclosure file (proof + raw bytes)',
        });
      } else {
        setInput({ proof: parsed['proof'] ?? parsed, origin: 'pasted proof JSON (no raw bytes: hash checks skipped)' });
      }
    } catch (e) {
      setError(`not JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setText(await file.text());
  }

  const proof = report?.proof;
  return (
    <main className="page">
      <h1>Verify a proof</h1>
      <p className="muted">Paste a proof, drop a disclosure file, or pick one of the exchanges this browser has kept. Hashes are recomputed here, the signature is checked here, and the log entry is re-read from the public log.</p>

      <div className="controls">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }} placeholder='{"v":1,"kind":"model",...}  or the "Disclose to auditor" file' />
        <div className="actions">
          <button type="button" className="btn primary" onClick={parsePasted} disabled={!text.trim()}>Verify</button>
          <label className="btn">
            Load file <input type="file" accept="application/json" style={{ display: 'none' }} onChange={(e) => void onFile(e.target.files?.[0])} />
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

      {report && input && (
        <section className={`card ${report.ok ? '' : 'red'}`}>
          <h3>{report.ok ? '✓ Proof verified' : '✗ Proof failed'}</h3>
          <p className="muted small">source: {input.origin}{logNote ? `; ${logNote}` : ''}</p>
          <ul className="mono">
            {report.checks.map((c) => (
              <li key={c.id}>{c.status === 'ok' ? '✓' : c.status === 'fail' ? '✗' : '—'} {c.id}: {c.detail}</li>
            ))}
          </ul>
          {proof && (
            <div className="actions">
              {proof.commitTx && <a className="btn" href={`${explorer}/txns/${proof.commitTx}`} target="_blank" rel="noreferrer">Commit on nearblocks</a>}
              <a className="btn" href={`https://cloud.near.ai/verify?model=${encodeURIComponent(proof.model)}`} target="_blank" rel="noreferrer">NEAR AI Verification Center</a>
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
