export function short(hex: string): string {
  return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : hex;
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
