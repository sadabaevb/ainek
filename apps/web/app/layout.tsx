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
      <body>
        <Providers config={config} lang={lang}>
          <header className="nav">
            <div className="nav-inner">
              <Link href="/" className="brand"><Logo /> Ainek</Link>
              <NavLinks />
              <span className="right">
                <WalletButton />
                <LangToggle />
              </span>
            </div>
          </header>
          {children}
        </Providers>
      </body>
    </html>
  );
}
