// One place for the ✓ / ✗ / — glyphs and the check list used by the chat steps, the card and /verify. The details are
// English whatever the UI language (they come from @ainek/proof), hence lang="en" on the list.
import type { ReactNode } from 'react';

export type Status = 'ok' | 'fail' | 'skipped' | 'running';

const MARK: Record<Status, string> = { ok: '✓', fail: '✗', skipped: '—', running: '…' };

export function mark(status: Status): string {
  return MARK[status];
}

export function CheckList({ items }: { items: ReadonlyArray<{ id: string; status: Status; detail: string }> }) {
  return (
    <ul className="mono checks" lang="en">
      {items.map((c) => (
        <li key={c.id} className={c.status}>{mark(c.status)} {c.id}: {c.detail}</li>
      ))}
    </ul>
  );
}

/** The strip at the top of a result card: tone and glyph follow the status, so a card can never look green by omission. */
export function CardHead({ status, when, children }: { status: 'ok' | 'fail'; when?: ReactNode; children: ReactNode }) {
  return (
    <header className={`card-head ${status}`}>
      <span>{mark(status)} {children}</span>
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
    <Tag className={`row ${status === 'running' ? 'skipped' : status}`}>
      <span className="mark" aria-hidden>{mark(status)}</span>
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
