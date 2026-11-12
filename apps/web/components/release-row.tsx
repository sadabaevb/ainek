'use client';
// The "Code behind the key" line of the proof card and of /log. The other lines of a card were checked before the
// message left; this one is checked when the visitor asks, because it sends requests from their browser to GitHub and
// Sigstore (lib/release.ts, loaded on the click).
import { useMemo, useState } from 'react';
import { getSdkError, isVerificationError, type VerifiedModelAttestation } from '@nearai/inference-sdk';
import { useT } from '@/app/providers';
import { describeError } from '@/lib/errors';
import type { KeyLogContext, ReleaseCheck } from '@/lib/release';
import { Row, mark } from './checks';

/**
 * `failed` on an error: the hardware evidence itself did not verify. Anything else thrown is a check that could not be made.
 * A finished check keeps the report it read and the function that reads the key log against it, so that the key-log line
 * follows the log and the viewer's trust set as they change, without checking the release again.
 */
type State =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; check: ReleaseCheck; attestation: VerifiedModelAttestation; withKeyLog: typeof import('@/lib/release').withKeyLog }
  | { kind: 'error'; why: string; failed: boolean };

/**
 * `attest` gives the verified report to read: the card hands over the one it already holds, /log verifies one when asked.
 * `history` adds the list of the service's releases under the line. `keyLog` adds, to the lines, where the public key log
 * stands on that report's action log: /log has the entries at hand, a card shown later does not.
 */
export function ReleaseRow({ attest, model, hint, history = false, keyLog }: { attest: () => Promise<VerifiedModelAttestation>; model: string; hint?: string | undefined; history?: boolean; keyLog?: KeyLogContext | undefined }) {
  const { t } = useT();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [open, setOpen] = useState(false);

  const run = async () => {
    setState({ kind: 'running' });
    try {
      const [{ checkRelease, withKeyLog }, attestation] = await Promise.all([import('@/lib/release'), attest()]);
      setState({ kind: 'done', check: await checkRelease(attestation, model), attestation, withKeyLog });
    } catch (err) {
      const refused = getSdkError(err);
      setState({ kind: 'error', why: describeError(err), failed: isVerificationError(refused) && !refused.retryable });
    }
  };

  const check = useMemo(() => (state.kind !== 'done' ? undefined : keyLog ? state.withKeyLog(state.check, state.attestation, model, keyLog) : state.check), [state, keyLog, model]);
  const status = check ? check.status : state.kind === 'running' ? 'running' : state.kind === 'error' && state.failed ? 'fail' : 'skipped';
  const again = <button type="button" className="btn small" onClick={run}>{t.codeAgain}</button>;
  const detail = check && (
    <>
      {open && (
        <ul className="mono checks sentences" lang="en">
          {check.lines.map((l, i) => (
            <li key={i} className={l.status}>{mark(l.status)} {l.text}</li>
          ))}
        </ul>
      )}
      {history && check.history.length > 0 && (
        <>
          <p className="small history-title">{t.codeHistory(check.history.length)}</p>
          <ul className="mono checks sentences" lang="en">
            {check.history.map((r, i) => (
              <li key={i}>{r.deployedAt} · {r.name} · {r.commit.slice(0, 10)}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
  return (
    <Row status={status} label={t.rowCode} {...(hint ? { hint } : {})} {...(detail ? { detail } : {})}>
      {state.kind === 'idle' && (
        <>
          {t.codeIdle}{' '}
          <button type="button" className="btn small" onClick={run}>{t.codeCheck}</button>
        </>
      )}
      {state.kind === 'running' && t.codeRunning}
      {state.kind === 'error' && <>{state.failed ? t.codeFailed : t.codeError} <span lang="en">{state.why}</span> {again}</>}
      {check && (
        <>
          <ReleaseSummary check={check} />{' '}
          {check.lines.length > 0 && <button type="button" className="linklike" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? t.codeHide : t.codeDetails}</button>}
          {/* Only when asking again can change the answer: GitHub or Sigstore did not answer for something. */}
          {check.retry && <> {again}</>}
        </>
      )}
    </Row>
  );
}

/**
 * One sentence for the row, read in the order `verdictOf` gives: a failure first, whatever else is missing; then a
 * release that could not be resolved; then what was not checked; then what held.
 */
function ReleaseSummary({ check }: { check: ReleaseCheck }) {
  const { t } = useT();
  const { release, failures, unchecked, unresolved } = check;
  // The first failure is enough to read the line as failed; everything that was not checked is named.
  const failed = failures.length > 0 && <>{t.codeFailed} <span lang="en">{failures[0]}</span></>;
  if (!release) return failed || <>{t.codeUnresolved} <span lang="en">{unresolved}</span></>;
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
      {failed || (unchecked.length > 0 ? <>{t.codeUnchecked} <span lang="en">{unchecked.join('; ')}</span></> : t.codeAllHeld)}
    </>
  );
}
