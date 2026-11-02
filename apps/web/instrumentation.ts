// Runs once when the Next.js server starts (both `next dev` and `next start`), before any request.
// Node-only work lives in instrumentation-node.ts and is imported dynamically, as the Next docs recommend,
// so this file stays valid for the edge runtime bundle as well.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
