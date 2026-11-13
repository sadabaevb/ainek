// The log's hash chain, recomputed by a reader (SPEC §4.1). The contract hashes every entry over its own fields, the
// hash of the entry before it and the account that wrote it. Here the same is done over what an RPC returned, so a reader
// does not take the contract's word for it, and the result is compared with places of the log somebody saw earlier.
import { entryHashOf } from './commit.ts';
import type { KeyLogReader } from './near-view.ts';
import type { KeyEntry, KeyEntryInput } from './schema.ts';

/** A place in the log as somebody saw it: an index and the hash the log had there. `head()` returns one. */
export interface LogPoint {
  index: number;
  entry_hash: string;
}

/** The first entry at which the chain does not hold, and why. */
export interface ChainBreak {
  index: number;
  reason: string;
}

/** What the verifier wrote, without what the contract added: the part of an entry its hash is taken over. */
export function inputOf(entry: KeyEntry): KeyEntryInput {
  const { index: _index, verifier: _verifier, prev_hash: _prev, entry_hash: _hash, block_height: _height, ...input } = entry;
  return input;
}

/**
 * Walks the log from its first entry (`entries` is the whole log, oldest first). Every entry must stand at its own
 * index, name the hash of the entry before it ("" for the first) and carry the hash of its own fields. The first entry
 * that does not is returned.
 *
 * A chain that holds says the entries fit each other. It does not say they are the ones that were written: whoever can
 * replace the contract's code can rewrite an entry and every hash after it. `pointStanding` is what catches that.
 */
export function chainBreak(entries: readonly KeyEntry[]): ChainBreak | undefined {
  let prev = '';
  for (const [i, e] of entries.entries()) {
    if (e.index !== i) return { index: i, reason: `entry #${e.index} stands where #${i} should` };
    if (e.prev_hash !== prev) return { index: i, reason: i === 0 ? 'the first entry names an entry before it' : `entry #${i} does not name the hash of entry #${i - 1}` };
    if (entryHashOf(e.prev_hash, inputOf(e), e.verifier) !== e.entry_hash) return { index: i, reason: `the hash of entry #${i} is not the hash of its fields` };
    prev = e.entry_hash;
  }
  return undefined;
}

/**
 * What became of a place seen earlier, in a log whose chain holds now: `kept` when the entry at that index still has
 * that hash, `changed` when it has another, `gone` when the log is now shorter. Each hash covers everything before it,
 * so `kept` says that no entry up to that index was changed, removed or inserted since the point was taken.
 */
export function pointStanding(entries: readonly KeyEntry[], point: LogPoint): 'kept' | 'changed' | 'gone' {
  const now = entries[point.index];
  return !now ? 'gone' : now.entry_hash === point.entry_hash ? 'kept' : 'changed';
}

/**
 * `entries` as the holder of the contract's key could rewrite them: entry `at` altered by `change`, then its hash and
 * every hash after it recomputed so that the chain holds again. For the negative controls (`pnpm demo:log`, tests).
 */
export function rewrittenFrom(entries: readonly KeyEntry[], at: number, change: (entry: KeyEntry) => KeyEntry): KeyEntry[] {
  const out = entries.slice(0, at);
  for (const original of entries.slice(at)) {
    const e = original.index === at ? change(original) : original;
    const prev_hash = out.at(-1)?.entry_hash ?? '';
    out.push({ ...e, prev_hash, entry_hash: entryHashOf(prev_hash, inputOf(e), e.verifier) });
  }
  return out;
}

/** The log as one read saw it: the head, and every entry up to it, oldest first. */
export interface WholeLog {
  head: LogPoint | null;
  entries: KeyEntry[];
}

/** How many entries one read asks for: the contract's own cap (`entries_since`). */
const PAGE = 100;

/**
 * The head first, then the entries up to it in pages. In that order a log that grows during the read only has more
 * entries than the head names, and they are left for the next read. A log that turns out shorter than its head comes
 * back short: `walkLog` reports it.
 */
export async function readWholeLog(reader: Pick<KeyLogReader, 'head' | 'entriesSince'>): Promise<WholeLog> {
  const head = await reader.head();
  const entries: KeyEntry[] = [];
  if (!head) return { head, entries };
  while (entries.length <= head.index) {
    const page = await reader.entriesSince(entries.length, PAGE);
    if (page.length === 0) break;
    entries.push(...page);
  }
  return { head, entries: entries.slice(0, head.index + 1) };
}

/** Where the chain of a whole log does not hold, the head the contract reported for it included. Nothing for a log that holds, and for an empty one. */
export function walkLog({ head, entries }: WholeLog): ChainBreak | undefined {
  if (!head) return undefined;
  const broken = chainBreak(entries);
  if (broken) return broken;
  if (entries.length !== head.index + 1) return { index: entries.length, reason: `the log ends before its head #${head.index}: entry #${entries.length} did not come back` };
  if (entries[head.index]!.entry_hash !== head.entry_hash) return { index: head.index, reason: `the head names another hash than entry #${head.index} has` };
  return undefined;
}
