import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from './providers';

export const metadata = { title: 'Ainek', description: 'Glass box for private AI agents on NEAR' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="nav">
          <Link href="/" className="brand">Ainek</Link>
          <Link href="/log">Log</Link>
          <Link href="/verify">Verify</Link>
          <Link href="/trust">Trust</Link>
        </nav>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
