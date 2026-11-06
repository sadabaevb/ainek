// What the owner reads in Telegram (SPEC §5.3 in plain text, no parse mode). Text the model wrote is flattened to one line and labelled as
// the model's: a forwarded injection must not be able to forge a line of the card above the approval buttons. The wording follows docs/CLAIMS.md: "attested deployment", "proof", and it says only what this service checked: before an action is
// proposed, the decision's signature and the attestation of the run that made it.
import { explorerTxUrl, shortHex as short, type Check, type ModelProof, type Verdict } from '@ainek/proof';
import type { Result } from './pipeline.ts';
import { fromMinimalUnits } from './units.ts';

export interface Card {
  /** Runs once the owner has received the card. */
  delivered?: () => Promise<void>;
  text: string;
  /** Set when the owner has to decide: the action to approve or reject. */
  approval: number | null;
}

/** One line, bounded, no control characters: for anything the model or a remote service wrote. */
const oneLine = (text: string, max = 300): string => {
  const flat = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};
const modelLine = (m: ModelProof): string => `Model: ${m.model}, attested deployment, E2EE, signed in its TEE; key #${m.logIndex} in the public log`;
const failedChecks = (checks: Check[]): string => checks.filter((c) => c.status === 'fail').map((c) => `- ${oneLine(c.detail)}`).join('\n');

export function renderCard(r: Result, cfg: { explorer: string; tokenDecimals: number }): Card {
  const plain = (text: string): Card => ({ text, approval: null });
  const txUrl = (tx: string): string => explorerTxUrl(cfg.explorer, tx);
  switch (r.kind) {
    case 'not-sent':
      return plain(`✗ Your message was not sent to the model (${r.step}): ${oneLine(r.reason)}\nNothing was proposed.`);
    case 'declined':
      return plain(`— No payment proposed. The model says: "${oneLine(r.reason)}"\n${modelLine(r.modelProof)}`);
    case 'bad-call':
      return plain(`— The model gave no usable payment, so nothing was proposed: ${oneLine(r.reason)}\n${modelLine(r.modelProof)}`);
    case 'decision-rejected':
      return plain(`✗ The policy's answer failed the local checks, so nothing was proposed and no gas was spent:\n${failedChecks(r.checks)}\n${modelLine(r.modelProof)}`);
    case 'failed':
      if (r.stage === 'after-propose') return plain(`✗ ${oneLine(r.reason)}`);
      return plain(`✗ Stopped at the ${r.stage} step: ${oneLine(r.reason)}\n${r.stage === 'chain' ? 'Check the account on the explorer before retrying: a transaction may have landed.' : 'Nothing was proposed.'}`);
    case 'proposed': {
      const { action, decision, proof } = { action: r.proof.action, decision: r.proof.decision, proof: r.proof };
      const v = decision.policy_version;
      const heads: Record<Verdict, string> = {
        Deny: `✗ Denied by policy v${v}. Nothing moved.`,
        NeedsApproval: `? Needs your approval (policy v${v}). Nothing moved yet.`,
        Allow: r.transfer === 'executed' ? `✓ Allowed by policy v${v} and executed.` : r.transfer === 'refused' ? `✗ Allowed by policy v${v}, but the token refused the transfer. Nothing moved, and the amount no longer counts toward today's total.` : `? Allowed by policy v${v}, but the contract reported no execution in this transaction. Check the link below.`,
      };
      const commits = [proof.commitTx ? `action proof ${txUrl(proof.commitTx)}` : null, r.modelProof.commitTx ? `model proof ${txUrl(r.modelProof.commitTx)}` : null].filter(Boolean).join(', ');
      return {
        text: [
          heads[decision.verdict],
          `Payment: ${fromMinimalUnits(action.amount, cfg.tokenDecimals)} ${action.token_id} to ${action.receiver_id}`,
          ...(r.purpose ? [`Purpose, in the model's words: "${oneLine(r.purpose, 200)}"`] : []),
          modelLine(r.modelProof),
          `Decision: signature verifies under the registered policy key ${short(proof.teePubkey)}, policy hash ${short(decision.policy_hash)}; the run was checked: published build, quote signed by Intel: ${proof.attestationUrl}`,
          `Contract: action #${proof.actionId}, ${txUrl(proof.proposeTx)}`,
          `Salted commits on NEAR: ${commits}`,
          ...(r.commitError ? [`Action proof not committed: ${oneLine(r.commitError)}. The action itself is on-chain, see above`] : []),
          ...(r.saveError ? [`The commit landed, but the proof file could not be updated with it: ${oneLine(r.saveError)}. The salt is saved`] : []),
        ].join('\n'),
        approval: decision.verdict === 'NeedsApproval' ? proof.actionId : null,
      };
    }
  }
}
