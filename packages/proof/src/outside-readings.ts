// Who else has looked at exactly this: public readings by parties that are not us, keyed by the values the enclave
// attests (its signing key and launcher, the hash of its action log, the hash of its release file). Three are read:
//  - Countersign (github.com/greenlima/sealed-review): a reviewer's hash-chained feed, mirrored to a NEAR testnet
//    contract that has no access keys. Each entry is a JWT signed ES256 on a hardware key; it is verified here
//    against the feed's two public keys, pinned below.
//  - Quill Cloud (github.com/Lore-Hex/quill-cloud-proxy): the policy file of a gateway's enclave, public in its
//    repository. A pin there follows a review by a person.
//  - teemoon audits (github.com/teemoonai/audits): source reviews in a public repository, one page for each hash of a
//    release file.
// Shown, never applied: nothing here takes part in the decision to send, and none of them is in a trust set. A reading
// marked `seen` says that the party has published something about exactly this state; what it concluded is in the words
// of the reading, and may be a warning. Their formats are theirs and may change, so a reading that cannot be made is
// said and not guessed.
import { base64UrlToBytes } from './disclosure.ts';
import { normalizeHex, oneLine, shortHex } from './hash.ts';
import { composeHashOf } from './key-entry.ts';
import { eitherSignal, viewFunction } from './near-view.ts';
import { isRepoPath } from './release.ts';
import { releaseName, utcTextOfMs } from './release-lines.ts';
import { actionsHash, type AttestedReport } from './release-marks.ts';
import type { ReleaseInspection } from './release-types.ts';

/**
 * What one outside party says about the attested state. Not a `ReleaseLine` on purpose: those are checks of ours and
 * feed a verdict, and these never do.
 */
export interface OutsideReading {
  /** Who published it, and what kind of publication it is. */
  source: string;
  /**
   * `seen`: what the party publishes now covers exactly this state. `not-seen`: it was read and does not.
   * `unknown`: it could not be read or compared. None of the three is the party's verdict.
   */
  status: 'seen' | 'not-seen' | 'unknown';
  /** The finding in words, with the party's own conclusion quoted when it gave one. */
  text: string;
}
/** A reading before its source is named: what one reader returns. */
export type Finding = Omit<OutsideReading, 'source'>;
const seen = (text: string): Finding => ({ status: 'seen', text });
const notSeen = (text: string): Finding => ({ status: 'not-seen', text });
const unknown = (text: string): Finding => ({ status: 'unknown', text });

/** What the enclave attested, as far as an outside reading can be keyed by it. */
export interface AttestedState {
  model: string;
  /** The model's signing key, hex. */
  signingKey: string;
  /** The compose hash of the enclave's launcher. */
  composeHash: string;
  /** The action log as it stands: how many actions, and their hash as the enclave quotes it. */
  actions?: { count: number; sha256: string } | undefined;
  /** The release that serves the model, when one was resolved. */
  release?: { name: string; file: string; fileSha256?: string | undefined } | undefined;
}

/** The state a verified report attests, with the release an inspection of it resolved (the first service of the model). */
export function attestedStateOf({ signer, deployment }: Pick<AttestedReport, 'signer' | 'deployment'>, model: string, inspection?: ReleaseInspection): AttestedState {
  const actions = deployment.composeManager?.actions;
  const release = inspection?.services[0]?.release;
  return {
    model,
    signingKey: signer.signingAddress,
    composeHash: composeHashOf(deployment),
    actions: actions && { count: actions.length, sha256: actionsHash(actions) },
    release: release && { name: releaseName(release), file: release.file, fileSha256: release.fileSha256 },
  };
}

// ---- Countersign -----------------------------------------------------------------------------------
/**
 * The feed's contract and its two signing keys. The keys are the ones the contract returns from `feed_keys` and the
 * ones in `feed-public-a.pem` and `feed-public-b.pem` of the repository at commit 0a6af7d (compared on Nov 13, 2026).
 * The feed is on testnet whatever network this client reads its own log from.
 */
