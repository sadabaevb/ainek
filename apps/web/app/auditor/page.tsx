'use client';
// The auditor's side of selective disclosure (SPEC §5.4). Someone hands over ONE exchange: its proof with the salt, the
// exact bytes and the log entry. This page says what that file proves and checks it without trusting the sender: the
// hashes and the commit are recomputed here, the log entry is re-read from the chain, and the commit is looked up on
// NEAR. Nothing leaves this browser except view calls to the NEAR RPC. The checks live in @ainek/proof; this page only
// groups them into rows. Fields the TEE signature does not cover (`e2ee`, `commitTx`) are shown as the sender's claims.
import { useState } from 'react';
import { checkProofCommit, parseDisclosure, readProofCommit, verifyModelProof, withChecks, type Check, type CheckId, type ParsedDisclosure, type VerifyReport } from '@ainek/proof';
import sampleFile from '../../../../docs/samples/disclosure.sample.json';
import { CheckList, Row } from '@/components/checks';
import { JsonTextarea, LoadFileButton } from '@/components/json-file-input';
import type { PublicConfig } from '@/lib/config';
import { describeError } from '@/lib/errors';
import { short, utcMinute } from '@/lib/format';
import { resolveLogEntry } from '@/lib/key-log';
import { explorerTxUrl, verificationCenterUrl } from '@/lib/links';
import { useConfig } from '../providers';

type Line = Omit<Check, 'id'>;

interface Result {
  d: ParsedDisclosure;
  report: VerifyReport;
}

/** The on-chain record for this commit (SPEC §4.2), or why it was not looked up. */
async function lookupCommit(cfg: PublicConfig, d: ParsedDisclosure, account: string): Promise<Check> {
  const id = 'on-chain-commit';
  const { commit, commitTx } = d.proof;
  if (commit === undefined || commitTx === undefined) return { id, status: 'skipped', detail: 'the proof was never committed on NEAR (no commit transaction in the file): nothing to look up' };
  if (cfg.logSource === 'sample') return { id, status: 'skipped', detail: 'chain not consulted (AINEK_LOG_SOURCE=sample)' };
  if (!account) return { id, status: 'skipped', detail: 'enter the NEAR account that committed to look the commit up on-chain' };
  try {
    return checkProofCommit(d.proof, await readProofCommit(cfg.rpcUrl, cfg.contract, account, commit), account);
  } catch (err) {
    return { id, status: 'skipped', detail: `lookup failed: ${describeError(err)}` };
  }
}

const check = (report: VerifyReport, id: CheckId): Line => report.checks.find((c) => c.id === id) ?? { status: 'skipped', detail: 'not run' };

/** One card row from several checks: every failure's detail, else every skip's, else the ok wording. */
function combine(okText: string, ...lines: Line[]): Line {
  for (const status of ['fail', 'skipped'] as const) {
    const hit = lines.filter((l) => l.status === status);
    if (hit.length > 0) return { status, detail: hit.map((l) => l.detail).join('; ') };
  }
  return { status: 'ok', detail: okText };
}

function VerdictCard({ d, report, cfg }: Result & { cfg: PublicConfig }) {
  const { proof } = d;
  const commit = combine(`sha256(salt ‖ canonical proof) = ${short(proof.commit ?? '')}: the public hash is this exchange's`, check(report, 'commit'));
  const bytes = combine(`request ${d.requestBody.length} B and response ${d.responseBody.length} B hash to the values the model TEE signed`, check(report, 'request-hash'), check(report, 'response-hash'));
  const signed = combine(`${proof.signingAlgo} signature by model key ${short(proof.signingAddress)} over model:sha256(request):sha256(response)`, check(report, 'route'), check(report, 'signed-text'), check(report, 'signature'));
  const keyInLog = check(report, 'key-in-log');
  const logEntry = check(report, 'log-entry');
  const key = combine(`${keyInLog.detail}; ${logEntry.detail}`, keyInLog, logEntry);
  const chain = check(report, 'on-chain-commit');
  // "Checks out" only when the public log itself answered: an internally consistent file whose key was confirmed by
  // nothing but the sender's own copy of the entry is a weaker thing, and the headline says so.
  const title = !report.ok ? '✗ This disclosure does not check out' : logEntry.status === 'ok' ? '✓ This disclosure checks out' : '✓ Internally consistent; the public log was not consulted';

  return (
    <section className={`card ${report.ok ? '' : 'red'}`}>
      <h3>{title}</h3>
      <p className="muted small">verified {utcMinute(proof.verifiedAt)}, disclosed {utcMinute(d.disclosedAt)}</p>
      <Row status={commit.status} label="Commit">{commit.detail}</Row>
      <Row status={bytes.status} label="Disclosed bytes">{bytes.detail}</Row>
      <Row status={signed.status} label="Signed inside the model TEE">{signed.detail}</Row>
      <Row status={key.status} label="Key in the public log">{key.detail}</Row>
      <Row status={chain.status} label="On NEAR">
        {chain.detail}
        {proof.commitTx && <> · sender&apos;s transaction: <a href={explorerTxUrl(cfg.explorer, proof.commitTx)} target="_blank" rel="noreferrer">{short(proof.commitTx)}</a></>}
      </Row>
      <div className="actions">
        <a className="btn" href={verificationCenterUrl(proof)} target="_blank" rel="noreferrer">Same signature in NEAR AI Verification Center</a>
      </div>
    </section>
  );
}

