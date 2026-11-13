// `pnpm demo:log`: the public key log walked from its first entry, with no key (view calls on the NEAR contract only).
// The contract says each entry is hashed over the one before it. This command does not take that on trust: it reads every
// entry, recomputes every hash and compares the result with places of the log seen earlier (recorded in this repository,
// or given with --seen). A chain that holds says the entries fit each other; that they are the entries once written,
// only an earlier place can say. The controls at the end show both halves on the entries just read.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ContractMethodNotFound, DEMO_SWAPPED_KEY, chainBreak, hex64, inputOf, entryHashOf, keyLogReader, pointStanding, readWholeLog, rewrittenFrom, shortHex as short, utcTextOfMs, walkLog, type KeyEntry, type LogPoint } from '@ainek/proof';
import { loadLiveEnv } from './env.ts';
import { FAIL, NA, OK, describe, exitFlushed, head, line } from './term.ts';

/** A place of the log with where it comes from, for the line that reports it. */
interface SeenPoint extends LogPoint {
  from: string;
}

function usage(problem: string): never {
  console.error(`${problem}\nusage: pnpm demo:log [--seen <index>:<entry hash>]...`);
  return process.exit(2);
}

const flags = (() => {
  try {
    return parseArgs({ options: { seen: { type: 'string', multiple: true, default: [] } }, strict: true }).values;
  } catch (err) {
    return usage(err instanceof Error ? err.message : String(err));
  }
})();
const given: SeenPoint[] = flags.seen.map((text) => {
  const [index = '', hash = ''] = text.split(':');
  if (!/^\d{1,9}$/.test(index) || !hex64.safeParse(hash).success) usage(`--seen takes <index>:<entry hash of 64 hex characters>, got "${text}"`);
  return { index: Number(index), entry_hash: hash, from: 'given with --seen' };
});

const { cfg } = loadLiveEnv();
if (cfg.logSource !== 'contract') usage('pnpm demo:log reads the live log (AINEK_LOG_SOURCE=contract)');

