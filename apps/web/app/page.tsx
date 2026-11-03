'use client';
// Chat with a proof card per reply. The page only renders; lib/flow.ts does the work step by step.
// The page owns the wallet, so the on-chain commit (SPEC §4.2) runs here after a verified outcome.
import { memo, useEffect, useRef, useState } from 'react';
import { useNearWallet } from 'near-connect-hooks';
import { ProofCard } from '@/components/proof-card';
import { CheckList } from '@/components/checks';
import { describeError } from '@/lib/errors';
import { runChat, type ChatMessage, type ChatOutcome, type StepEvent } from '@/lib/flow';
import { short } from '@/lib/format';
import { putExchange } from '@/lib/store';
import { commitProofOnChain, fcKeyLogin, isMethodNotFound } from '@/lib/wallet';
import { useConfig, useT } from './providers';

interface Turn {
  message: ChatMessage;
  steps: StepEvent[];
  outcome?: ChatOutcome;
}

const TurnView = memo(function TurnView({ turn, walletConnected }: { turn: Turn; walletConnected: boolean }) {
  const { t } = useT();
  return (
    <article className="turn">
      <div className="bubble user"><span className="who">{t.you}</span>{turn.message.content}</div>
      {turn.steps.length > 0 && (
        <details className="steps" open={!turn.outcome}>
          <summary>{t.steps}</summary>
          <CheckList items={turn.steps} />
        </details>
      )}
      {turn.outcome && 'reply' in turn.outcome && (
        <div className="bubble assistant"><span className="who">{t.assistant}</span>{turn.outcome.reply}</div>
      )}
      {turn.outcome && <ProofCard outcome={turn.outcome} walletConnected={walletConnected} />}
    </article>
  );
});

export default function ChatPage() {
  const cfg = useConfig();
  const { t } = useT();
  const { signedAccountId, signIn, signOut, callFunctionRaw, loading: walletLoading } = useNearWallet();
  const [model, setModel] = useState(cfg.model);
  const [tamper, setTamper] = useState(false);
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTamper(new URLSearchParams(window.location.search).get('tamper') === '1');
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns.length]);

  const patch = (idx: number, fn: (turn: Turn) => Turn) => setTurns((prev) => prev.map((turn, i) => (i === idx ? fn(turn) : turn)));
  const step = (idx: number, e: StepEvent) => patch(idx, (turn) => ({ ...turn, steps: upsert(turn.steps, e) }));

  /** After a verified reply: commit the salted hash with the function-call key, or explain why not. Never blocks the card. */
  async function commit(idx: number, outcome: ChatOutcome) {
    if (outcome.kind !== 'verified') return;
    if (!signedAccountId) {
      step(idx, { id: 'commit', status: 'skipped', detail: 'no wallet connected: the commit stays local (connect a wallet to put it on NEAR)' });
      return;
    }
    step(idx, { id: 'commit', status: 'running', detail: `commit_proof on ${cfg.contract} as ${signedAccountId}` });
    try {
      const tx = await commitProofOnChain(callFunctionRaw, cfg, outcome.proof);
      const proof = { ...outcome.proof, commitTx: tx };
      step(idx, { id: 'commit', status: 'ok', detail: `commit ${short(proof.commit ?? '')} recorded in transaction ${short(tx)}` });
      patch(idx, (turn) => ({ ...turn, outcome: { ...outcome, proof } }));
      await putExchange({ completionId: outcome.exchange.completionId, model: outcome.proof.model, sentAt: outcome.exchange.sentAt, requestBody: outcome.exchange.requestBody, responseBody: outcome.exchange.responseBody, reply: outcome.reply, proof, logEntry: outcome.logEntry }).catch(() => undefined);
    } catch (err) {
      step(idx, { id: 'commit', status: 'skipped', detail: isMethodNotFound(err) ? `commit_proof is not in ${cfg.contract} yet (SPEC §4.2 lands next): commit kept locally` : `commit failed: ${describeError(err)}; commit kept locally` });
    }
  }

  async function send() {
    const content = input.trim();
    if (!content || busy) return;
    setInput('');
    setBusy(true);
    const history: ChatMessage[] = turns.flatMap((x) => (x.outcome && 'reply' in x.outcome && typeof x.outcome.reply === 'string' ? [x.message, { role: 'assistant' as const, content: x.outcome.reply }] : []));
    const messages = [...history, { role: 'user' as const, content }];
    const idx = turns.length;
    setTurns((prev) => [...prev, { message: { role: 'user', content }, steps: [] }]);
    try {
      const outcome = await runChat(cfg, { model, messages, tamper, onStep: (e) => step(idx, e) });
      patch(idx, (turn) => ({ ...turn, outcome }));
      await commit(idx, outcome);
    } catch (err) {
      // Not a step failure (those become outcomes inside runChat): report it at the step that was running.
      patch(idx, (turn) => ({ ...turn, outcome: { kind: 'failed', step: turn.steps.findLast((s) => s.status === 'running')?.id ?? 'send', reason: describeError(err) } }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <header className="top">
        <div>
          <h1>Ainek</h1>
          <p className="muted">{t.tagline}</p>
        </div>
        <div className="wallet">
          {signedAccountId ? (
            <span className="muted small">{t.wallet}: <span className="mono">{signedAccountId}</span> <button type="button" className="btn small" onClick={() => void signOut()}>{t.disconnect}</button></span>
          ) : (
            <button type="button" className="btn small" onClick={() => void fcKeyLogin(signIn, cfg)} disabled={walletLoading}>{t.connectWallet}</button>
          )}
        </div>
      </header>

      <div className="controls">
        <label>
          {t.model}{' '}
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
            <option value={cfg.model}>{cfg.model} · {t.teeModel}</option>
            <option value={cfg.incognitoModel}>{cfg.incognitoModel} · {t.incognitoModel}</option>
          </select>
        </label>
        <label className="muted">
          <input type="checkbox" checked={tamper} onChange={(e) => setTamper(e.target.checked)} disabled={busy} /> {t.tamper}
        </label>
      </div>

      <section className="thread">
        {turns.map((turn, i) => <TurnView key={i} turn={turn} walletConnected={Boolean(signedAccountId)} />)}
        <div ref={bottom} />
      </section>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t.placeholder} disabled={busy} maxLength={4000} />
        <button type="submit" className="btn primary" disabled={busy || !input.trim()}>{busy ? t.working : t.send}</button>
      </form>
    </main>
  );
}

function upsert(steps: StepEvent[], e: StepEvent): StepEvent[] {
  const i = steps.findIndex((s) => s.id === e.id);
  return i === -1 ? [...steps, e] : steps.map((s, j) => (j === i ? e : s));
}
