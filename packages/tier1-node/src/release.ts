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
import { composeFilesOf, firstDeployments, firstRuntimeEvent, isCommitId, isPlainTag, isRepoPath, managerStartOf, releasesFor, sha256Hex, timeOf, type ManagerAction, type Release } from '@ainek/proof';
import { MAX_COMPOSE_BYTES, managerDefinition, modelServices, parseImage, type ComposeValue, type EngineService, type ImageRef, type ModelService } from '@ainek/proof/compose-file';
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

/** A check that passed with a value, could not be made (network, rate limit, nothing to check), or failed. */
export type Checked<T> = { status: 'ok'; value: T } | { status: 'skipped'; why: string } | { status: 'fail'; why: string };

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
/** A value read from the measured launcher compose, and whether the operator can set the variable in it. */
export interface MeasuredSetting extends ComposeValue {
  /** True when the variable is among the app compose's `allowed_envs`: its value then comes from the operator, unmeasured. */
  settable: boolean;
}
export interface ServiceRelease {
  service: string;
  /** Every release of this service the log holds, oldest first. */
  history: Release[];
  /** The latest one: what the log says serves the model. */
  release: Release;
  /** The public file at the release's commit hashes to what the enclave recorded. */
  file: Checked<{ sha256: string }>;
  /** The repository's own tag of the recorded name points at the recorded commit. */
  tag: Checked<string>;
  /** The service's image: on NEAR AI the proxy that decrypts the prompt and signs the answer. */
  proxy?: ImageCheck;
  engines: EngineService[];
  /** When the release's commit was made, by GitHub's record (for a merged pull request, the time of the merge). */
  committedAt: Checked<string>;
  /** The most recent earlier release that ran another build of the service's image, within the look-back. */
  previousBuild?: { release: Release; proxy: ImageCheck; change: Checked<SourceChange> };
}
export interface ReleaseInspection {
  log: {
    actions: number;
    since: string;
    until: string;
    tcbStatus: string;
    /**
     * The quote behind the log and the quote behind the signing key name one dstack instance id. The SDK checks that both
     * booted from the same app compose, which every replica of a model does; this ties the log to the replica that attested
     * the key. It rules out a mix-up between replicas, not a host that runs two CVMs under one id.
     */
    instance: Checked<string>;
  };
  /**
   * The image Compose Manager says it last started as. `boot` is the image the measured compose starts it as, and whether
   * the two are the same: when they are, the manager's image is part of the compose hash and not only the log's own word.
   */
  manager?: ImageCheck & { startedAt: string; boot?: { image: ImageRef; variable?: string; settable: boolean; same: boolean } };
  /** The minimum age Compose Manager is told to demand of a tag, as the measured compose writes it. */
  minTagAge?: MeasuredSetting;
  /** The compose file the model's service was found in. */
  file?: string;
  services: ServiceRelease[];
  /** Why no service could be resolved, when none was. */
  unresolved?: string;
}
export interface LeadTime {
  release: Release;
  committedAt: Checked<string>;
  /** Milliseconds from the commit to its first `compose_up`, when both are known. */
  leadMs?: number;
}

export interface InspectReleaseParams {
  deployment: VerifiedModelAttestation['deployment'];
  /** The verified report the deployment came from: only its two event logs, which the SDK has replayed against both quotes. */
  report?: { eventLog?: unknown; composeManagerAttestation?: { eventLog?: unknown } | undefined } | undefined;
  model: string;
  /** Optional: raises GitHub's anonymous limit of 60 requests an hour. Sent to api.github.com only. */
  githubToken?: string | undefined;
  /** How many earlier releases to open while looking for the previous build of the service's image. */
  lookBack?: number;
  fetch?: typeof globalThis.fetch;
}

const GITHUB_API = 'https://api.github.com';
const ok = <T>(value: T): Checked<T> => ({ status: 'ok', value });
const skipped = (why: string): Checked<never> => ({ status: 'skipped', why });
const failed = (why: string): Checked<never> => ({ status: 'fail', why });

