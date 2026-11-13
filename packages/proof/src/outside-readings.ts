// Who else has looked at exactly this: public readings by parties that are not us, keyed by the values the enclave
// attests (its signing key and launcher, the hash of its action log, the hash of its release file). Three are read:
//  - Countersign (github.com/greenlima/sealed-review): a reviewer's hash-chained feed, mirrored to a NEAR testnet
//    contract that has no access keys. Each entry is a JWT signed ES256 on a hardware key; it is verified here
//    against the feed's two public keys, pinned below.
//  - Quill Cloud (github.com/Lore-Hex/quill-cloud-proxy): the policy file of a gateway's enclave, public in its
//    repository. A pin there follows a review by a person.
//  - teemoon audits (github.com/teemoonai/audits): source reviews in a public repository, one page for each hash of a
//    release file.
// Shown, never applied: nothing here takes part in the decision to send, and none of them is in a trust set. A check
// mark on a line says that the party has looked at exactly this state; what it concluded is in the words of the line.
// Their formats are theirs and may change, so a reading that cannot be made is said and not guessed.
import { normalizeHex, shortHex } from './hash.ts';
import { viewFunction } from './near-view.ts';
import { isRepoPath, type ManagerAction } from './release.ts';
import { releaseName, utcText, type ReleaseLine } from './release-lines.ts';
import { actionsHash } from './release-marks.ts';
import type { ReleaseInspection } from './release-types.ts';

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

