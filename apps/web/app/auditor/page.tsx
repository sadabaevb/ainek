'use client';
// The auditor's side of selective disclosure (SPEC §5.4). Someone hands over ONE exchange: its proof with the salt, the
// exact bytes and the log entry. This page says what that file proves and checks it without trusting the sender: the
// hashes and the commit are recomputed here, the log entry is re-read from the chain, and the commit is looked up on
// NEAR. Nothing leaves this browser except view calls to the NEAR RPC. The checks live in @ainek/proof; this page only
// groups them into rows. Fields the TEE signature does not cover (`e2ee`, `commitTx`) are shown as the sender's claims.
import { useState } from 'react';
import { checkProofCommit, parseDisclosure, readProofCommit, standingOf, trustedVerifierCheck, verifyModelProof, withChecks, type Check, type CheckId, type ParsedDisclosure, type VerifyReport } from '@ainek/proof';
import sampleFile from '../../../../docs/samples/disclosure.sample.json';
import sampleChain from '../../../../docs/samples/disclosure.sample.chain.json';
import { CardHead, CheckList, Row } from '@/components/checks';
import { JsonTextarea, LoadFileButton } from '@/components/json-file-input';
import { RedCard } from '@/components/red-card';
import { KvTable } from '@/components/stack-table';
import type { PublicConfig } from '@/lib/config';
import { describeError } from '@/lib/errors';
import { short, utcMinute } from '@/lib/format';
import { fill } from '@/lib/fill';
import { dict } from '@/lib/i18n';
import { resolveLogEntry } from '@/lib/key-log';
import { explorerTxUrl, verificationCenterUrl } from '@/lib/links';
import { useConfig, useT, useTrust } from '../providers';

type Line = Omit<Check, 'id'>;

/** Check details stay English (components/checks.tsx). This one asks the reader to act, so the card shows it translated. */
const NEEDS_ACCOUNT = dict.en.auditor.enterAccount;

interface Result {
  d: ParsedDisclosure;
  report: VerifyReport;
}

/** The on-chain record for this commit (SPEC §4.2), or why it was not looked up. English like every other check detail. */
async function lookupCommit(cfg: PublicConfig, d: ParsedDisclosure, account: string): Promise<Check> {
  const id = 'on-chain-commit';
  // The chain decides whether a commit exists, not the file: `commitTx` is only the sender's note (a file saved before its commit landed has none).
  const { commit } = d.proof;
  if (commit === undefined) return { id, status: 'skipped', detail: 'the proof carries no commit: nothing to look up' };
  if (cfg.logSource === 'sample') return { id, status: 'skipped', detail: 'chain not consulted (AINEK_LOG_SOURCE=sample)' };
  if (!account) return { id, status: 'skipped', detail: NEEDS_ACCOUNT };
  try {
    return checkProofCommit(d.proof, await readProofCommit(cfg.rpcUrl, cfg.contract, account, commit), account);
  } catch (err) {
    return { id, status: 'skipped', detail: `lookup failed: ${describeError(err)}` };
  }
}

/** One card row from several checks: every failure's detail, else every skip's, else the ok wording. */
function combine(okText: string, ...lines: Line[]): Line {
  for (const status of ['fail', 'skipped'] as const) {
    const hit = lines.filter((l) => l.status === status);
    if (hit.length > 0) return { status, detail: hit.map((l) => l.detail).join('; ') };
  }
  return { status: 'ok', detail: okText };
}

function VerdictCard({ d, report, cfg }: Result & { cfg: PublicConfig }) {
  const { t } = useT();
  const ta = t.auditor;
  const { proof } = d;
  const check = (id: CheckId): Line => report.checks.find((c) => c.id === id) ?? { status: 'skipped', detail: ta.notRun };
  const commit = combine(ta.commitOk(short(proof.commit ?? '')), check('commit'));
  const bytes = combine(ta.bytesOk(d.requestBody.length, d.responseBody.length), check('request-hash'), check('response-hash'));
  const signed = combine(ta.signedOk(proof.signingAlgo, short(proof.signingAddress)), check('route'), check('signed-text'), check('signature'));
  const keyInLog = check('key-in-log');
  const logEntry = check('log-entry');
  const key = combine(`${keyInLog.detail}; ${logEntry.detail}`, keyInLog, logEntry, check('verifier-trusted'));
  const chain = check('on-chain-commit');
  // "Checks out" only when the public log itself answered and the entry's verifier is one the reader trusts: an
  // internally consistent file whose key was confirmed by nothing but the sender's own copy of the entry, or by an
  // account anyone could have registered, is a weaker thing, and the headline and its colour say so.
  const standing = standingOf(report);
  const title = standing === 'failed' ? ta.verdictFail : standing === 'verified' ? ta.verdictOk : logEntry.status === 'ok' ? ta.verdictUntrusted : ta.verdictLocal;

  return (
    <section className="card">
      <CardHead status={standing === 'verified' ? 'ok' : standing === 'failed' ? 'fail' : 'skipped'} when={ta.when(utcMinute(proof.verifiedAt), utcMinute(d.disclosedAt))}>{title}</CardHead>
      <Row status={commit.status} label={ta.rowCommit}>{commit.detail}</Row>
      <Row status={bytes.status} label={ta.rowBytes}>{bytes.detail}</Row>
      <Row status={signed.status} label={ta.rowSigned}>{signed.detail}</Row>
      <Row status={key.status} label={t.rowKey}>{key.detail}</Row>
      <Row status={chain.status} label={t.rowChain}>
        {chain.detail === NEEDS_ACCOUNT ? ta.enterAccount : chain.detail}
        {proof.commitTx && <> · {ta.senderTx} <a href={explorerTxUrl(cfg.explorer, proof.commitTx)} target="_blank" rel="noreferrer">{short(proof.commitTx)}</a></>}
      </Row>
      <div className="actions">
        <a className="btn" href={verificationCenterUrl(proof)} target="_blank" rel="noreferrer">{ta.vcSame}</a>
      </div>
    </section>
  );
}

