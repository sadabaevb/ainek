// The release that serves a model, followed from the enclave's authenticated action log to public sources:
//   action log (in the model report, bound to a TDX quote; the SDK authenticates it)
//     -> the latest `compose_up` that covered the model's service: tag, commit, file, sha256 of the file
//     -> that file in the public repository at that commit, hashed here and compared
//     -> the repository's tag of that name, which must point at that commit
//     -> the image the service runs, pinned by digest in the file
//     -> the image's signed build provenance (Sigstore, GitHub Actions): source repository, ref and commit.
// Node only: it reads GitHub. Everything it fetches is public; a GitHub token only raises the anonymous rate limit.
//
// What this establishes and what it does not is spelled out in docs/CLAIMS.md. In short: it follows what Compose Manager
// recorded. It does not show which containers run right now and it does not rebuild images. The log is a record, not a
// measurement: the quote behind it says it came from inside this CVM, not from which container, and the serving containers
// the log describes hold the same quote socket. So the log is as good as the code that has run in that CVM.
import { fetchImageProvenance, verifyImageProvenance, type ImageProvenancePolicy, type VerifiedModelAttestation } from '@nearai/inference-sdk/node';
import { checked, composeFilesOf, firstDeployments, isCommitId, isPlainTag, isRepoPath, managerStartOf, releasesFor, sameInstance, sha256Hex, timeOf, type Checked, type ManagerAction, type Release } from '@ainek/proof';
import { MAX_COMPOSE_BYTES, launcherSettings, modelServices, parseImage, type EngineService, type ImageRef, type LauncherSettings, type MeasuredSetting, type ModelService } from '@ainek/proof/compose-file';
import { describeSdkError as whyOf } from './errors.ts';

/** Where NEAR AI keeps the compose files Compose Manager deploys (the SDK's default too). */
export const COMPOSE_REPOSITORY = 'nearai/cvm-compose-files';

/**
 * Which repository and workflow may build which image, from the SDK's verification guide ("Optional image build
 * provenance"). An image that is not listed is reported as not checked, never as fine.
 */
export const IMAGE_POLICIES: Readonly<Record<string, ImageProvenancePolicy>> = {
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
export interface SourceChange {
  commits: number;
  /** Files changed, as GitHub's comparison lists them: it stops at 300. */
  files: number;
  url: string;
}
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
  /** The engines the service forwards to, as the file names them; empty when it names none this reads. */
  engines: EngineService[];
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
  deployment: VerifiedModelAttestation['deployment'];
  /** The verified report the deployment came from: only its two event logs, which the SDK has replayed against both quotes. */
  report?: { eventLog?: unknown; composeManagerAttestation?: { eventLog?: unknown } | undefined } | undefined;
  model: string;
  /** Optional: raises GitHub's anonymous limit of 60 requests an hour. Sent to api.github.com only. */
  githubToken?: string | undefined;
  fetch?: typeof globalThis.fetch;
}

const GITHUB_API = 'https://api.github.com';

/**
 * The GitHub reads this needs. Public data; the token is optional. Commits, paths and tags come from the action log, so
 * each is checked for its shape here, where it reaches a URL: a path with `..` would read another repository under this one's name.
 */
