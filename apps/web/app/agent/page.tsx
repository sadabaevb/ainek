'use client';
// The third question, "did the agent do only what it was allowed to?", as a page anyone can open (SPEC §4.3, §7.2). Everything
// comes from the contract's views and the agent account's access keys over public RPC; each record is re-checked in this browser
// with the code `pnpm -F demo check-agent` runs. The owner can approve or reject a waiting action here: the page only builds the
// call, the wallet signs it with a full-access key. The page follows the chain while it is open, so an action the bot proposes appears by itself.
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNearWallet } from 'near-connect-hooks';
import { checkActionRecord, decidedAtMs, decidedUnderCurrentPolicy, oneLine, readProofCommit, type ActionRecord, type Check, type ProofCommitLookup } from '@ainek/proof';
import sampleAction from '../../../../docs/samples/action-proof.sample.json';
import { CheckList, Row, mark, type Status } from '@/components/checks';
import { RedCard } from '@/components/red-card';
import { describeError } from '@/lib/errors';
import { fill } from '@/lib/fill';
import { short, utcMinute } from '@/lib/format';
import { amountText, ledgerMoved, loadLedger, type AgentState, type Ledger } from '@/lib/ledger';
import { explorerAccountUrl, explorerTxUrl } from '@/lib/links';
import { errorText, isDialogClosed, ownerDecide, plainLogin } from '@/lib/wallet';
import { useConfig, useT } from '../providers';

const POLL_MS = 10_000;
const DAY_MS = 86_400_000;

/** The model proof commit of a record, or why it could not be looked up: a failed read must not leave a row "checking" forever. */
type CommitState = ProofCommitLookup | { status: 'failed'; detail: string };
type Decided = { method: 'approve' | 'reject'; tx: string };

const commitKey = (r: ActionRecord): string => `${r.agent_id}/${r.decision.model_proof_commit}`;

function checksOf(record: ActionRecord, commit: CommitState): Check[] {
  if (commit.status !== 'failed') return checkActionRecord(record, commit);
  return [...checkActionRecord(record, { status: 'not-deployed' }).slice(0, -1), { id: 'model-commit-on-chain', status: 'skipped', detail: `lookup failed: ${commit.detail}` }];
}

const worst = (checks: Check[] | null): Status => (!checks ? 'running' : checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'skipped') ? 'skipped' : 'ok');

/** The ledger, re-read when `reload` is called or when the chain moved while the tab is visible. A failed re-read keeps the last good one on screen. */
function useLedger() {
  const cfg = useConfig();
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    loadLedger(cfg, ctl.signal)
      .then((next) => {
        setLedger(next);
        setError('');
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(describeError(e));
      });
    return () => ctl.abort();
  }, [cfg, version]);

  useEffect(() => {
    if (!ledger) return;
    const ctl = new AbortController();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      ledgerMoved(cfg, ledger, ctl.signal)
        .then((moved) => {
          if (moved) setVersion((v) => v + 1);
        })
        .catch(() => undefined); // a missed look is repeated ten seconds later
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      ctl.abort();
    };
  }, [cfg, ledger]);

  return { ledger, error, reload: () => setVersion((v) => v + 1) };
}

/** `proof_commit` for the model proof each record names. A commit that was found stays found, so it is asked once per page. */
function useModelCommits(ledger: Ledger | null): Record<string, CommitState> {
  const cfg = useConfig();
  const [commits, setCommits] = useState<Record<string, CommitState>>({});
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const record of ledger?.records ?? []) {
      const key = commitKey(record);
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      readProofCommit(cfg.rpcUrl, cfg.contract, record.agent_id, record.decision.model_proof_commit)
        .catch((e: unknown): CommitState => ({ status: 'failed', detail: describeError(e) }))
        .then((commit) => setCommits((prev) => ({ ...prev, [key]: commit })));
    }
  }, [cfg, ledger]);
  return commits;
}

