// Re-records the public evidence that `pnpm demo` replays offline (no API key needed):
//   docs/samples/intel-collateral.json   Intel PCS collateral per quote in attestation-report.json
//   docs/samples/nras-response.json      NVIDIA NRAS verdict (JWT) for the recorded nvidia_payload
//   docs/samples/nvidia-jwks.json        NVIDIA public keys
//   docs/samples/replay-manifest.json    when it was recorded and the instant replay evaluates it at
// Run when the replay starts failing on collateral validity (Intel rotates TCB info about monthly):
//   pnpm -F demo record
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import qvl from '@phala/dcap-qvl';
import { decodeJwt, decodeProtectedHeader } from 'jose';

const samples = new URL('../../../docs/samples/', import.meta.url);
const read = (name) => readFileSync(new URL(name, samples), 'utf8');
const write = (name, text) => writeFileSync(new URL(name, samples), text);
const sha = (s) => createHash('sha256').update(s).digest('hex');

const PCS = 'https://api.trustedservices.intel.com';
const NRAS = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
const JWKS = 'https://nras.attestation.nvidia.com/.well-known/jwks.json';

const report = JSON.parse(read('attestation-report.json'));
const model = report.model_attestations[0];
const gateway = report.gateway_attestation;
const quotes = {
  model: model.intel_quote,
  gateway: gateway.intel_quote,
  ...(model.compose_manager_attestation ? { compose_manager: model.compose_manager_attestation.quote } : {}),
};

async function retry(label, fn) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      console.warn(`${label}: attempt ${i} failed: ${err.message}`);
      if (i === 3) throw err;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

const recordedAt = new Date();
const nowSecs = Math.floor(recordedAt.getTime() / 1000);
const byQuoteSha256 = {};
const quoteNames = {};
for (const [name, quoteHex] of Object.entries(quotes)) {
  const key = sha(quoteHex);
  quoteNames[key] = name;
  byQuoteSha256[key] = await retry(`collateral(${name})`, () => qvl.getCollateral(PCS, Buffer.from(quoteHex, 'hex')));
  // Fail early if the fresh collateral does not verify the quote at this instant.
  const verified = qvl.verify(Buffer.from(quoteHex, 'hex'), byQuoteSha256[key], nowSecs);
  console.log(`${name}: collateral ok, TCB ${verified.status}`);
}

const nrasText = await retry('NRAS', async () => {
  const res = await fetch(NRAS, { method: 'POST', headers: { 'content-type': 'application/json' }, body: model.nvidia_payload });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.text();
});
const jwks = await retry('JWKS', async () => (await fetch(JWKS)).json());
const overall = JSON.parse(nrasText)[0][1];
const claims = decodeJwt(overall);
console.log(`NRAS: overall ${claims['x-nvidia-overall-att-result']}, eat_nonce ${String(claims.eat_nonce).slice(0, 8)}…, iat ${claims.iat}`);

write('intel-collateral.json', JSON.stringify({
  _note: `Intel PCS collateral (public: TCB info, QE identity, CRLs, issuer chains) fetched ${recordedAt.toISOString()} from ${PCS}, keyed by sha256 of the quote hex it was fetched for. Valid only around that time; replay passes nowSecs from replay-manifest.json.`,
  byQuoteSha256,
}) + '\n');
write('nras-response.json', nrasText.endsWith('\n') ? nrasText : `${nrasText}\n`);
write('nvidia-jwks.json', `${JSON.stringify(jwks)}\n`);
write('replay-manifest.json', `${JSON.stringify({
  _note: 'Timestamps the offline replay evaluates the recorded evidence at. The report and chat were captured 2026-11-02; Intel collateral and the NRAS verdict were recorded later (see evidenceRecordedAt). Freshness is therefore not re-checked by the replay and the demo says so.',
  reportCapturedAt: '2026-11-02T16:14:00Z',
  evidenceRecordedAt: recordedAt.toISOString(),
  nowSecs,
  nras: { iat: claims.iat, exp: claims.exp, kid: decodeProtectedHeader(overall).kid },
  quotes: quoteNames,
}, null, 2)}\n`);
console.log('saved to docs/samples');
