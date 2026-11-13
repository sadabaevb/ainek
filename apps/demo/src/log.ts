// `pnpm demo:log`: the public key log walked from its first entry, with no key (view calls on the NEAR contract only).
// The contract says each entry is hashed over the one before it. This command does not take that on trust: it reads every
// entry, recomputes every hash and compares the result with places of the log seen earlier (recorded in this repository,
// or given with --seen). A chain that holds says the entries fit each other; that they are the entries once written,
// only an earlier place can say. The controls at the end show both halves on the entries just read.
import { parseArgs } from 'node:util';
import { DEMO_SWAPPED_KEY, LogPoint, chainBreak, isForeignAnswer, keyLogReader, oneLine, pointStanding, readWholeLog, rewrittenFrom, shortHex as short, utcTextOfMs, walkLog, type KeyEntry } from '@ainek/proof';
import { loadLiveEnv } from './env.ts';
import { readJson } from './evidence.ts';
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
  // The whole argument, so that two pairs pasted together are not read as one; a hash copied in capitals is the same hash.
  const [, index, hash] = /^(\d{1,9}):([0-9a-f]{64})$/i.exec(text) ?? [];
  if (index === undefined || hash === undefined) usage(`--seen takes one <index>:<entry hash of 64 hex characters>, got "${text}"`);
  return { index: Number(index), entry_hash: hash.toLowerCase(), from: 'given with --seen' };
});

const { cfg } = loadLiveEnv();
if (cfg.logSource !== 'contract') usage('pnpm demo:log reads the live log (AINEK_LOG_SOURCE=contract)');

/** The places this repository holds: taken from the chain on the day named, in git since then. */
function recordedPoints(): SeenPoint[] {
  const file = 'log-points.json';
  const recorded = readJson<{ contract: string; points: Array<LogPoint & { seen: string }> }>(file);
  if (recorded.contract !== cfg.contract) {
    line(NA, `the places recorded in this repository are of ${recorded.contract}, not of this contract: not compared`);
    return [];
  }
  return recorded.points.map(({ seen, ...point }, i) => {
    // The file is edited by hand: a place that is not an index and a hash would read as a rewritten log.
    const parsed = LogPoint.safeParse(point);
    if (!parsed.success) usage(`docs/samples/${file}: place ${i} is not an index and an entry hash of 64 lowercase hex characters`);
    return { ...parsed.data, from: `recorded in this repository on ${seen} (docs/samples/${file})` };
  });
}

const place = (p: LogPoint): string => `#${p.index} ${short(p.entry_hash)}`;

console.log(`Ainek key log, walked from its first entry: ${cfg.contract} on ${cfg.network} via ${cfg.rpcUrl}`);
let failed = false;
const report = (ok: boolean, text: string): void => {
  failed = line(ok ? OK : FAIL, text) || failed;
};

