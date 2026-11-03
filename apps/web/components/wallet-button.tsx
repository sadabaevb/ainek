'use client';
// One wallet control for the whole app (nav): login adds a function-call key limited to commit_proof.
import { useNearWallet } from 'near-connect-hooks';
import { useConfig, useT } from '@/app/providers';
import { fcKeyLogin } from '@/lib/wallet';

export function WalletButton() {
  const cfg = useConfig();
  const { t } = useT();
  const { signedAccountId, signIn, signOut, loading } = useNearWallet();
  if (signedAccountId) {
    return (
      <span className="muted small wallet">
        <span className="mono">{signedAccountId}</span> <button type="button" className="btn small" onClick={() => void signOut()}>{t.disconnect}</button>
      </span>
    );
  }
  return (
    <button type="button" className="btn small" onClick={() => void fcKeyLogin(signIn, cfg)} disabled={loading}>{t.connectWallet}</button>
  );
}
