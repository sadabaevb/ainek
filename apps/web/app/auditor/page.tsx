'use client';
// The auditor's side of selective disclosure (SPEC §5.4). Someone hands over ONE exchange: its proof with the salt, the
// exact ciphertext bytes and the log entry. This page says what that file proves and checks it without trusting the
// sender: the hashes and the commit are recomputed here, the log entry is re-read from the chain, and the commit is
// looked up on NEAR. Nothing leaves this browser except view calls to the NEAR RPC.
import { useState } from 'react';
import { Disclosure, parseDisclosure, readProofCommit, verifyModelProof, type Check, type CheckId, type DisclosedExchange, type VerifyReport } from '@ainek/proof';
import sampleFile from '../../../../docs/samples/disclosure.sample.json';
import { CheckList, Row, type Status } from '@/components/checks';
import type { PublicConfig } from '@/lib/config';
import { describeError } from '@/lib/errors';
import { short } from '@/lib/format';
import { resolveLogEntry, type ResolvedEntry } from '@/lib/key-log';
import { explorerTxUrl, verificationCenterUrl } from '@/lib/links';
import { useConfig } from '../providers';

interface Line {
  status: Exclude<Status, 'running'>;
  detail: string;
}

interface Result {
  file: Disclosure;
  d: DisclosedExchange;
  report: VerifyReport;
  log: ResolvedEntry;
  chain: Line;
}

/** `proof_commit(account, commit)`: the public record this disclosure must match (SPEC §4.2). */
async function lookupCommit(cfg: PublicConfig, d: DisclosedExchange, account: string): Promise<Line> {
  const { commit, logIndex } = d.proof;
  if (commit === undefined) return { status: 'skipped', detail: 'the proof carries no commit: nothing to look up on NEAR' };
  if (cfg.logSource === 'sample') return { status: 'skipped', detail: 'chain not consulted (AINEK_LOG_SOURCE=sample)' };
  if (!account) return { status: 'skipped', detail: 'enter the NEAR account that committed to look the commit up on-chain' };
  try {
    const r = await readProofCommit(cfg.rpcUrl, cfg.contract, account, commit);
    if (r.status === 'not-deployed') return { status: 'skipped', detail: `${cfg.contract} has no proof_commit view yet (SPEC §4.2 lands next): the on-chain record cannot be checked today` };
    if (r.status === 'none') return { status: 'fail', detail: `${account} never committed ${short(commit)} on ${cfg.contract}` };
    const problems: string[] = [];
    if (r.record.kind !== 'model') problems.push(`committed as kind "${r.record.kind}", expected "model"`);
    if (r.record.log_index !== logIndex) problems.push(`committed with log_index ${r.record.log_index}, the proof points at #${logIndex}`);
    if (problems.length > 0) return { status: 'fail', detail: problems.join('; ') };
    return { status: 'ok', detail: `commit ${short(commit)} recorded by ${account} at block ${r.record.block_height} (kind model, log #${r.record.log_index})` };
  } catch (err) {
    return { status: 'skipped', detail: `lookup failed: ${describeError(err)}` };
  }
}

function check(report: VerifyReport, id: CheckId): Check {
  return report.checks.find((c) => c.id === id) ?? { id, status: 'skipped', detail: 'not run' };
}

/** One card row from several checks: the first failure wins, then the first skip, else the ok wording. */
function combine(okText: string, ...lines: Line[]): Line {
  return lines.find((l) => l.status === 'fail') ?? lines.find((l) => l.status === 'skipped') ?? { status: 'ok', detail: okText };
}

function VerdictCard({ r, cfg }: { r: Result; cfg: PublicConfig }) {
  const { proof } = r.d;
  const commit = check(r.report, 'commit');
  const commitLine: Line = commit.status === 'ok' && proof.commit ? { status: 'ok', detail: `sha256(salt ‖ canonical proof) = ${short(proof.commit)}: the public hash is this exchange's` } : commit.status === 'skipped' ? { status: 'skipped', detail: 'the file has no salt and commit: nothing to compare with the chain' } : commit;
  const bytes = combine(`request ${r.d.requestBody.length} B and response ${r.d.responseBody.length} B of ${proof.e2ee ? 'E2EE ciphertext' : 'plaintext'} hash to the values the model TEE signed`, check(r.report, 'request-hash'), check(r.report, 'response-hash'));
  const signed = combine(`${proof.signingAlgo} signature by model key ${short(proof.signingAddress)} over model:sha256(request):sha256(response)`, check(r.report, 'route'), check(r.report, 'signed-text'), check(r.report, 'signature'));
  const keyCheck = check(r.report, 'key-in-log');
  const failures = [keyCheck, r.log].filter((l) => l.status === 'fail');
  const key: Line = failures.length > 0 ? { status: 'fail', detail: failures.map((l) => l.detail).join('; ') } : { status: r.log.status === 'ok' ? 'ok' : 'skipped', detail: `${keyCheck.detail}; ${r.log.detail}` };
  const ok = [commitLine, bytes, signed, key, r.chain].every((l) => l.status !== 'fail');
  const stamp = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

  return (
    <section className={`card ${ok ? '' : 'red'}`}>
      <h3>{ok ? '✓ This disclosure checks out' : '✗ This disclosure does not check out'}</h3>
      <p className="muted small">{proof.model}, completion {proof.completionId}, verified {stamp(proof.verifiedAt)}, disclosed {stamp(r.file.disclosedAt)}</p>
      <Row status={commitLine.status} label="Commit">{commitLine.detail}</Row>
      <Row status={bytes.status} label="Disclosed bytes">{bytes.detail}</Row>
      <Row status={signed.status} label="Signed inside the model TEE">{signed.detail}</Row>
      <Row status={key.status} label="Key in the public log">{key.detail}</Row>
      <Row status={r.chain.status} label="On NEAR">
        {r.chain.detail}
        {proof.commitTx && <> · <a href={explorerTxUrl(cfg.explorer, proof.commitTx)} target="_blank" rel="noreferrer">transaction {short(proof.commitTx)}</a></>}
      </Row>
      <div className="actions">
        <a className="btn" href={verificationCenterUrl(proof)} target="_blank" rel="noreferrer">Same signature in NEAR AI Verification Center</a>
      </div>
    </section>
  );
}