function Disclosed({ d }: { d: ParsedDisclosure }) {
  const { proof } = d;
  const rows: Array<[string, string]> = [
    ['Model', proof.model],
    ['Completion', proof.completionId],
    ['Request', `${d.requestBody.length} bytes, sha256 ${short(proof.requestSha256)}`],
    ['Response', `${d.responseBody.length} bytes, sha256 ${short(proof.responseSha256)}`],
    ['End-to-end encrypted', `${proof.e2ee ? 'yes' : 'no'}, as stated by the sender: the flag is not covered by the signature. What the signature covers is the bytes above, whatever they contain.`],
    ['Tools', proof.toolNames.length > 0 ? proof.toolNames.join(', ') : 'none'],
    ['Salt', proof.salt ? 'included (32 bytes): needed to recompute the commit; it makes this file private' : 'not included'],
    ['Plaintext', 'not part of the proof. Any text the sender shows you is not bound by this file.'],
    ['Log entry', `#${d.logEntry.index} by ${d.logEntry.verifier}, embedded in the file (compared with the chain above)`],
  ];
  if (d.note) rows.push(['Note', d.note]);
  return (
    <section>
      <h2>What was disclosed</h2>
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

function Claims({ d, report }: Result) {
  return (
    <section>
      {report.ok ? (
        <>
          <h2>What this file proves</h2>
          <ul>
            <li>The disclosed bytes were signed inside an attested deployment of {d.proof.model} on NEAR AI Cloud: the signing key was logged on NEAR by a verifier that checked the Intel TDX and NVIDIA GPU evidence, and the signature over these exact bytes verifies here.</li>
            <li>The public commit is this exchange&apos;s: it equals sha256(salt ‖ canonical proof) for the proof and salt in this file, so the sender cannot swap in another exchange after the fact. The on-chain record, once <span className="mono">proof_commit</span> is live, fixes the block at which that commit was made.</li>
          </ul>
        </>
      ) : (
        <>
          <h2>What this file proves</h2>
          <p>Nothing: at least one check above failed, so none of the guarantees below are established for this file.</p>
        </>
      )}
      <h2>What it does not prove</h2>
      <ul>
        <li>What the plaintext said: the proof binds bytes, not meaning, and the bytes of an E2EE exchange are ciphertext.</li>
        <li>What the model enclave did with the data after inference: retention inside the enclave is not provable by attestation. The deployment is attested, not the model weights.</li>
        <li>Anything about the sender&apos;s other exchanges: this is a selective disclosure of one.</li>
      </ul>
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
      const d = parseDisclosure(JSON.parse(text));
      const [log, chain] = await Promise.all([resolveLogEntry(cfg, d.proof.logIndex, d.logEntry), lookupCommit(cfg, d, account.trim())]);
      setResult({ d, report: withChecks(verifyModelProof(d.proof, d.requestBody, d.responseBody, log.entry), log.check, chain) });
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
        <JsonTextarea value={text} onChange={setText} placeholder='{"v":1,"kind":"disclosure",...}' />
        <input type="text" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="NEAR account that committed (optional), e.g. alice.testnet" />
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => void run()} disabled={busy || !text.trim()}>{busy ? 'Checking…' : 'Check'}</button>
          <LoadFileButton onText={setText} onError={setError} />
          <button type="button" className="btn" onClick={() => setText(JSON.stringify(sampleFile, null, 2))}>Use the sample file</button>
        </div>
      </div>

      {error && <p className="card red">{error}</p>}

      {result && (
        <>
          <VerdictCard {...result} cfg={cfg} />
          <Disclosed d={result.d} />
          <Claims {...result} />
          <details style={{ marginTop: '1rem' }}>
            <summary>Technical details</summary>
            <CheckList items={result.report.checks} />
            <pre className="mono small">{JSON.stringify(result.d.proof, null, 2)}</pre>
          </details>
        </>
      )}
    </main>
  );
}
