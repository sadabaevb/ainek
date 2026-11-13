'use client';
// The "Code behind the key" line of the proof card and of /log. The other lines of a card were checked before the
// message left; this one is checked when the visitor asks, because it sends requests from their browser to GitHub and
// Sigstore (lib/release.ts, loaded on the click).
import { useMemo, useState } from 'react';
import { getSdkError, isVerificationError, type VerifiedModelAttestation } from '@nearai/inference-sdk';
import { useT } from '@/app/providers';
import { describeError } from '@/lib/errors';
import { withKeyLog, type KeyLogContext } from '@/lib/key-log-line';
import type { OutsideReading } from '@ainek/proof/release-chain';
import type { ReleaseCheck } from '@/lib/release';
import { CheckLine, Row } from './checks';

/**
 * `failed` on an error: the hardware evidence itself did not verify. Anything else thrown is a check that could not be made.
 * A finished check keeps the report it read and when, so that the key-log line follows the log and the viewer's trust set
 * as they change without checking the release again, and still speaks for the moment of that check.
 */
type State = { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; check: ReleaseCheck; attestation: VerifiedModelAttestation; at: number; /** What outside parties say about this state; absent while it is being read. */ outside?: OutsideReading[] } | { kind: 'error'; why: string; failed: boolean };

/**
 * `attest` gives the verified report to read: the card hands over the one it already holds, /log verifies one when asked.
 * `history` adds the list of the service's releases under the line. `keyLog` adds, to the lines, where the public key log
 * stands on that report's action log: /log has the entries at hand (null while it is reading them), a card shown later
 * does not and leaves it out.
 */
export function ReleaseRow({ attest, model, hint, history = false, keyLog }: { attest: () => Promise<VerifiedModelAttestation>; model: string; hint?: string | undefined; history?: boolean; keyLog?: KeyLogContext | null | undefined }) {
  const { t, lang } = useT();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [open, setOpen] = useState(false);

  const run = async () => {
    setState({ kind: 'running' });
    try {
      const [{ checkRelease, readOutside }, attestation] = await Promise.all([import('@/lib/release'), attest()]);
      const at = Date.now(); // the report is as fresh as it will be; the key-log line is read as of now
      const check = await checkRelease(attestation, model);
      setState({ kind: 'done', check, attestation, at });
      // The row does not wait for the outside readings, and they land only on the check they were read for.
      const outside = await readOutside(attestation, model, check.inspection);
      setState((s) => (s.kind === 'done' && s.at === at ? { ...s, outside } : s));
    } catch (err) {
      const refused = getSdkError(err);
      setState({ kind: 'error', why: describeError(err), failed: isVerificationError(refused) && !refused.retryable });
    }
  };

  const check = useMemo(() => (state.kind !== 'done' ? undefined : keyLog === undefined ? state.check : withKeyLog(state.check, state.attestation, model, keyLog, state.at)), [state, keyLog, model]);
  const status = check ? check.status : state.kind === 'running' ? 'running' : state.kind === 'error' && state.failed ? 'fail' : 'skipped';
  const again = <button type="button" className="btn small" onClick={run}>{t.codeAgain}</button>;
  const outside = state.kind === 'done' ? state.outside : undefined;
  const detail = check && (
    <>
      {open && (
        <ul className="mono checks" lang="en">
          {check.lines.map((l, i) => <CheckLine key={i} status={l.status}>{l.text}</CheckLine>)}
        </ul>
      )}
      <p className="small history-title">{t.outsideTitle}</p>
      <p className="muted small">{outside ? t.outsideNote : t.outsideLoading}</p>
      {/* Words in a tag, not the marks of our own checks: "seen" is not "held". */}
      {outside && (
        <ul className="mono checks" lang="en">
          {outside.map((r, i) => <li key={i}><span className="tag" lang={lang}>{t.outsideStatus[r.status]}</span> {r.source}: {r.text}</li>)}
        </ul>
      )}
      {history && check.history.length > 0 && (
        <>
          <p className="small history-title">{t.codeHistory(check.history.length)}</p>
          <ul className="mono checks" lang="en">
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
          {/* Only when asking again can change the answer: GitHub or Sigstore did not answer for something, or the line about
              the key log is shown, which speaks for the moment of the check and for an enclave that may have moved on. */}
          {(check.retry || keyLog !== undefined) && <> {again}</>}
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
