import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';
import { LangToggle } from '@/components/lang-toggle';
import { NavLinks } from '@/components/nav-links';
import { WalletButton } from '@/components/wallet-button';
import { readPublicConfig } from '@/lib/config.server';
import { Providers } from './providers';

export const metadata = { title: 'Ainek', description: 'Glass box for private AI agents on NEAR' };
// Config comes from the root .env at request time (loaded by instrumentation.ts), so the layout cannot be prerendered.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  const config = readPublicConfig();
  return (
    <html lang="en">
      <body>
        <Providers config={config}>
          <nav className="nav">
            <Link href="/" className="brand">Ainek</Link>
            <NavLinks />
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
