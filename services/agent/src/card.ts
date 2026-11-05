// What the owner reads in Telegram (SPEC §5.3 in plain text; no parse mode, so a purpose cannot break the formatting). The wording
// follows docs/CLAIMS.md: "attested deployment", "proof", and it says only what this service checked. It verifies the decision's
// signature; it does not read the attestation behind the URL.
import { explorerTxUrl, shortHex as short, type Check, type ModelProof, type Verdict } from '@ainek/proof';
import type { Result } from './pipeline.ts';
import { fromMinimalUnits } from './units.ts';

export interface Card {
  text: string;
  /** Set when the owner has to decide: the action to approve or reject. */
  approval: number | null;
}

const modelLine = (m: ModelProof): string => `Model: ${m.model}, attested deployment, E2EE, signed in its TEE; key #${m.logIndex} in the public log`;
const failedChecks = (checks: Check[]): string => checks.filter((c) => c.status === 'fail').map((c) => `- ${c.detail}`).join('\n');

export function renderCard(r: Result, cfg: { explorer: string; tokenDecimals: number }): Card {
  const plain = (text: string): Card => ({ text, approval: null });
  const txUrl = (tx: string): string => explorerTxUrl(cfg.explorer, tx);
  switch (r.kind) {
    case 'not-sent':
      return plain(`✗ Your message was not sent to the model (${r.step}): ${r.reason}\nNothing was proposed.`);
    case 'declined':
      return plain(`— No payment proposed: ${r.reason}\n${modelLine(r.modelProof)}`);
    case 'bad-call':
      return plain(`— The model gave no usable payment, so nothing was proposed: ${r.reason}\n${modelLine(r.modelProof)}`);
    case 'decision-rejected':
      return plain(`✗ The policy's answer failed the local checks, so nothing was proposed and no gas was spent:\n${failedChecks(r.checks)}\n${modelLine(r.modelProof)}`);
    case 'failed':
      if (r.stage === 'after-propose') return plain(`✗ ${r.reason}`);
      return plain(`✗ Stopped at the ${r.stage} step: ${r.reason}\n${r.stage === 'chain' ? 'Check the account on the explorer before retrying: a transaction may have landed.' : 'Nothing was proposed.'}`);
    case 'proposed': {
      const { action, decision, proof } = { action: r.proof.action, decision: r.proof.decision, proof: r.proof };
      const v = decision.policy_version;
      const heads: Record<Verdict, string> = {
        Deny: `✗ Denied by policy v${v}. Nothing moved.`,
        NeedsApproval: `? Needs your approval (policy v${v}). Nothing moved yet.`,
        Allow: proof.executeTx ? `✓ Allowed by policy v${v} and executed.` : `? Allowed by policy v${v}, but the contract reported no execution in this transaction. Check the link below.`,
      };
      const commits = [proof.commitTx ? `action proof ${txUrl(proof.commitTx)}` : null, r.modelProof.commitTx ? `model proof ${txUrl(r.modelProof.commitTx)}` : null].filter(Boolean).join(', ');
      return {
        text: [
          heads[decision.verdict],
          `Payment: ${fromMinimalUnits(action.amount, cfg.tokenDecimals)} ${action.token_id} to ${action.receiver_id}${r.purpose ? ` ("${r.purpose}")` : ''}`,
          modelLine(r.modelProof),
          `Decision: signature verifies under the registered policy key ${short(proof.teePubkey)}, policy hash ${short(decision.policy_hash)}; attestation (not checked by this service): ${proof.attestationUrl}`,
          `Contract: action #${proof.actionId}, ${txUrl(proof.proposeTx)}`,
          `Salted commits on NEAR: ${commits}`,
          ...(r.commitError ? [`Action proof not committed: ${r.commitError}. The action itself is on-chain, see above`] : []),
        ].join('\n'),
        approval: decision.verdict === 'NeedsApproval' ? proof.actionId : null,
      };
    }
  }
}
