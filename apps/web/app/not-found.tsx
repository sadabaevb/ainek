'use client';
// An address the site does not have, said in the site's own look and language. Without this file Next.js shows its own
// white page under our header.
import Link from 'next/link';
import { useT } from './providers';

export default function NotFound() {
  const { t } = useT();
  return (
    <main className="page">
      <p className="kicker">404</p>
      <h1>{t.notFound.title}</h1>
      <p className="muted">{t.notFound.body}</p>
      <div className="actions">
        <Link className="btn primary" href="/">{t.notFound.home}</Link>
      </div>
    </main>
  );
}
