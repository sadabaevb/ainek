'use client';
// Chat with a proof card per reply. The page only renders; lib/flow.ts does the work step by step.
// The wallet is a React hook, so the page hands flow a committer resolver for the on-chain step (SPEC §4.2).
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNearWallet } from 'near-connect-hooks';
import { ProofCard } from '@/components/proof-card';
import { CheckList } from '@/components/checks';
import { canCommitNow, commitAction, commitOutcome, consentFor, runChat, type ChatMessage, type ChatOutcome, type ChatParams, type StepEvent, type VerifiedOutcome } from '@/lib/flow';
import type { Dict } from '@/lib/i18n';
import { walletCommitter, type Consent } from '@/lib/wallet';
import { useConfig, useT, useTrust } from './providers';

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

/** The step in flight, in plain words (flow says which wording fits the route), over an indeterminate bar: the cold attestation alone can take many seconds and no step index would show that. */
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

const TurnView = memo(function TurnView({ turn, idx, canRetry, onCommit, onRetry }: { turn: Turn; idx: number; /** Only the last turn, and only while nothing is in flight, may be resent. */ canRetry: boolean; onCommit: (idx: number, outcome: VerifiedOutcome) => void; onRetry: (content: string, model: string) => void }) {
  const { t } = useT();
  const commit = useCallback((outcome: VerifiedOutcome) => onCommit(idx, outcome), [onCommit, idx]);
  const { outcome } = turn;
  // The honest key helps only when the swapped key was the whole problem: a split log would refuse the honest key too.
  const retryModel = canRetry && outcome?.kind === 'refused' && outcome.tampered && outcome.keyVerdict.reason === 'absent' ? outcome.model : null;
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
      {outcome && <ProofCard outcome={outcome} onCommit={commit} onRetry={retryModel ? () => onRetry(turn.message.content, retryModel) : undefined} />}
    </article>
  );
});

const DOT: Record<Chip, 'ok' | 'fail' | 'warn'> = { ask: 'ok', tamper: 'fail', incognito: 'warn' };