export const COUNTERSIGN = {
  contract: 'sealed-review-feed.testnet',
  rpcUrl: 'https://rpc.testnet.fastnear.com',
  keys: {
    'iit2a6pLyZ0vObtpjo4bYro9GsmIrXR-U1MbDS5j5eY': { kty: 'EC', crv: 'P-256', x: 'RMNFphPrY344BBKNT6k6jrsyPutzV_I-beGAFe8QC60', y: 'bo0Ey9LmVPnP2BjxBDUeT7G9hjFqWC-4du1WKOHme5A' },
    MQLw81quH7bKRZPW_GNiuWIylUf8IkQv9n38iWNv8DA: { kty: 'EC', crv: 'P-256', x: '1fREPPJ-o06vVNADxX2TLTESR8CQXrX2ztcMhF0hG34', y: 'eGf5-h7eRVoZEU4aFwcKOv9MqdY_hHvxmmkPYlF0nKA' },
  } as Readonly<Record<string, { kty: 'EC'; crv: 'P-256'; x: string; y: string }>>,
} as const;
/** How many routes of the feed are read at most: two for a model today, the direct one and the one through the gateway. */
const MAX_ROUTES = 6;

/** One machine of a feed entry, as far as this client reads it. */
export interface ReviewedMachine {
  signingKey: string;
  composeHash: string;
  /** The reviewer's verdict on this machine, in its own word (`affirming`, `warning`, `contraindicated`, `none`). */
  status: string;
  /** The ids of the reviewer's checks that did not pass. */
  open: string[];
  /** The deployments its action log left running: one compose file can be there several times, once for each set of services. */
  deployments: Array<{ file: string; sha256: string; tag?: string | undefined }>;
}
export interface FeedEntry {
  seq: number;
  /** The route the entry reviews, as the feed names it. */
  host: string;
  signedAtMs: number;
  expiresAtMs: number;
  machines: ReviewedMachine[];
}

const record = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** A word of theirs that a reading will quote (a host, a verdict, a tag, a check id): one line, bounded. */
const quoted = (v: unknown): string => oneLine(text(v), 120);
const reasonOf = (err: unknown): string => oneLine(err instanceof Error ? err.message : String(err), 200);
const jsonOf = (base64url: string): Record<string, unknown> => record(JSON.parse(new TextDecoder().decode(base64UrlToBytes(base64url))));

function machineOf(submod: unknown): ReviewedMachine {
  const m = record(submod);
  const claims = record(m['ear_attester_claims']);
  return {
    signingKey: normalizeHex(text(claims['signing_key']).replace(/^ed25519:/, '')),
    composeHash: normalizeHex(text(claims['compose_hash'])),
    status: quoted(m['ear_status']),
    open: list(record(m['ear_verifier_claims'])['checks']).map(record).filter((c) => c['status'] !== 'pass').map((c) => quoted(c['id'])).filter(Boolean),
    deployments: list(record(claims['workload'])['deployments']).map(record).map((d) => ({ file: text(d['file']), sha256: normalizeHex(text(d['sha256'])), tag: quoted(d['tag']) || undefined })),
  };
}

/**
 * A feed entry, read only if its signature verifies under one of the pinned keys: the contract checks the same
 * signature when the entry is appended, and this client does not take the RPC's word for that. Throws when the entry
 * is not a JWT, is signed by another key, does not verify, or carries no times.
 */
export async function readFeedEntry(jws: string): Promise<FeedEntry> {
  const [head, body, signature, ...rest] = jws.split('.');
  if (!head || !body || !signature || rest.length > 0) throw new Error('not a signed entry');
  const header = jsonOf(head);
  const kid = text(header['kid']);
  const jwk = header['alg'] === 'ES256' && Object.hasOwn(COUNTERSIGN.keys, kid) ? COUNTERSIGN.keys[kid] : undefined;
  if (!jwk) throw new Error('signed by a key this client does not hold for the feed');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, base64UrlToBytes(signature), new TextEncoder().encode(`${head}.${body}`));
  if (!verified) throw new Error('its signature does not verify');
  const payload = jsonOf(body);
  const seq = record(payload['sr_feed'])['seq'];
  const { iat, exp } = payload;
  if (typeof seq !== 'number' || typeof iat !== 'number' || typeof exp !== 'number') throw new Error('it carries no sequence number or no times');
  return { seq, host: quoted(record(payload['sr_scope'])['host']), signedAtMs: iat * 1000, expiresAtMs: exp * 1000, machines: Object.values(record(payload['submods'])).map(machineOf) };
}