/**
 * The GitHub reads this needs. Public data; the token is optional. Commits, paths and tags come from the action log, so
 * each is checked for its shape before it reaches a URL: a path with `..` would read another repository under this one's name.
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
    /** The commit a commit id or a tag name resolves to in a repository, and when it was committed. */
    async commit(repository: string, ref: string): Promise<{ sha: string | undefined; date: string | undefined }> {
      if (!isCommitId(ref) && !isPlainTag(ref)) throw new Error('the action log names a malformed commit or tag');
      const body = (await (await get(`/repos/${repository}/commits/${ref}`, 'application/vnd.github+json')).json()) as { sha?: unknown; commit?: { committer?: { date?: unknown } } };
      const date = body.commit?.committer?.date;
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

/**
 * What the measured app compose says about Compose Manager: the image it is started as and the minimum tag age it is given.
 * This text is the one the quote's compose hash covers (the SDK checked that), so it is measured, unlike the action log.
 */
function launcherOf(appCompose: string): { image?: MeasuredSetting; minTagAge?: MeasuredSetting } | undefined {
  try {
    const app = JSON.parse(appCompose) as { docker_compose_file?: unknown; allowed_envs?: unknown };
    if (typeof app.docker_compose_file !== 'string') return undefined;
    const manager = managerDefinition(app.docker_compose_file);
    if (!manager) return undefined;
    const allowed = new Set(Array.isArray(app.allowed_envs) ? app.allowed_envs.filter((name): name is string => typeof name === 'string') : []);
    const measured = (value: ComposeValue): MeasuredSetting => ({ ...value, settable: value.variable !== undefined && allowed.has(value.variable) });
    return { ...(manager.image ? { image: measured(manager.image) } : {}), ...(manager.minTagAge ? { minTagAge: measured(manager.minTagAge) } : {}) };
  } catch {
    return undefined; // not an app compose this reads: the lines that depend on it are left out
  }
}

/**
 * Follows the action log of a verified model deployment to the release that serves `model`. Returns undefined when the
 * report carried no action log. Never throws for something GitHub or Sigstore did: such a check comes back `skipped`.
 */
export async function inspectRelease({ deployment, report, model, githubToken, lookBack = 3, fetch: fetchImpl = globalThis.fetch }: InspectReleaseParams): Promise<ReleaseInspection | undefined> {
  const manager = deployment.composeManager;
  if (!manager) return undefined;
  const actions: readonly ManagerAction[] = manager.actions;
  const gh = github(githubToken, fetchImpl);
  const launcher = launcherOf(deployment.appCompose);
  const keyInstance = firstRuntimeEvent(report?.eventLog, 'instance-id');
  const logInstance = firstRuntimeEvent(report?.composeManagerAttestation?.eventLog, 'instance-id');
  const instance: Checked<string> = !keyInstance || !logInstance ? skipped('an event log names no instance id') : keyInstance === logInstance ? ok(keyInstance) : failed(`the log was quoted by instance ${logInstance}, the signing key by instance ${keyInstance}`);
  const inspection: ReleaseInspection = {
    log: { actions: actions.length, since: actions[0]?.timestamp ?? '', until: actions.at(-1)?.timestamp ?? '', tcbStatus: manager.tcbStatus, instance },
    ...(launcher?.minTagAge ? { minTagAge: launcher.minTagAge } : {}),
    services: [],
  };

  /** Build provenance of one image, by the policy for its repository. */
  const checkImage = async (image: ImageRef): Promise<ImageCheck> => {
    const policy = Object.hasOwn(IMAGE_POLICIES, image.repository) ? IMAGE_POLICIES[image.repository] : undefined;
    if (!policy) return { image, provenance: skipped('no build policy for this image') };
    if (!image.digest) return { image, provenance: failed('the image is not pinned by a sha256 digest') };
    let bundles: readonly string[];
    try {
      bundles = await fetchImageProvenance({ repository: policy.repository, digest: image.digest, ...(githubToken ? { githubToken } : {}) });
    } catch (err) {
      return { image, provenance: skipped(`build proofs could not be fetched: ${whyOf(err)}`) };
    }
    try {
      const p = await verifyImageProvenance({ bundles, digest: image.digest, policy });
      return { image, provenance: ok({ repository: p.repository, commit: p.commit, ref: p.ref, workflow: p.workflow }) };
    } catch (err) {
      return { image, provenance: failed(whyOf(err)) };
    }
  };

  const started = managerStartOf(actions);
  if (started) {
    const check = await checkImage(parseImage(started.image));
    const boot = launcher?.image;
    const bootImage = boot ? parseImage(boot.fallback ?? boot.raw) : undefined;
    inspection.manager = {
      ...check,
      startedAt: started.startedAt,
      ...(boot && bootImage ? { boot: { image: bootImage, ...(boot.variable ? { variable: boot.variable } : {}), settable: boot.settable, same: bootImage.digest !== undefined && bootImage.digest === check.image.digest && bootImage.repository === check.image.repository } } : {}),
    };
  }

  // The compose file at a commit, fetched once: its hash, and the model's services in it. A file the log deployed need not
  // be a compose file (a token rotation job, say), so text that does not parse has no services and keeps the reason.
  const files = new Map<string, Promise<{ sha256: string; services: ModelService[]; unreadable?: string }>>();
  const fileAt = (file: string, commit: string) => {
    const key = `${file}@${commit}`;
    let loading = files.get(key);
    if (!loading) {
      loading = gh.raw(COMPOSE_REPOSITORY, file, commit).then((bytes) => {
        const sha256 = sha256Hex(bytes);
        try {
          return { sha256, services: modelServices(new TextDecoder().decode(bytes), model) };
        } catch (err) {
          return { sha256, services: [], unreadable: whyOf(err) };
        }
      });
      files.set(key, loading);
    }
    return loading;
  };

  // Which file holds the model's service: the most recently deployed one that names it.
  let found: { file: string; names: string[] } | undefined;
  const unreadable: string[] = [];
  try {
    for (const candidate of composeFilesOf(actions)) {
      const at = await fileAt(candidate.file, candidate.commit);
      if (at.unreadable) unreadable.push(`${candidate.file}: ${at.unreadable}`);
      if (at.services.length > 0) {
        found = { file: candidate.file, names: at.services.map((s) => s.service) };
        break;
      }
    }
  } catch (err) {
    inspection.unresolved = whyOf(err);
    return inspection;
  }
  if (!found) {
    inspection.unresolved = `no compose file the log deployed has a service with MODEL_NAME=${model}${unreadable.length > 0 ? `; not read as a compose file: ${unreadable.join('; ')}` : ''}`;
    return inspection;
  }
  inspection.file = found.file;

  for (const service of found.names) {
    const history = releasesFor(actions, { file: found.file, service });
    const release = history.at(-1);
    if (!release) continue; // defined in the file, never brought up by this log
    const entry: ServiceRelease = { service, history, release, file: skipped('not checked'), tag: skipped('not checked'), engines: [], committedAt: skipped('not checked') };
    try {
      const at = await fileAt(release.file, release.commit);
      entry.file = !release.fileSha256 ? skipped('the action records no file hash') : at.sha256 === release.fileSha256 ? ok({ sha256: at.sha256 }) : failed(`the public file hashes to ${at.sha256}, the enclave recorded ${release.fileSha256}`);
      const definition = at.services.find((s) => s.service === service);
      if (definition) {
        entry.engines = definition.engines;
        if (definition.image) entry.proxy = await checkImage(definition.image);
      }
    } catch (err) {
      entry.file = skipped(whyOf(err));
    }
    // The tag, resolved in the repository itself. A commit id alone does not show that the commit is the repository's own:
    // GitHub serves a commit pushed to any fork under the parent's name. A tag is set by those who can write to the
    // repository. The same answer carries the commit's time; without a tag the commit is asked for directly.
    const tag = release.tag !== undefined && isPlainTag(release.tag) ? release.tag : undefined;
    if (!tag) entry.tag = skipped(release.tag === undefined ? 'the action names no tag' : 'the tag is not a name this looks up');
    try {
      const at = await gh.commit(COMPOSE_REPOSITORY, tag ?? release.commit);
      const same = at.sha === release.commit.toLowerCase();
      if (tag) entry.tag = same ? ok(tag) : failed(`tag ${tag} of ${COMPOSE_REPOSITORY} points at ${at.sha ?? 'no commit'}, the enclave recorded ${release.commit}`);
      entry.committedAt = !same ? skipped('GitHub resolved another commit') : at.date ? ok(at.date) : skipped('GitHub returned no commit date');
    } catch (err) {
      const why = whyOf(err);
      if (tag) entry.tag = skipped(why);
      entry.committedAt = skipped(why);
    }
    // The previous build: walk back through earlier releases until the image differs.
    if (entry.proxy?.image.digest) {
      for (const earlier of history.slice(0, -1).reverse().slice(0, lookBack)) {
        let image: ImageRef | undefined;
        try {
          image = (await fileAt(earlier.file, earlier.commit)).services.find((s) => s.service === service)?.image;
        } catch {
          break; // GitHub stopped answering: the previous build stays unknown
        }
        if (!image?.digest || image.digest === entry.proxy.image.digest) continue;
        const proxy = await checkImage(image);
        entry.previousBuild = { release: earlier, proxy, change: await sourceChange(gh, proxy.provenance, entry.proxy.provenance) };
        break;
      }
    }
    inspection.services.push(entry);
  }
  if (inspection.services.length === 0) inspection.unresolved = `the log never brought up the service of ${model} from ${found.file}`;
  return inspection;
}

/** How much source lies between two builds of one repository, by GitHub's compare. */
async function sourceChange(gh: ReturnType<typeof github>, from: Checked<Provenance>, to: Checked<Provenance>): Promise<Checked<SourceChange>> {
  if (from.status !== 'ok' || to.status !== 'ok') return skipped('one of the two builds has no verified source commit');
  if (from.value.repository !== to.value.repository) return skipped('the two builds come from different repositories');
  try {
    const cmp = await gh.compare(to.value.repository, from.value.commit, to.value.commit);
    return cmp ? ok({ ...cmp, url: `https://github.com/${to.value.repository}/compare/${from.value.commit.slice(0, 10)}...${to.value.commit.slice(0, 10)}` }) : skipped('GitHub returned no comparison');
  } catch (err) {
    return skipped(whyOf(err));
  }
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
    if (unavailable || !isCommitId(release.commit)) {
      out.push({ release, committedAt: skipped(unavailable ?? 'the action names a malformed commit') });
      continue;
    }
    try {
      const { date } = await gh.commit(COMPOSE_REPOSITORY, release.commit);
      const leadMs = date ? timeOf(release.deployedAt) - timeOf(date) : Number.NaN;
      out.push({ release, committedAt: date ? ok(date) : skipped('GitHub returned no commit date'), ...(Number.isFinite(leadMs) ? { leadMs } : {}) });
    } catch (err) {
      unavailable = whyOf(err);
      out.push({ release, committedAt: skipped(unavailable) });
    }
  }
  return out;
}
