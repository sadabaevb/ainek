// Does a deployed contract speak the SPEC §4.1 ABI the client relies on? Read-only view calls over RPC, no keys.
//   pnpm -F demo check-contract [account] [rpcUrl] [model]   (defaults: AINEK_CONTRACT / NEAR_RPC_URL / NEARAI_MODEL from .env or the shared defaults)
// Prints ✓/✗ per method and validates every returned entry against the KeyEntry schema from @ainek/proof.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { ainekConfigFromEnv, checkProofCommit, keyLogReader, parseDisclosure, readProofCommit } from '@ainek/proof';

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
// The /auditor sample: committed on this contract, its log entry unchanged. A redeploy or reset makes it stale: a note, not an ABI failure.
const sample = parseDisclosure(JSON.parse(readFileSync(new URL('../../../docs/samples/disclosure.sample.json', import.meta.url), 'utf8')));
const sampleChain = JSON.parse(readFileSync(new URL('../../../docs/samples/disclosure.sample.chain.json', import.meta.url), 'utf8'));
if (account !== sampleChain.contract) console.log(`  — the /auditor sample was committed on ${sampleChain.contract}, not checked here`);
else if (head != null) {
  const [entry, commit] = await Promise.all([log.entry(sample.proof.logIndex).catch(() => undefined), readProofCommit(rpc, account, sampleChain.committer, sample.proof.commit).catch(() => undefined)]);
  const committed = commit !== undefined && checkProofCommit(sample.proof, commit, sampleChain.committer).status === 'ok';
  if (entry && isDeepStrictEqual(entry, sample.logEntry) && committed) ok(`the /auditor sample: entry #${sample.proof.logIndex} unchanged, committed by ${sampleChain.committer}`);
  else if (entry !== undefined && commit !== undefined) console.log(`  — the /auditor sample is stale (${!committed ? 'no commit by ' + sampleChain.committer : 'entry #' + sample.proof.logIndex + ' differs'}): record it again, see docs/samples/README.md`);
}
if (Array.isArray(latest) && latest.length === 0) console.log(`  — latest_keys is empty for ${model} in the last 24 h: the client would refuse to send (fail-closed)`);
console.log(failures === 0 ? 'Result: ABI OK, the methods the client calls are there' : `Result: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