/** The first entry, in the order given, that reviews a machine the test accepts, with every such machine of it. */
function firstWith(entries: readonly FeedEntry[], test: (m: ReviewedMachine) => boolean): { entry: FeedEntry; machines: ReviewedMachine[] } | undefined {
  for (const entry of entries) {
    const machines = entry.machines.filter(test);
    if (machines.length > 0) return { entry, machines };
  }
  return undefined;
}

/** What the reviewer recorded of the file that serves the model now: nothing when either side names none. */
function recordedRelease(machines: readonly ReviewedMachine[], release: AttestedState['release']): string {
  const ours = release?.fileSha256 && normalizeHex(release.fileSha256);
  const recorded = machines.flatMap((m) => m.deployments.filter((d) => d.file === release?.file));
  if (!ours || recorded.length === 0) return '';
  // The file is recorded once for each set of services it left running, so the running release is looked for among all.
  if (recorded.some((d) => d.sha256 === ours)) return ` It recorded the release file that runs now${machines.length > 1 ? ' on at least one of them' : ''}.`;
  const names = [...new Set(recorded.map((d) => d.tag ?? shortHex(d.sha256)))];
  return ` Of this release file it recorded ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}: the one that runs now (${shortHex(ours)}) is not among them.`;
}

/** What the feed's current entries say about the attested key and launcher. Entries that could not be read are left out by the caller. */
export function countersignLine(state: AttestedState, entries: readonly FeedEntry[], now: number): Finding {
  const key = normalizeHex(state.signingKey);
  const launcher = normalizeHex(state.composeHash);
  const sameKey = (m: ReviewedMachine): boolean => m.signingKey === key;
  const sameMachine = (m: ReviewedMachine): boolean => sameKey(m) && m.composeHash === launcher;
  // The route through the gateway first: it is the one this client sends over.
  const throughGateway = (e: FeedEntry): number => Number(e.host.startsWith('cloud-api.'));
  const ordered = [...entries].sort((a, b) => throughGateway(b) - throughGateway(a));
  const current = ordered.filter((e) => e.expiresAtMs > now);
  const hit = firstWith(current, sameMachine);
  if (hit) {
    // Replicas share the key and the launcher, and the report does not say which one the reviewer met: all are quoted.
    const { entry, machines } = hit;
    const verdicts = [...new Set(machines.map((m) => `"${m.status}"`))].join(', ');
    const verdict = machines.length === 1 ? `its verdict there is ${verdicts}` : `its verdicts on the ${machines.length} machines there with this key and launcher are ${verdicts}`;
    const notPassed = [...new Set(machines.flatMap((m) => m.open))];
    const open = notPassed.length > 0 ? ` (not passed: ${notPassed.slice(0, 4).join(', ')}${notPassed.length > 4 ? ', …' : ''})` : '';
    return seen(`entry ${entry.seq} of ${utcTextOfMs(entry.signedAtMs)} lists this signing key with this launcher for ${entry.host}; ${verdict}${open}, valid until ${utcTextOfMs(entry.expiresAtMs)}.${recordedRelease(machines, state.release)}`);
  }
  const expired = firstWith(ordered.filter((e) => e.expiresAtMs <= now), sameMachine);
  if (expired) return notSeen(`its entry ${expired.entry.seq} listed this signing key with this launcher and expired on ${utcTextOfMs(expired.entry.expiresAtMs)}`);
  const otherLauncher = firstWith(current, sameKey)?.machines[0];
  if (otherLauncher) return notSeen(`lists this signing key with another launcher (${shortHex(otherLauncher.composeHash)}), not this one`);
  return notSeen(`none of its ${current.length} current entries lists this signing key`);
}

