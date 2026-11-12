'use client';
// The public key log as the client sees it: who logged which key for which model, and whether two trusted
// verifiers disagree (split view). Wallet login here asks for the function-call key later used for commit_proof.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNearWallet, type NearContextValue } from 'near-connect-hooks';
import { ANY_AGE_NS, LOG_WINDOW_NS, latestKeysFor, deploymentStanding, deploymentsSeen, findSplitView, releaseRuleOf, type KeyEntry, type SeenDeployment } from '@ainek/proof';
import { RedCard } from '@/components/red-card';
import { ReleaseRow } from '@/components/release-row';
import { StackTable, type Column } from '@/components/stack-table';
import { TrustPanel } from '@/components/trust-panel';
import { describeError } from '@/lib/errors';
import { fill } from '@/lib/fill';
import { hoursSince, observedUtc, short, utcMinuteOf } from '@/lib/format';
import { keyLogFor } from '@/lib/key-log';
import { chatModelOf, verifyDeployment } from '@/lib/nearai-browser';
import { useConfig, useT, useTrust } from '../providers';

type AccessKeyInfo = Awaited<ReturnType<NearContextValue['getAccessKeyList']>>['keys'][number];

const WINDOW_HOURS = Number(LOG_WINDOW_NS) / 3_600_000_000_000;

interface LogWindow {
  entries: KeyEntry[];
  /** The latest entries for the model regardless of age (the contract returns at most 100), for the deployments list and to say how stale an empty window is: undefined while that read is in flight, null when it failed. */
  all?: KeyEntry[] | null;
}