function AccountLink({ account }: { account: string }) {
  const cfg = useConfig();
  return <a className="mono" href={explorerAccountUrl(cfg.explorer, account)} target="_blank" rel="noreferrer">{account}</a>;
}

function AgentCard({ agent, ledger }: { agent: AgentState; ledger: Ledger }) {
  const cfg = useConfig();
  const ta = useT().t.agent;
  const { info, keys, funds } = agent;
  const amount = (units: string) => (info ? amountText(units, info.token_id, ledger.tokens) : units);
  const scoped = keys.functionCall;
  const state = info?.paused ? (scoped.length === 0 ? 'stopped' : 'paused') : scoped.length === 0 ? 'noKey' : 'running';
  return (
    <section className="card agent-card">
      <h3><AccountLink account={agent.id} /></h3>
      {!info ? (
        <p className="muted">{ta.notRegistered}</p>
      ) : (
        <>
          <Row status={state === 'running' ? 'ok' : 'skipped'} label={ta.rowState}>{ta.state[state]}</Row>
          <Row status={scoped.length === 0 ? 'skipped' : scoped.every((k) => k.problem === null) ? 'ok' : 'fail'} label={ta.rowKey} hint={keys.fullAccess > 0 ? ta.fullAccessNote(keys.fullAccess) : undefined}>
            {scoped.length === 0
              ? ta.keyNone
              : scoped.map((k) => {
                  const key = `${k.publicKey.slice(0, 16)}…`;
                  return <span key={k.publicKey} className="line">{k.problem === null ? ta.keyOk(key, k.methods.join(', ')) : ta.keyBad(key, k.problem)}</span>;
                })}
          </Row>
          {funds && <Row status={funds.onAgent === '0' ? 'ok' : 'fail'} label={ta.rowFunds}>{ta.funds(amount(funds.inContract), amount(funds.onAgent))}</Row>}
          <Row status="skipped" label={ta.rowPolicy}>{ta.policy(short(info.policy_hash), info.policy_version)}</Row>
          <Row status="skipped" label={ta.rowDecisionKey}>{fill(ta.decisionKey(short(info.tee_pubkey)), { verify: <Link href="/verify?sample=action">{ta.verifyLink}</Link> })}</Row>
          <Row status="skipped" label={ta.rowSpent}>{ta.spent(amount(info.spent_today))}</Row>
          <Row status="skipped" label={ta.rowOwner}>
            <AccountLink account={ledger.owner} />{ledger.owner === cfg.contract && ` (${ta.ownerIsContract})`}: {ta.ownerLine}
          </Row>
        </>
      )}
    </section>
  );
}

/** What stops an approval before the wallet is asked. The contract enforces each of these; saying so here saves the owner a refused transaction. */
function approvalBlock(record: ActionRecord, agent: AgentState | undefined): 'paused' | 'earlierDay' | 'replaced' | null {
  if (agent?.info?.paused) return 'paused';
  if (record.day !== Math.floor(Date.now() / DAY_MS)) return 'earlierDay';
  if (agent?.info && !decidedUnderCurrentPolicy(record, agent.info)) return 'replaced';
  return null;
}

