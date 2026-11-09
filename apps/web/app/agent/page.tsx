'use client';
// The third question, "did the agent do only what it was allowed to?", as a page anyone can open (SPEC §4.3, §7.2). The data
// comes from the contract's views and the agent account's access keys over public RPC; each record is re-checked in this browser
// with the code `pnpm -F demo check-agent` runs. The owner can approve or reject a waiting action here: the page only builds the
// call, the wallet signs it with a full-access key. The page follows the chain while it is open, so an action the bot proposes appears by itself.
import Link from 'next/link';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useNearWallet } from 'near-connect-hooks';
import { approveBlocker, checkActionRecord, decidedAtMs, decidedUnderCurrentPolicy, oneLine, readModelCommits, type ActionRecord, type AgentState, type Check, type ModelCommitLookup } from '@ainek/proof';
import sampleAction from '../../../../docs/samples/action-proof.sample.json';
import { CheckList, Row, worstStatus, type Status } from '@/components/checks';
import { RedCard } from '@/components/red-card';
import { KvTable } from '@/components/stack-table';
import { describeError } from '@/lib/errors';
import { fill } from '@/lib/fill';
import { short, utcMinuteOf } from '@/lib/format';
import { amountText, ledgerMoved, loadLedger, type Ledger } from '@/lib/ledger';
import { explorerAccountUrl, explorerTxUrl } from '@/lib/links';
import { errorText, isDialogClosed, ownerDecide } from '@/lib/wallet';
import { useConfig, useT } from '../providers';

const POLL_MS = 10_000;
/** After the owner signed, the chain shows the result within seconds: look often for a minute, so the card does not sit undecided. */
const EAGER_MS = 2_000;
const EAGER_FOR_MS = 60_000;
/** Every sixth turn the ledger is read again whatever the look says: the balances, the owner and anything else the look does not watch. */
const REFRESH_EVERY = 6;
/** A commit lookup that failed, or that a node behind the chain answered with "none", is asked again this often, this many times. */
const RETRY_MS = 10_000;
const MAX_TRIES = 5;

type Decided = { method: 'approve' | 'reject'; tx: string };
/** The checks of each record by action id; an action is absent until its model proof commit has been looked up. */
type Checks = ReadonlyMap<number, Check[]>;

const commitKey = (r: ActionRecord): string => `${r.agent_id}/${r.decision.model_proof_commit}`;

/**
 * The ledger, kept in step with the chain by one loop: read, wait, look for news while the tab is visible, read again if something
 * moved or a minute has passed. One loop, so a slow read is never overtaken by the next look. A re-read keeps what cannot change
 * (`loadLedger`). With a ledger on screen a failed look or re-read is silent and repeated on the next turn. `follow` is for an
 * action the owner has just signed for: the loop looks at once and often until the chain shows what became of it.
 */
function useLedger() {
  const cfg = useConfig();
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [error, setError] = useState('');
  const [kick, setKick] = useState(0);
  // What the loop last read, kept across its restarts so that a restart re-reads from there, not from nothing. Per config.
  const held = useRef<{ cfg: typeof cfg; ledger: Ledger } | null>(null);
  const signedAt = useRef(new Map<number, number>());

  useEffect(() => {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let turns = 0;
    const known = (): Ledger | null => (held.current?.cfg === cfg ? held.current.ledger : null);
    const turn = async () => {
      const before = known();
      turns += 1;
      try {
        const due = before === null || (document.visibilityState === 'visible' && (turns % REFRESH_EVERY === 0 || (await ledgerMoved(cfg, before, ctl.signal))));
        if (due) {
          const next = await loadLedger(cfg, ctl.signal, before ?? undefined);
          if (ctl.signal.aborted) return;
          held.current = { cfg, ledger: next };
          setLedger(next);
          setError('');
        }
      } catch (e) {
        if (ctl.signal.aborted) return;
        if (before === null) setError(describeError(e));
      }
      const now = Date.now();
      const awaited = (known()?.records ?? []).some((r) => r.status === 'Pending' && now - (signedAt.current.get(r.action_id) ?? -EAGER_FOR_MS) < EAGER_FOR_MS);
      timer = setTimeout(() => void turn(), awaited ? EAGER_MS : POLL_MS);
    };
    void turn();
    return () => {
      ctl.abort();
      clearTimeout(timer);
    };
  }, [cfg, kick]);

  const follow = (actionId: number) => {
    signedAt.current.set(actionId, Date.now());
    setKick((k) => k + 1);
  };
  return { ledger, error, follow };
}

