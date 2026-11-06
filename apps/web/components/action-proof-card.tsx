'use client';
// An action proof on /verify: checked against the contract's record and, in this browser, against the run's Intel-signed attestation.
import { useEffect, useState } from 'react';
import { checkActionProof, quoteVerifierOf, type ActionReport } from '@ainek/proof';
import { useConfig, useT } from '@/app/providers';
import { describeError } from '@/lib/errors';
import { explorerTxUrl } from '@/lib/links';
import { CardHead, CheckList } from './checks';
import { RedCard } from './red-card';

export function ActionProofCard({ value }: { value: unknown }) {
  const cfg = useConfig();
  const { t } = useT();
  const tv = t.verify;
  const [report, setReport] = useState<ActionReport | null>(null);
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
  // A skipped attestation must not read as verified: the card stays green only when Intel was really asked about this run.
  const runChecked = report.checks.some((c) => c.id === 'run-binding' && c.status === 'ok');
  return (
    <section className="card">
      <CardHead status={report.ok && runChecked ? 'ok' : 'fail'} when={tv.actionSource}>{!report.ok ? tv.actionFailed : runChecked ? tv.actionOk : tv.actionUnchecked}</CardHead>
      <CheckList items={report.checks} />
      {report.proof && (
        <div className="actions">
          <a className="btn" href={explorerTxUrl(cfg.explorer, report.proof.proposeTx)} target="_blank" rel="noreferrer">{tv.proposeTx}</a>
          <a className="btn" href={report.proof.attestationUrl} target="_blank" rel="noreferrer">{tv.attestation}</a>
        </div>
      )}
    </section>
  );
}
