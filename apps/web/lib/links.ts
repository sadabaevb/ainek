import type { ModelProof } from '@ainek/proof';
import { bytesToBase64 } from '@ainek/proof';

/** NEAR AI Verification Center with a reply receipt in the fragment (docs.near.ai/cloud/verification/verification-center). */
export function verificationCenterUrl(proof: ModelProof): string {
  const receipt = {
    completionId: proof.completionId,
    model: proof.model,
    signatureKind: proof.signatureKind,
    signingAlgo: proof.signingAlgo,
    signingAddress: proof.signingAddress,
    signedText: proof.signedText,
    signature: proof.signature,
    verifiedAt: proof.verifiedAt,
  };
  const fragment = bytesToBase64(new TextEncoder().encode(JSON.stringify(receipt))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `https://cloud.near.ai/verify?model=${encodeURIComponent(proof.model)}#receipt=${fragment}`;
}

export function explorerTxUrl(explorer: string, tx: string): string {
  return `${explorer}/txns/${encodeURIComponent(tx)}`; // tx comes from a proof, i.e. from whoever wrote the file
}