function Disclosed({ d }: { d: ParsedDisclosure }) {
  const { t } = useT();
  const ta = t.auditor;
  const { proof } = d;
  const rows: Array<[string, string]> = [
    [t.rowModel, proof.model],
    [ta.completion, proof.completionId],
    [ta.request, ta.bytesLine(d.requestBody.length, short(proof.requestSha256))],
    [ta.response, ta.bytesLine(d.responseBody.length, short(proof.responseSha256))],
    [t.rowE2ee, ta.e2eeLine(proof.e2ee)],
    [ta.tools, proof.toolNames.length > 0 ? proof.toolNames.join(', ') : ta.noTools],
    [ta.salt, proof.salt ? ta.saltIncluded : ta.saltMissing],
    [ta.plaintext, ta.plaintextLine],
    [ta.logEntry, ta.logEntryLine(d.logEntry.index, d.logEntry.verifier)],
  ];
  if (d.note) rows.push([ta.note, d.note]);
  return (
    <section>
      <h2>{ta.disclosedTitle}</h2>
      <div className="table-wrap">
        <KvTable rows={rows} />
      </div>
    </section>
  );
}

function Claims({ d, report }: Result) {
  const ta = useT().t.auditor;
  const standing = standingOf(report);
  return (
    <section>
      <h2>{ta.provesTitle}</h2>
      {standing === 'verified' ? (
        <ul>
          <li>{ta.proves1(d.proof.model)}</li>
          <li>{fill(ta.proves2, { method: <span className="mono">proof_commit</span> })}</li>
        </ul>
      ) : (
        <p>{standing === 'failed' ? ta.provesNothing : ta.provesUnconfirmed}</p>
      )}
      <h2>{ta.notProvesTitle}</h2>
      <ul>
        {ta.notProves.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </section>
  );
}

export default function AuditorPage() {
  const cfg = useConfig();
  const { t } = useT();
  const ta = t.auditor;
  const { trust } = useTrust();
  const [text, setText] = useState('');
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  // The sample's committer, filled in by its button, belongs to the sample only: any other text clears it.
  const loadText = (next: string) => {
    setText(next);
    setAccount((a) => (a === sampleChain.committer ? '' : a));
  };
  const loadSample = () => {
    setText(JSON.stringify(sampleFile, null, 2));
    // Committed on one contract only: on another deployment the account would only make the row red.
    setAccount(cfg.contract === sampleChain.contract ? sampleChain.committer : '');
  };

  async function run() {
    setError('');
    setBusy(true);
    try {
      const d = parseDisclosure(JSON.parse(text));
      const [log, chain] = await Promise.all([resolveLogEntry(cfg, d.proof.logIndex, d.logEntry), lookupCommit(cfg, d, account.trim())]);
      const trusted = trustedVerifierCheck(log.entry?.verifier ?? d.proof.verifier, trust.verifiers);
      setResult({ d, report: withChecks(verifyModelProof(d.proof, d.requestBody, d.responseBody, log.entry), log.check, trusted, chain) });
    } catch (err) {
      setResult(null);
      setError(ta.notDisclosure(describeError(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <h1>{t.nav.auditor}</h1>
      <p className="muted">{ta.intro}</p>

      <div className="controls">
        <JsonTextarea value={text} onChange={loadText} onError={setError} placeholder={ta.placeholder} />
        <input type="text" value={account} onChange={(e) => setAccount(e.target.value)} placeholder={ta.accountPlaceholder} />
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => void run()} disabled={busy || !text.trim()}>{busy ? ta.checking : ta.check}</button>
          <LoadFileButton onText={loadText} onError={setError} />
          <button type="button" className="btn" onClick={loadSample}>{ta.useSample}</button>
        </div>
      </div>

      {error && <RedCard title={error} />}

      {result && (
        <>
          <VerdictCard {...result} cfg={cfg} />
          <Disclosed d={result.d} />
          <Claims {...result} />
          <details style={{ marginTop: '1rem' }}>
            <summary>{t.details}</summary>
            <CheckList items={result.report.checks} />
            <pre className="mono small" lang="en">{JSON.stringify(result.d.proof, null, 2)}</pre>
          </details>
        </>
      )}
    </main>
  );
}