head('1. The chain, recomputed here');
const whole = await readWholeLog(keyLogReader(cfg.rpcUrl, cfg.contract)).catch((err: unknown) => {
  // An account with other code answers too, and an entry this client's schema refuses is an answer as well: either way
  // the reason is kept, since it names the field.
  line(FAIL, isForeignAnswer(err) ? `${cfg.contract} did not answer as the key log's views do (SPEC §4.1): ${oneLine(describe(err).replace(/\s+/g, ' '), 240)}` : `the log could not be read: ${describe(err)}`);
  return undefined;
});
const broken = whole && walkLog(whole);
if (!whole) {
  console.log('\nResult: NOT CHECKED. The log was not read.');
} else if (!whole.head) {
  line(NA, 'the log is empty: there is nothing to walk');
  console.log('\nResult: NOT CHECKED. The log is empty.');
} else if (broken) {
  report(false, `the chain does not hold at entry #${broken.index}: ${broken.reason}`);
  console.log(`\nResult: BROKEN at entry #${broken.index}. What this node returned is not a log the contract's code could have written.`);
} else {
  const { entries, head: top } = whole;
  const first = entries[0]!;
  const last = entries.at(-1)!;
  report(true, `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}, #0 to #${last.index}: each stands at its index, names the hash of the one before it and carries the hash of its own fields`);
  report(true, `the last of them is the head the contract reports: ${place(top)}`);
  const writers = new Map<string, number>();
  for (const e of entries) writers.set(e.verifier, (writers.get(e.verifier) ?? 0) + 1);
  line(NA, `written by ${[...writers].map(([verifier, n]) => `${verifier} (${n})`).join(', ')}; by the verifiers' own clocks, the first on ${utcTextOfMs(Number(first.observed_at))}, the last on ${utcTextOfMs(Number(last.observed_at))}`);

  head('2. Against places of the log seen earlier');
  const points = [...recordedPoints(), ...given];
  for (const p of points) {
    const standing = pointStanding(entries, p);
    if (standing === 'kept') report(true, `${place(p)}, ${p.from}: still there${p.index > 0 ? `, so no entry up to #${p.index} was changed, removed or put in since` : ''}`);
    else if (standing === 'changed') report(false, `${place(p)}, ${p.from}: entry #${p.index} now has the hash ${short(entries[p.index]!.entry_hash)}. A log that held that place was rewritten at or before #${p.index}`);
    else report(false, `${place(p)}, ${p.from}: the log read now ends at #${last.index}. Either this node is behind the one that gave the place (run it again), or a log that held it has lost entries`);
  }
  if (points.length === 0) line(NA, 'no earlier place to compare with: the chain above fits itself, which a rewritten log would too');

  head('3. Controls: the entries just read, changed in memory');
  // One field of an entry in the middle: the key it vouches for. Three forgers, each more thorough than the last.
  const at = Math.floor((entries.length - 1) / 2);
  const swapKey = (e: KeyEntry): KeyEntry => ({ ...e, signing_address: DEMO_SWAPPED_KEY });
  const control = (what: string, forged: KeyEntry[], wanted: number): void => {
    const found = chainBreak(forged);
    if (found?.index === wanted) report(true, `${what}: refused, ${found.reason}`);
    else report(false, found ? `${what}: refused at entry #${found.index}, where #${wanted} was expected (${found.reason})` : `${what}: the chain held, and it must not`);
  };
  control(`the signing key in entry #${at} replaced`, entries.map((e) => (e.index === at ? swapKey(e) : e)), at);
  if (at + 1 < entries.length) {
    // The log rewritten up to that entry only: its own hash fits again, and the entry after it still names the old one.
    control(`the same, with the hash of #${at} recomputed`, [...rewrittenFrom(entries.slice(0, at + 1), at, swapKey), ...entries.slice(at + 1)], at + 1);
    // What the holder of the contract's key could do. No walk catches it; the head read a moment ago does.
    const rewritten = rewrittenFrom(entries, at, swapKey);
    const caught = chainBreak(rewritten) === undefined && pointStanding(rewritten, top) === 'changed';
    report(caught, caught
      ? `the same, with every hash after it recomputed, as whoever can replace the contract's code could do: the chain holds, and the head read above (${place(top)}) is no longer in it. Only a place seen earlier shows such a rewrite`
      : `the same, with every hash after it recomputed: the head read above did not show the rewrite, and it must`);
  }

  console.log();
  const covers = points.length ? 'A place covers the entries up to its own index, from the day it was taken: nothing after that index, and nothing before that day. ' : '';
  line(NA, `${covers}One RPC node was read: that another gives everyone the same log is not shown. The contract account has a full-access key (docs/CLAIMS.md, "An immutable log")`);
  line(NA, `To compare a later log with this one: pnpm demo:log --seen ${top.index}:${top.entry_hash}`);
  const kept = points.length === 0 ? '' : `, and ${points.length === 1 ? 'the place seen earlier is' : `${points.length === 2 ? 'both' : `all ${points.length}`} places seen earlier are`} still in it`;
  console.log(failed ? `\nResult: FAILED. See the line marked ${FAIL} above.` : `\nResult: the chain holds from #0 to #${last.index}${kept}.`);
}
// Zero only for a log that was read, is not empty, holds, still has every earlier place and whose controls were all refused.
await exitFlushed(whole?.head && !broken && !failed ? 0 : 1);
