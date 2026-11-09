// A NEP-141 token as the agent, the CLI and the pages read it. Amounts are digit strings: the owner writes "12.5", the chain wants
// minimal units. No floats anywhere.
import { viewFunction } from './near-view.ts';
import { u128String } from './schema.ts';

/** "12.5" with 6 decimals → "12500000". More fractional digits than the token has is an error, not a rounding, and zero is not a payment. */
export function toMinimalUnits(amount: string, decimals: number): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!m) throw new Error(`amount "${amount}" is not a decimal number`);
  const whole = m[1] ?? '0';
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`amount "${amount}" has more than ${decimals} decimals`);
  const units = (whole + frac.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '');
  if (units === '0') throw new Error('amount must be positive');
  return units;
}

/** "12500000" with 6 decimals → "12.5", for the card. */
export function fromMinimalUnits(units: string, decimals: number): string {
  const padded = units.padStart(decimals + 1, '0');
  const at = padded.length - decimals;
  const fraction = padded.slice(at).replace(/0+$/, '');
  return fraction ? `${padded.slice(0, at)}.${fraction}` : padded.slice(0, at);
}

/** The token's short name for a card. It only labels an amount, so anything unusable falls back to the account id instead of failing, and it cannot carry a forged line into the card. */
export function tokenSymbolOf(metadata: unknown, tokenId: string): string {
  const symbol = (metadata as { symbol?: unknown } | null | undefined)?.symbol;
  return typeof symbol === 'string' && /^[\p{L}\p{N}._-]{1,16}$/u.test(symbol) ? symbol : tokenId;
}

/** `decimals` from the token's NEP-148 `ft_metadata`. */
export function tokenDecimalsOf(metadata: unknown): number {
  const decimals = (metadata as { decimals?: unknown } | null | undefined)?.decimals;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 24) throw new Error(`the token reports no usable decimals in ft_metadata (${String(decimals)})`);
  return decimals;
}

export interface TokenInfo {
  decimals: number;
  symbol: string;
}

/** The chain's own answer, not a config value: on a wrong scale an amount would still read "300" while the transfer was off by orders of magnitude. */
export async function readTokenInfo(rpcUrl: string, tokenId: string, signal?: AbortSignal): Promise<TokenInfo> {
  const metadata = await viewFunction(rpcUrl, tokenId, 'ft_metadata', {}, signal);
  return { decimals: tokenDecimalsOf(metadata), symbol: tokenSymbolOf(metadata, tokenId) };
}

/** "400 AINEK": minimal units scaled by the token's own decimals, with its short name. */
export function tokenAmountText(units: string, token: TokenInfo): string {
  return `${fromMinimalUnits(units, token.decimals)} ${token.symbol}`;
}

/** `ft_balance_of(account_id)` in minimal units. An account the token has never seen holds "0". */
export async function readTokenBalance(rpcUrl: string, tokenId: string, accountId: string, signal?: AbortSignal): Promise<string> {
  return u128String.parse(await viewFunction(rpcUrl, tokenId, 'ft_balance_of', { account_id: accountId }, signal));
}
