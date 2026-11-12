'use client';
// One place for the ✓ / ✗ / — glyphs and the check list used by the chat steps, the card and /verify. The details are
// English whatever the UI language (they come from @ainek/proof), hence lang="en" on the list.
import type { ReactNode } from 'react';
import { useT } from '@/app/providers';

export type Status = 'ok' | 'fail' | 'skipped' | 'running';

const MARK: Record<Status, string> = { ok: '✓', fail: '✗', skipped: '—', running: '…' };

export function mark(status: Status): string {
  return MARK[status];
}

/**
 * The mark of a line with its word for a screen reader. The stylesheet draws the shape and gives it a colour, which only
 * the eye gets; the word says the same to whoever listens to the page. `lang` because the word is in the language of the
 * interface, and the check lists it stands in are marked as English.
 */
function StatusMark({ status, className }: { status: Status; className: string }) {
  const { t, lang } = useT();
  return <span className={className} role="img" aria-label={t.status[status]} lang={lang}>{mark(status)}</span>;
}

/** One line of a check list: the mark in its own column, so a second line of the text stays clear of it. */
export function CheckLine({ status, children }: { status: Status; children: ReactNode }) {
  return (
    <li className={`check ${status}`}>
      <StatusMark status={status} className={`tick ${status}`} />
      <span>{children}</span>
    </li>
  );
}

export function CheckList({ items }: { items: ReadonlyArray<{ id: string; status: Status; detail: string }> }) {
  return (
    <ul className="mono checks" lang="en">
      {items.map((c) => <CheckLine key={c.id} status={c.status}>{c.id}: {c.detail}</CheckLine>)}
    </ul>
  );
}

/** The head of a result card: the verdict as a stamp. Tone and glyph follow the status, so a card can never look green by omission. */
export function CardHead({ status, when, children }: { status: 'ok' | 'fail'; when?: ReactNode; children: ReactNode }) {
  return (
    <header className={`card-head ${status}`}>
      <span className="stamp"><span className={`tick ${status}`} aria-hidden>{mark(status)}</span> {children}</span>
      {when !== undefined && <span className="when">{when}</span>}
    </header>
  );
}

/**
 * One guarantee line; `hint` is the plain-language explanation shown when the card's "What do these rows mean?" is open. `as="span"`
 * for a line inside a <summary>, which may hold phrasing content only. A line still being checked is drawn in the neutral tone.
 * `detail` is block content under the value (a list of checks); the value is a span and cannot hold one. Not with `as="span"`.
 */
export function Row({ status, label, hint, detail, as: Tag = 'div', children }: { status: Status; label: string; hint?: string; detail?: ReactNode; as?: 'div' | 'span'; children: ReactNode }) {
  return (
    <Tag className="row">
      <StatusMark status={status} className={`mark ${status === 'running' ? 'skipped' : status}`} />
      <span className="label">{label}</span>
      <span className="value">{children}</span>
      {detail && <div className="detail">{detail}</div>}
      {hint && <span className="hint">{hint}</span>}
    </Tag>
  );
}

/** The first of fail, skipped, ok that any line has; `running` while there are no lines yet. */
export function worstStatus(lines: ReadonlyArray<{ status: Exclude<Status, 'running'> }> | undefined): Status {
  if (!lines) return 'running';
  return lines.some((l) => l.status === 'fail') ? 'fail' : lines.some((l) => l.status === 'skipped') ? 'skipped' : 'ok';
}
