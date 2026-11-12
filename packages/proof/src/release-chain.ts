// The release that serves a model, followed from the enclave's authenticated action log to public sources:
//   action log (in the model report, bound to a TDX quote; the SDK authenticates it)
//     -> the latest `compose_up` that covered the model's service: tag, commit, file, sha256 of the file
//     -> that file in the public repository at that commit, hashed here and compared
//     -> the repository's tag of that name, which must point at that commit
//     -> the image the service runs, pinned by digest in the file
//     -> the image's signed build provenance (Sigstore, GitHub Actions): source repository, ref and commit.
// It reads GitHub with `fetch`, so it runs in Node and in a browser alike. Everything it fetches is public; a GitHub token
// only raises the anonymous rate limit. A subpath of its own (`@ainek/proof/release-chain`), because it brings the YAML
// parser with it. The image checks are NEAR AI's SDK's, which this package does not import: the caller hands them in
// (`ProvenanceSdk`), Node from the SDK's node entry and a browser from its root entry.
//
// What this establishes and what it does not is spelled out in docs/CLAIMS.md. In short: it follows what Compose Manager
// recorded. It does not show which containers run right now and it does not rebuild images. The log is a record, not a
// measurement: the quote behind it says it came from inside this CVM, not from which container, and the serving containers
// the log describes hold the same quote socket. So the log is as good as the code that has run in that CVM.
//
// Every check ends in one of three states (`Checked`). The line between two of them is drawn here: GitHub saying "there is no
// such tag, file or build proof" is the check failing; GitHub not answering (rate limit, outage, no network) is the check
// not made.
import { checked, type Checked } from './checked.ts';
import { MAX_COMPOSE_BYTES, launcherSettings, modelServices, parseImage, type EngineService, type ImageRef, type LauncherSettings, type MeasuredSetting, type ModelService } from './compose-file.ts';
import { sha256Hex } from './hash.ts';
import { COMPOSE_REPOSITORY, composeFilesOf, firstDeployments, isCommitId, isPlainTag, isRepoPath, managerStartOf, releasesFor, sameInstance, timeOf, type ManagerAction, type Release } from './release.ts';

/** Which repository and workflow may build an image. */
export interface ImagePolicy {
  repository: string;
  workflow: string;
}

/**
 * The three functions of NEAR AI's SDK this needs, passed in so that this package imports no SDK. `getSdkError` finds the
 * SDK's own error in a cause chain: its `failure.code` and `retryable` are what tell "there is no build proof" from
 * "nothing could be checked".
 */
export interface ProvenanceSdk {
  fetchImageProvenance(params: { repository: string; digest: string; githubToken?: string }): Promise<readonly string[]>;
  verifyImageProvenance(params: { bundles: readonly string[]; digest: string; policy: ImagePolicy }): Promise<{ repository: string; commit: string; ref: string; workflow: string }>;
  getSdkError(err: unknown): { message: string; retryable: boolean; failure: { code: string; details?: unknown } } | undefined;
}

/** One line for an error that is not the SDK's: a failed read, text that did not parse. */
const whyOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export { COMPOSE_REPOSITORY };

/**
 * Which repository and workflow may build which image, from the SDK's verification guide ("Optional image build
 * provenance"). An image that is not listed is reported as not checked, never as fine.
 */
export const IMAGE_POLICIES: Readonly<Record<string, ImagePolicy>> = {
  'nearaidev/vllm-proxy-rs': { repository: 'nearai/inference-proxy', workflow: '.github/workflows/build.yml' },
  'nearaidev/compose-manager': { repository: 'nearai/compose-manager', workflow: '.github/workflows/build.yml' },
};

/** How many earlier releases are opened while looking for the previous build of a service's image. */
const LOOK_BACK = 3;