function Disclosed({ r }: { r: Result }) {
  const { proof } = r.d;
  const rows: Array<[string, string]> = [
    ['Model', proof.model],
    ['Completion', proof.completionId],
    ['Request', `${r.d.requestBody.length} bytes, sha256 ${short(proof.requestSha256)}`],
    ['Response', `${r.d.responseBody.length} bytes, sha256 ${short(proof.responseSha256)}`],
    ['End-to-end encrypted', proof.e2ee ? 'yes: the bytes are ciphertext as sent and received' : 'no: the bytes are the plaintext exchange'],
    ['Tools', proof.toolNames.length > 0 ? proof.toolNames.join(', ') : 'none'],
    ['Salt', proof.salt ? 'included (32 bytes): needed to recompute the commit; it makes this file private' : 'not included'],
    ['Plaintext', proof.e2ee ? 'not included. The proof binds the ciphertext bytes; any text the sender shows you is not bound by this file.' : 'the request and response bytes above are readable'],
    ['Log entry', `#${r.d.logEntry.index} by ${r.d.logEntry.verifier}, embedded in the file (compared with the chain above)`],
  ];
  if (r.file.note) rows.push(['Note', r.file.note]);
  return (
    <section>
      <h2 style={{ fontSize: '1.1rem', marginTop: '1.5rem' }}>What was disclosed</h2>
      <table>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}><th style={{ width: '11rem' }}>{k}</th><td>{v}</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function AuditorPage() {
  const cfg = useConfig();
  const [text, setText] = useState('');
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  async function run() {
    setError('');
    setBusy(true);
    try {
      const file = Disclosure.parse(JSON.parse(text)); // strict: exactly the file a proof card downloads
      const d = parseDisclosure(file);
      const [log, chain] = await Promise.all([resolveLogEntry(cfg, d.proof.logIndex, d.logEntry), lookupCommit(cfg, d, account.trim())]);
      setResult({ file, d, report: verifyModelProof(d.proof, d.requestBody, d.responseBody, log.entry), log, chain });
    } catch (err) {
      setResult(null);
      setError(`not a disclosure file: ${describeError(err)}. A bare proof can be checked on /verify.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <h1>Auditor</h1>
      <p className="muted">
        Someone sent you a &quot;Disclose to auditor&quot; file: one exchange, its proof with the salt, the exact bytes and the log entry. This page recomputes the hashes and the commit here, re-reads the log entry from the public log on NEAR, and looks the commit up on-chain. The file is read in this browser and not uploaded.
      </p>

      <div className="controls">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }} placeholder='{"v":1,"kind":"disclosure",...}' />
        <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="NEAR account that committed (optional), e.g. alice.testnet" style={{ width: '100%', padding: '0.5rem 0.7rem', border: '1px solid var(--line)', borderRadius: 8, font: 'inherit' }} />
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => void run()} disabled={busy || !text.trim()}>{busy ? 'Checking…' : 'Check'}</button>
          <label className="btn">
            Load file <input type="file" accept="application/json" style={{ display: 'none' }} onChange={(e) => void e.target.files?.[0]?.text().then(setText)} />
          </label>
          <button type="button" className="btn" onClick={() => setText(JSON.stringify(sampleFile, null, 2))}>Use the sample file</button>
        </div>
      </div>

      {error && <p className="card red">{error}</p>}

      {result && (
        <>
          <VerdictCard r={result} cfg={cfg} />
          <Disclosed r={result} />
          <section>
            <h2 style={{ fontSize: '1.1rem', marginTop: '1.5rem' }}>What this file proves</h2>
            <ul>
              <li>The disclosed bytes were signed inside an attested deployment of {result.d.proof.model} on NEAR AI Cloud: the signing key was logged on NEAR by a verifier that checked the Intel TDX and NVIDIA GPU evidence, and the signature over these exact bytes verifies here.</li>
              <li>The public commit is this exchange&apos;s: it equals sha256(salt ‖ canonical proof) for the proof and salt in this file, so the sender cannot swap in another exchange after the fact. The on-chain record, once <span className="mono">proof_commit</span> is live, fixes the block at which that commit was made.</li>
            </ul>
            <h2 style={{ fontSize: '1.1rem', marginTop: '1rem' }}>What it does not prove</h2>
            <ul>
              <li>What the plaintext said: an E2EE disclosure contains ciphertext. The proof binds bytes, not meaning.</li>
              <li>What the model enclave did with the data after inference: retention inside the enclave is not provable by attestation. The deployment is attested, not the model weights.</li>
              <li>Anything about the sender&apos;s other exchanges: this is a selective disclosure of one.</li>
            </ul>
          </section>
          <details style={{ marginTop: '1rem' }}>
            <summary>Technical details</summary>
            <CheckList items={[{ id: 'log-entry', ...result.log }, ...result.report.checks, { id: 'on-near', ...result.chain }]} />
            <pre className="mono small">{JSON.stringify(result.d.proof, null, 2)}</pre>
          </details>
        </>
      )}
    </main>
  );
}
