// Secrets live in ONE file, .env at the repo root (CLAUDE.md "No secrets in git"; .env.example lists every
// variable). Next.js only reads apps/web/.env*, so we load the root file here with Node's own parser.
// Variables already present in the environment keep precedence over the file.
import { existsSync } from 'node:fs';
import path from 'node:path';

let dir = process.cwd(); // apps/web when started through pnpm
for (;;) {
  if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const envFile = path.join(dir, '.env');
    if (existsSync(envFile)) process.loadEnvFile(envFile);
    break;
  }
  const parent = path.dirname(dir);
  if (parent === dir) break; // not inside the monorepo: rely on the environment only
  dir = parent;
}