export interface Provenance {
  repository: string;
  commit: string;
  ref: string;
  workflow: string;
}
export interface ImageCheck {
  image: ImageRef;
  provenance: Checked<Provenance>;
}
/** The source between two builds, from the earlier one's commit to the later one's. */
export interface SourceChange {
  /** Commits the later build has that the earlier one lacks. */
  ahead: number;
  /** Commits the earlier build has that the later one lacks: above zero, the later build is from older or diverged source. */
  behind: number;
  /** Files changed by the `ahead` commits, as GitHub's comparison lists them: it stops at 300. */
  files: number;
  url: string;
}
/** An engine behind the service. `release` is the engine's own latest release when that is not the service's. */
export type Engine = EngineService & { release?: Release };
export interface ServiceRelease {
  service: string;
  /** Every release of this service the log holds, oldest first. */
  history: Release[];
  /** The latest of them (`history.at(-1)`): what the log says serves the model. */
  release: Release;
  /** The public file at the release's commit hashes to what the enclave recorded. */
  file: Checked<{ sha256: string }>;
  /** The repository's own tag of the recorded name points at the recorded commit. */
  tag: Checked<string>;
  /** The service's image: on NEAR AI the proxy that decrypts the prompt and signs the answer. */
  proxy?: ImageCheck;
  /** The engines the service forwards to, each as its own latest release defines it; empty when the file names none this reads. */
  engines: Engine[];
  /** When the release's commit was made, by GitHub's record (for a merged pull request, the time of the merge). */
  committedAt: Checked<string>;
  /** The most recent earlier release that ran another build of the service's image, among the last few. */
  previousBuild?: { release: Release; proxy: ImageCheck; change: Checked<SourceChange> };
}
export interface ReleaseInspection {
  log: {
    actions: number;
    since: string;
    until: string;
    tcbStatus: string;
    /** The quote behind the log and the quote behind the signing key name one dstack instance id (`sameInstance`). */
    instance: Checked<string>;
  };
  /** What the measured app compose says about Compose Manager, or why it was not read. */
  launcher: Checked<LauncherSettings>;
  /**
   * The image Compose Manager says it last started as. `boot` is the image the measured compose starts it as, when it
   * names one, and whether the two are the same: when they are, the manager's image is part of the compose hash and not
   * only the log's own word.
   */
  manager?: ImageCheck & { startedAt: string; boot?: MeasuredSetting & { image: ImageRef; same: boolean } };
  /** The compose file the model's service was found in. */
  file?: string;
  services: ServiceRelease[];
  /** Why no service could be resolved, when none was. */
  unresolved?: string;
}
export interface LeadTime {
  release: Release;
  committedAt: Checked<string>;
  /** Milliseconds from the commit to its first `compose_up`; undefined when a time is missing or does not parse. */
  leadMs: number | undefined;
}

export interface InspectReleaseParams {
  /** The verified deployment of a model report: the measured app compose and, when the report carried one, the action log the SDK authenticated. */
  deployment: { appCompose: string; composeManager?: { actions: readonly ManagerAction[]; tcbStatus: string } | undefined };
  /** The verified report the deployment came from: only its two event logs, which the SDK has replayed against both quotes. */
  report?: { eventLog?: unknown; composeManagerAttestation?: { eventLog?: unknown } | undefined } | undefined;
  model: string;
  /** Optional: raises GitHub's anonymous limit of 60 requests an hour. Sent to api.github.com only. */
  githubToken?: string | undefined;
  fetch?: typeof globalThis.fetch;
  sdk: ProvenanceSdk;
}

const GITHUB_API = 'https://api.github.com';

/**
 * A GitHub read that did not give the resource. `gone` is true when the answer is about that one resource: GitHub says it
 * does not exist, or its reference is malformed, or it is too large. Another resource may still be read, and a check that
 * needed this one has failed. Otherwise GitHub is not answering now (rate limit, refusal, outage, no network): stop
 * asking, and the check was not made.
 */
class ReadError extends Error {
  readonly gone: boolean;
  constructor(message: string, gone: boolean) {
    super(message);
    this.gone = gone;
  }
}
const isGone = (err: unknown): boolean => err instanceof ReadError && err.gone;

/** A commit named by its id, or by a tag of the repository. */
type CommitRef = { id: string } | { tag: string };

/**
 * The GitHub reads this needs. Public data; the token is optional. Commits, paths and tags come from the action log, so
 * each is checked for its shape here, where it reaches a URL: a path with `..` would read another repository under this one's name.
 */
