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

/** One guarantee line; `hint` is the plain-language explanation shown when the card's "What do these rows mean?" is open. */
export function Row({ status, label, hint, children }: { status: Exclude<Status, 'running'>; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className={`row ${status}`}>
      <span className="mark" aria-hidden>{mark(status)}</span>
      <span className="label">{label}</span>
      <span className="value">{children}</span>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
