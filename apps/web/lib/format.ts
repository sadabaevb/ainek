export { shortHex as short } from '@ainek/proof';

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** `2026-11-04 04:42 UTC` from an ISO timestamp: minute precision is enough for a card. */
export function utcMinute(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}