/**
 * `proof_commit` for the model proof each record names (`readModelCommits`: a few at a time). A commit that was found stays found,
 * so it is asked once per page. An answer that may still change, a failed read or a "none" from a node behind the chain, is shown
 * as it is and asked again a few times. Lookups cut short by a new ledger are handed back and asked again by the next run.
 */
function useModelCommits(ledger: Ledger | null): Record<string, ModelCommitLookup> {
  const cfg = useConfig();
  const [commits, setCommits] = useState<Record<string, ModelCommitLookup>>({});
  const [retry, setRetry] = useState(0);
  /** In flight, or answered for good. */
  const asked = useRef(new Set<string>());
  const tries = useRef(new Map<string, number>());
  useEffect(() => {
    const todo = new Map<string, ActionRecord>();
    for (const record of ledger?.records ?? []) {
      const key = commitKey(record);
      if (!asked.current.has(key) && (tries.current.get(key) ?? 0) < MAX_TRIES) todo.set(key, record);
    }
    if (todo.size === 0) return;
    for (const key of todo.keys()) asked.current.add(key);
    const unanswered = new Set(todo.keys());
    const ctl = new AbortController();
    let again: ReturnType<typeof setTimeout> | undefined;
    void readModelCommits(cfg.rpcUrl, cfg.contract, [...todo.values()], {
      signal: ctl.signal,
      onBatch: (found) => {
        if (ctl.signal.aborted) return;
        const answers = found.map(([record, lookup]) => [commitKey(record), lookup] as const);
        for (const [key, lookup] of answers) {
          unanswered.delete(key);
          tries.current.set(key, (tries.current.get(key) ?? 0) + 1);
          if (lookup.status === 'failed' || lookup.status === 'none') asked.current.delete(key);
        }
        setCommits((prev) => ({ ...prev, ...Object.fromEntries(answers) }));
        if (answers.some(([key]) => !asked.current.has(key))) again ??= setTimeout(() => setRetry((n) => n + 1), RETRY_MS);
      },
    });
    return () => {
      ctl.abort();
      clearTimeout(again);
      for (const key of unanswered) asked.current.delete(key);
    };
  }, [cfg, ledger, retry]);
  return commits;
}

/**
 * Every record's checks, computed once for the pending cards and the list alike. A signature check costs milliseconds and the page
 * re-renders on every answer from the chain, so a record is re-checked only when it or its commit lookup changed.
 */
function useChecks(ledger: Ledger | null, commits: Record<string, ModelCommitLookup>): Checks {
  const cache = useRef(new Map<string, Check[]>());
  return useMemo(() => {
    const checks = new Map<number, Check[]>();
    for (const record of ledger?.records ?? []) {
      const commit = commits[commitKey(record)];
      if (!commit) continue;
      const key = JSON.stringify([record, commit]);
      const done = cache.current.get(key) ?? checkActionRecord(record, commit);
      cache.current.set(key, done);
      checks.set(record.action_id, done);
    }
    return checks;
  }, [ledger, commits]);
}

function AccountLink({ account }: { account: string }) {
  const cfg = useConfig();
  return <a className="mono" href={explorerAccountUrl(cfg.explorer, account)} target="_blank" rel="noreferrer">{account}</a>;
}

function TxLink({ tx }: { tx: string }) {
  const cfg = useConfig();
  return <a href={explorerTxUrl(cfg.explorer, tx)} target="_blank" rel="noreferrer">{short(tx)}</a>;
}

