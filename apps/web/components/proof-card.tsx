'use client';
// The card a person sees after each reply (SPEC §5.3): one line per guarantee, ✓/✗/—, red states in their own design.
import Link from 'next/link';
import type { ChatOutcome } from '@/lib/flow';
import type { Dict } from '@/lib/i18n';
import { base64, base64url, downloadJson } from '@/lib/encoding';

const OK = '✓';
const FAIL = '✗';
const NA = '—';

function short(hex: string): string {
  return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
}

function Row({ mark, label, children }: { mark: string; label: string; children: React.ReactNode }) {
  const tone = mark === OK ? 'ok' : mark === FAIL ? 'fail' : 'na';
  return (
    <div className={`row ${tone}`}>
      <span className="mark" aria-hidden>{mark}</span>
      <span className="label">{label}</span>
      <span className="value">{children}</span>
    </div>
  );
}

export function ProofCard({ outcome, t }: { outcome: ChatOutcome; t: Dict }) {
  if (outcome.kind === 'failed') {
    return (
      <section className="card red">
        <h3>{t.failedTitle}</h3>
        <p className="mono">{outcome.step}: {outcome.reason}</p>
      </section>
    );
  }
  if (outcome.kind === 'refused') {
    const seen = outcome.seenKey;
    return (
      <section className="card red">
        <h3>{t.refusedTitle}</h3>
        <p>{t.refusedBody}</p>
        <details>
          <summary>{t.details}</summary>
          <ul className="mono">
            <li>key seen by the client: {seen}</li>
            <li>verdict: {outcome.keyVerdict.status}: {outcome.keyVerdict.detail}</li>
            <li>log source: {outcome.keyLog.source}, entries in window: {outcome.keyLog.entries.length}</li>
            <li>attested model key (for comparison): {outcome.deployment.models.map((m) => m.signer.signingAddress).join(', ')}</li>
          </ul>
        </details>
      </section>
    );
  }
  if (outcome.kind === 'non-tee') {
    return (
      <section className="card red">
        <h3>{t.nonTeeTitle}</h3>
        <p>{t.nonTeeBody}</p>
        <details>
          <summary>{t.details}</summary>
          <ul className="mono">
            <li>model: {outcome.model}</li>
            <li>signature_kind: {outcome.signature.kind} (signer {short(outcome.signature.signer.signingAddress)} = gateway {short(outcome.gateway.signer.signingAddress)})</li>
            <li>gateway TCB: {outcome.gateway.tcbStatus}</li>
            <li>completion: {outcome.exchange.completionId}</li>
          </ul>
        </details>
      </section>
    );
  }

  const { proof, deployment, logEntry, keyVerdict, exchange, report, keyLog } = outcome;
  const m = deployment.models.find((x) => x.signer.signingAddress.toLowerCase() === proof.signingAddress.toLowerCase()) ?? deployment.models[0];
  const composeHash = m?.deployment.runtimeMeasurements.composeHash ?? logEntry.compose_hash;
  const since = new Date(Number(logEntry.observed_at)).toISOString().slice(0, 10);
  const receipt = base64url(JSON.stringify({
    completionId: proof.completionId, model: proof.model, signatureKind: proof.signatureKind, signingAlgo: proof.signingAlgo,
    signingAddress: proof.signingAddress, signedText: proof.signedText, signature: proof.signature, verifiedAt: proof.verifiedAt,
  }));
  const vcUrl = `https://cloud.near.ai/verify?model=${encodeURIComponent(proof.model)}#receipt=${receipt}`;
  const hashesOk = report.checks.filter((c) => ['request-hash', 'response-hash', 'signature', 'signed-text'].includes(c.id)).every((c) => c.status === 'ok');

  function disclose() {
    downloadJson(`ainek-proof-${proof.completionId}.json`, {
      _note: 'Selective disclosure: this file lets an auditor recompute the hashes and the salted commit of ONE exchange. The raw bytes are the E2EE ciphertext as sent/received; the plaintext is not included.',
      proof,
      logEntry,
      rawRequestBase64: base64(exchange.requestBody),
      rawResponseBase64: base64(exchange.responseBody),
      disclosedAt: new Date().toISOString(),
    });
  }

  return (
    <section className="card">
      <h3>{t.card}</h3>
      <Row mark={OK} label={t.rowModel}>{proof.model}, {t.attested} (compose {short(composeHash)})</Row>
      <Row mark={OK} label={t.rowHardware}>Intel TDX {m?.tcbStatus ?? '?'}, NVIDIA GPU {m?.gpuEvidence ?? '?'} ({deployment.tookMs === 0 ? t.cached : `${t.checkedInBrowser}, ${(deployment.tookMs / 1000).toFixed(1)} s`})</Row>
      <Row mark={OK} label={t.rowKey}>{t.keyLine(logEntry.index, keyVerdict.confirmedBy.join(', '), since)}{keyLog.source === 'sample' ? ` (${t.sampleEntry})` : ''}</Row>
      <Row mark={hashesOk ? OK : FAIL} label={t.rowHashes}>{t.hashesOk}</Row>
      <Row mark={OK} label={t.rowE2ee}>{t.e2eeYes}</Row>
      <Row mark={proof.commitTx ? OK : NA} label={t.rowChain}>{proof.commitTx ? t.chainTx(short(proof.commit ?? '')) : `${t.chainPending} (commit ${short(proof.commit ?? '')})`}</Row>
      <div className="actions">
        <Link className="btn" href={`/verify?id=${encodeURIComponent(proof.completionId)}`}>{t.reverify}</Link>
        <a className="btn" href={vcUrl} target="_blank" rel="noreferrer">{t.openVc}</a>
        <button type="button" className="btn" onClick={disclose}>{t.disclose}</button>
      </div>
      <details>
        <summary>{t.details}</summary>
        <ul className="mono">
          {report.checks.map((c) => (
            <li key={c.id}>{c.status === 'ok' ? OK : c.status === 'fail' ? FAIL : NA} {c.id}: {c.detail}</li>
          ))}
        </ul>
        <pre className="mono small">{JSON.stringify({ ...proof, salt: '(kept on this device)' }, null, 2)}</pre>
      </details>
    </section>
  );
}
