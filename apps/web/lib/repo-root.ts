// Server-only: the monorepo root (the directory holding pnpm-workspace.yaml), for reading docs/samples.
import { existsSync } from 'node:fs';
import path from 'node:path';

export function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('pnpm-workspace.yaml not found above ' + process.cwd());
    dir = parent;
  }
}
