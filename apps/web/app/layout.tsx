import { cookies } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';
import { LangToggle } from '@/components/lang-toggle';
import { Logo } from '@/components/logo';
import { NavLinks } from '@/components/nav-links';
import { WalletButton } from '@/components/wallet-button';
import { readPublicConfig } from '@/lib/config.server';
import { LANG_COOKIE, type Lang } from '@/lib/i18n';
import { Providers } from './providers';

export const metadata = { title: 'Ainek', description: 'Glass box for private AI agents on NEAR' };
// Config comes from the root .env at request time (loaded by instrumentation.ts), so the layout cannot be prerendered.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const config = readPublicConfig();
  // The language lives in a cookie so the server renders the right one: no flash of English, no client-only nav.
  const lang: Lang = (await cookies()).get(LANG_COOKIE)?.value === 'ru' ? 'ru' : 'en';
  return (
    <html lang={lang}>
      <head>
        {/* The self-hosted font subsets, preloaded so the first paint does not reflow when they land. */}
        <link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        {lang === 'ru' && <link rel="preload" href="/fonts/inter-cyrillic.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />}
      </head>
      <body>
        <Providers config={config} lang={lang}>
          <nav className="nav">
            <div className="nav-inner">
              <Link href="/" className="brand"><Logo /> Ainek</Link>
              <NavLinks />
              <span className="right">
                <WalletButton />
                <LangToggle />
              </span>
            </div>
          </nav>
          {children}
        </Providers>
      </body>
    </html>
  );
}
