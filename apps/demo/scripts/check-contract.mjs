// Does a deployed contract speak the SPEC §4.1 ABI the client relies on? Read-only view calls over RPC, no keys.
//   pnpm -F demo check-contract [account] [rpcUrl] [model]   (defaults: AINEK_CONTRACT / NEAR_RPC_URL / NEARAI_MODEL from .env or the shared defaults)
// Prints ✓/✗ per method and validates every returned entry against the KeyEntry schema from @ainek/proof.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { LOG_WINDOW_NS, ainekConfigFromEnv, checkProofCommit, freshCoverage, keyLogReader, parseDisclosure, readProofCommit, readWholeLog, resolveLogEntry, walkLog } from '@ainek/proof';

const cfg = ainekConfigFromEnv(process.env);
const [account = cfg.contract, rpc = cfg.rpcUrl, model = cfg.model] = process.argv.slice(2);
const log = keyLogReader(rpc, account);

let failures = 0;
const ok = (line) => console.log(`  ✓ ${line}`);
const bad = (line) => { failures += 1; console.log(`  ✗ ${line}`); };

async function check(label, fn) {
  try {
    const value = await fn();
    ok(`${label}: ${JSON.stringify(value).slice(0, 120)}`);
    return value;
  } catch (err) {
    bad(`${label}: ${err.message}`);
    return undefined;
  }
}

