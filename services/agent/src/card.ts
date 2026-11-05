// What the owner reads in Telegram (SPEC §5.3 in plain text; no parse mode, so a memo cannot break the formatting). The wording
// follows docs/CLAIMS.md: "attested deployment", "proof", and a denial is the policy's signed decision, not the bot's opinion.
import { shortHex as short, type Action, type Check, type ModelProof } from '@ainek/proof';
import { fromMinimalUnits } from './llm.ts';
import type { Result } from './pipeline.ts';

export interface CardConfig {
  explorer: string;
  tokenDecimals: number;
}
export interface Card {
  text: string;
  /** Set when the owner has to decide: the action to approve or reject. */
  approval: number | null;
}

const txUrl = (cfg: CardConfig, tx: string): string => `${cfg.explorer}/txns/${tx}`;
const payment = (cfg: CardConfig, a: Action): string => `${fromMinimalUnits(a.amount, cfg.tokenDecimals)} ${a.token_id} to ${a.receiver_id}${a.memo ? ` ("${a.memo}")` : ''}`;
const modelLine = (m: ModelProof): string => `Model: ${m.model}, attested deployment, E2EE, signed in its TEE; key #${m.logIndex} in the public log`;
const failedChecks = (checks: Check[]): string => checks.filter((c) => c.status === 'fail').map((c) => `- ${c.detail}`).join('\n');

export function renderCard(r: Result, cfg: CardConfig): Card {
  const plain = (text: string): Card => ({ text, approval: null });
  switch (r.kind) {
    case 'not-sent':
      return plain(`✗ Not sent to the model (${r.step}): ${r.reason}\nNothing left this service and nothing was proposed.`);
    case 'declined':
      return plain(`— No payment proposed: ${r.reason}\n${modelLine(r.modelProof)}`);
    case 'bad-call':
      return plain(`— The model gave no usable payment, so nothing was proposed: ${r.reason}\n${modelLine(r.modelProof)}`);
    case 'decision-rejected':
      return plain(`✗ The policy's answer failed the local checks, so nothing was proposed and no gas was spent:\n${failedChecks(r.checks)}\n${modelLine(r.modelProof)}`);
    case 'failed':
      return plain(`✗ Stopped at the ${r.stage} step: ${r.reason}${r.stage === 'chain' ? '\nCheck the account on the explorer before retrying: a transaction may have landed.' : '\nNothing was proposed.'}`);
    case 'proposed': {
      const { action, decision } = r.proof;
      const head =
        r.verdict === 'Deny'
          ? `✗ Denied by policy v${decision.policy_version}. Nothing moved.`
          : r.verdict === 'NeedsApproval'
            ? `? Needs your approval (policy v${decision.policy_version}). Nothing moved yet.`
            : r.executed
              ? `✓ Allowed by policy v${decision.policy_version} and executed.`
              : `? Allowed by policy v${decision.policy_version}, but the contract reported no execution in this transaction. Check the link below.`;
      const commits = [r.commitTx ? `action proof ${txUrl(cfg, r.commitTx)}` : null, r.modelCommitTx ? `model proof ${txUrl(cfg, r.modelCommitTx)}` : null].filter(Boolean).join(', ');
      return {
        text: [
          head,
          `Payment: ${payment(cfg, action)}`,
          modelLine(r.modelProof),
          `Decision: signed in the OutLayer TEE by key ${short(r.proof.teePubkey)}, build ${short(r.proof.wasmHash)}, policy hash ${short(decision.policy_hash)}; attestation ${r.proof.attestationUrl}`,
          `Contract: action #${r.actionId}, ${txUrl(cfg, r.proposeTx)}`,
          ...(commits ? [`Salted commits on NEAR: ${commits}`] : []),
          ...(r.commitError ? [`Not committed: ${r.commitError}. The action itself is on-chain, see above`] : []),
        ].join('\n'),
        approval: r.verdict === 'NeedsApproval' ? r.actionId : null,
      };
    }
  }
}