/** The places this repository holds: taken from the chain on the day named, in git since then. */
function recordedPoints(): SeenPoint[] {
  const file = 'docs/samples/log-points.json';
  const recorded = JSON.parse(readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8')) as { contract: string; points: Array<LogPoint & { seen: string }> };
  if (recorded.contract !== cfg.contract) {
    line(NA, `the places recorded in this repository are of ${recorded.contract}, not of this contract: not compared`);
    return [];
  }
  return recorded.points.map(({ index, entry_hash, seen }) => ({ index, entry_hash, from: `recorded in this repository on ${seen} (${file})` }));
}

const place = (p: LogPoint): string => `#${p.index} ${short(p.entry_hash)}`;
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

console.log(`Ainek key log, walked from its first entry: ${cfg.contract} on ${cfg.network} via ${cfg.rpcUrl}`);
let failed = false;
const report = (ok: boolean, text: string): void => {
  failed = line(ok ? OK : FAIL, text) || failed;
};

head('1. The chain, recomputed here');
const whole = await readWholeLog(keyLogReader(cfg.rpcUrl, cfg.contract)).catch((err: unknown) => {
  // An account with other code, or with none, answers; what it answers is not this log's views (SPEC §4.1).
  const notTheLog = err instanceof ContractMethodNotFound || (err instanceof Error && err.name === 'ZodError');
  line(FAIL, notTheLog ? `${cfg.contract} does not answer as the key log does: its head and entries are not the ones of SPEC §4.1` : `the log could not be read: ${describe(err)}`);
  return undefined;
});
const walk = whole && walkLog(whole);
if (!whole || !walk) {
  console.log('\nResult: NOT CHECKED. The log was not read.');
} else if (walk.status === 'empty') {
  line(NA, 'the log is empty: there is nothing to walk');
  console.log('\nResult: NOT CHECKED. The log is empty.');
} else if (walk.status === 'broken') {
  report(false, `the chain does not hold at entry #${walk.at.index}: ${walk.at.reason}`);
  console.log(`\nResult: BROKEN at entry #${walk.at.index}. What this node returned is not a log the contract's code could have written.`);
} else {
  const { entries } = whole;
  const first = entries[0]!;
  const last = entries.at(-1)!;
  report(true, `${count(entries.length, 'entry', 'entries')}, #0 to #${last.index}: each stands at its index, names the hash of the one before it and carries the hash of its own fields`);
  report(true, `the last of them is the head the contract reports: ${place(walk.head)}`);
  const writers = new Map<string, number>();
  for (const e of entries) writers.set(e.verifier, (writers.get(e.verifier) ?? 0) + 1);
  line(NA, `written by ${[...writers].map(([verifier, n]) => `${verifier} (${n})`).join(', ')}; by the verifiers' own clocks, the first on ${utcTextOfMs(Number(first.observed_at))}, the last on ${utcTextOfMs(Number(last.observed_at))}`);

  head('2. Against places of the log seen earlier');
  const points = [...recordedPoints(), ...given];
  for (const p of points) {
    const standing = pointStanding(entries, p);
    if (standing === 'kept') report(true, `${place(p)}, ${p.from}: still there${p.index > 0 ? `, so no entry up to #${p.index} was changed, removed or put in since` : ''}`);
    else if (standing === 'changed') report(false, `${place(p)}, ${p.from}: entry #${p.index} now has the hash ${short(entries[p.index]!.entry_hash)}. A log that held that place was rewritten at or before #${p.index}`);
    else report(false, `${place(p)}, ${p.from}: the log now ends at #${last.index}. A log that held that place has lost entries`);
  }
  if (points.length === 0) line(NA, 'no earlier place to compare with: the chain above fits itself, which a rewritten log would too');

  head('3. Controls: the entries just read, changed in memory');
  // One field of an entry in the middle: the key it vouches for. Three forgers, each more thorough than the last.
  const at = Math.floor((entries.length - 1) / 2);
  const swapKey = (e: KeyEntry): KeyEntry => ({ ...e, signing_address: DEMO_SWAPPED_KEY });
  const control = (what: string, forged: KeyEntry[], wanted: number): void => {
    const found = chainBreak(forged);
    report(found?.index === wanted, found ? `${what}: refused, ${found.reason}` : `${what}: the chain held, and it must not`);
  };
  control(`the signing key in entry #${at} replaced`, entries.map((e) => (e.index === at ? swapKey(e) : e)), at);
  if (at + 1 < entries.length) {
    control(`the same, with the hash of #${at} recomputed`, entries.map((e) => (e.index === at ? { ...swapKey(e), entry_hash: entryHashOf(e.prev_hash, inputOf(swapKey(e)), e.verifier) } : e)), at + 1);
    // What the holder of the contract's key could do. No walk catches it; the head read a moment ago does.
    const rewritten = rewrittenFrom(entries, at, swapKey);
    const caught = chainBreak(rewritten) === undefined && pointStanding(rewritten, walk.head) === 'changed';
    report(caught, caught
      ? `the same, with every hash after it recomputed, as whoever can replace the contract's code could do: the chain holds, and the head read above (${place(walk.head)}) is no longer in it. Only a place seen earlier shows such a rewrite`
      : `the same, with every hash after it recomputed: the head read above did not show the rewrite, and it must`);
  }

  console.log();
  line(NA, 'Not shown by this: that the log was the same before the earliest place above was taken, or that another RPC node gives everyone the same log. The contract account has a full-access key (docs/CLAIMS.md, "An immutable log")');
  line(NA, `To compare a later log with this one: pnpm demo:log --seen ${walk.head.index}:${walk.head.entry_hash}`);
  const kept = points.length === 0 ? '' : `, and ${points.length === 1 ? 'the place seen earlier is' : `${points.length === 2 ? 'both' : `all ${points.length}`} places seen earlier are`} still in it`;
  console.log(failed ? `\nResult: FAILED. See the line marked ${FAIL} above.` : `\nResult: the chain holds from #0 to #${last.index}${kept}.`);
}
await exitFlushed(walk?.status === 'held' && !failed ? 0 : 1);
