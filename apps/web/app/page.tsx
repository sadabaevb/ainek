'use client';
// Chat with a proof card per reply. The page only renders; lib/flow.ts does the work step by step.
// The wallet is a React hook, so the page hands flow a committer resolver for the on-chain step (SPEC §4.2).
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNearWallet } from 'near-connect-hooks';
import { ProofCard } from '@/components/proof-card';
import { CheckList, mark } from '@/components/checks';
import { canCommitNow, commitAction, commitOutcome, consentFor, runChat, type ChatMessage, type ChatOutcome, type ChatParams, type StepEvent, type Tamper, type VerifiedOutcome } from '@/lib/flow';
import { chatHistory, hasOtherThread, leftBehind } from '@/lib/history';
import type { Dict } from '@/lib/i18n';
import { saveOwnReleaseRule } from '@/lib/trust-set';
import { walletCommitter, type Consent } from '@/lib/wallet';
import { useConfig, useT, useTrust } from './providers';

interface Turn {
  message: ChatMessage;
  /** The model this turn was sent to: the next message carries only the turns of its own model (lib/history.ts). */
  model: string;
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
  // The honest retry helps only when the swap was the whole problem: a split log or a short quorum would refuse the honest message too.
  const retryModel = canRetry && outcome?.kind === 'refused' && outcome.honestWouldPass ? turn.model : null;
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
      {outcome && 'reply' in outcome && <div className="bubble assistant"><span className="who">{t.assistant}</span>{outcome.reply}</div>}
      {outcome?.kind === 'failed' && outcome.unverifiedReply !== undefined && (
        <div className="bubble assistant unverified"><span className="who">{t.assistantUnverified}</span>{outcome.unverifiedReply}</div>
      )}
      {outcome && <ProofCard outcome={outcome} onCommit={commit} onRetry={retryModel ? () => onRetry(turn.message.content, retryModel) : undefined} />}
    </article>
  );
});

/** What each scenario ends in, drawn as the mark its card will carry: a proof, a refusal, a card that says "no hardware proof". */
const ENDS: Record<Chip, 'ok' | 'fail' | 'warn'> = { ask: 'ok', tamper: 'fail', deployment: 'fail', incognito: 'warn' };
const TAMPER_OF: Partial<Record<Chip, Tamper>> = { tamper: 'key', deployment: 'deployment' };

/** First screen: what the page is about, the honest path and the catches as one-click scenarios. Shown until the first message. */
function Intro({ onPick }: { onPick: (chip: Chip) => void }) {
  const { t } = useT();
  const chips = Object.keys(t.intro.chips) as Chip[];
  return (
    <section>
      <div className="hero">
        <h1>{t.hero[0]} <span className="marked">{t.hero[1]}</span></h1>
      </div>
      <p className="kicker">{t.intro.title}</p>
      <ol className="steps-grid">
        {t.intro.lines.map((line, i) => (
          <li key={line} className="step"><span className="num" aria-hidden>{String(i + 1).padStart(2, '0')}</span>{line}</li>
        ))}
      </ol>
      <p className="kicker try">{t.intro.tryTitle}</p>
      <div className="scenarios">
        {chips.map((chip) => (
          <button key={chip} type="button" className="scenario" onClick={() => onPick(chip)}>
            <span className={`mark ${ENDS[chip]}`} aria-hidden>{ENDS[chip] === 'warn' ? '!' : mark(ENDS[chip])}</span>
            <span className="title">{t.intro.chips[chip]}</span>
            <span className="sub">{t.intro.subs[chip]}</span>
            <span className="go" aria-hidden />
          </button>
        ))}
      </div>
    </section>
  );
}

export default function ChatPage() {
  const cfg = useConfig();
  const { trust, releaseRule } = useTrust();
  const { t } = useT();
  const wallet = useNearWallet();
  const [model, setModel] = useState(cfg.model);
  const [tamper, setTamper] = useState<Tamper>(false);
  /** A change of the release switch the browser did not keep, by what was asked: on holds for this page, off did not happen. */
  const [ruleUnsaved, setRuleUnsaved] = useState<'on' | 'off' | null>(null);
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const turnsRef = useRef(turns); // the latest thread for callbacks that must stay stable across step events
  useLayoutEffect(() => {
    turnsRef.current = turns;
  });

  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get('tamper');
    setTamper(asked === '1' ? 'key' : asked === 'deployment' ? 'deployment' : false);
  }, []);
  useEffect(() => {
    // Follow the thread as it grows. Not on the first screen: with no message yet there is nothing to follow, and the page
    // would open scrolled past its own headline.
    if (turns.length === 0) return;
    bottom.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
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
    const messages = [...chatHistory(turns, opts.model, cfg.model, content), { role: 'user' as const, content }];
    const idx = turns.length;
    setTurns((prev) => [...prev, { message: { role: 'user', content }, model: opts.model, steps: [] }]);
    try {
      const outcome = await runChat(cfg, { ...opts, trust, releaseRule, messages, onStep: (e) => setTurns(atTurn(idx, withStep(e))) }); // never throws
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
    void send(t.intro.prompts[chip], { model: chip === 'incognito' ? cfg.incognitoModel : cfg.model, tamper: TAMPER_OF[chip] ?? false });
  }

  // What the next message will leave behind for lack of room in one request, by what is typed so far to the model
  // chosen now. A retry of an earlier message sends that message's own text, which can leave behind a few more.
  const behind = leftBehind(turns, model, cfg.model, input);

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
        <span className="switches muted">
          <label><input type="checkbox" checked={tamper === 'key'} onChange={(e) => setTamper(e.target.checked && 'key')} disabled={busy} /> {t.tamper}</label>
          <label><input type="checkbox" checked={tamper === 'deployment'} onChange={(e) => setTamper(e.target.checked && 'deployment')} disabled={busy} /> {t.tamperDeployment}</label>
          {/* Not a demo: the viewer's own rule. Where the site has it on, the box only shows that. */}
          <label><input type="checkbox" checked={releaseRule} onChange={(e) => setRuleUnsaved(saveOwnReleaseRule(cfg, e.target.checked) ? null : e.target.checked ? 'on' : 'off')} disabled={busy || cfg.requireLoggedRelease} /> {t.releaseSwitch}</label>
        </span>
      </div>
      {ruleUnsaved && <p className="small trust-bad" role="alert">{ruleUnsaved === 'on' ? t.releaseSwitchUnsaved : t.log.trust.notSaved}</p>}
      {releaseRule && model === cfg.incognitoModel && <p className="muted small">{t.releaseSwitchIncognito}</p>}
      {hasOtherThread(turns, model, cfg.model) && <p className="muted small">{t.ownThread}</p>}
      {behind > 0 && <p className="muted small">{t.longThread(behind)}</p>}

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
          <input value={input} onChange={(e) => setInput(e.target.value)} aria-label={t.composerLabel} placeholder={model === cfg.incognitoModel ? t.placeholderIncognito : t.placeholder} disabled={busy} maxLength={4000} />
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