/** The state from a verified report: its key and launcher, its action log, and the release an inspection resolved (the first service of the model). */
export function attestedStateOf(p: { model: string; signingKey: string; composeHash: string; actions?: readonly ManagerAction[] | undefined; inspection?: ReleaseInspection | undefined }): AttestedState {
  const release = p.inspection?.services[0]?.release;
  return {
    model: p.model,
    signingKey: p.signingKey,
    composeHash: p.composeHash,
    ...(p.actions ? { actions: { count: p.actions.length, sha256: actionsHash(p.actions) } } : {}),
    ...(release ? { release: { name: releaseName(release), file: release.file, fileSha256: release.fileSha256 } } : {}),
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
/** A feed with more routes than this is not read to the end: each route is one view call. */
const MAX_ROUTES = 4;

/** One machine of a feed entry, as far as this client reads it. */
export interface ReviewedMachine {
  signingKey: string;
  composeHash: string;
  /** The reviewer's verdict on this machine, in its own word (`affirming`, `warning`, `contraindicated`, `none`). */
  status: string;
  /** The ids of the reviewer's checks that did not pass. */
  open: string[];
  /** The release files its action log left running, by path. */
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

const bytesOf = (base64url: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};
const record = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * A feed entry, read only if its signature verifies under one of the pinned keys: the contract checks the same
 * signature when the entry is appended, and this client does not take the RPC's word for that. Throws when the entry
 * is not a JWT, is signed by another key, does not verify, or carries no times.
 */
export async function readFeedEntry(jws: string): Promise<FeedEntry> {
  const [head, body, signature, ...rest] = jws.split('.');
  if (!head || !body || !signature || rest.length > 0) throw new Error('not a signed entry');
  const header = record(JSON.parse(new TextDecoder().decode(bytesOf(head))));
  const jwk = header['alg'] === 'ES256' ? COUNTERSIGN.keys[text(header['kid'])] : undefined;
  if (!jwk) throw new Error('signed by a key this client does not hold for the feed');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytesOf(signature), new TextEncoder().encode(`${head}.${body}`));
  if (!verified) throw new Error('its signature does not verify');
  const payload = record(JSON.parse(new TextDecoder().decode(bytesOf(body))));
  const seq = record(payload['sr_feed'])['seq'];
  const { iat, exp } = payload;
  if (typeof seq !== 'number' || typeof iat !== 'number' || typeof exp !== 'number') throw new Error('it carries no sequence number or no times');
  const machines = Object.values(record(payload['submods'])).map((submod): ReviewedMachine => {
    const m = record(submod);
    const claims = record(m['ear_attester_claims']);
    return {
      signingKey: normalizeHex(text(claims['signing_key']).replace(/^ed25519:/, '')),
      composeHash: normalizeHex(text(claims['compose_hash'])),
      status: text(m['ear_status']),
      open: list(record(m['ear_verifier_claims'])['checks']).map(record).filter((c) => c['status'] !== 'pass').map((c) => text(c['id'])).filter(Boolean),
      deployments: list(record(claims['workload'])['deployments']).map(record).map((d) => ({ file: text(d['file']), sha256: normalizeHex(text(d['sha256'])), ...(text(d['tag']) ? { tag: text(d['tag']) } : {}) })),
    };
  });
  return { seq, host: text(record(payload['sr_scope'])['host']), signedAtMs: iat * 1000, expiresAtMs: exp * 1000, machines };
}

const COUNTERSIGN_NAME = `Countersign, a reviewer's signed feed in a NEAR contract (${COUNTERSIGN.contract})`;
const utcOf = (ms: number): string => utcText(Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString() : '');
const sameKey = (state: AttestedState) => (m: ReviewedMachine) => m.signingKey === normalizeHex(state.signingKey);
const sameMachine = (state: AttestedState) => (m: ReviewedMachine) => sameKey(state)(m) && m.composeHash === normalizeHex(state.composeHash);

/** What the feed's current entries say about the attested key and launcher. Entries that could not be read are left out by the caller. */
export function countersignLine(state: AttestedState, entries: readonly FeedEntry[], now: number): ReleaseLine {
  // The route through the gateway first: it is the one this client sends over.
  const ordered = [...entries].sort((a, b) => Number(b.host.startsWith('cloud-api.')) - Number(a.host.startsWith('cloud-api.')));
  const current = ordered.filter((e) => e.expiresAtMs > now);
  const hit = current.find((e) => e.machines.some(sameMachine(state)));
  if (!hit) {
    const expired = ordered.find((e) => e.expiresAtMs <= now && e.machines.some(sameMachine(state)));
    if (expired) return { status: 'skipped', text: `${COUNTERSIGN_NAME}: its entry ${expired.seq} listed this signing key with this launcher and expired on ${utcOf(expired.expiresAtMs)}` };
    const otherLauncher = current.flatMap((e) => e.machines).find(sameKey(state));
    if (otherLauncher) return { status: 'skipped', text: `${COUNTERSIGN_NAME}: lists this signing key with another launcher (${shortHex(otherLauncher.composeHash)}), not this one` };
    return { status: 'skipped', text: `${COUNTERSIGN_NAME}: none of its ${current.length} current entries lists this signing key` };
  }
  const machine = hit.machines.find(sameMachine(state)) as ReviewedMachine;
  const open = machine.open.length > 0 ? ` (not passed: ${machine.open.slice(0, 4).join(', ')}${machine.open.length > 4 ? ', …' : ''})` : '';
  const recorded = state.release && machine.deployments.find((d) => d.file === state.release?.file);
  const ours = state.release?.fileSha256 && normalizeHex(state.release.fileSha256);
  const release = !recorded || !ours ? '' : recorded.sha256 === ours ? ' It recorded the release file that runs now.' : ` It recorded release file ${shortHex(recorded.sha256)}${recorded.tag ? ` (${recorded.tag})` : ''}, another than the one that runs now (${shortHex(ours)}).`;
  return {
    status: 'ok',
    text: `${COUNTERSIGN_NAME}: entry ${hit.seq} of ${utcOf(hit.signedAtMs)} lists this signing key with this launcher for ${hit.host}; its verdict there is "${machine.status}"${open}, valid until ${utcOf(hit.expiresAtMs)}.${release}`,
  };
}

async function readCountersign(state: AttestedState, now: number, signal: AbortSignal): Promise<ReleaseLine> {
  const routes = list(await viewFunction(COUNTERSIGN.rpcUrl, COUNTERSIGN.contract, 'hosts', {}, signal)).map(record).slice(0, MAX_ROUTES);
  const read = await Promise.allSettled(
    routes.map(async (route) => {
      const seq = record(route['latest'])['seq'];
      if (typeof seq !== 'number') throw new Error('a route without a current entry');
      return readFeedEntry(text(await viewFunction(COUNTERSIGN.rpcUrl, COUNTERSIGN.contract, 'entry', { seq }, signal)));
    }),
  );
  const entries = read.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failed = read.find((r) => r.status === 'rejected');
  // An entry that does not verify is not a reading: said, and the others still count.
  if (entries.length === 0 && failed) throw failed.reason;
  return countersignLine(state, entries, now);
}

// ---- Quill Cloud -----------------------------------------------------------------------------------
export const QUILL_POLICY_URL = 'https://raw.githubusercontent.com/Lore-Hex/quill-cloud-proxy/main/enclave-go/sidecar/near_ai_policy.json';
const QUILL_NAME = "Quill Cloud, a gateway whose public policy pins what a person reviewed";

/** What the gateway's policy file pins for this model, against the launcher and the action log attested now. */
export function quillLine(state: AttestedState, policy: unknown): ReleaseLine {
  const pins = list(policy).map(record).filter((p) => p['model'] === state.model);
  if (pins.length === 0) return { status: 'skipped', text: `${QUILL_NAME}: has no pin for this model` };
  const pin = pins.find((p) => normalizeHex(text(p['compose_hash'])) === normalizeHex(state.composeHash));
  if (!pin) return { status: 'skipped', text: `${QUILL_NAME}: pins another launcher for this model (${shortHex(text(pins[0]?.['compose_hash']))}), not this one` };
  const pinned = normalizeHex(text(pin['deployment_actions_sha256']));
  if (!pinned) return { status: 'skipped', text: `${QUILL_NAME}: pins this launcher without a state of its action log` };
  if (!state.actions) return { status: 'skipped', text: `${QUILL_NAME}: pins this launcher at action log ${shortHex(pinned)}; this report carries no action log to compare` };
  if (pinned === normalizeHex(state.actions.sha256)) return { status: 'ok', text: `${QUILL_NAME}: pins this launcher at exactly this state of the action log (${shortHex(pinned)}, ${state.actions.count} actions)` };
  const file = normalizeHex(text(pin['deployment_sha256']));
  return {
    status: 'skipped',
    text: `${QUILL_NAME}: pins this launcher at another state of the action log (${shortHex(pinned)}${file ? `, release file ${shortHex(file)}` : ''}) than the one attested now (${shortHex(state.actions.sha256)}, ${state.actions.count} actions): nobody there has reviewed this state`,
  };
}

// ---- teemoon audits --------------------------------------------------------------------------------
const TEEMOON_PAGES = 'https://raw.githubusercontent.com/teemoonai/audits/main/manifests/nearai/cvm-compose-files';
const TEEMOON_NAME = 'teemoon audits, public source reviews keyed by the hash of a release file';

/** The page that repository would hold for a release file: its path layout is the one its README calls frozen. */
export function teemoonPageUrl(release: { file: string; fileSha256?: string | undefined }): string | undefined {
  const sha = release.fileSha256 && normalizeHex(release.fileSha256);
  if (!sha || !/^[0-9a-f]{64}$/.test(sha) || !isRepoPath(release.file)) return undefined;
  return `${TEEMOON_PAGES}/${release.file.replace(/\.ya?ml$/, '').split('/').map(encodeURIComponent).join('/')}/sha256-${sha}.md`;
}

/** `page` is the review's text, or null when the repository has no page for this hash. */
export function teemoonLine(release: NonNullable<AttestedState['release']>, page: string | null): ReleaseLine {
  const which = `${shortHex(release.fileSha256 ?? '')}, ${release.name}`;
  if (page === null) return { status: 'skipped', text: `${TEEMOON_NAME}: no review of this release file (${which})` };
  // The verdict is the page's own first words after its heading; this client quotes them and reads no further.
  const verdict = /^## verdict:\s*(.+)$/m.exec(page)?.[1]?.split(' — ')[0]?.trim().slice(0, 60);
  return { status: 'ok', text: `${TEEMOON_NAME}: a review of exactly this release file (${which})${verdict ? `; its verdict line begins "${verdict}"` : '; its verdict line was not found'}` };
}

async function readTeemoon(state: AttestedState, signal: AbortSignal): Promise<ReleaseLine> {
  const url = state.release && teemoonPageUrl(state.release);
  if (!state.release || !url) return { status: 'skipped', text: `${TEEMOON_NAME}: no release file with a hash to look up` };
  const response = await fetch(url, { signal });
  if (response.status === 404) return teemoonLine(state.release, null);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return teemoonLine(state.release, await response.text());
}

// ---- all three -------------------------------------------------------------------------------------
/** How long the three readings together may take: they are a courtesy, and the page does not wait on them. */
const READ_TIMEOUT_MS = 15_000;

/**
 * The three readings, each on its own: one that cannot be made is a line that says so, and never an error. They go to
 * the NEAR testnet RPC and to raw.githubusercontent.com, with no key and no token.
 */
export async function outsideReadings(state: AttestedState, { now = Date.now(), signal }: { now?: number; signal?: AbortSignal } = {}): Promise<ReleaseLine[]> {
  const stop = signal ? AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]) : AbortSignal.timeout(READ_TIMEOUT_MS);
  const said = (name: string, read: Promise<ReleaseLine>): Promise<ReleaseLine> =>
    read.catch((err: unknown) => ({ status: 'skipped' as const, text: `${name}: could not be read (${err instanceof Error ? err.message : String(err)})` }));
  return Promise.all([
    said(COUNTERSIGN_NAME, readCountersign(state, now, stop)),
    said(QUILL_NAME, fetch(QUILL_POLICY_URL, { signal: stop }).then(async (r) => (r.ok ? quillLine(state, await r.json()) : Promise.reject(new Error(`HTTP ${r.status}`))))),
    said(TEEMOON_NAME, readTeemoon(state, stop)),
  ]);
}