function AgentCard({ agent, ledger }: { agent: AgentState; ledger: Ledger }) {
  const cfg = useConfig();
  const ta = useT().t.agent;
  const { info, keys, funds } = agent;
  const head = <h3><AccountLink account={agent.id} /></h3>;
  if (!info) {
    return (
      <section className="card agent-card">
        {head}
        <p className="muted">{ta.notRegistered}</p>
      </section>
    );
  }
  const amount = (units: string) => amountText(units, info.token_id, ledger.tokens);
  const scoped = keys.functionCall;
  // A pause is the contract's own refusal, whatever keys exist. Without it, only a key scoped to the agent's two methods on this
  // contract counts as "the agent's key"; a full-access key could still sign a proposal, and the page says so instead of "cannot".
  const hasAgentKey = scoped.some((k) => k.problem === null);
  const state = info.paused ? (hasAgentKey ? ta.state.paused : ta.state.stopped) : hasAgentKey ? ta.state.running : ta.stateNoKey(keys.fullAccess);
  return (
    <section className="card agent-card">
      {head}
      <Row status={!info.paused && hasAgentKey ? 'ok' : 'skipped'} label={ta.rowState}>{state}</Row>
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
    </section>
  );
}

/** One action in three lines: what happened, the payment, when and how it checks out. The memo is the agent's text, so it is flattened and isolated. */
function ActionLine({ record, tokens, status, note }: { record: ActionRecord; tokens: Ledger['tokens']; status: Status; note: string }) {
  const ta = useT().t.agent;
  const { action, decision } = record;
  const memo = oneLine(action.memo, 200);
  return (
    <Row as="span" status={status} label={`#${record.action_id} · ${ta.outcome[`${decision.verdict}/${record.status}`] ?? ta.otherOutcome(decision.verdict, record.status)}`} hint={`${ta.decidedAt(utcMinuteOf(decidedAtMs(decision)))} · ${note}`}>
      {ta.payment(amountText(action.amount, action.token_id, tokens), action.receiver_id)}
      {memo && <> · <bdi>{ta.memo(memo)}</bdi></>}
    </Row>
  );
}

