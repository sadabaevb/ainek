'use client';

// Client-side providers. NearProvider (near-connect-hooks) owns one NearConnector instance
// (@hot-labs/near-connect): wallets are loaded from a public manifest into sandboxed iframes, so we
// install no wallet-specific packages. Testnet only (CLAUDE.md "Testnet first").
import { NearProvider } from 'near-connect-hooks';
import type { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  return <NearProvider config={{ network: 'testnet' }}>{children}</NearProvider>;
}