/** When and until when a read may run. */
interface Reading {
  now: number;
  signal: AbortSignal;
}

async function readCountersign(state: AttestedState, { now, signal }: Reading): Promise<Finding> {
  const hosts = await viewFunction(COUNTERSIGN.rpcUrl, COUNTERSIGN.contract, 'hosts', {}, signal);
  if (!Array.isArray(hosts) || hosts.length === 0) throw new Error('its list of routes is empty or not one this client reads');
  // Each route is one view call, so a long list is not read to the end: the routes that name the model go first.
  const namesModel = (route: Record<string, unknown>): number => Number(text(route['host']).includes(state.model));
  const routes = hosts.map(record).sort((a, b) => namesModel(b) - namesModel(a));
  const read = await Promise.allSettled(
    routes.slice(0, MAX_ROUTES).map(async (route) => {
      const seq = record(route['latest'])['seq'];
      if (typeof seq !== 'number') throw new Error('a route without a current entry');
      return readFeedEntry(text(await viewFunction(COUNTERSIGN.rpcUrl, COUNTERSIGN.contract, 'entry', { seq }, signal)));
    }),
  );
  const entries = read.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const failed = read.filter((r) => r.status === 'rejected');
  if (entries.length === 0 && failed[0]) throw failed[0].reason;
  const found = countersignLine(state, entries, now);
  // "Not seen" needs everything read. An entry that did not verify or did not arrive, or a route left unread, may be the one.
  const unread = [
    ...(failed[0] ? [`${failed.length} of its entries could not be read (${reasonOf(failed[0].reason)})`] : []),
    ...(routes.length > MAX_ROUTES ? [`${routes.length - MAX_ROUTES} of its ${routes.length} routes were not read`] : []),
  ];
  return found.status === 'seen' || unread.length === 0 ? found : unknown(`${unread.join(', and ')}; among the rest, ${found.text}`);
}

const okOrThrow = (response: Response): Response => {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
};

// ---- Quill Cloud -----------------------------------------------------------------------------------
export const QUILL_POLICY_URL = 'https://raw.githubusercontent.com/Lore-Hex/quill-cloud-proxy/main/enclave-go/sidecar/near_ai_policy.json';

/** What the gateway's policy file pins for this model, against the launcher and the action log attested now. */
export function quillLine(state: AttestedState, policy: unknown): Finding {
  if (!Array.isArray(policy)) return unknown('its policy file is not the list of pins this client reads');
  const pins = policy.map(record).filter((p) => p['model'] === state.model);
  if (pins.length === 0) return notSeen('has no pin for this model');
  // Replicas share a launcher and each has an action log of its own, so the file may pin one launcher more than once.
  const ofLauncher = pins.filter((p) => normalizeHex(text(p['compose_hash'])) === normalizeHex(state.composeHash));
  const attested = state.actions && normalizeHex(state.actions.sha256);
  const pin = ofLauncher.find((p) => normalizeHex(text(p['deployment_actions_sha256'])) === attested) ?? ofLauncher[0];
  if (!pin) return notSeen(`pins another launcher for this model (${[...new Set(pins.map((p) => shortHex(normalizeHex(text(p['compose_hash'])))))].join(', ')}), not this one`);
  const pinned = normalizeHex(text(pin['deployment_actions_sha256']));
  if (!pinned) return notSeen('pins this launcher without a state of its action log');
  if (!state.actions) return unknown(`pins this launcher at action log ${shortHex(pinned)}; this report carries no action log to compare`);
  if (pinned === attested) return seen(`pins this launcher at exactly this state of the action log (${shortHex(pinned)}, ${state.actions.count} actions)`);
  const file = normalizeHex(text(pin['deployment_sha256']));
  return notSeen(`pins this launcher at another state of the action log (${shortHex(pinned)}${file ? `, release file ${shortHex(file)}` : ''}) than the one attested now (${shortHex(state.actions.sha256)}, ${state.actions.count} actions): nobody there has reviewed this state`);
}

