// The key log as recorded in docs/samples (one sample entry), used until the contract is deployed
// (AINEK_LOG_SOURCE=sample). The browser applies the same trust rule to it as to the live log.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { repoRoot } from '@/lib/repo-root';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const file = path.join(repoRoot(), 'docs', 'samples', 'key-entry.sample.json');
  const { entry } = JSON.parse(await readFile(file, 'utf8')) as { entry: unknown };
  return NextResponse.json({ entries: [entry], source: 'sample' });
}
