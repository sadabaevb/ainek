'use client';
// The card a person sees after each reply (SPEC §5.3): one line per guarantee, ✓/✗/—, red states in their own design.
import Link from 'next/link';
import { memo, useMemo, useState } from 'react';
import { useNearWallet } from 'near-connect-hooks';
import { composeHashOf, normalizeHex, toDisclosure, type KeyLogReason } from '@ainek/proof';
import { useConfig, useT } from '@/app/providers';
import { canCommitNow, commitAction, failurePhase, type ChatOutcome, type VerifiedOutcome } from '@/lib/flow';
import { commitLabel } from '@/lib/commit-label';
import { DEPOSIT_NEAR } from '@/lib/wallet';
import { downloadJson } from '@/lib/encoding';
import { observedUtc, seconds, short, utcMinute } from '@/lib/format';
import { explorerTxUrl, verificationCenterUrl } from '@/lib/links';
import { fill } from '@/lib/fill';
import { CardHead, CheckList, Row } from './checks';
import { RedCard } from './red-card';
import { CopyButton } from './copy-button';

export const ProofCard = memo(function ProofCard({ outcome, onCommit, onRetry }: { outcome: ChatOutcome; onCommit?: (outcome: VerifiedOutcome) => void; /** Shown on a refusal caused by the tamper switch: send the same message again with the honest key. */ onRetry?: () => void }) {
  const { t } = useT();
  const cfg = useConfig();
  const { signedAccountId } = useNearWallet(); // the button's label follows the wallet as it is now, not the turn's frozen status
  const [explain, setExplain] = useState(false);
  const vcUrl = useMemo(() => (outcome.kind === 'verified' ? verificationCenterUrl(outcome.proof) : ''), [outcome]);

  if (outcome.kind === 'failed') {
    const phase = failurePhase(outcome.step);
    const [title, body] = phase === 'answered' ? [t.failedAfterSendTitle, t.failedAfterSendBody] : phase === 'sent' ? [t.failedSentTitle, t.failedSentBody] : [t.failedTitle, undefined];
    return <RedCard title={title} body={body} lines={[`${outcome.step}: ${outcome.reason}`]} />;
  }
  if (outcome.kind === 'refused') {
    // The decision is the same (nothing sent); the wording follows the verdict's reason, decided once in @ainek/proof.
    const v = outcome.keyVerdict;
    const texts: Record<Exclude<KeyLogReason, 'ok'>, [string, string]> = {
      'split-view': [t.refusedSplitTitle, t.refusedSplitBody],
      'below-quorum': [t.refusedQuorumTitle, t.refusedQuorumBody(v.confirmedBy.length, cfg.quorum)],
      'untrusted-only': [t.refusedUntrustedTitle, t.refusedUntrustedBody(v.loggedByUntrusted.join(', '))],
      absent: [t.refusedTitle, t.refusedBody],
    };
    const reason = v.reason === 'ok' ? 'absent' : v.reason;
    const [title, body] = texts[reason];
    return (
      <RedCard
        title={title}
        body={body}
        note={t.refusedConsequence[reason]}
        action={onRetry && <button type="button" className="btn primary" onClick={onRetry}>{t.retryHonest}</button>}
        lines={[
          `key seen by the client: ${outcome.seenKey}`,
          `verdict: ${outcome.keyVerdict.status}: ${outcome.keyVerdict.detail}`,
          `log source: ${outcome.logSource}, entries in window: ${outcome.entriesInWindow}`,
          `attested model key (for comparison): ${outcome.deployment.models.map((m) => m.signer.signingAddress).join(', ')}`,
        ]}
      />
    );
  }
  if (outcome.kind === 'non-tee') {
    return (
      <RedCard
        title={t.nonTeeTitle}
        body={t.nonTeeBody}
        lines={[
          `model: ${outcome.model}`,
          `signature_kind: ${outcome.signature.kind} (signer ${short(outcome.signature.signer.signingAddress)} = gateway ${short(outcome.gateway.signer.signingAddress)})`,
          `gateway TCB: ${outcome.gateway.tcbStatus}`,
          `completion: ${outcome.exchange.completionId}`,
          'transport: plaintext through our proxy and the gateway (no model key to encrypt to)',
        ]}
      />
    );
  }

  const { proof, deployment, modelAttestation: m, logEntry, keyVerdict, exchange, report, logSource } = outcome;
  const composeHash = composeHashOf(m.deployment);
  const since = observedUtc(logEntry.observed_at).slice(0, 10);
  const commit = proof.commit ?? '';
  const chainText = { pending: t.chainCommitting, depositing: t.chainDepositing(DEPOSIT_NEAR), 'no-wallet': t.chainNoWallet, 'no-deposit': t.chainNoDeposit, 'not-deployed': t.chainPending, failed: t.chainFailed, committed: t.chainCommittedElsewhere }[outcome.commit];
  const hint = (key: keyof typeof t.hints) => (explain ? t.hints[key] : undefined);
  const disclose = () => downloadJson(`ainek-proof-${proof.completionId}.json`, toDisclosure({ proof, logEntry, requestBody: exchange.requestBody, responseBody: exchange.responseBody }));

  return (
    <section className="card">
      <CardHead status="ok" when={utcMinute(exchange.sentAt)}>{t.cardVerified}</CardHead>
      <Row status="ok" label={t.rowModel} hint={hint('model')}>{proof.model}, {t.attested} (compose {short(composeHash)})</Row>
      <Row status="ok" label={t.rowHardware} hint={hint('hardware')}>Intel TDX {m.tcbStatus}, NVIDIA GPU {m.gpuEvidence} ({deployment.tookMs === 0 ? t.cached : `${t.checkedInBrowser}, ${seconds(deployment.tookMs)}`})</Row>
      <Row status="ok" label={t.rowKey} hint={hint('key')}>{t.keyLine(logEntry.index, keyVerdict.confirmedBy.join(', '), since)}{logSource === 'sample' ? ` (${t.sampleEntry})` : ''}{normalizeHex(logEntry.compose_hash) === composeHash ? '' : ` (${t.otherCompose})`}</Row>
      <Row status="ok" label={t.rowHashes} hint={hint('hashes')}>{t.hashesOk}</Row>
      <Row status="ok" label={t.rowE2ee} hint={hint('e2ee')}>{t.e2eeYes}</Row>
      <Row status={proof.commitTx || outcome.commit === 'committed' ? 'ok' : 'skipped'} label={t.rowChain} hint={hint(proof.commitTx || outcome.commit === 'committed' ? 'chain' : 'chainPending')}>
        {proof.commitTx ? (
          <>{t.chainTx(short(commit))} <a href={explorerTxUrl(cfg.explorer, proof.commitTx)} target="_blank" rel="noreferrer">{short(proof.commitTx)}</a> <CopyButton text={proof.commitTx} /></>
        ) : (
          <>{chainText} (commit {short(commit)}) <CopyButton text={commit} /></>
        )}
        {onCommit && canCommitNow(outcome.commit) && (
          <>
            {' '}
            <button type="button" className="btn small" onClick={() => onCommit(outcome)}>{commitLabel(t, commitAction(outcome.commit, !!signedAccountId))}</button>
          </>
        )}
      </Row>
      <p className="small hint-line"><button type="button" className="linklike" onClick={() => setExplain((v) => !v)}>{explain ? t.hideRows : t.explainRows}</button></p>
      <div className="actions">
        <Link className="btn" href={`/verify?id=${encodeURIComponent(proof.completionId)}`}>{t.reverify}</Link>
        <a className="btn" href={vcUrl} target="_blank" rel="noreferrer">{t.openVc}</a>
        <button type="button" className="btn" onClick={disclose}>{t.disclose}</button>
      </div>
      <p className="muted small">{fill(t.discloseHint, { auditor: <Link href="/auditor">/auditor</Link> })}</p>
      <details>
        <summary>{t.details}</summary>
        <CheckList items={report.checks} />
        <pre className="mono small" lang="en">{JSON.stringify({ ...proof, salt: '(kept on this device)' }, null, 2)}</pre>
      </details>
    </section>
  );
});
