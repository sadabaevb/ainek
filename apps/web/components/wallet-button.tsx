'use client';
// One wallet control for the whole app (nav): login asks for a function-call key limited to commit_proof.
import { useState } from 'react';
import { useNearWallet } from 'near-connect-hooks';
import { useConfig, useT } from '@/app/providers';
import { describeError } from '@/lib/errors';
import { short } from '@/lib/format';
import { fcKeyLogin, isDialogClosed } from '@/lib/wallet';

/** Implicit (hex) accounts are 64 characters; named ones show whole. */
const shortAccount = (id: string) => (/^[0-9a-f]{64}$/.test(id) ? short(id) : id);

export function WalletButton() {
  const cfg = useConfig();
  const { t } = useT();
  const { signedAccountId, signIn, signOut, loading } = useNearWallet();
  const [failed, setFailed] = useState('');
  // Closing the wallet's dialog or window is a choice, not a failure: nothing to report. Anything else is said out loud.
  const attempt = (action: () => Promise<void>) => {
    setFailed('');
    action().catch((err: unknown) => {
      if (!isDialogClosed(err)) setFailed(describeError(err));
    });
  };
  return (
    <>
      {signedAccountId ? (
        <span className="wallet">
          <span className="dot ok" aria-hidden />
          <span className="mono" title={signedAccountId}>{shortAccount(signedAccountId)}</span>
          <button type="button" className="btn small" onClick={() => attempt(signOut)}>{t.disconnect}</button>
        </span>
      ) : (
        <button type="button" className="btn small" onClick={() => attempt(() => fcKeyLogin(signIn, cfg))} disabled={loading}>{t.connectWallet}</button>
      )}
      {failed && <p className="wallet-error" role="alert">{t.walletFailed(failed)}</p>}
    </>
  );
}