console.log(`ABI check for ${account} via ${rpc}`);
const head = await check('head', () => log.head());
if (head === null) console.log('  — the log is empty (head = null)');
const latest = await check(`latest_keys(${model}, 24h)`, () => log.latestKeys(model));
// The client reads each trusted verifier's entries on their own (latestKeysFor). A build without the `verifier` argument
// would ignore it and answer with everyone's entries: the client would then lose that protection without any error.
for (const verifier of cfg.trustedVerifiers) {
  await check(`latest_keys(${model}, 24h, verifier ${verifier})`, async () => {
    const own = await log.latestKeys(model, undefined, undefined, verifier);
    const other = own.find((e) => e.verifier !== verifier);
    if (other) throw new Error(`the filter is not applied: entry #${other.index} is by ${other.verifier}`);
    return `${own.length} entr${own.length === 1 ? 'y' : 'ies'}, all by ${verifier}`;
  });
}
// The check above cannot fail while that verifier is the only writer in the window. The contract account never writes
// to its own log, so with the filter applied this read is empty; a build that ignores the argument answers with entries.
await check(`latest_keys(${model}, 24h, verifier ${account})`, async () => {
  const none = await log.latestKeys(model, undefined, undefined, account);
  if (none.length > 0) throw new Error(`the filter is not applied: ${none.length} entries came back for an account that wrote none`);
  return 'no entries for an account that wrote none: the filter is applied';
});
await check('entries_since(0, 10)', () => log.entriesSince(0, 10));
if (head != null) await check(`entry(${head.index})`, async () => { const e = await log.entry(head.index); if (e === null) throw new Error('returned nothing for the head index'); return e; });
// The offline replay's log is entry #0 recorded from this contract. A redeploy makes that recording stale: a note, not an ABI failure.
const recorded = JSON.parse(readFileSync(new URL('../../../docs/samples/key-entry.sample.json', import.meta.url), 'utf8'));
if (account !== recorded.contract) console.log(`  — the replay's entry #0 was recorded from ${recorded.contract}, not checked here`);
else if (head != null) {
  const live = await log.entry(0).catch(() => undefined);
  if (live && isDeepStrictEqual(live, recorded.entry)) ok('entry(0) equals the replay\'s recording (docs/samples/key-entry.sample.json)');
  else if (live !== undefined) console.log(`  — entry(0) ${live ? 'differs from' : 'is missing, unlike'} the replay's recording: re-record docs/samples/key-entry.sample.json`);
}
// The /auditor sample: committed on this contract, its log entry unchanged. Same checks as the page; a stale or unreadable
// sample is a note, not an ABI failure.
try {
  const sample = parseDisclosure(JSON.parse(readFileSync(new URL('../../../docs/samples/disclosure.sample.json', import.meta.url), 'utf8')));
  const sampleChain = JSON.parse(readFileSync(new URL('../../../docs/samples/disclosure.sample.chain.json', import.meta.url), 'utf8'));
  if (account !== sampleChain.contract) console.log(`  — the /auditor sample was committed on ${sampleChain.contract}, not checked here`);
  else {
    const [{ check: entry }, commit] = await Promise.all([
      resolveLogEntry(log, sample.proof.logIndex, sample.logEntry, account),
      readProofCommit(rpc, account, sampleChain.committer, sample.proof.commit).then((r) => checkProofCommit(sample.proof, r, sampleChain.committer)),
    ]);
    const open = [entry, commit].filter((c) => c.status !== 'ok');
    if (open.length === 0) ok(`the /auditor sample: entry #${sample.proof.logIndex} unchanged, committed by ${sampleChain.committer}`);
    else if (open.some((c) => c.status === 'fail')) console.log(`  — the /auditor sample is stale (${open.map((c) => c.detail).join('; ')}): record it again, see docs/samples/README.md`);
    else console.log(`  — could not check the /auditor sample (${open.map((c) => c.detail).join('; ')})`);
  }
} catch (err) {
  console.log(`  — could not check the /auditor sample: ${err instanceof Error ? err.message : String(err)}`);
}
// `entry_hash` as SPEC §4.1 defines it, over every entry up to the head, and every entry in the client's schema: a log
// that cannot be read to its head fails here like any other method. `pnpm demo:log` adds the comparison with places of
// the log seen earlier.
const all = await (async () => {
  try {
    const whole = await readWholeLog(log);
    const broken = walkLog(whole);
    if (broken) bad(`hash chain: breaks at entry #${broken.index} (${broken.reason})`);
    else if (whole.entries.length > 0) ok(`hash chain: ${whole.entries.length} entries up to the head, each hash recomputed here and each naming the one before it`);
    return whole.entries;
  } catch (err) {
    bad(`hash chain: the log could not be read up to its head (${String(err instanceof Error ? err.message : err).replace(/\s+/g, ' ').slice(0, 240)})`);
    return [];
  }
})();
// Not an ABI check: over the log's whole history, how long would the chat have refused for lack of a fresh entry by a
// verifier the site trusts? `observed_at` is the verifier's own clock, and the daemon re-logs an unchanged key about
// every 6 hours, so pauses between entries are not downtime.
try {
  const mine = all.filter((e) => e.model === model && cfg.trustedVerifiers.includes(e.verifier));
  if (mine.length > 0) {
    const H = 3_600_000;
    const windowMs = Number(BigInt(LOG_WINDOW_NS) / 1_000_000n);
    const windowText = `${windowMs / H} h`;
    const times = mine.map((e) => Number(e.observed_at));
    const keys = new Set(mine.map((e) => e.signing_address)).size;
    const now = Date.now();
    const first = Math.min(...times);
    const c = freshCoverage(times, first, now, windowMs);
    const hours = (ms) => (ms / H).toFixed(1);
    const at = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`  — history of ${model} by ${cfg.trustedVerifiers.join(', ')}: ${mine.length} entries since ${at(first)} UTC, ${keys} signing key${keys === 1 ? '' : 's'}; no entry younger than ${windowText} for ${hours(c.uncoveredMs)} of ${hours(now - first)} h` +
      (c.unbrokenSince < now ? `; none missing since ${at(c.unbrokenSince)} UTC (${hours(now - c.unbrokenSince)} h, longest pause ${hours(c.longestPauseMs)} h, the one still open included)` : '; the log is stale now') +
      '. Any entry counts here, whatever its key: with a key change or a quorum above 1 the client can refuse while this line shows no gap');
  }
} catch (err) {
  console.log(`  — could not read the log's history: ${err instanceof Error ? err.message : String(err)}`);
}
if (Array.isArray(latest) && latest.length === 0) console.log(`  — latest_keys is empty for ${model} in the last 24 h: the client would refuse to send (fail-closed)`);
console.log(failures === 0 ? 'Result: ABI OK, the methods the client calls are there' : `Result: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
