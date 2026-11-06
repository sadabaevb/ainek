'use client';
// An action proof on /verify: checked against the contract's record and, in this browser, against the run's Intel-signed attestation.
import { useEffect, useState } from 'react';
import { checkActionProof, quoteVerifierOf, type ActionReport, type ActionVerdict } from '@ainek/proof';
import { useConfig, useT } from '@/app/providers';
import { describeError } from '@/lib/errors';
import { explorerTxUrl } from '@/lib/links';
import { CardHead, CheckList } from './checks';
import { RedCard } from './red-card';

export function ActionProofCard({ value }: { value: unknown }) {
  const cfg = useConfig();
  const { t } = useT();
  const tv = t.verify;
  const [report, setReport] = useState<(ActionReport & { verdict: ActionVerdict }) | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setError('');
    checkActionProof(value, {
      rpcUrl: cfg.rpcUrl,
      contract: cfg.contract,
      apiUrl: cfg.outlayerApiUrl,
      project: cfg.policyProject,
      wasmHash: cfg.policyWasmHash,
      network: cfg.network,
      loadQuoteVerifier: async () => quoteVerifierOf((await import('@phala/dcap-qvl')).verify),
    })
      .then((r) => { if (!cancelled) setReport(r); })
      .catch((e: unknown) => { if (!cancelled) setError(describeError(e)); });
    return () => {
      cancelled = true;
    };
  }, [value, cfg]);

  if (error) return <RedCard title={error} />;
  if (!report) return <p className="muted">{tv.checking}</p>;
  const title = { verified: tv.actionOk, failed: tv.actionFailed, unchecked: tv.actionUnchecked }[report.verdict];
  return (
    <section className="card">
      <CardHead status={report.verdict === 'verified' ? 'ok' : 'fail'} when={tv.actionSource}>{title}</CardHead>
      <CheckList items={report.checks} />
      {report.proof && (
        <div className="actions">
          <a className="btn" href={explorerTxUrl(cfg.explorer, report.proof.proposeTx)} target="_blank" rel="noreferrer">{tv.proposeTx}</a>
          {report.verdict === 'verified' && <a className="btn" href={report.proof.attestationUrl} target="_blank" rel="noreferrer">{tv.attestation}</a>}
        </div>
      )}
    </section>
  );
}