export default function LogPage() {
  const cfg = useConfig();
  const { trust } = useTrust();
  const { t } = useT();
  const tl = t.log;
  const [log, setLog] = useState<LogWindow | null>(null);
  const [error, setError] = useState('');
  /** Null until the contract answers: an unanswered view must not read as "nobody is registered". */
  const [registered, setRegistered] = useState<string[] | null>(null);
  const { signedAccountId, getAccessKeyList } = useNearWallet();
  const [keys, setKeys] = useState<AccessKeyInfo[]>([]);

  // The verifiers you trust are read one by one as well as in the general window (latestKeysFor in @ainek/proof), so the
  // page shows what the chat's check will see even when another registered verifier wrote the newest 100 entries.
  const trustedKey = trust.verifiers.join(',');
  useEffect(() => {
    const reader = keyLogFor(cfg);
    const verifiers = trustedKey ? trustedKey.split(',') : [];
    // A window read for another trust set is not this one's: it goes off the screen until the new answer is in, and the
    // reads still in flight for it are stopped (their answers must not replace a newer one, nor keep loading the RPC).
    const stop = new AbortController();
    const current = () => !stop.signal.aborted;
    setLog(null);
    setError('');
    void (async () => {
      try {
        const entries = await latestKeysFor(reader, cfg.model, verifiers, undefined, stop.signal);
        if (!current()) return;
        setLog({ entries });
        // The wider read only adds to the page, so it waits its turn: together the two would double the burst on the RPC.
        const all = await latestKeysFor(reader, cfg.model, verifiers, ANY_AGE_NS, stop.signal).catch(() => null);
        if (current()) setLog({ entries, all });
      } catch (e) {
        if (current()) setError(describeError(e));
      }
    })();
    reader.verifiers().then((v) => current() && setRegistered(v)).catch(() => undefined); // only widens the list of choices: without it the log's own verifiers are still there
    return () => stop.abort();
  }, [cfg, trustedKey]);

  useEffect(() => {
    if (!signedAccountId) {
      setKeys([]);
      return;
    }
    getAccessKeyList(signedAccountId).then((r) => setKeys(r.keys)).catch(() => setKeys([]));
    // getAccessKeyList is rebuilt on every provider render; the account id is the only real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedAccountId]);

  const split = log ? findSplitView(log.entries, cfg.model, trust.verifiers) : null;
  const newest = log?.all?.[0];
  const td = tl.deployments;
  // The report the chat would use, verified now and not taken from the chat's cache of up to an hour: the key-log line
  // under the release check speaks for the moment of the attestation.
  const attestNow = useCallback(async () => {
    const report = chatModelOf(await verifyDeployment(cfg.model, { acceptedTcbStatuses: cfg.acceptedTcbStatuses }, true));
    if (!report) throw new Error('no model attestation returned');
    return report;
  }, [cfg.model, cfg.acceptedTcbStatuses]);
  // The release rule (SPEC §7.5) on the entries this page read: shown under the release check, enforced only by the chat.
  // Null while the page has no read of the log, so that the line says so and does not go missing.
  const { requireLoggedDeployment, releaseWaitMs, requireLoggedRelease } = cfg;
  const entries = log?.entries;
  const keyLog = useMemo(
    () => (entries ? { entries, trust, rule: releaseRuleOf({ requireLoggedDeployment, releaseWaitMs }), enforced: requireLoggedRelease } : null),
    [entries, trust, requireLoggedDeployment, releaseWaitMs, requireLoggedRelease],
  );
  const deployments = useMemo(() => deploymentsSeen(log?.all ?? [], cfg.model), [log?.all, cfg.model]);
  // The chat's own rule per deployment (deploymentStanding in @ainek/proof), once per answer from the log or change of the trust set.
  const standing = useMemo(() => new Map(deployments.map((d) => [d.composeHash, deploymentStanding(log?.entries ?? [], d, { model: cfg.model, trustedVerifiers: trust.verifiers, quorum: trust.quorum })])), [deployments, log?.entries, cfg.model, trust]);
  const deploymentColumns: Column<SeenDeployment>[] = [
    { label: td.columns.compose, cell: (d) => short(d.composeHash), className: 'mono' },
    { label: td.columns.keys, cell: (d) => d.keys.map(short).join(', '), className: 'mono' },
    { label: td.columns.verifiers, cell: (d) => d.verifiers.join(', '), className: 'mono' },
    { label: td.columns.entries, cell: (d) => d.entries },
    { label: td.columns.first, cell: (d) => utcMinuteOf(d.firstSeenMs) },
    { label: td.columns.last, cell: (d) => utcMinuteOf(d.lastSeenMs) },
    { label: td.columns.counts, cell: (d) => td.counts[standing.get(d.composeHash) ?? 'untrusted'] },
  ];
  const c = tl.columns;
  const columns: Column<KeyEntry>[] = [
    { label: c.index, cell: (e) => e.index },
    { label: c.model, cell: (e) => e.model, className: 'mono' },
    { label: c.verifier, cell: (e) => (trust.verifiers.includes(e.verifier) ? e.verifier : `${e.verifier} ${tl.notTrusted}`), className: 'mono' },
    { label: c.key, cell: (e) => short(e.signing_address), className: 'mono' },
    { label: c.compose, cell: (e) => short(e.compose_hash), className: 'mono' },
    { label: c.tcb, cell: (e) => e.tcb_status },
    { label: c.observed, cell: (e) => observedUtc(e.observed_at) },
  ];

  return (
    <main className="page">
      <h1>{tl.title}</h1>
      <p className="muted">
        {fill(tl.intro(cfg.network), { contract: <span className="mono">{cfg.contract}</span> })}
        {cfg.logSource === 'sample' && ` ${tl.sampleNote}`}
      </p>
      {error && <RedCard title={error} />}
      {split && <RedCard title={tl.split} body={split.detail} />}
      {log && (log.entries.length === 0 ? (
        <section className="card">
          <h3>{tl.emptyTitle(WINDOW_HOURS, cfg.model)}</h3>
          <p>
            {tl.emptyBody}
            {log.all != null && ` ${newest ? tl.newest(newest.index, newest.verifier, observedUtc(newest.observed_at), hoursSince(newest.observed_at)) : tl.none}`}
          </p>
        </section>
      ) : (
        <StackTable columns={columns} rows={log.entries} rowKey={(e) => String(e.index)} />
      ))}

      {log?.all === null && <p className="muted small">{td.unavailable}</p>}
      {log?.all && deployments.length > 0 && (
        <section>
          <h2>{td.title}</h2>
          <p className="muted small">{td.intro} {cfg.requireLoggedDeployment ? td.enforced.on : td.enforced.off}</p>
          <StackTable columns={deploymentColumns} rows={deployments} rowKey={(d) => d.composeHash} />
          <p className="muted small">{td.scope(log.all.length)}</p>
        </section>
      )}

      <section>
        <h2>{tl.code.title}</h2>
        <p className="muted small">{tl.code.intro}</p>
        <div className="card">
          <ReleaseRow attest={attestNow} model={cfg.model} history keyLog={keyLog} />
        </div>
      </section>

      <TrustPanel entries={log?.entries ?? null} registered={registered} />

      <h2>{tl.wallet}</h2>
      <p className="muted small">{fill(tl.walletNote, { method: <span className="mono">commit_proof</span> })}</p>
      {signedAccountId ? (
        <>
          <p>{tl.connectedAs} <span className="mono">{signedAccountId}</span></p>
          <details>
            <summary>{tl.accessKeys(keys.length)}</summary>
            <ul className="mono">
              {keys.map((k) => {
                const p = k.access_key.permission;
                const fc = typeof p === 'object' && p !== null && 'FunctionCall' in p ? p.FunctionCall : null;
                return <li key={k.public_key}>{k.public_key.slice(0, 20)}… · {fc ? `FunctionCall on ${fc.receiver_id}, methods [${fc.method_names.join(', ') || 'all'}]` : 'FullAccess'}</li>;
              })}
            </ul>
          </details>
        </>
      ) : (
        <p className="muted">{tl.noWallet}</p>
      )}
    </main>
  );
}
