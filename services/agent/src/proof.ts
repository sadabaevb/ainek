// The action proof (SPEC §5.2): the action, the signed decision that let it through, where it happened on-chain, salted
// and committed the same way as a model proof (SPEC §4.2: commit = sha256(salt || canonical_json(proof without envelope))).
import { ActionProof, actionCommitOf, commitOf, randomHex32, type Action, type Decision } from '@ainek/proof';

export interface ActionProofInput {
  actionId: number;
  action: Action;
  modelProofCommit: string;
  decision: Decision;
  teeSignature: string;
  teePubkey: string;
  wasmHash: string;
  attestationUrl: string;
  proposeTx: string;
  executeTx: string | null;
  approver: string | null;
  /** 32-byte hex; drawn at random when omitted. Fixed only in tests. */
  salt?: string;
}

export type CommittedActionProof = ActionProof & { salt: string; commit: string };

export function buildActionProof(x: ActionProofInput): CommittedActionProof {
  const salt = x.salt ?? randomHex32();
  const payload = ActionProof.parse({
    v: 1,
    kind: 'action',
    actionId: x.actionId,
    action: x.action,
    actionCommit: actionCommitOf(x.action),
    modelProofCommit: x.modelProofCommit,
    decision: x.decision,
    teeSignature: x.teeSignature,
    teePubkey: x.teePubkey,
    wasmHash: x.wasmHash,
    attestationUrl: x.attestationUrl,
    proposeTx: x.proposeTx,
    executeTx: x.executeTx,
    approver: x.approver,
  });
  return { ...payload, salt, commit: commitOf(salt, payload) };
}