function github(token: string | undefined, fetchImpl: typeof globalThis.fetch) {
  let useToken = token !== undefined;
  const get = async (path: string, accept: string): Promise<Response> => {
    const ask = async (): Promise<Response> => {
      try {
        return await fetchImpl(`${GITHUB_API}${path}`, {
          headers: { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ainek-demo', ...(useToken ? { Authorization: `Bearer ${token}` } : {}) },
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        throw new ReadError(`GitHub did not answer (${err instanceof Error ? err.message : String(err)})`, false);
      }
    };
    let res = await ask();
    // A token GitHub refuses (expired, revoked) must not hide public data: read anonymously from here on.
    if (res.status === 401 && useToken) {
      useToken = false;
      res = await ask();
    }
    if (res.ok) return res;
    const limited = (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0';
    if (limited) throw new ReadError(`GitHub's rate limit is used up (${useToken ? 'for this token' : '60 anonymous requests an hour; GITHUB_TOKEN raises it'})`, false);
    // 404, and 422 for a ref that names no commit: GitHub has no such resource. Anything else is GitHub not serving now.
    throw new ReadError(`GitHub answered HTTP ${res.status} for ${path}`, res.status === 404 || res.status === 422);
  };
  return {
    /** A file of a repository at a commit, as bytes. */
    async raw(repository: string, file: string, commit: string): Promise<Uint8Array> {
      if (!isCommitId(commit) || !isRepoPath(file)) throw new ReadError('the action log names a malformed commit or file path', true);
      const res = await get(`/repos/${repository}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${commit}`, 'application/vnd.github.raw+json');
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_COMPOSE_BYTES) throw new ReadError(`${file} at ${commit} is larger than ${MAX_COMPOSE_BYTES} bytes`, true);
      return bytes;
    },
    /**
     * The commit a commit id or a tag name resolves to in a repository, and when it was committed. The caller says which of
     * the two it holds, so that a name where an id belongs is never looked up as a name. A commit id is read as a git
     * object, about 1 KB; a tag name needs the commits endpoint to resolve it, whose answer carries the patches too.
     */
    async commit(repository: string, by: CommitRef): Promise<{ sha: string | undefined; date: string | undefined }> {
      const byId = 'id' in by;
      if (byId ? !isCommitId(by.id) : !isPlainTag(by.tag)) throw new ReadError(`the action log names a malformed ${byId ? 'commit' : 'tag'}`, true);
      const res = await get(`/repos/${repository}/${byId ? `git/commits/${by.id}` : `commits/${by.tag}`}`, 'application/vnd.github+json');
      const body = (await res.json()) as { sha?: unknown; committer?: { date?: unknown }; commit?: { committer?: { date?: unknown } } };
      const date = (byId ? body.committer : body.commit?.committer)?.date;
      return { sha: typeof body.sha === 'string' ? body.sha.toLowerCase() : undefined, date: typeof date === 'string' ? date : undefined };
    },
    /** What lies between two commits of a repository, from `from` to `to`: commits on each side and the files `to` changed. */
    async compare(repository: string, from: string, to: string): Promise<{ ahead: number; behind: number; files: number } | undefined> {
      if (!isCommitId(from) || !isCommitId(to)) throw new ReadError('a build names a malformed source commit', true);
      const cmp = (await (await get(`/repos/${repository}/compare/${from}...${to}`, 'application/vnd.github+json')).json()) as { ahead_by?: unknown; behind_by?: unknown; files?: unknown };
      return typeof cmp.ahead_by === 'number' && typeof cmp.behind_by === 'number' ? { ahead: cmp.ahead_by, behind: cmp.behind_by, files: Array.isArray(cmp.files) ? cmp.files.length : 0 } : undefined;
    },
  };
}

/** Build provenance of one image, by the policy for its repository. Never rejects. */
async function provenanceOf(image: ImageRef, githubToken: string | undefined, sdk: ProvenanceSdk): Promise<Checked<Provenance>> {
  const said = (err: unknown): string => sdk.getSdkError(err)?.message ?? whyOf(err);
  /** The HTTP status a request of the SDK failed with, when an HTTP status is what failed it. */
  const httpStatus = (err: unknown): unknown => {
    const failure = sdk.getSdkError(err)?.failure;
    return failure?.code === 'api.http_status' ? (failure.details as { status?: unknown } | undefined)?.status : undefined;
  };
  const policy = Object.hasOwn(IMAGE_POLICIES, image.repository) ? IMAGE_POLICIES[image.repository] : undefined;
  if (!policy) return checked.skipped('no build policy for this image');
  const { digest } = image;
  if (!digest) return checked.failed('the image is not pinned by a sha256 digest');
  const proofs = (token: string | undefined) => sdk.fetchImageProvenance({ repository: policy.repository, digest, ...(token ? { githubToken: token } : {}) });
  let bundles: readonly string[];
  try {
    // A token GitHub refuses must not hide public data: ask again without it.
    bundles = await proofs(githubToken).catch((err: unknown) => (githubToken && httpStatus(err) === 401 ? proofs(undefined) : Promise.reject(err)));
  } catch (err) {
    // GitHub answers 404 for a digest it holds no build proof for. That is the check failing, not the network.
    if (httpStatus(err) === 404) return checked.failed(`${policy.repository} holds no build proof for this digest`);
    return checked.skipped(`build proofs could not be fetched: ${said(err)}`);
  }
  try {
    const p = await sdk.verifyImageProvenance({ bundles, digest, policy });
    return checked.ok({ repository: p.repository, commit: p.commit, ref: p.ref, workflow: p.workflow });
  } catch (err) {
    // The SDK marks one verification failure retryable: Sigstore's trust root could not be fetched. Nothing was verified then.
    return sdk.getSdkError(err)?.retryable === true ? checked.skipped(`build proofs could not be verified now: ${said(err)}`) : checked.failed(said(err));
  }
}

/** `load` made to run once per key: a second caller gets the first one's promise, its failure included. */
function once<A extends unknown[], T>(keyOf: (...args: A) => string, load: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  const seen = new Map<string, Promise<T>>();
  return (...args) => {
    const key = keyOf(...args);
    let loading = seen.get(key);
    if (!loading) seen.set(key, (loading = load(...args)));
    return loading;
  };
}

/** The reads of one inspection, each made once: the services of a model often share a commit, a tag and an image. */
function reader(model: string, githubToken: string | undefined, fetchImpl: typeof globalThis.fetch, sdk: ProvenanceSdk) {
  const gh = github(githubToken, fetchImpl);
  return {
    /**
     * The compose file at a commit: its hash and the model's services in it. A file the log deployed need not be a
     * compose file (a token rotation job, say), so text that does not parse has no services and keeps the reason.
     */
    fileAt: once(
      (file: string, commit: string) => `${file}@${commit}`,
      async (file, commit): Promise<{ sha256: string; services: ModelService[]; unreadable?: string }> => {
        const bytes = await gh.raw(COMPOSE_REPOSITORY, file, commit);
        const sha256 = sha256Hex(bytes);
        try {
          return { sha256, services: modelServices(new TextDecoder().decode(bytes), model) };
        } catch (err) {
          return { sha256, services: [], unreadable: whyOf(err) };
        }
      },
    ),
    /** The commit a tag name or a commit id of the compose repository resolves to. */
    commit: once(
      (by: CommitRef) => ('id' in by ? `id ${by.id}` : `tag ${by.tag}`),
      (by) => gh.commit(COMPOSE_REPOSITORY, by),
    ),
    image: once(
      (image: ImageRef) => image.raw,
      async (image): Promise<ImageCheck> => ({ image, provenance: await provenanceOf(image, githubToken, sdk) }),
    ),
    compare: gh.compare,
  };
}
type Reader = ReturnType<typeof reader>;

/**
 * Which compose file holds the model's service: the most recently deployed one that names it. A file that cannot be read
 * (gone from the repository, not a compose file) is passed over with its reason; GitHub not answering ends the search.
 */
async function findModelFile(actions: readonly ManagerAction[], model: string, read: Reader): Promise<{ file: string; names: string[] } | { unresolved: string }> {
  const unreadable: string[] = [];
  for (const candidate of composeFilesOf(actions)) {
    try {
      const at = await read.fileAt(candidate.file, candidate.commit);
      if (at.services.length > 0) return { file: candidate.file, names: at.services.map((s) => s.service) };
      if (at.unreadable) unreadable.push(`${candidate.file}: ${at.unreadable}`);
    } catch (err) {
      if (!isGone(err)) return { unresolved: whyOf(err) };
      unreadable.push(`${candidate.file}: ${whyOf(err)}`);
    }
  }
  return { unresolved: `no compose file the log deployed has a service with MODEL_NAME=${model}${unreadable.length > 0 ? `; not read as a compose file: ${unreadable.join('; ')}` : ''}` };
}

/**
 * Each engine as its own latest release defines it. An engine can be brought up alone, from another commit than the
 * service in front of it, so the service's file does not say which engine image the log last started.
 */
function enginesOf(named: EngineService[], current: Release, actions: readonly ManagerAction[], read: Reader): Promise<Engine[]> {
  return Promise.all(
    named.map(async (engine): Promise<Engine> => {
      const own = releasesFor(actions, { file: current.file, service: engine.service }).at(-1);
      if (!own || own.commit === current.commit) return engine;
      try {
        const defined = (await read.fileAt(own.file, own.commit)).services.flatMap((s) => s.engines).find((e) => e.service === engine.service);
        return { ...(defined ?? { service: engine.service }), release: own };
      } catch {
        return { service: engine.service, release: own }; // that file was not read: the release is known, the image is not
      }
    }),
  );
}

/** The release's file against the recorded hash, and the service's image and engines. */
async function releaseFile(service: string, release: Release, actions: readonly ManagerAction[], read: Reader): Promise<Pick<ServiceRelease, 'file' | 'proxy' | 'engines'>> {
  try {
    const at = await read.fileAt(release.file, release.commit);
    const file = !release.fileSha256 ? checked.skipped('the action records no file hash') : at.sha256 === release.fileSha256 ? checked.ok({ sha256: at.sha256 }) : checked.failed(`the public file hashes to ${at.sha256}, the enclave recorded ${release.fileSha256}`);
    const definition = at.services.find((s) => s.service === service);
    const [proxy, engines] = await Promise.all([definition?.image ? read.image(definition.image) : undefined, enginesOf(definition?.engines ?? [], release, actions, read)]);
    return { file, engines, ...(proxy ? { proxy } : {}) };
  } catch (err) {
    // The repository has no such file at that commit: the recorded release is not there to compare.
    return { file: isGone(err) ? checked.failed(whyOf(err)) : checked.skipped(whyOf(err)), engines: [] };
  }
}

/**
 * The release's tag, resolved in the repository itself, and the commit's time. A commit id alone does not show that the
 * commit is the repository's own: GitHub serves a commit pushed to any fork under the parent's name. A tag is set by those
 * who can write to the repository, so a recorded tag the repository does not have, or has on another commit, fails.
 * The answer for the tag carries the commit's time; without a tag the commit is asked for.
 */
async function releaseTag(release: Release, read: Reader): Promise<Pick<ServiceRelease, 'tag' | 'committedAt'>> {
  const tag = release.tag !== undefined && isPlainTag(release.tag) ? release.tag : undefined;
  const untagged = checked.skipped(release.tag === undefined ? 'the action names no tag' : 'the tag is not a name this looks up');
  try {
    const at = await read.commit(tag ? { tag } : { id: release.commit });
    const same = at.sha === release.commit;
    return {
      tag: !tag ? untagged : same ? checked.ok(tag) : checked.failed(`tag ${tag} of ${COMPOSE_REPOSITORY} points at ${at.sha ?? 'no commit'}, the enclave recorded ${release.commit}`),
      committedAt: !same ? checked.skipped('GitHub resolved another commit') : at.date ? checked.ok(at.date) : checked.skipped('GitHub returned no commit date'),
    };
  } catch (err) {
    const unanswered = checked.skipped(whyOf(err));
    if (!tag) return { tag: untagged, committedAt: unanswered };
    return { tag: isGone(err) ? checked.failed(`${COMPOSE_REPOSITORY} has no tag ${tag}: ${whyOf(err)}`) : unanswered, committedAt: unanswered };
  }
}

/** The most recent earlier release that ran another build of the service's image, among the last `LOOK_BACK`. */
async function previousBuild(service: string, history: Release[], current: ImageCheck, read: Reader): Promise<ServiceRelease['previousBuild']> {
  for (const earlier of history.slice(-1 - LOOK_BACK, -1).reverse()) {
    let image: ImageRef | undefined;
    try {
      image = (await read.fileAt(earlier.file, earlier.commit)).services.find((s) => s.service === service)?.image;
    } catch {
      return undefined; // that file was not read: the previous build stays unknown
    }
    if (!image?.digest || image.digest === current.image.digest) continue;
    const proxy = await read.image(image);
    return { release: earlier, proxy, change: await sourceChange(read, proxy.provenance, current.provenance) };
  }
  return undefined;
}

/** What source lies between two builds of one repository, by GitHub's compare, from the earlier build to the later one. */
async function sourceChange(read: Reader, from: Checked<Provenance>, to: Checked<Provenance>): Promise<Checked<SourceChange>> {
  if (from.status !== 'ok' || to.status !== 'ok') return checked.skipped('one of the two builds has no verified source commit');
  if (from.value.repository !== to.value.repository) return checked.skipped('the two builds come from different repositories');
  try {
    const cmp = await read.compare(to.value.repository, from.value.commit, to.value.commit);
    return cmp ? checked.ok({ ...cmp, url: `https://github.com/${to.value.repository}/compare/${from.value.commit.slice(0, 10)}...${to.value.commit.slice(0, 10)}` }) : checked.skipped('GitHub returned no comparison');
  } catch (err) {
    return checked.skipped(whyOf(err));
  }
}

/** One service of the model: its latest release checked against the public file and tag, its image, the build before it. */
async function inspectService(service: string, history: Release[], release: Release, actions: readonly ManagerAction[], read: Reader): Promise<ServiceRelease> {
  // The file and the tag do not depend on each other.
  const [fromFile, fromTag] = await Promise.all([releaseFile(service, release, actions, read), releaseTag(release, read)]);
  const previous = fromFile.proxy?.image.digest ? await previousBuild(service, history, fromFile.proxy, read) : undefined;
  return { service, history, release, ...fromFile, ...fromTag, ...(previous ? { previousBuild: previous } : {}) };
}

/** The image the log says the manager last started as, checked, next to the image the measured compose starts it as. */
async function managerOf(actions: readonly ManagerAction[], launcher: Checked<LauncherSettings>, read: Reader): Promise<ReleaseInspection['manager']> {
  const started = managerStartOf(actions);
  if (!started) return undefined;
  const check = await read.image(parseImage(started.image));
  const setting = launcher.status === 'ok' ? launcher.value.image : undefined;
  if (!setting) return { ...check, startedAt: started.startedAt };
  const image = parseImage(setting.fallback ?? setting.raw);
  return { ...check, startedAt: started.startedAt, boot: { ...setting, image, same: image.digest !== undefined && image.digest === check.image.digest && image.repository === check.image.repository } };
}

/**
 * Follows the action log of a verified model deployment to the release that serves `model`. Returns undefined when the
 * report carried no action log. Never throws for something GitHub or Sigstore did: a check they kept from being made comes
 * back `skipped`.
 */
export async function inspectRelease({ deployment, report, model, githubToken, fetch: fetchImpl = globalThis.fetch, sdk }: InspectReleaseParams): Promise<ReleaseInspection | undefined> {
  const log = deployment.composeManager;
  if (!log) return undefined;
  const actions: readonly ManagerAction[] = log.actions;
  const read = reader(model, githubToken, fetchImpl, sdk);
  const launcher = launcherSettings(deployment.appCompose);
  const managerCheck = managerOf(actions, launcher, read); // does not depend on the release: started now, awaited below
  const found = await findModelFile(actions, model, read);
  const services: ServiceRelease[] = [];
  if ('file' in found) {
    const inspected = await Promise.all(
      found.names.map((service) => {
        const history = releasesFor(actions, { file: found.file, service });
        const release = history.at(-1);
        return release ? inspectService(service, history, release, actions, read) : undefined; // defined in the file, never brought up by this log
      }),
    );
    services.push(...inspected.filter((s) => s !== undefined));
  }
  const manager = await managerCheck;
  const unresolved = 'unresolved' in found ? found.unresolved : services.length === 0 ? `the log never brought up the service of ${model} from ${found.file}` : undefined;
  return {
    log: { actions: actions.length, since: actions[0]?.timestamp ?? '', until: actions.at(-1)?.timestamp ?? '', tcbStatus: log.tcbStatus, instance: sameInstance(report?.eventLog, report?.composeManagerAttestation?.eventLog) },
    launcher,
    ...(manager ? { manager } : {}),
    ...('file' in found ? { file: found.file } : {}),
    services,
    ...(unresolved ? { unresolved } : {}),
  };
}

type Named = [what: string, check: Checked<unknown>];
/** The checks that say whether the release serving the model is the one public sources show, each with a name for a person. */
function currentChecks(inspection: ReleaseInspection): Named[] {
  return [
    ['that the log is from the CVM that holds the key', inspection.log.instance],
    ["the manager image's build provenance", inspection.manager?.provenance ?? checked.skipped('the log records no start of the manager')],
    ...inspection.services.flatMap((s): Named[] => [
      [`the file of the release (${s.service})`, s.file],
      [`the tag of the release (${s.service})`, s.tag],
      [`the build provenance of the image (${s.service})`, s.proxy?.provenance ?? checked.skipped('the service names no image in the file')],
    ]),
  ];
}

/**
 * Every check of an inspection that was made and did not hold, one line each. A check that could not be made is not among
 * them. The rule lives here, next to the result, so that whoever shows an inspection cannot print a failure and miss it.
 */
export function failedChecks(inspection: ReleaseInspection): string[] {
  const earlier = inspection.services.flatMap((s): Named[] => (s.previousBuild ? [[`the build provenance of the previous image (${s.service})`, s.previousBuild.proxy.provenance]] : []));
  return [...currentChecks(inspection), ...earlier].flatMap(([what, check]) => (check.status === 'fail' ? [`${what}: ${check.why}`] : []));
}

/**
 * The checks of the current release that could not be made, by name. While there are any, the release was not verified,
 * whatever else held: "nothing failed" is not "everything was checked".
 */
export function uncheckedChecks(inspection: ReleaseInspection): string[] {
  return currentChecks(inspection).flatMap(([what, check]) => (check.status === 'skipped' ? [what] : []));
}

/**
 * For every commit of `file` the log deployed: when GitHub says the commit was made, and how long after that its first
 * `compose_up` ran. One GitHub request per commit. The commit time is the committer's (for a merged pull request, GitHub's
 * at the merge) and the deployment time is Compose Manager's clock: neither is a trusted timestamp.
 */
export async function leadTimes(actions: readonly ManagerAction[], file: string, { githubToken, fetch: fetchImpl = globalThis.fetch }: { githubToken?: string | undefined; fetch?: typeof globalThis.fetch } = {}): Promise<LeadTime[]> {
  const gh = github(githubToken, fetchImpl);
  const out: LeadTime[] = [];
  let unavailable: string | undefined; // once GitHub stops answering, stop asking; a commit it does not have is only that commit's gap
  for (const release of firstDeployments(actions, file)) {
    let committedAt: Checked<string>;
    if (unavailable) committedAt = checked.skipped(unavailable);
    else {
      try {
        const { date } = await gh.commit(COMPOSE_REPOSITORY, { id: release.commit });
        committedAt = date ? checked.ok(date) : checked.skipped('GitHub returned no commit date');
      } catch (err) {
        committedAt = checked.skipped(whyOf(err));
        if (!isGone(err)) unavailable = whyOf(err);
      }
    }
    const leadMs = committedAt.status === 'ok' ? timeOf(release.deployedAt) - timeOf(committedAt.value) : Number.NaN;
    out.push({ release, committedAt, leadMs: Number.isFinite(leadMs) ? leadMs : undefined });
  }
  return out;
}

export { countText, describeRelease, utcText } from './release-lines.ts';
export type { ReleaseLine } from './release-lines.ts';
