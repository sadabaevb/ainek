export { shortHex as short } from '@ainek/proof';

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
