// Does a deployed contract speak the SPEC §4.1 ABI the client relies on? Read-only view calls over RPC, no keys.
//   pnpm -F demo check-contract ainek.testnet [https://rpc.testnet.near.org] [model]
// Prints ✓/✗ per method and validates every returned entry against the KeyEntry schema from @ainek/proof.
import { KeyEntry, viewFunction } from '@ainek/proof';

const [account = 'ainek.testnet', rpc = 'https://rpc.testnet.near.org', model = 'z-ai/glm-5.3-flash'] = process.argv.slice(2);

const view = (method, args) => viewFunction(rpc, account, method, args);

let failures = 0;
const ok = (line) => console.log(`  ✓ ${line}`);
const bad = (line) => { failures += 1; console.log(`  ✗ ${line}`); };

async function check(method, args, validate) {
  try {
    const value = await view(method, args);
    const problem = validate(value);
    if (problem) bad(`${method}: ${problem}`);
    else ok(`${method}: ${JSON.stringify(value).slice(0, 120)}`);
    return value;
  } catch (err) {
    bad(`${method}: ${err.message}`);
    return undefined;
  }
}

function entriesProblem(value) {
  if (!Array.isArray(value)) return `expected an array, got ${typeof value}`;
  const r = KeyEntry.array().safeParse(value);
  return r.success ? null : `entries do not match KeyEntry (SPEC §4.1): ${r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
}

console.log(`ABI check for ${account} via ${rpc}`);
const head = await check('head', {}, (v) => (v === null || (typeof v?.index === 'number' && typeof v?.entry_hash === 'string') ? null : 'expected { index: u64, entry_hash: String } or null for an empty log'));
if (head === null) console.log('  — the log is empty (head = null)');
const latest = await check('latest_keys', { model, max_age_ns: '86400000000000' }, entriesProblem);
await check('entries_since', { index: 0, limit: 10 }, entriesProblem);
if (head != null && typeof head.index === 'number') {
  await check('entry', { index: head.index }, (v) => (v == null ? 'returned nothing for the head index' : KeyEntry.safeParse(v).success ? null : 'does not match KeyEntry'));
}
if (Array.isArray(latest) && latest.length === 0) console.log(`  — latest_keys is empty for ${model} in the last 24 h: the client would refuse to send (fail-closed)`);
console.log(failures === 0 ? 'Result: ABI OK, the client can switch to AINEK_LOG_SOURCE=contract' : `Result: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
