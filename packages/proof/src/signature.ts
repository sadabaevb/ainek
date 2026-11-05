// Local signature check over `signedText`, the same text NEAR AI's TEE signed (SPEC §5.1).
//   ed25519: `signing_address` IS the 32-byte public key (hex); signature is 64 bytes (hex, no 0x).
//   ecdsa:   EIP-191 personal_sign; `signing_address` is the 20-byte Ethereum address; recover with ethers.
import nacl from 'tweetnacl';
import { verifyMessage } from 'ethers';
import { hexToBytes, normalizeHex, stripHexPrefix, utf8Bytes } from './hash.ts';
import type { SigningAlgo } from './schema.ts';

export interface SignatureCheck {
  ok: boolean;
  detail: string;
}

export function verifySignedText(input: {
  signedText: string;
  signature: string;
  signingAddress: string;
  signingAlgo: SigningAlgo;
}): SignatureCheck {
  try {
    if (input.signingAlgo === 'ed25519') return verifyEd25519(input.signedText, input.signature, input.signingAddress);
    return verifyEcdsa(input.signedText, input.signature, input.signingAddress);
  } catch (err) {
    return { ok: false, detail: `signature could not be checked: ${(err as Error).message}` };
  }
}

function verifyEd25519(signedText: string, signature: string, signingAddress: string): SignatureCheck {
  const publicKey = hexToBytes(signingAddress);
  if (publicKey.length !== 32) return { ok: false, detail: `ed25519 signing_address must be 32 bytes, got ${publicKey.length}` };
  const sig = decodeSignature(signature);
  if (sig.length !== 64) return { ok: false, detail: `ed25519 signature must be 64 bytes, got ${sig.length}` };
  const ok = nacl.sign.detached.verify(utf8Bytes(signedText), sig, publicKey);
  return ok
    ? { ok: true, detail: `ed25519 signature verifies under ${signingAddress.slice(0, 8)}…` }
    : { ok: false, detail: 'ed25519 signature does not verify under signing_address' };
}

function verifyEcdsa(signedText: string, signature: string, signingAddress: string): SignatureCheck {
  const sig = `0x${stripHexPrefix(signature)}`;
  const recovered = normalizeHex(verifyMessage(signedText, sig));
  const expected = normalizeHex(signingAddress);
  return recovered === expected
    ? { ok: true, detail: `ecdsa signer ${recovered.slice(0, 10)}… matches signing_address` }
    : { ok: false, detail: `ecdsa signer ${recovered} differs from signing_address ${expected}` };
}

/** NEAR AI returns hex; accept base64 too, as SPEC §5.1 says "as returned". */
export function decodeSignature(signature: string): Uint8Array {
  const clean = stripHexPrefix(signature);
  if (/^[0-9a-fA-F]+$/.test(clean) && clean.length % 2 === 0) return hexToBytes(clean);
  return Uint8Array.from(Buffer.from(signature, 'base64'));
}
