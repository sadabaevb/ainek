// Token amounts as digit strings: the owner writes "12.5", the chain wants minimal units. No floats anywhere.

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
