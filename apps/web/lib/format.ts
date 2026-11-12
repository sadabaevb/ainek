export { shortHex as short } from '@ainek/proof';

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** `2026-11-04 04:42 UTC` from an ISO timestamp: minute precision is enough for a card. */
export function utcMinute(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

/** Milliseconds since epoch at minute precision, UTC. */
export function utcMinuteOf(ms: number): string {
  return utcMinute(new Date(ms).toISOString());
}

/** A log entry's `observed_at` (ms since epoch, as a U64 string) at minute precision, UTC. */
export function observedUtc(observedAtMs: string): string {
  return utcMinuteOf(Number(observedAtMs));
}

/** Clamped at zero: the verifier's clock may run slightly ahead of this browser's. */
export function hoursSince(observedAtMs: string): string {
  return (Math.max(0, Date.now() - Number(observedAtMs)) / 3_600_000).toFixed(1);
}

/** Whole minutes in a span of ms, rounded down and never negative: an age shown this way is never more than it is. */
export function wholeMinutes(ms: number): number {
  return Math.max(0, Math.floor(ms / 60_000));
}
