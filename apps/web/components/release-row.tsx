'use client';
// The "Code behind the key" line of the proof card. The other lines were checked before the message left; this one is
// checked when the visitor asks, because it sends requests from their browser to GitHub and Sigstore (lib/release.ts).
import { useState } from 'react';
import type { VerifiedModelAttestation } from '@nearai/inference-sdk';
import { useT } from '@/app/providers';
import { describeError } from '@/lib/errors';
import type { ReleaseCheck } from '@/lib/release';
import { Row, mark } from './checks';

type State = { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; check: ReleaseCheck } | { kind: 'error'; why: string };

/**
 * `attestation` is the verified report the card already holds, or a way to get one (the /log page has none until asked).
 * `history` adds the list of the service's releases under the line.
 */
export function ReleaseRow({ attestation, model, hint, history = false }: { attestation: VerifiedModelAttestation | (() => Promise<VerifiedModelAttestation>); model: string; hint?: string | undefined; history?: boolean }) {
  const { t } = useT();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [open, setOpen] = useState(false);

  const run = async () => {
    setState({ kind: 'running' });
    try {
      const [{ checkRelease }, verified] = await Promise.all([import('@/lib/release'), typeof attestation === 'function' ? attestation() : attestation]);
      setState({ kind: 'done', check: await checkRelease(verified, model) });
    } catch (err) {
      setState({ kind: 'error', why: describeError(err) });
    }
  };

  const status = state.kind === 'done' ? state.check.status : state.kind === 'running' ? 'running' : state.kind === 'error' ? 'fail' : 'skipped';
  return (
    <Row status={status} label={t.rowCode} {...(hint ? { hint } : {})}>
      {state.kind === 'idle' && (
        <>
          {t.codeIdle}{' '}
          <button type="button" className="btn small" onClick={run}>{t.codeCheck}</button>
        </>
      )}
      {state.kind === 'running' && t.codeRunning}
      {state.kind === 'error' && (
        <>
          {t.codeError} <span lang="en">{state.why}</span>{' '}
          <button type="button" className="btn small" onClick={run}>{t.codeAgain}</button>
        </>
      )}
      {state.kind === 'done' && (
        <>
          <ReleaseSummary check={state.check} />{' '}
          <button type="button" className="linklike" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? t.codeHide : t.codeDetails}</button>
          {open && (
            <ul className="mono checks sentences" lang="en">
              {state.check.lines.map((l, i) => (
                <li key={i} className={l.status}>{mark(l.status)} {l.text}</li>
              ))}
            </ul>
          )}
          {history && state.check.history.length > 0 && (
            <>
              <span className="line small">{t.codeHistory(state.check.history.length)}</span>
              <ul className="mono checks sentences" lang="en">
                {state.check.history.map((r) => (
                  <li key={`${r.commit}@${r.deployedAt}`}>{r.deployedAt} · {r.name} · {r.commit.slice(0, 10)}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Row>
  );
}

/** One sentence for the row: the release and where its proxy was built from, then what failed or was not checked. */
function ReleaseSummary({ check }: { check: ReleaseCheck }) {
  const { t } = useT();
  const { release, failures, unchecked, unresolved } = check;
  if (!release) return <>{t.codeUnresolved} <span lang="en">{unresolved}</span></>;
  const built = release.builtFrom;
  return (
    <>
      {t.codeRelease(release.name, release.deployedAt)}
      {built && (
        <>
          {t.codeBuiltFrom}{' '}
          <a href={`https://github.com/${built.repository}/commit/${built.commit}`} target="_blank" rel="noreferrer">{built.repository}@{built.commit.slice(0, 10)}</a>
        </>
      )}
      {'. '}
      {failures.length > 0 ? <>{t.codeFailed} <span lang="en">{failures[0]}</span></> : unchecked.length > 0 ? <>{t.codeUnchecked} <span lang="en">{unchecked.join('; ')}</span></> : t.codeAllHeld}
    </>
  );
}