function github(token: string | undefined, fetchImpl: typeof globalThis.fetch) {
  const get = async (path: string, accept: string): Promise<Response> => {
    let res: Response;
    try {
      res = await fetchImpl(`${GITHUB_API}${path}`, {
        headers: { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ainek-demo', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new Error(`GitHub did not answer (${err instanceof Error ? err.message : String(err)})`);
    }
    if (res.ok) return res;
    const limited = (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0';
    throw new Error(limited ? `GitHub's rate limit is used up (${token ? 'for this token' : '60 anonymous requests an hour; GITHUB_TOKEN raises it'})` : `GitHub answered HTTP ${res.status} for ${path}`);
  };
  return {
    /** A file of a repository at a commit, as bytes. */
    async raw(repository: string, file: string, commit: string): Promise<Uint8Array> {
      if (!isCommitId(commit) || !isRepoPath(file)) throw new Error('the action log names a malformed commit or file path');
      const res = await get(`/repos/${repository}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${commit}`, 'application/vnd.github.raw+json');
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_COMPOSE_BYTES) throw new Error(`${file} at ${commit} is larger than ${MAX_COMPOSE_BYTES} bytes`);
      return bytes;
    },
    /**
     * The commit a commit id or a tag name resolves to in a repository, and when it was committed. A commit id is read as a
     * git object, about 1 KB; a tag name needs the commits endpoint to resolve it, whose answer carries the patches too.
     */
    async commit(repository: string, ref: string): Promise<{ sha: string | undefined; date: string | undefined }> {
      const byId = isCommitId(ref);
      if (!byId && !isPlainTag(ref)) throw new Error('the action log names a malformed commit or tag');
      const res = await get(`/repos/${repository}/${byId ? 'git/commits' : 'commits'}/${ref}`, 'application/vnd.github+json');
      const body = (await res.json()) as { sha?: unknown; committer?: { date?: unknown }; commit?: { committer?: { date?: unknown } } };
      const date = (byId ? body.committer : body.commit?.committer)?.date;
      return { sha: typeof body.sha === 'string' ? body.sha.toLowerCase() : undefined, date: typeof date === 'string' ? date : undefined };
    },
    /** How many commits and files lie between two commits of a repository. */
    async compare(repository: string, from: string, to: string): Promise<{ commits: number; files: number } | undefined> {
      if (!isCommitId(from) || !isCommitId(to)) throw new Error('a build names a malformed source commit');
      const cmp = (await (await get(`/repos/${repository}/compare/${from}...${to}`, 'application/vnd.github+json')).json()) as { total_commits?: unknown; files?: unknown };
      return typeof cmp.total_commits === 'number' && Array.isArray(cmp.files) ? { commits: cmp.total_commits, files: cmp.files.length } : undefined;
    },
  };
}

/** Build provenance of one image, by the policy for its repository. Never rejects. */
async function provenanceOf(image: ImageRef, githubToken: string | undefined): Promise<Checked<Provenance>> {
  const policy = Object.hasOwn(IMAGE_POLICIES, image.repository) ? IMAGE_POLICIES[image.repository] : undefined;
  if (!policy) return checked.skipped('no build policy for this image');
  if (!image.digest) return checked.failed('the image is not pinned by a sha256 digest');
  let bundles: readonly string[];
  try {
    bundles = await fetchImageProvenance({ repository: policy.repository, digest: image.digest, ...(githubToken ? { githubToken } : {}) });
  } catch (err) {
    return checked.skipped(`build proofs could not be fetched: ${whyOf(err)}`);
  }
  try {
    const p = await verifyImageProvenance({ bundles, digest: image.digest, policy });
    return checked.ok({ repository: p.repository, commit: p.commit, ref: p.ref, workflow: p.workflow });
  } catch (err) {
    return checked.failed(whyOf(err));
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
function reader(model: string, githubToken: string | undefined, fetchImpl: typeof globalThis.fetch) {
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
      (ref: string) => ref,
      (ref) => gh.commit(COMPOSE_REPOSITORY, ref),
    ),
    image: once(
      (image: ImageRef) => image.raw,
      async (image): Promise<ImageCheck> => ({ image, provenance: await provenanceOf(image, githubToken) }),
    ),
    compare: gh.compare,
  };
}
type Reader = ReturnType<typeof reader>;

/** Which compose file holds the model's service: the most recently deployed one that names it. */
async function findModelFile(actions: readonly ManagerAction[], model: string, read: Reader): Promise<{ file: string; names: string[] } | { unresolved: string }> {
  const unreadable: string[] = [];
  try {
    for (const candidate of composeFilesOf(actions)) {
      const at = await read.fileAt(candidate.file, candidate.commit);
      if (at.unreadable) unreadable.push(`${candidate.file}: ${at.unreadable}`);
      if (at.services.length > 0) return { file: candidate.file, names: at.services.map((s) => s.service) };
    }
  } catch (err) {
    return { unresolved: whyOf(err) };
  }
  return { unresolved: `no compose file the log deployed has a service with MODEL_NAME=${model}${unreadable.length > 0 ? `; not read as a compose file: ${unreadable.join('; ')}` : ''}` };
}

/** The release's file against the recorded hash, and the service's image and engines as that file defines them. */
async function releaseFile(service: string, release: Release, read: Reader): Promise<Pick<ServiceRelease, 'file' | 'proxy' | 'engines'>> {
  try {
    const at = await read.fileAt(release.file, release.commit);
    const file = !release.fileSha256 ? checked.skipped('the action records no file hash') : at.sha256 === release.fileSha256 ? checked.ok({ sha256: at.sha256 }) : checked.failed(`the public file hashes to ${at.sha256}, the enclave recorded ${release.fileSha256}`);
    const definition = at.services.find((s) => s.service === service);
    return { file, engines: definition?.engines ?? [], ...(definition?.image ? { proxy: await read.image(definition.image) } : {}) };
  } catch (err) {
    return { file: checked.skipped(whyOf(err)), engines: [] };
  }
}

/**
 * The release's tag, resolved in the repository itself, and the commit's time. A commit id alone does not show that the
 * commit is the repository's own: GitHub serves a commit pushed to any fork under the parent's name. A tag is set by those
 * who can write to the repository. The answer for the tag carries the commit's time; without a tag the commit is asked for.
 */
async function releaseTag(release: Release, read: Reader): Promise<Pick<ServiceRelease, 'tag' | 'committedAt'>> {
  const tag = release.tag !== undefined && isPlainTag(release.tag) ? release.tag : undefined;
  const untagged = checked.skipped(release.tag === undefined ? 'the action names no tag' : 'the tag is not a name this looks up');
  try {
    const at = await read.commit(tag ?? release.commit);
    const same = at.sha === release.commit;
    return {
      tag: !tag ? untagged : same ? checked.ok(tag) : checked.failed(`tag ${tag} of ${COMPOSE_REPOSITORY} points at ${at.sha ?? 'no commit'}, the enclave recorded ${release.commit}`),
      committedAt: !same ? checked.skipped('GitHub resolved another commit') : at.date ? checked.ok(at.date) : checked.skipped('GitHub returned no commit date'),
    };
  } catch (err) {
    const unanswered = checked.skipped(whyOf(err));
    return { tag: tag ? unanswered : untagged, committedAt: unanswered };
  }
}

/** The most recent earlier release that ran another build of the service's image, among the last `LOOK_BACK`. */
async function previousBuild(service: string, history: Release[], current: ImageCheck, read: Reader): Promise<ServiceRelease['previousBuild']> {
  for (const earlier of history.slice(-1 - LOOK_BACK, -1).reverse()) {
    let image: ImageRef | undefined;
    try {
      image = (await read.fileAt(earlier.file, earlier.commit)).services.find((s) => s.service === service)?.image;
    } catch {
      return undefined; // GitHub stopped answering: the previous build stays unknown
    }
    if (!image?.digest || image.digest === current.image.digest) continue;
    const proxy = await read.image(image);
    return { release: earlier, proxy, change: await sourceChange(read, proxy.provenance, current.provenance) };
  }
  return undefined;
}

/** How much source lies between two builds of one repository, by GitHub's compare. */
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
async function inspectService(service: string, history: Release[], release: Release, read: Reader): Promise<ServiceRelease> {
  // The file and the tag do not depend on each other.
  const [fromFile, fromTag] = await Promise.all([releaseFile(service, release, read), releaseTag(release, read)]);
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
 * report carried no action log. Never throws for something GitHub or Sigstore did: such a check comes back `skipped`.
 */
export async function inspectRelease({ deployment, report, model, githubToken, fetch: fetchImpl = globalThis.fetch }: InspectReleaseParams): Promise<ReleaseInspection | undefined> {
  const log = deployment.composeManager;
  if (!log) return undefined;
  const actions: readonly ManagerAction[] = log.actions;
  const read = reader(model, githubToken, fetchImpl);
  const launcher = launcherSettings(deployment.appCompose);
  const managerCheck = managerOf(actions, launcher, read); // does not depend on the release: started now, awaited below
  const found = await findModelFile(actions, model, read);
  const services: ServiceRelease[] = [];
  if ('file' in found) {
    const inspected = await Promise.all(
      found.names.map((service) => {
        const history = releasesFor(actions, { file: found.file, service });
        const release = history.at(-1);
        return release ? inspectService(service, history, release, read) : undefined; // defined in the file, never brought up by this log
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

/**
 * Every check of an inspection that was made and did not hold, one line each. A check that could not be made is not among
 * them. The rule lives here, next to the result, so that whoever shows an inspection cannot print a failure and miss it.
 */
export function failedChecks(inspection: ReleaseInspection): string[] {
  const all: [what: string, check: Checked<unknown>][] = [['the instance behind the action log', inspection.log.instance]];
  if (inspection.manager) all.push(["the manager image's build provenance", inspection.manager.provenance]);
  for (const s of inspection.services) {
    all.push([`${s.service}: the release's file`, s.file], [`${s.service}: the release's tag`, s.tag]);
    if (s.proxy) all.push([`${s.service}: the image's build provenance`, s.proxy.provenance]);
    if (s.previousBuild) all.push([`${s.service}: the previous image's build provenance`, s.previousBuild.proxy.provenance]);
  }
  return all.flatMap(([what, check]) => (check.status === 'fail' ? [`${what}: ${check.why}`] : []));
}

/**
 * For every commit of `file` the log deployed: when GitHub says the commit was made, and how long after that its first
 * `compose_up` ran. One GitHub request per commit. The commit time is the committer's (for a merged pull request, GitHub's
 * at the merge) and the deployment time is Compose Manager's clock: neither is a trusted timestamp.
 */
export async function leadTimes(actions: readonly ManagerAction[], file: string, { githubToken, fetch: fetchImpl = globalThis.fetch }: { githubToken?: string | undefined; fetch?: typeof globalThis.fetch } = {}): Promise<LeadTime[]> {
  const gh = github(githubToken, fetchImpl);
  const out: LeadTime[] = [];
  let unavailable: string | undefined; // after GitHub refuses once, stop asking
  for (const release of firstDeployments(actions, file)) {
    let committedAt: Checked<string>;
    if (unavailable) committedAt = checked.skipped(unavailable);
    else if (!isCommitId(release.commit)) committedAt = checked.skipped('the action names a malformed commit'); // its own entry, not a reason to stop
    else {
      try {
        const { date } = await gh.commit(COMPOSE_REPOSITORY, release.commit);
        committedAt = date ? checked.ok(date) : checked.skipped('GitHub returned no commit date');
      } catch (err) {
        committedAt = checked.skipped((unavailable = whyOf(err)));
      }
    }
    const leadMs = committedAt.status === 'ok' ? timeOf(release.deployedAt) - timeOf(committedAt.value) : Number.NaN;
    out.push({ release, committedAt, leadMs: Number.isFinite(leadMs) ? leadMs : undefined });
  }
  return out;
}
