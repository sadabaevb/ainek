'use client';
// One wallet control for the whole app (nav): login adds a function-call key limited to commit_proof.
import { useNearWallet } from 'near-connect-hooks';
import { useConfig, useT } from '@/app/providers';
import { short } from '@/lib/format';
import { fcKeyLogin } from '@/lib/wallet';

/** Implicit (hex) accounts are 64 characters; named ones are short enough to show whole. */
const shortAccount = (id: string) => (id.length > 24 ? short(id) : id);

export function WalletButton() {
  const cfg = useConfig();
  const { t } = useT();
  const { signedAccountId, signIn, signOut, loading } = useNearWallet();
  if (signedAccountId) {
    return (
      <span className="wallet">
        <span className="dot ok" aria-hidden />
        <span className="mono" title={signedAccountId}>{shortAccount(signedAccountId)}</span>
        <button type="button" className="btn small" onClick={() => void signOut()}>{t.disconnect}</button>
      </span>
    );
  }
  return (
    <button type="button" className="btn small" onClick={() => void fcKeyLogin(signIn, cfg)} disabled={loading}>{t.connectWallet}</button>
  );
}