async function readQuill(state: AttestedState, { signal }: Reading): Promise<Finding> {
  return quillLine(state, await okOrThrow(await fetch(QUILL_POLICY_URL, { signal })).json());
}

// ---- teemoon audits --------------------------------------------------------------------------------
const TEEMOON_PAGES = 'https://raw.githubusercontent.com/teemoonai/audits/main/manifests/nearai/cvm-compose-files';

/** The page that repository would hold for a release file: its path layout is the one its README calls frozen. */
export function teemoonPageUrl(release: { file: string; fileSha256?: string | undefined }): string | undefined {
  const sha = release.fileSha256 && normalizeHex(release.fileSha256);
  if (!sha || !/^[0-9a-f]{64}$/.test(sha) || !isRepoPath(release.file)) return undefined;
  return `${TEEMOON_PAGES}/${release.file.replace(/\.ya?ml$/, '').split('/').map(encodeURIComponent).join('/')}/sha256-${sha}.md`;
}

/** `page` is the review's text, or null when the repository has no page for this hash. */
export function teemoonLine(release: NonNullable<AttestedState['release']>, page: string | null): Finding {
  const which = `${shortHex(release.fileSha256 ?? '')}, ${release.name}`;
  if (page === null) return notSeen(`no review of this release file (${which})`);
  // The verdict is the page's own first words after its heading; this client quotes them and reads no further.
  const verdict = /^## verdict:\s*(.+)$/m.exec(page)?.[1]?.split(' — ')[0];
  const begins = verdict && oneLine(verdict, 60);
  return seen(`a review of exactly this release file (${which})${begins ? `; its verdict line begins "${begins}"` : '; its verdict line was not found'}`);
}

async function readTeemoon(state: AttestedState, { signal }: Reading): Promise<Finding> {
  const url = state.release && teemoonPageUrl(state.release);
  if (!state.release || !url) return unknown('no release file with a hash to look up');
  const response = await fetch(url, { signal });
  return teemoonLine(state.release, response.status === 404 ? null : await okOrThrow(response).text());
}

// ---- all three -------------------------------------------------------------------------------------
const SOURCES: ReadonlyArray<{ source: string; read: (state: AttestedState, reading: Reading) => Promise<Finding> }> = [
  { source: `Countersign, a reviewer's signed feed in a NEAR contract (${COUNTERSIGN.contract})`, read: readCountersign },
  { source: 'Quill Cloud, a gateway whose public policy pins what a person reviewed', read: readQuill },
  { source: 'teemoon audits, public source reviews keyed by the hash of a release file', read: readTeemoon },
];
/** How long the three readings together may take: they are a courtesy, and the page does not wait on them. */
const READ_TIMEOUT_MS = 15_000;

/** The three readings, each on its own, from the NEAR testnet RPC and raw.githubusercontent.com with no key and no token. One that cannot be made is `unknown` and says why. */
export async function outsideReadings(state: AttestedState, { now = Date.now(), signal }: { now?: number; signal?: AbortSignal } = {}): Promise<OutsideReading[]> {
  const reading = { now, signal: eitherSignal(AbortSignal.timeout(READ_TIMEOUT_MS), signal) };
  return Promise.all(SOURCES.map(async ({ source, read }) => ({ source, ...(await read(state, reading).catch((err: unknown) => unknown(`could not be read (${reasonOf(err)})`))) })));
}

/**
 * The readings for a verified report and the inspection made of it. It never rejects: these stand next to a check that
 * has already been shown, and a report whose state cannot be worked out here (an action log this package cannot hash)
 * must not undo that check. Then all three are `unknown`.
 */
export async function outsideReadingsFor(attested: Pick<AttestedReport, 'signer' | 'deployment'>, model: string, inspection?: ReleaseInspection, options?: { now?: number; signal?: AbortSignal }): Promise<OutsideReading[]> {
  try {
    return await outsideReadings(attestedStateOf(attested, model, inspection), options);
  } catch (err) {
    return SOURCES.map(({ source }) => ({ source, ...unknown(`could not be read (${reasonOf(err)})`) }));
  }
}
