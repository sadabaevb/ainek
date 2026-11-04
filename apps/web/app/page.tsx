'use client';
// Chat with a proof card per reply. The page only renders; lib/flow.ts does the work step by step.
// The wallet is a React hook, so the page hands flow a committer resolver for the on-chain step (SPEC §4.2).
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useNearWallet } from 'near-connect-hooks';
import { ProofCard } from '@/components/proof-card';
import { CheckList } from '@/components/checks';
import { canCommitNow, commitOutcome, runChat, type ChatMessage, type ChatOutcome, type ChatParams, type StepEvent, type VerifiedOutcome } from '@/lib/flow';
import type { Dict } from '@/lib/i18n';
import { walletCommitter } from '@/lib/wallet';
import { useConfig, useT } from './providers';

interface Turn {
  message: ChatMessage;
  steps: StepEvent[];
  outcome?: ChatOutcome;
}

/** What the composer sends with: the selected model and the tamper switch, taken at the moment of sending. */
type SendOptions = Pick<ChatParams, 'model' | 'tamper'>;

type Chip = keyof Dict['intro']['chips'];

// Updaters for one turn of the thread, built outside the component so the callbacks below close over setTurns only.
const atTurn = (idx: number, fn: (turn: Turn) => Turn) => (prev: Turn[]) => prev.map((turn, i) => (i === idx ? fn(turn) : turn));
const withStep = (e: StepEvent) => (turn: Turn): Turn => ({ ...turn, steps: upsert(turn.steps, e) });
const withOutcome = (outcome: ChatOutcome) => (turn: Turn): Turn => ({ ...turn, outcome });

/** The step in flight, in plain words (flow says which wording fits the route), over an indeterminate bar: the cold attestation alone can take ten seconds and no step index would show that. */
function Progress({ steps }: { steps: StepEvent[] }) {
  const { t } = useT();
  if (steps.length === 0) return null;
  const running = steps.find((s) => s.status === 'running');
  return (
    <div className="progress" role="status">
      <span>{running ? t.progress[running.say ?? running.id] : t.working}</span>
      <span className="bar"><span /></span>
    </div>
  );
}

const TurnView = memo(function TurnView({ turn, idx, onCommit }: { turn: Turn; idx: number; onCommit: (idx: number, outcome: VerifiedOutcome) => void }) {
  const { t } = useT();
  const commit = useCallback((outcome: VerifiedOutcome) => onCommit(idx, outcome), [onCommit, idx]);
  return (
    <article className="turn">
      <div className="bubble user"><span className="who">{t.you}</span>{turn.message.content}</div>
      {!turn.outcome && <Progress steps={turn.steps} />}
      {turn.steps.length > 0 && (
        <details className="steps">
          <summary>{t.steps}</summary>
          <CheckList items={turn.steps} />
        </details>
      )}
      {turn.outcome && 'reply' in turn.outcome && (
        <div className="bubble assistant"><span className="who">{t.assistant}</span>{turn.outcome.reply}</div>
      )}
      {turn.outcome && <ProofCard outcome={turn.outcome} onCommit={commit} />}
    </article>
  );
});

/** First screen: what the page is about and the three catches as one-click prompts. Shown until the first message. */
function Intro({ onPick }: { onPick: (chip: Chip) => void }) {
  const { t } = useT();
  const chips = Object.keys(t.intro.chips) as Chip[];
  return (
    <section className="card intro">
      <h2>{t.intro.title}</h2>
      <ol>{t.intro.lines.map((line) => <li key={line}>{line}</li>)}</ol>
      <p className="try">{t.intro.tryTitle}</p>
      <div className="chips">
        {chips.map((chip) => <button key={chip} type="button" className="btn chip" onClick={() => onPick(chip)}>{t.intro.chips[chip]}</button>)}
      </div>
    </section>
  );
}

export default function ChatPage() {
  const cfg = useConfig();
  const { t } = useT();
  const wallet = useNearWallet();
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

  /** Step 8 for one turn, off the critical path: the card is already on screen, the commit lands when it lands. `connect` asks the wallet to sign in first (the card's button); the automatic pass after a reply never pops the wallet up. */
  const commitTurn = useCallback(
    async (idx: number, outcome: VerifiedOutcome, connect: boolean) => {
      if (outcome.commit !== 'pending') setTurns(atTurn(idx, withOutcome({ ...outcome, commit: 'pending' }))); // the automatic pass already is
      const committed = await commitOutcome(outcome, () => walletCommitter(wallet, cfg, connect), (e) => setTurns(atTurn(idx, withStep(e))));
      setTurns(atTurn(idx, withOutcome(committed)));
    },
    [wallet, cfg],
  );
  const onCommitClick = useCallback(
    (idx: number, outcome: VerifiedOutcome) => {
      if (canCommitNow(outcome.commit)) void commitTurn(idx, outcome, true);
    },
    [commitTurn],
  );

  async function send(text: string, opts: SendOptions) {
    const content = text.trim();
    if (!content || busy) return;
    setInput('');
    setBusy(true);
    const history: ChatMessage[] = turns.flatMap((x) => (x.outcome && 'reply' in x.outcome && typeof x.outcome.reply === 'string' ? [x.message, { role: 'assistant' as const, content: x.outcome.reply }] : []));
    const messages = [...history, { role: 'user' as const, content }];
    const idx = turns.length;
    setTurns((prev) => [...prev, { message: { role: 'user', content }, steps: [] }]);
    try {
      const outcome = await runChat(cfg, { ...opts, messages, onStep: (e) => setTurns(atTurn(idx, withStep(e))) }); // never throws
      setTurns(atTurn(idx, withOutcome(outcome)));
      if (outcome.kind === 'verified') void commitTurn(idx, outcome, false);
    } finally {
      setBusy(false);
    }
  }

  /** A chip sets the controls to the scenario it names and sends its prompt in one click. */
  function pick(chip: Chip) {
    const opts: SendOptions = { model: chip === 'incognito' ? cfg.incognitoModel : cfg.model, tamper: chip === 'tamper' };
    setModel(opts.model);
    setTamper(opts.tamper);
    void send(t.intro.prompts[chip], opts);
  }

  return (
    <main className="page">
      <header className="top">
        <h1>Ainek</h1>
        <p className="muted">{t.tagline}</p>
      </header>

      {turns.length === 0 && <Intro onPick={pick} />}

      <div className="controls">
        <label className="field">
          {t.model}
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
        {turns.map((turn, i) => <TurnView key={i} turn={turn} idx={i} onCommit={onCommitClick} />)}
        <div ref={bottom} />
      </section>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input, { model, tamper });
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
