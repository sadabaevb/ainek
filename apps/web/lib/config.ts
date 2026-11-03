import type { PublicConfig } from '@/app/api/config/route';

let cached: Promise<PublicConfig> | null = null;

export function getConfig(): Promise<PublicConfig> {
  cached ??= fetch('/api/config', { cache: 'no-store' }).then(async (r) => {
    if (!r.ok) throw new Error(`config: HTTP ${r.status}`);
    return (await r.json()) as PublicConfig;
  });
  return cached;
}
