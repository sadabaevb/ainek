'use client';
// The card a person sees after each reply (SPEC §5.3): one line per guarantee, ✓/✗/—, red states in their own design.
import Link from 'next/link';
import { memo, useMemo, type ReactNode } from 'react';
import { toDisclosure } from '@ainek/proof';
import { useConfig, useT } from '@/app/providers';
import { STEPS_AFTER_SEND, canCommitNow, type ChatOutcome, type VerifiedOutcome } from '@/lib/flow';
import { downloadJson } from '@/lib/encoding';
import { seconds, short } from '@/lib/format';
import { explorerTxUrl, verificationCenterUrl } from '@/lib/links';
import { CheckList, Row } from './checks';

function RedCard({ title, body, lines }: { title: string; body?: string; lines: ReactNode[] }) {
  const { t } = useT();
  return (
    <section className="card red">
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      <details>
        <summary>{t.details}</summary>
        <ul className="mono">{lines.map((line, i) => <li key={i}>{line}</li>)}</ul>
      </details>
    </section>
  );
}

export const ProofCard = memo(function ProofCard({ outcome, onCommit }: { outcome: ChatOutcome; onCommit?: (outcome: VerifiedOutcome) => void }) {
  const { t } = useT();
  const cfg = useConfig();
  const vcUrl = useMemo(() => (outcome.kind === 'verified' ? verificationCenterUrl(outcome.proof) : ''), [outcome]);

  if (outcome.kind === 'failed') {
    const afterSend = STEPS_AFTER_SEND.has(outcome.step);
    return <RedCard title={afterSend ? t.failedAfterSendTitle : t.failedTitle} {...(afterSend ? { body: t.failedAfterSendBody } : {})} lines={[`${outcome.step}: ${outcome.reason}`]} />;
  }
  if (outcome.kind === 'refused') {
    return (
      <RedCard
        title={t.refusedTitle}
        body={t.refusedBody}
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
  const composeHash = m.deployment.runtimeMeasurements.composeHash ?? logEntry.compose_hash;
  const since = new Date(Number(logEntry.observed_at)).toISOString().slice(0, 10);
  const commitShort = short(proof.commit ?? '');
  const chainText = { pending: t.chainCommitting, 'no-wallet': t.chainNoWallet, 'not-deployed': t.chainPending, failed: t.chainFailed, committed: '' }[outcome.commit];
  const disclose = () => downloadJson(`ainek-proof-${proof.completionId}.json`, toDisclosure({ proof, logEntry, requestBody: exchange.requestBody, responseBody: exchange.responseBody }));

  return (
    <section className="card">
      <h3>{t.card}</h3>
      <Row status="ok" label={t.rowModel}>{proof.model}, {t.attested} (compose {short(composeHash)})</Row>
      <Row status="ok" label={t.rowHardware}>Intel TDX {m.tcbStatus}, NVIDIA GPU {m.gpuEvidence} ({deployment.tookMs === 0 ? t.cached : `${t.checkedInBrowser}, ${seconds(deployment.tookMs)}`})</Row>
      <Row status="ok" label={t.rowKey}>{t.keyLine(logEntry.index, keyVerdict.confirmedBy.join(', '), since)}{logSource === 'sample' ? ` (${t.sampleEntry})` : ''}</Row>
      <Row status="ok" label={t.rowHashes}>{t.hashesOk}</Row>
      <Row status="ok" label={t.rowE2ee}>{t.e2eeYes}</Row>
      <Row status={proof.commitTx ? 'ok' : 'skipped'} label={t.rowChain}>
        {proof.commitTx ? (
          <>{t.chainTx(commitShort)} <a href={explorerTxUrl(cfg.explorer, proof.commitTx)} target="_blank" rel="noreferrer">{short(proof.commitTx)}</a></>
        ) : (
          `${chainText} (commit ${commitShort})`
        )}
        {onCommit && canCommitNow(outcome.commit) && (
          <>
            {' '}
            <button type="button" className="btn small" onClick={() => onCommit(outcome)}>{outcome.commit === 'no-wallet' ? t.commitConnect : t.commitRetry}</button>
          </>
        )}
      </Row>
      <div className="actions">
        <Link className="btn" href={`/verify?id=${encodeURIComponent(proof.completionId)}`}>{t.reverify}</Link>
        <a className="btn" href={vcUrl} target="_blank" rel="noreferrer">{t.openVc}</a>
        <button type="button" className="btn" onClick={disclose}>{t.disclose}</button>
      </div>
      <details>
        <summary>{t.details}</summary>
        <CheckList items={report.checks} />
        <pre className="mono small">{JSON.stringify({ ...proof, salt: '(kept on this device)' }, null, 2)}</pre>
      </details>
    </section>
  );
});
