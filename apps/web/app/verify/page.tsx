'use client';
// Re-verify a proof yourself: from this browser's store (?id=), from a pasted proof JSON, or from a disclosure file
// (proof + raw bytes + log entry). Hashes are recomputed here; the log entry is re-read from the public log.
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ModelProof, isDisclosure, parseDisclosure, verifyModelProof, withChecks, type KeyEntry, type VerifyReport } from '@ainek/proof';
import { CheckList } from '@/components/checks';
import { JsonTextarea, LoadFileButton } from '@/components/json-file-input';
import { describeError } from '@/lib/errors';
import { resolveLogEntry } from '@/lib/key-log';
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
    (async () => {
      // The chain is asked only for a schema-valid proof; a malformed one is reported by verifyModelProof without a view call.
      const parsed = ModelProof.safeParse(input.proof);
      const log = parsed.success ? await resolveLogEntry(cfg, parsed.data.logIndex, input.embeddedEntry) : null;
      const report = verifyModelProof(input.proof, input.requestBody, input.responseBody, log?.entry ?? null);
      if (!cancelled) setResult({ report: log ? withChecks(report, log.check) : report, origin: input.origin });
    })();
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
  return (
    <main className="page">
      <h1>Verify a proof</h1>
      <p className="muted">Paste a proof, drop a disclosure file, or pick one of the exchanges this browser has kept. Hashes are recomputed here, the signature is checked here, and the log entry is re-read from the public log. Received a disclosure from someone else? <Link href="/auditor">/auditor</Link> says what it proves.</p>

      <div className="controls">
        <JsonTextarea value={text} onChange={setText} placeholder='{"v":1,"kind":"model",...}  or the "Disclose to auditor" file' />
        <div className="actions">
          <button type="button" className="btn primary" onClick={parsePasted} disabled={!text.trim()}>Verify</button>
          <LoadFileButton onText={setText} />
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
        <section className={`card ${result.report.ok ? '' : 'red'}`}>
          <h3>{result.report.ok ? '✓ Proof verified' : '✗ Proof failed'}</h3>
          <p className="muted small">source: {result.origin}</p>
          <CheckList items={result.report.checks} />
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
