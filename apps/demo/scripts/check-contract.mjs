// Does a deployed contract speak the SPEC §4.1 ABI the client relies on? Read-only view calls over RPC, no keys.
//   pnpm -F demo check-contract [account] [rpcUrl] [model]   (defaults: AINEK_CONTRACT / NEAR_RPC_URL / NEARAI_MODEL from .env or the shared defaults)
// Prints ✓/✗ per method and validates every returned entry against the KeyEntry schema from @ainek/proof.
import { ainekConfigFromEnv, keyLogReader } from '@ainek/proof';

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
if (Array.isArray(latest) && latest.length === 0) console.log(`  — latest_keys is empty for ${model} in the last 24 h: the client would refuse to send (fail-closed)`);
console.log(failures === 0 ? 'Result: ABI OK, the client can switch to AINEK_LOG_SOURCE=contract' : `Result: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