/** First screen: what the page is about and the three catches as one-click scenarios. Shown until the first message. */
function Intro({ onPick }: { onPick: (chip: Chip) => void }) {
  const { t } = useT();
  const chips = Object.keys(t.intro.chips) as Chip[];
  return (
    <section>
      <div className="hero">
        <h1>{t.hero[0]} <span className="grad">{t.hero[1]}</span></h1>
        <p>{t.intro.title}</p>
      </div>
      <ol className="steps-grid">
        {t.intro.lines.map((line, i) => (
          <li key={line} className="step"><span className="num">{i + 1}</span><div>{line}</div></li>
        ))}
      </ol>
      <p className="try">{t.intro.tryTitle}</p>
      <div className="scenarios">
        {chips.map((chip) => (
          <button key={chip} type="button" className="scenario" onClick={() => onPick(chip)}>
            <span className="title"><span className={`dot ${DOT[chip]}`} aria-hidden />{t.intro.chips[chip]}</span>
            <span className="sub">{t.intro.subs[chip]}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export default function ChatPage() {
  const cfg = useConfig();
  const { trust } = useTrust();
  const { t } = useT();
  const wallet = useNearWallet();
  const [model, setModel] = useState(cfg.model);
  const [tamper, setTamper] = useState(false);
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const turnsRef = useRef(turns); // the latest thread for callbacks that must stay stable across step events
  useLayoutEffect(() => {
    turnsRef.current = turns;
  });

  useEffect(() => {
    setTamper(new URLSearchParams(window.location.search).get('tamper') === '1');
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns.length]);

  /** Step 8 for one turn, off the critical path: the card is already on screen, the commit lands when it lands. `consent` is what the click allowed (the card's button); the automatic pass after a reply opens no dialog. */
  const commitTurn = useCallback(
    async (idx: number, outcome: VerifiedOutcome, consent: Consent) => {
      const inFlight = consent === 'deposit' ? 'depositing' : 'pending';
      if (outcome.commit !== inFlight) setTurns(atTurn(idx, withOutcome({ ...outcome, commit: inFlight })));
      const committed = await commitOutcome(outcome, () => walletCommitter(wallet, cfg, consent), (e) => setTurns(atTurn(idx, withStep(e))));
      setTurns(atTurn(idx, withOutcome(committed)));
      return committed.commit;
    },
    [wallet, cfg],
  );
  /** The prepayment is per account, not per card: once one card has paid, the others still saying "no deposit" commit through the key with no dialog. */
  const commitOthersAfterDeposit = useCallback(
    async (paidIdx: number) => {
      const pending = turnsRef.current.flatMap((turn, i) => (i !== paidIdx && turn.outcome?.kind === 'verified' && turn.outcome.commit === 'no-deposit' ? [[i, turn.outcome] as const] : []));
      for (const [i, outcome] of pending) await commitTurn(i, outcome, 'none');
    },
    [commitTurn],
  );
  const onCommitClick = useCallback(
    (idx: number, outcome: VerifiedOutcome) => {
      // The button said what it would do (connect, deposit, retry, commit); the click allows exactly that.
      if (!canCommitNow(outcome.commit)) return;
      const consent = consentFor(commitAction(outcome.commit, !!wallet.signedAccountId));
      void commitTurn(idx, outcome, consent).then((status) => {
        if (consent === 'deposit' && status === 'committed') return commitOthersAfterDeposit(idx);
      });
    },
    [commitTurn, commitOthersAfterDeposit, wallet.signedAccountId],
  );

  /** Sends with the given controls and shows them as sent: the composer, a scenario card and the retry all go through here. */
  async function send(text: string, opts: SendOptions) {
    const content = text.trim();
    if (!content || busy) return;
    setModel(opts.model);
    setTamper(opts.tamper);
    setInput('');
    setBusy(true);
    const history: ChatMessage[] = turns.flatMap((x) => (x.outcome && 'reply' in x.outcome && typeof x.outcome.reply === 'string' ? [x.message, { role: 'assistant' as const, content: x.outcome.reply }] : []));
    const messages = [...history, { role: 'user' as const, content }];
    const idx = turns.length;
    setTurns((prev) => [...prev, { message: { role: 'user', content }, steps: [] }]);
    try {
      const outcome = await runChat(cfg, { ...opts, trust, messages, onStep: (e) => setTurns(atTurn(idx, withStep(e))) }); // never throws
      setTurns(atTurn(idx, withOutcome(outcome)));
      if (outcome.kind === 'verified') void commitTurn(idx, outcome, 'none');
    } finally {
      setBusy(false);
    }
  }

  // `send` closes over the thread, so it is a new function every render; the retry callback reads the latest one through a ref
  // (published before paint) and stays stable for the memoized turns.
  const sendRef = useRef(send);
  useLayoutEffect(() => {
    sendRef.current = send;
  });
  const onRetryClick = useCallback((content: string, model: string) => void sendRef.current(content, { model, tamper: false }), []);

  /** A scenario card sends its prompt with the controls it names. */
  function pick(chip: Chip) {
    void send(t.intro.prompts[chip], { model: chip === 'incognito' ? cfg.incognitoModel : cfg.model, tamper: chip === 'tamper' });
  }

  return (
    <main className="page chat">
      {turns.length === 0 ? <Intro onPick={pick} /> : <h1 className="compact">{t.hero.join(' ')}</h1>}

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
        {turns.map((turn, i) => <TurnView key={i} turn={turn} idx={i} canRetry={!busy && i === turns.length - 1} onCommit={onCommitClick} onRetry={onRetryClick} />)}
        <div ref={bottom} />
      </section>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input, { model, tamper });
        }}
      >
        <div className="composer-inner">
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t.placeholder} disabled={busy} maxLength={4000} />
          <button type="submit" className="btn primary" disabled={busy || !input.trim()}>{busy ? t.working : t.send}</button>
        </div>
      </form>
    </main>
  );
}

function upsert(steps: StepEvent[], e: StepEvent): StepEvent[] {
  const i = steps.findIndex((s) => s.id === e.id);
  return i === -1 ? [...steps, e] : steps.map((s, j) => (j === i ? e : s));
}
