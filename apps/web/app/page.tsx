'use client';
// Chat with a proof card per reply. The page only renders; lib/flow.ts does the work step by step.
// The wallet is a React hook, so the page hands flow a committer callback for the on-chain step (SPEC §4.2).
import { memo, useEffect, useRef, useState } from 'react';
import { useNearWallet } from 'near-connect-hooks';
import { ProofCard } from '@/components/proof-card';
import { CheckList } from '@/components/checks';
import { describeError } from '@/lib/errors';
import { commitOutcome, runChat, type ChatMessage, type ChatOutcome, type StepEvent } from '@/lib/flow';
import { commitProofOnChain, isMethodNotFound } from '@/lib/wallet';
import { useConfig, useT } from './providers';

interface Turn {
  message: ChatMessage;
  steps: StepEvent[];
  outcome?: ChatOutcome;
}

const TurnView = memo(function TurnView({ turn }: { turn: Turn }) {
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
      {turn.outcome && <ProofCard outcome={turn.outcome} />}
    </article>
  );
});

export default function ChatPage() {
  const cfg = useConfig();
  const { t } = useT();
  const wallet = useNearWallet();
  const walletRef = useRef(wallet); // the commit runs after an await: read the wallet as it is then, not as it was
  walletRef.current = wallet;
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
  const setOutcome = (idx: number, outcome: ChatOutcome) => patch(idx, (turn) => ({ ...turn, outcome }));

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
      setOutcome(idx, outcome);
      if (outcome.kind === 'verified') {
        // Off the critical path: the card is already on screen, the composer unlocks, the commit lands when it lands.
        const { signedAccountId, callFunctionRaw } = walletRef.current;
        const committer = signedAccountId ? (proof: Parameters<typeof commitProofOnChain>[2]) => commitProofOnChain(callFunctionRaw, cfg, proof) : null;
        void commitOutcome(outcome, committer, (e) => step(idx, e), isMethodNotFound).then((committed) => setOutcome(idx, committed));
      }
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
        {turns.map((turn, i) => <TurnView key={i} turn={turn} />)}
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
