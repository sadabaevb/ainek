// Hashing and byte helpers that work in Node and in the browser (ethers' sha256 is pure JS).
import { sha256 as ethersSha256 } from 'ethers';

const encoder = new TextEncoder();

export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** SHA-256 of raw bytes, or of the UTF-8 encoding of a string. Returns lowercase hex without 0x. */
export function sha256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? utf8Bytes(data) : data;
  return ethersSha256(bytes).slice(2);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** `0x`/`0X` prefix removed, otherwise unchanged. The one place this rule lives. */
export function stripHexPrefix(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

/** Canonical text form of a hex value for logging and comparison: no prefix, lowercase. */
export function normalizeHex(hex: string): string {
  return stripHexPrefix(hex).toLowerCase();
}

/** Accepts hex with or without 0x, any case. Throws on odd length or non-hex characters. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = stripHexPrefix(hex);
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(`not a hex string: ${hex.length > 40 ? hex.slice(0, 40) + '…' : hex}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function isHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** 32 random bytes as hex; used for proof salts. Uses WebCrypto (Node 24 and browsers). */
export function randomHex32(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** `5a0210f2…caff` for anything longer than 16 chars; shorter strings are returned as is. One format for card, CLI and verdicts. */
export function shortHex(hex: string): string {
  return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : hex;
}
