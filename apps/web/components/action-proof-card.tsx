'use client';
// An action proof on /verify: checked against the contract's record and, in this browser, against the run's Intel-signed attestation.
import { useEffect, useState } from 'react';
import { actionRunChecks, quoteVerifierOf, verifyActionProofOnChain, type ActionReport } from '@ainek/proof';
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
    (async () => {
      const onChain = await verifyActionProofOnChain(value, { rpcUrl: cfg.rpcUrl, contract: cfg.contract, wasmHash: cfg.policyWasmHash });
      if (!onChain.proof || !onChain.ok) return onChain; // no point in asking Intel about a proof that already failed
      const { verify } = await import('@phala/dcap-qvl'); // the library is large: only this card needs it on this page
      const run = await actionRunChecks(onChain.proof, { apiUrl: cfg.outlayerApiUrl, project: cfg.policyProject, wasmHash: cfg.policyWasmHash, rpcUrl: cfg.rpcUrl, network: cfg.network, verifyQuote: quoteVerifierOf(verify) });
      const checks = [...onChain.checks, ...run];
      return { ...onChain, checks, ok: !checks.some((c) => c.status === 'fail') };
    })()
      .then((r) => { if (!cancelled) setReport(r); })
      .catch((e: unknown) => { if (!cancelled) setError(describeError(e)); });
    return () => {
      cancelled = true;
    };
  }, [value, cfg]);

  if (error) return <RedCard title={error} />;
  if (!report) return <p className="muted">{tv.checking}</p>;
  return (
    <section className="card">
      <CardHead status={report.ok ? 'ok' : 'fail'} when={tv.actionSource}>{report.ok ? tv.actionOk : tv.actionFailed}</CardHead>
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
