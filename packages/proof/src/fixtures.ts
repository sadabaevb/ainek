// Test-only loader for the recorded samples in docs/samples and docs/test-vectors (repo root = ../../..).
import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);

export function readRepoFile(path: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(path, root)));
}

export function readRepoJson<T = unknown>(path: string): T {
  return JSON.parse(new TextDecoder().decode(readRepoFile(path))) as T;
}
