// One place for the ✓ / ✗ / — glyphs and the check list used by the chat steps, the card and /verify.
import type { ReactNode } from 'react';

export type Status = 'ok' | 'fail' | 'skipped' | 'running';

const MARK: Record<Status, string> = { ok: '✓', fail: '✗', skipped: '—', running: '…' };

export function mark(status: Status): string {
  return MARK[status];
}

export function CheckList({ items }: { items: ReadonlyArray<{ id: string; status: Status; detail: string }> }) {
  return (
    <ul className="mono checks">
      {items.map((c) => (
        <li key={c.id} className={c.status}>{mark(c.status)} {c.id}: {c.detail}</li>
      ))}
    </ul>
  );
}

export function Row({ status, label, children }: { status: Exclude<Status, 'running'>; label: string; children: ReactNode }) {
  return (
    <div className={`row ${status}`}>
      <span className="mark" aria-hidden>{mark(status)}</span>
      <span className="label">{label}</span>
      <span className="value">{children}</span>
    </div>
  );
}
