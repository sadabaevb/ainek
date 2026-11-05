'use client';
// A refusal or failure in its own red design: title with a warning glyph, optional body, optional English technical lines.
import type { ReactNode } from 'react';
import { useT } from '@/app/providers';

const WARN = (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
    <path d="M12 3 2.5 20h19L12 3Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <path d="M12 9v5M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export function RedCard({ title, body, lines }: { title: string; body?: string; lines?: ReactNode[] }) {
  const { t } = useT();
  return (
    <section className="card red">
      <h3>{WARN}<span>{title}</span></h3>
      {body && <p>{body}</p>}
      {lines && (
        <details>
          <summary>{t.details}</summary>
          <ul className="mono" lang="en">{lines.map((line, i) => <li key={i}>{line}</li>)}</ul>
        </details>
      )}
    </section>
  );
}