function Pending({ records, ledger, checks, decided, onDecided }: { records: ActionRecord[]; ledger: Ledger; checks: Checks; decided: Record<number, Decided>; onDecided: (actionId: number, decided: Decided) => void }) {
  const cfg = useConfig();
  const ta = useT().t.agent;
  const { signedAccountId, signIn, callFunctionRaw } = useNearWallet();
  const [busy, setBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState('');
  const isOwner = signedAccountId === ledger.owner;
  // Closing the wallet is a choice, not a failure.
  const report = (e: unknown) => {
    if (!isDialogClosed(e)) setFailed(errorText(e));
  };
  const decide = (record: ActionRecord, method: Decided['method']) => {
    setBusy(record.action_id);
    setFailed('');
    ownerDecide(callFunctionRaw, cfg, method, record.action_id)
      .then((tx) => onDecided(record.action_id, { method, tx }))
      .catch(report)
      .finally(() => setBusy(null));
  };
  // A bare sign-in: no function-call key is asked for. Every owner call here needs a full-access signature anyway (1 yoctoNEAR), and
  // a key left in this browser on the owner's account is exactly what that rule guards against (SPEC §4.3).
  const connect = () => {
    setFailed('');
    signIn().catch(report);
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
        const agent = ledger.agents.find((a) => a.id === record.agent_id)?.info;
        const block = agent ? approveBlocker(record, agent, Date.now()) : null;
        // `approve` names only an id, so what the owner signs for is what the contract holds: Approve stays off until that record
        // has been re-checked here and every check passed. Reject moves nothing, so it needs no check.
        const status = worstStatus(checks.get(record.action_id));
        const signed = decided[record.action_id];
        return (
          <div key={record.action_id} className="card">
            <ActionLine record={record} tokens={ledger.tokens} status={status} note={ta.checked[status]} />
            {signed ? (
              // The wallet returned, the chain has not shown the result yet: no second click, the loop is looking every two seconds.
              <p className="small">{ta.decided[signed.method]} <TxLink tx={signed.tx} />. <span className="muted">{ta.awaitingChain}</span></p>
            ) : (
              <>
                {block && <p className="muted small">{ta.blocked[block]}</p>}
                {isOwner && status !== 'ok' && <p className="muted small">{ta.approveNeedsCheck}</p>}
                {isOwner && (
                  <div className="actions">
                    <button type="button" className="btn primary" disabled={busy !== null || block !== null || status !== 'ok'} onClick={() => decide(record, 'approve')}>{ta.approve}</button>
                    <button type="button" className="btn" disabled={busy !== null} onClick={() => decide(record, 'reject')}>{ta.reject}</button>
                    {busy === record.action_id && <span className="muted small">{ta.deciding}</span>}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** Memoized: the list re-renders on every answer from the chain, and a row changes only with its own record, checks or transaction. */
const ActionItem = memo(function ActionItem({ record, agent, tokens, checks, commit, decided }: { record: ActionRecord; agent: AgentState | undefined; tokens: Ledger['tokens']; checks: Check[] | undefined; commit: ModelCommitLookup | undefined; decided: Decided | undefined }) {
  const ta = useT().t.agent;
  const [tampered, setTampered] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  // The demo edits a copy in this browser: flip the verdict, keep the signature, and run the same checks.
  const flipped = record.decision.verdict === 'Deny' ? 'Allow' : 'Deny';
  const edited = useMemo(() => (tampered && commit ? checkActionRecord({ ...record, decision: { ...record.decision, verdict: flipped } }, commit) : null), [tampered, record, commit, flipped]);
  const status = worstStatus(checks);
  const earlier = agent?.info && !decidedUnderCurrentPolicy(record, agent.info) ? ta.earlierPolicy : null;
  const isSample = sampleAction.actionId === record.action_id && sampleAction.teeSignature === record.tee_signature;
  return (
    <li>
      <details>
        <summary>
          <ActionLine record={record} tokens={tokens} status={status} note={[ta.checked[status], earlier].filter(Boolean).join(' · ')} />
        </summary>
        <div className="ledger-body">
          {decided && <p className="small">{ta.decided[decided.method]} <TxLink tx={decided.tx} /></p>}
          {checks && <CheckList items={edited ?? checks} />}
          {edited && <p className="muted small">{ta.tamperNote(record.decision.verdict, flipped)}</p>}
          {checks && (
            <div className="actions">
              <button type="button" className="btn small" onClick={() => setTampered((v) => !v)}>{tampered ? ta.tamperUndo : ta.tamper}</button>
            </div>
          )}
          {isSample && <p className="small">{fill(ta.sampleProof, { verify: <Link href="/verify?sample=action">{ta.sampleProofLink}</Link> })}</p>}
          <KvTable
            rows={[
              [ta.detail.agent, <AccountLink account={record.agent_id} />],
              [ta.detail.policy, ta.policyLine(short(record.decision.policy_hash), record.decision.policy_version)],
              [ta.detail.key, <span className="mono">{record.tee_pubkey}</span>],
              [ta.detail.modelCommit, <span className="mono">{record.decision.model_proof_commit}</span>],
              [ta.detail.block, record.block_height],
            ]}
          />
          <details onToggle={(e) => setRawOpen(e.currentTarget.open)}>
            <summary className="small">{ta.rawRecord}</summary>
            {rawOpen && <pre className="mono small" lang="en">{JSON.stringify(record, null, 2)}</pre>}
          </details>
        </div>
      </details>
    </li>
  );
});

export default function AgentPage() {
  const cfg = useConfig();
  const { t } = useT();
  const ta = t.agent;
  const { ledger, error, follow } = useLedger();
  const commits = useModelCommits(ledger);
  const checks = useChecks(ledger, commits);
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
              checks={checks}
              decided={decided}
              onDecided={(actionId, d) => {
                setDecided((prev) => ({ ...prev, [actionId]: d }));
                follow(actionId);
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
                {[...ledger.records].reverse().map((record) => (
                  <ActionItem key={record.action_id} record={record} agent={ledger.agents.find((a) => a.id === record.agent_id)} tokens={ledger.tokens} checks={checks.get(record.action_id)} commit={commits[commitKey(record)]} decided={decided[record.action_id]} />
                ))}
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
