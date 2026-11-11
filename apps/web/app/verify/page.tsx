'use client';
// Re-verify a proof yourself: from this browser's store (?id=), from a pasted proof JSON, from a disclosure file
// (proof + raw bytes + log entry), or from a link that carries that file in its fragment (lib/proof-link.ts). Hashes are recomputed here; the log entry is re-read from the public log. An exchange
// kept in this browser whose proof was never committed can be committed from here (SPEC §4.2), wallet connected on demand.
import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useNearWallet } from 'near-connect-hooks';
import { ModelProof, isDisclosure, parseDisclosure, verifyModelProof, withChecks, type DisclosedExchange, type KeyEntry, type VerifyReport } from '@ainek/proof';
import sampleAction from '../../../../docs/samples/action-proof.sample.json';
import { ActionProofCard } from '@/components/action-proof-card';
import { CardHead, CheckList } from '@/components/checks';
import { JsonTextarea, LoadFileButton } from '@/components/json-file-input';
import { RedCard } from '@/components/red-card';
import { describeError } from '@/lib/errors';
import { fill } from '@/lib/fill';
import { commitAction, commitExchange, consentFor, type CommitStatus } from '@/lib/flow';
import { commitLabel } from '@/lib/commit-label';
import type { Dict } from '@/lib/i18n';
import { resolveLogEntry } from '@/lib/key-log';
import { explorerTxUrl, verificationCenterUrl } from '@/lib/links';
import { proofFromFragment } from '@/lib/proof-link';
import { getExchange, listExchanges, type StoredExchange } from '@/lib/store';
import { walletCommitter } from '@/lib/wallet';
import { useConfig, useT } from '../providers';

/** Where the input came from; the wording follows the language toggle, so only the key is kept. */
type Origin = keyof Dict['verify']['origin'];

interface Input {
  proof: unknown;
  requestBody?: Uint8Array;
  responseBody?: Uint8Array;
  /** Entry embedded in the input; the public log is still asked first, and a mismatch is reported. */
  embeddedEntry?: KeyEntry;
  /** Set when the input is an exchange kept in this browser: the one this page can commit. */
  stored?: StoredExchange;
  origin: Origin;
}

interface Result {
  report: VerifyReport;
  origin: Origin;
  stored?: StoredExchange;
}

/** A disclosure file and a stored exchange carry the same four things. */
function inputOf(x: DisclosedExchange, origin: Origin, stored?: StoredExchange): Input {
  return { proof: x.proof, requestBody: x.requestBody, responseBody: x.responseBody, embeddedEntry: x.logEntry, origin, ...(stored ? { stored } : {}) };
}

