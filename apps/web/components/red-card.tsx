'use client';
// A refusal or failure in its own red design: the crossed box of a failed line, the title, an optional body and optional
// English technical lines.
import type { ReactNode } from 'react';
import { useT } from '@/app/providers';
import { mark } from './checks';

export function RedCard({ title, body, note, action, lines }: { title: string; body?: string; note?: string; action?: ReactNode; lines?: ReactNode[] }) {
  const { t } = useT();
  return (
    <section className="card red">
      <h3><span className="mark fail" aria-hidden>{mark('fail')}</span><span>{title}</span></h3>
      {body && <p>{body}</p>}
      {note && <p className="muted small">{note}</p>}
      {action && <div className="actions">{action}</div>}
      {lines && (
        <details>
          <summary>{t.details}</summary>
          <ul className="mono" lang="en">{lines.map((line, i) => <li key={i}>{line}</li>)}</ul>
        </details>
      )}
    </section>
  );
}
