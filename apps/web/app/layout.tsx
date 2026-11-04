import { cookies } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';
import { LangToggle } from '@/components/lang-toggle';
import { WalletButton } from '@/components/wallet-button';
import { readPublicConfig } from '@/lib/config.server';
import { LANG_COOKIE, dict, type Lang } from '@/lib/i18n';
import { Providers } from './providers';

export const metadata = { title: 'Ainek', description: 'Glass box for private AI agents on NEAR' };
// Config comes from the root .env at request time (loaded by instrumentation.ts), so the layout cannot be prerendered.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const config = readPublicConfig();
  // The language lives in a cookie so the server renders the right one: no flash of English, no client-only nav.
  const lang: Lang = (await cookies()).get(LANG_COOKIE)?.value === 'ru' ? 'ru' : 'en';
  const nav = dict[lang].nav;
  return (
    <html lang={lang}>
      <body>
        <Providers config={config} lang={lang}>
          <nav className="nav">
            <Link href="/" className="brand">Ainek</Link>
            <Link href="/log">{nav.log}</Link>
            <Link href="/verify">{nav.verify}</Link>
            <Link href="/auditor">{nav.auditor}</Link>
            <Link href="/trust">{nav.trust}</Link>
            <span className="right">
              <WalletButton />
              <LangToggle />
            </span>
          </nav>
          {children}
        </Providers>
      </body>
    </html>
  );
}