function VerifyInner() {
  const cfg = useConfig();
  const { t } = useT();
  const tv = t.verify;
  const wallet = useNearWallet();
  const params = useSearchParams();
  const id = params.get('id');
  const sample = params.get('sample');
  const [text, setText] = useState('');
  const [input, setInput] = useState<Input | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [stored, setStored] = useState<StoredExchange[]>([]);
  const [committing, setCommitting] = useState(false);
  const [commitStatus, setCommitStatus] = useState<Record<string, CommitStatus>>({}); // per exchange, what the previous click ended in: decides the button's label and what the next click may open
  const [missingId, setMissingId] = useState<string | null>(null); // ?id= not in this browser's store: worded at render, so it follows the language
  const [error, setError] = useState('');
  const linkRead = useRef(0); // counts reads of the address fragment, so a stale one is dropped
  const [badLink, setBadLink] = useState<string | null>(null); // a proof link that could not be read: worded at render, so it follows the language
  const [actionProof, setActionProof] = useState<unknown>(null); // an action proof has its own card: there is no exchange to re-hash

  useEffect(() => {
    listExchanges().then(setStored).catch(() => undefined);
    setMissingId(null);
    if (!id) return;
    getExchange(id)
      .then((x) => {
        if (!x) setMissingId(id);
        else setInput(inputOf(x, 'store', x));
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
      if (!cancelled) setResult({ report: log ? withChecks(report, log.check) : report, origin: input.origin, ...(input.stored ? { stored: input.stored } : {}) });
    })().catch((e: unknown) => {
      if (!cancelled) setError(describeError(e));
    });
    return () => {
      cancelled = true;
    };
  }, [input, cfg]);

  function check(source: string) {
    setError('');
    setMissingId(null);
    // Nothing from the previous click may stay on screen as if it were this one's verdict, and a check still running must not land later.
    setActionProof(null);
    setInput(null);
    setResult(null);
    try {
      const parsed = JSON.parse(source) as unknown;
      const isAction = (parsed as { kind?: unknown } | null)?.kind === 'action';
      if (isAction) {
        setActionProof(parsed);
        return;
      }
      if (isDisclosure(parsed)) setInput(inputOf(parseDisclosure(parsed), 'disclosure'));
      else setInput({ proof: parsed, origin: 'pasted' });
    } catch (e) {
      setError(tv.notProof(describeError(e)));
    }
  }

  /** Text that arrived by itself (a query parameter, a link): shown in the box and checked at once, like a click on Verify. */
  function load(source: string) {
    setText(source);
    check(source);
  }

  // /agent links here for the one action whose proof file is in the repository: the same text the button below pastes.
  useEffect(() => {
    if (sample === 'action') load(JSON.stringify(sampleAction, null, 2));
    // `load` only sets state; the query parameter is the one thing this depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample]);

  /** The Verify button: what the box holds now. A proof link in the address would no longer describe the page, so it goes. */
  function checkTyped(source: string) {
    linkRead.current++; // a link still being read must not replace this
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setBadLink(null);
    check(source);
  }

  // A proof link: the disclosure travels in the fragment, which the browser keeps to itself. Checked like a dropped file.
  // Only the newest read may land: an older link's inflate can finish after a newer one's, or after a click on Verify.
  useEffect(() => {
    const read = () => {
      const mine = ++linkRead.current;
      setBadLink(null);
      proofFromFragment(window.location.hash).then(
        (source) => { if (mine === linkRead.current && source !== null) load(source); },
        (e: unknown) => {
          if (mine !== linkRead.current) return;
          // A verdict left from the previous address would read as this link's.
          setActionProof(null);
          setInput(null);
          setResult(null);
          setBadLink(describeError(e));
        },
      );
    };
    read();
    window.addEventListener('hashchange', read);
    return () => {
      linkRead.current++;
      window.removeEventListener('hashchange', read);
    };
    // `load` only sets state; the fragment is the one thing this depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The stored row carries the transaction once committed; the report's proof is the one that was verified (equal apart from commitTx).
  const proof = result?.stored?.proof ?? result?.report.proof;
  const committable = result?.stored && result.report.ok && !result.stored.proof.commitTx ? result.stored : null;
  const action = commitAction((committable && commitStatus[committable.completionId]) ?? 'no-wallet', !!wallet.signedAccountId);

  /** commit_proof for an exchange kept here (its salt is in the proof). commitTx is an envelope field outside the signed and committed bytes, so the report stays as it is; only the transaction link appears. */
  async function commitStored(x: StoredExchange) {
    setError('');
    setCommitting(true);
    const r = await commitExchange(x, () => walletCommitter(wallet, cfg, consentFor(action)), (e) => {
      if (e.status === 'skipped') setError(e.detail);
    });
    setCommitStatus((prev) => ({ ...prev, [x.completionId]: r.commit }));
    // The page may be showing something else by now (a pasted proof): only the same exchange takes the transaction.
    if (r.commit === 'committed') setResult((prev) => (prev?.stored?.completionId === x.completionId ? { ...prev, stored: r.exchange } : prev));
    setCommitting(false);
  }

  return (
    <main className="page">
      <h1>{tv.title}</h1>
      <p className="muted">{fill(tv.intro, { auditor: <Link href="/auditor">/auditor</Link> })}</p>

      <div className="controls">
        <JsonTextarea value={text} onChange={setText} onError={setError} placeholder={tv.placeholder} />
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => checkTyped(text)} disabled={!text.trim()}>{tv.verify}</button>
          <LoadFileButton onText={setText} onError={setError} />
          <button type="button" className="btn" onClick={() => setText(JSON.stringify(sampleAction, null, 2))}>{tv.useActionSample}</button>
        </div>
      </div>

      {stored.length > 0 && (
        <details>
          <summary>{tv.kept(stored.length)}</summary>
          <ul className="mono">
            {stored.map((x) => (
              <li key={x.completionId}><a href={`/verify?id=${encodeURIComponent(x.completionId)}`}>{x.completionId}</a> · {x.model} · {x.sentAt.slice(0, 19)}</li>
            ))}
          </ul>
        </details>
      )}

      {missingId && <RedCard title={tv.noExchange(missingId)} />}
      {badLink && <RedCard title={tv.badLink(badLink)} />}
      {error && <RedCard title={error} />}

      {actionProof !== null && <ActionProofCard value={actionProof} />}
      {result && (
        <section className="card">
          <CardHead status={result.report.ok ? 'ok' : 'fail'} when={tv.source(tv.origin[result.origin])}>{result.report.ok ? tv.ok : tv.failed}</CardHead>
          <CheckList items={result.report.checks} />
          {proof && (
            <div className="actions">
              {proof.commitTx && <a className="btn" href={explorerTxUrl(cfg.explorer, proof.commitTx)} target="_blank" rel="noreferrer">{tv.commitTx}</a>}
              {committable && (
                <button type="button" className="btn" onClick={() => void commitStored(committable)} disabled={committing}>{committing ? tv.committing : commitLabel(t, action)}</button>
              )}
              <a className="btn" href={verificationCenterUrl(proof)} target="_blank" rel="noreferrer">{t.openVc}</a>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

export default function VerifyPage() {
  const { t } = useT();
  return (
    <Suspense fallback={<main className="page"><p className="muted">{t.loading}</p></main>}>
      <VerifyInner />
    </Suspense>
  );
}
