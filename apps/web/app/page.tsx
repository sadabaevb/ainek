'use client';
// Chat with a proof card per reply. The page only renders; lib/flow.ts does the work step by step.
import { useEffect, useRef, useState } from 'react';
import { ProofCard } from '@/components/proof-card';
import { getConfig } from '@/lib/config';
import { runChat, type ChatMessage, type ChatOutcome, type StepEvent } from '@/lib/flow';
import { useLang } from '@/lib/i18n';

interface Turn {
  message: ChatMessage;
  outcome?: ChatOutcome;
  steps?: StepEvent[];
}

export default function ChatPage() {
  const [lang, t, toggleLang] = useLang();
  const [models, setModels] = useState<{ tee: string; incognito: string } | null>(null);
  const [model, setModel] = useState('');
  const [tamper, setTamper] = useState(false);
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getConfig().then((c) => {
      setModels({ tee: c.model, incognito: c.incognitoModel });
      setModel(c.model);
    }).catch(() => setModels({ tee: 'z-ai/glm-5.3-flash', incognito: 'anthropic/claude-haiku-5-5' }));
    setTamper(new URLSearchParams(window.location.search).get('tamper') === '1');
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  async function send() {
    const content = input.trim();
    if (!content || busy || !model) return;
    setInput('');
    setBusy(true);
    const history: ChatMessage[] = turns.flatMap((x) => (x.outcome && 'reply' in x.outcome ? [x.message, { role: 'assistant' as const, content: x.outcome.reply }] : []));
    const messages = [...history, { role: 'user' as const, content }];
    const idx = turns.length;
    setTurns((prev) => [...prev, { message: { role: 'user', content }, steps: [] }]);
    const onStep = (e: StepEvent) =>
      setTurns((prev) => prev.map((turn, i) => (i === idx ? { ...turn, steps: upsert(turn.steps ?? [], e) } : turn)));
    try {
      const outcome = await runChat({ model, messages, tamper, onStep });
      setTurns((prev) => prev.map((turn, i) => (i === idx ? { ...turn, outcome } : turn)));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setTurns((prev) => prev.map((turn, i) => (i === idx ? { ...turn, outcome: { kind: 'failed', step: 'send', reason } } : turn)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <header className="top">
        <div>
          <h1>{t.title}</h1>
          <p className="muted">{t.tagline}</p>
        </div>
        <button type="button" className="btn small" onClick={toggleLang} aria-label="language">{t.lang}</button>
      </header>

      <div className="controls">
        <label>
          {t.model}{' '}
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!models || busy}>
            {models && <option value={models.tee}>{models.tee} · {t.teeModel}</option>}
            {models && <option value={models.incognito}>{models.incognito} · {t.incognitoModel}</option>}
          </select>
        </label>
        <label className="muted">
          <input type="checkbox" checked={tamper} onChange={(e) => setTamper(e.target.checked)} disabled={busy} /> {t.tamper}
        </label>
      </div>

      <section className="thread">
        {turns.map((turn, i) => (
          <article key={i} className="turn">
            <div className="bubble user"><span className="who">{t.you}</span>{turn.message.content}</div>
            {turn.steps && turn.steps.length > 0 && (
              <details className="steps" open={!turn.outcome}>
                <summary>{t.steps}</summary>
                <ul className="mono">
                  {turn.steps.map((s) => (
                    <li key={s.id} className={s.status}>{s.status === 'ok' ? '✓' : s.status === 'fail' ? '✗' : s.status === 'skipped' ? '—' : '…'} {s.id}: {s.detail}</li>
                  ))}
                </ul>
              </details>
            )}
            {turn.outcome && 'reply' in turn.outcome && (
              <div className="bubble assistant"><span className="who">{t.assistant}</span>{turn.outcome.reply}</div>
            )}
            {turn.outcome && <ProofCard outcome={turn.outcome} t={t} />}
          </article>
        ))}
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
      <p className="muted small">lang={lang}</p>
    </main>
  );
}

function upsert(steps: StepEvent[], e: StepEvent): StepEvent[] {
  const i = steps.findIndex((s) => s.id === e.id);
  if (i === -1) return [...steps, e];
  return steps.map((s, j) => (j === i ? e : s));
}