function Pending({ records, ledger, commits, onDecided }: { records: ActionRecord[]; ledger: Ledger; commits: Record<string, CommitState>; onDecided: (actionId: number, decided: Decided) => void }) {
  const cfg = useConfig();
  const ta = useT().t.agent;
  const { signedAccountId, signIn, callFunctionRaw } = useNearWallet();
  const [busy, setBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState('');
  const isOwner = signedAccountId === ledger.owner;

  const decide = (record: ActionRecord, method: Decided['method']) => {
    setBusy(record.action_id);
    setFailed('');
    ownerDecide(callFunctionRaw, cfg, method, record.action_id)
      .then((tx) => onDecided(record.action_id, { method, tx }))
      .catch((e: unknown) => {
        if (!isDialogClosed(e)) setFailed(errorText(e));
      })
      .finally(() => setBusy(null));
  };
  const connect = () => {
    setFailed('');
    plainLogin(signIn).catch((e: unknown) => {
      if (!isDialogClosed(e)) setFailed(errorText(e));
    });
  };

  return (
    <section className="pending">
      <h2>{ta.pendingTitle(records.length)}</h2>
      <p className="muted">{ta.pendingBody}</p>
      {!signedAccountId ? (
        <p className="small">
          <button type="button" className="btn small" onClick={connect}>{ta.connectOwner}</button> <span className="muted">{ta.ownerOnly(ledger.owner)} {ta.connectOwnerNote}</span>
        </p>
      ) : (
        !isOwner && <p className="muted small">{ta.notOwner(signedAccountId, ledger.owner)}</p>
      )}
      {failed && <RedCard title={ta.decideFailed(failed)} />}
      {records.map((record) => {
        const block = approvalBlock(record, ledger.agents.find((a) => a.id === record.agent_id));
        // `approve` names only an id, so what the owner signs for is what the contract holds, re-checked here before the wallet opens.
        const commit = commits[commitKey(record)];
        const status = worst(commit ? checksOf(record, commit) : null);
        return (
          <div key={record.action_id} className="card">
            <ActionLine record={record} ledger={ledger} status={status} note={ta.checked[status]} />
            {block && <p className="muted small">{ta.blocked[block]}</p>}
            {isOwner && (
              <div className="actions">
                <button type="button" className="btn primary" disabled={busy !== null || block !== null} onClick={() => decide(record, 'approve')}>{ta.approve}</button>
                <button type="button" className="btn" disabled={busy !== null} onClick={() => decide(record, 'reject')}>{ta.reject}</button>
                {busy === record.action_id && <span className="muted small">{ta.deciding}</span>}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** One action in three lines: what happened, the payment, when and how it checks out. Spans only, so it can sit in a <summary>. The memo is the agent's text, so it is flattened and isolated. */
function ActionLine({ record, ledger, status, note }: { record: ActionRecord; ledger: Ledger; status: Status; note?: string }) {
  const ta = useT().t.agent;
  const { action, decision } = record;
  const memo = oneLine(action.memo, 200);
  const tone = status === 'running' ? 'skipped' : status;
  return (
    <span className={`row ${tone}`}>
      <span className="mark" aria-hidden>{mark(status)}</span>
      <span className="label">#{record.action_id} · {ta.outcome[`${decision.verdict}/${record.status}`] ?? ta.otherOutcome(decision.verdict, record.status)}</span>
      <span className="value">
        {ta.payment(amountText(action.amount, action.token_id, ledger.tokens), action.receiver_id)}
        {memo && <> · <bdi>{ta.memo(memo)}</bdi></>}
      </span>
      <span className="hint">{ta.decidedAt(utcMinute(new Date(decidedAtMs(decision)).toISOString()))}{note && ` · ${note}`}</span>
    </span>
  );
}

function ActionItem({ record, ledger, commit, decided }: { record: ActionRecord; ledger: Ledger; commit: CommitState | undefined; decided: Decided | undefined }) {
  const cfg = useConfig();
  const ta = useT().t.agent;
  const [tampered, setTampered] = useState(false);
  const checks = useMemo(() => (commit ? checksOf(record, commit) : null), [record, commit]);
  // The demo edits a copy in this browser: flip the verdict, keep the signature, and run the same checks.
  const flipped = record.decision.verdict === 'Deny' ? 'Allow' : 'Deny';
  const edited = useMemo(() => (tampered && commit ? checksOf({ ...record, decision: { ...record.decision, verdict: flipped } }, commit) : null), [tampered, record, commit, flipped]);
  const status = worst(checks);
  const agent = ledger.agents.find((a) => a.id === record.agent_id);
  const earlier = agent?.info && !decidedUnderCurrentPolicy(record, agent.info) ? ta.earlierPolicy : null;
  const isSample = sampleAction.actionId === record.action_id && sampleAction.teeSignature === record.tee_signature;
  const rows: Array<[string, React.ReactNode]> = [
    [ta.detail.agent, <AccountLink key="a" account={record.agent_id} />],
    [ta.detail.policy, ta.policyLine(short(record.decision.policy_hash), record.decision.policy_version)],
    [ta.detail.key, <span key="k" className="mono">{record.tee_pubkey}</span>],
    [ta.detail.modelCommit, <span key="m" className="mono">{record.decision.model_proof_commit}</span>],
    [ta.detail.block, record.block_height],
  ];
  return (
    <li>
      <details>
        <summary>
          <ActionLine record={record} ledger={ledger} status={status} note={[ta.checked[status], earlier].filter(Boolean).join(' · ')} />
        </summary>
        <div className="ledger-body">
          {decided && <p className="small">{ta.decided[decided.method]} <a href={explorerTxUrl(cfg.explorer, decided.tx)} target="_blank" rel="noreferrer">{short(decided.tx)}</a></p>}
          {checks && <CheckList items={edited ?? checks} />}
          {edited && <p className="muted small">{ta.tamperNote(record.decision.verdict, flipped)}</p>}
          {checks && (
            <div className="actions">
              <button type="button" className="btn small" onClick={() => setTampered((v) => !v)}>{tampered ? ta.tamperUndo : ta.tamper}</button>
            </div>
          )}
          {isSample && <p className="small">{fill(ta.sampleProof, { verify: <Link href="/verify?sample=action">{ta.sampleProofLink}</Link> })}</p>}
          <table className="kv">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k}><th>{k}</th><td>{v}</td></tr>
              ))}
            </tbody>
          </table>
          <details>
            <summary className="small">{ta.rawRecord}</summary>
            <pre className="mono small" lang="en">{JSON.stringify(record, null, 2)}</pre>
          </details>
        </div>
      </details>
    </li>
  );
}

export default function AgentPage() {
  const cfg = useConfig();
  const { t } = useT();
  const ta = t.agent;
  const { ledger, error, reload } = useLedger();
  const commits = useModelCommits(ledger);
  // Transactions this browser sent, so the row can link to them; the outcome itself is always read from the chain.
  const [decided, setDecided] = useState<Record<number, Decided>>({});
  const pending = ledger?.records.filter((r) => r.status === 'Pending') ?? [];

  return (
    <main className="page">
      <h1>{ta.title}</h1>
      <p className="muted">{fill(ta.intro(cfg.network), { contract: <AccountLink account={cfg.contract} /> })}</p>
      {error && <RedCard title={error} />}
      {!ledger && !error && <p className="muted">{ta.loading}</p>}
      {ledger && (
        <>
          {ledger.agents.map((agent) => <AgentCard key={agent.id} agent={agent} ledger={ledger} />)}
          {pending.length > 0 && (
            <Pending
              records={pending}
              ledger={ledger}
              commits={commits}
              onDecided={(actionId, d) => {
                setDecided((prev) => ({ ...prev, [actionId]: d }));
                reload();
              }}
            />
          )}
          <h2>{ta.actionsTitle(ledger.records.length)}</h2>
          {ledger.more && <p className="muted small">{ta.more(ledger.records.length)}</p>}
          {ledger.records.length === 0 ? (
            <p className="muted">{ta.noActions}</p>
          ) : (
            <div className="table-wrap">
              <ul className="ledger">
                {[...ledger.records].reverse().map((record) => <ActionItem key={record.action_id} record={record} ledger={ledger} commit={commits[commitKey(record)]} decided={decided[record.action_id]} />)}
              </ul>
            </div>
          )}
          <h2>{ta.showsTitle}</h2>
          <ul>{ta.shows.map((line) => <li key={line}>{line}</li>)}</ul>
          <h2>{ta.notShowsTitle}</h2>
          <ul>{ta.notShows.map((line) => <li key={line}>{line}</li>)}</ul>
        </>
      )}
    </main>
  );
}
