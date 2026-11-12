// Reading a docker compose file that Compose Manager deployed: which service answers for a model, which image it runs and
// which engines it forwards to. The file is YAML with anchors and merge keys (the image of a proxy usually sits in a shared
// anchor), so this needs a real parser; it is a subpath export (`@ainek/proof/compose-file`) to keep that parser out of
// bundles that never read a compose file.
//
// The text comes from a public repository and is matched against the sha256 the enclave recorded before it gets here. It is
// still input from outside: the parser's alias limit stays on (raised, see MAX_ALIASES), and nothing in the file is executed
// or interpolated.
import { parse } from 'yaml';
import { checked, type Checked } from './checked.ts';
import { readAppCompose } from './key-entry.ts';

/** Compose files are capped before parsing, as the SDK does (8 MiB). */
export const MAX_COMPOSE_BYTES = 8 * 1024 * 1024;
/**
 * The parser's guard against alias expansion bombs. Its default of 100 refuses NEAR AI's production file (38 services sharing
 * 21 anchors needed about 300 on Nov 12, 2026); 1000 leaves room and still stops a file whose aliases multiply.
 */
const MAX_ALIASES = 1000;

export interface ImageRef {
  /** Repository without a registry prefix for Docker Hub, e.g. `nearaidev/vllm-proxy-rs`. */
  repository: string;
  /** `sha256:<64 hex>` when the reference pins one; a tag alone identifies nothing. */
  digest?: string;
  tag?: string;
  /** The reference as written. */
  raw: string;
}

export interface EngineService {
  service: string;
  image?: ImageRef;
  /** Hugging Face repository and snapshot the engine's command line points at, when it names one. Declared, not measured. */
  weights?: { repository: string; snapshot: string };
}

export interface ModelService {
  /** Compose service whose `MODEL_NAME` is the model: the proxy that terminates E2EE and signs. */
  service: string;
  image?: ImageRef;
  /** Services named in the proxy's `VLLM_BACKEND_URLS`. */
  engines: EngineService[];
}

/** A value as a compose file writes it: plain, or one substitution (`${VAR}`, `${VAR:-fallback}`) filled from the environment at start. */
export interface ComposeValue {
  raw: string;
  /** The environment variable that sets it, when the whole value is one substitution. */
  variable?: string;
  /** What it is while that variable is unset or empty (`:-`) or unset (`-`). */
  fallback?: string;
}

/** What a launcher compose says about Compose Manager: the image it starts as and the minimum age it demands of a tag. */
export interface ManagerDefinition {
  image?: ComposeValue;
  /** `MIN_TAG_AGE_HOURS` as written. Compose Manager's own default, when the variable is absent, is 48. */
  minTagAge?: ComposeValue;
}

/** A value read from a measured app compose, and whether the deployer can set the variable in it. */
export interface MeasuredSetting extends ComposeValue {
  /** True when the variable is among the app compose's `allowed_envs`: its value then comes from the operator, unmeasured. */
  settable: boolean;
}

/** Compose Manager's settings in a measured app compose. */
export interface LauncherSettings {
  image?: MeasuredSetting;
  minTagAge?: MeasuredSetting;
}

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `services` mapping of a compose file, anchors and merge keys resolved. Throws on text that has none. */
function servicesOf(composeYaml: string): Dict {
  if (new TextEncoder().encode(composeYaml).length > MAX_COMPOSE_BYTES) throw new Error(`compose file is larger than ${MAX_COMPOSE_BYTES} bytes`);
  const doc: unknown = parse(composeYaml, { merge: true, maxAliasCount: MAX_ALIASES });
  const services = isDict(doc) ? doc['services'] : undefined;
  if (!isDict(services)) throw new Error('not a compose file: no services mapping');
  return services;
}

/** Splits `${VAR}`, `${VAR:-fallback}` and `${VAR-fallback}`; anything else is a plain value. */
export function composeValue(raw: string): ComposeValue {
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}$/.exec(raw.trim());
  if (!m || !m[1]) return { raw };
  return { raw, variable: m[1], ...(m[2] !== undefined ? { fallback: m[2] } : {}) };
}

/** `repo[:tag][@sha256:…]`, with Docker Hub's optional `docker.io/` prefix dropped. A variable (`${…}`) is kept as written and pins nothing. */
export function parseImage(raw: string): ImageRef {
  const text = raw.trim();
  const at = text.indexOf('@');
  const name = (at === -1 ? text : text.slice(0, at)).replace(/^docker\.io\//, '');
  const digestText = at === -1 ? '' : text.slice(at + 1).toLowerCase();
  const digest = /^sha256:[0-9a-f]{64}$/.test(digestText) ? digestText : undefined;
  // A colon after the last slash separates the tag; one before it belongs to a registry port.
  const colon = name.lastIndexOf(':');
  const tagged = colon > name.lastIndexOf('/');
  const repository = tagged ? name.slice(0, colon) : name;
  const tag = tagged ? name.slice(colon + 1) : undefined;
  return { repository, ...(digest ? { digest } : {}), ...(tag ? { tag } : {}), raw: text };
}

/** `environment` as a map, whether the file wrote it as a list of `K=V` or as a mapping. */
function envOf(service: Dict): Map<string, string> {
  const env = new Map<string, string>();
  const raw = service['environment'];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const eq = item.indexOf('=');
      if (eq > 0) env.set(item.slice(0, eq), item.slice(eq + 1));
    }
  } else if (isDict(raw)) {
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' || typeof v === 'number') env.set(k, String(v));
  }
  return env;
}

function imageOf(service: Dict): ImageRef | undefined {
  const image = service['image'];
  return typeof image === 'string' && image.trim() !== '' ? parseImage(image) : undefined;
}

/** The Hugging Face snapshot in a command line: `…/models--org--repo/snapshots/<40 hex>`. */
function weightsOf(service: Dict): EngineService['weights'] {
  const command = service['command'];
  const text = typeof command === 'string' ? command : Array.isArray(command) ? command.filter((c) => typeof c === 'string').join(' ') : '';
  const m = /models--([A-Za-z0-9_.-]+)--([A-Za-z0-9_.-]+)\/snapshots\/([0-9a-f]{40})/.exec(text);
  return m && m[1] && m[2] && m[3] ? { repository: `${m[1]}/${m[2]}`, snapshot: m[3] } : undefined;
}

/**
 * The services of a compose file whose `MODEL_NAME` equals `model`, each with its image (anchors and merge keys resolved)
 * and the engines its `VLLM_BACKEND_URLS` names. Throws on text that is not a compose file with a `services` mapping.
 */
export function modelServices(composeYaml: string, model: string): ModelService[] {
  const services = servicesOf(composeYaml);
  // An engine is found by its service key or by its container_name, whichever the URL uses.
  const byHost = new Map<string, [string, Dict]>();
  for (const [name, svc] of Object.entries(services)) {
    if (!isDict(svc)) continue;
    byHost.set(name, [name, svc]);
    const container = svc['container_name'];
    if (typeof container === 'string' && !byHost.has(container)) byHost.set(container, [name, svc]);
  }
  const found: ModelService[] = [];
  for (const [name, svc] of Object.entries(services)) {
    if (!isDict(svc)) continue;
    const env = envOf(svc);
    if (env.get('MODEL_NAME') !== model) continue;
    const engines: EngineService[] = [];
    for (const url of (env.get('VLLM_BACKEND_URLS') ?? '').split(',')) {
      const host = /^[a-z]+:\/\/([^/:]+)/i.exec(url.trim())?.[1];
      const hit = host ? byHost.get(host) : undefined;
      if (!hit || engines.some((e) => e.service === hit[0])) continue;
      const image = imageOf(hit[1]);
      const weights = weightsOf(hit[1]);
      engines.push({ service: hit[0], ...(image ? { image } : {}), ...(weights ? { weights } : {}) });
    }
    const image = imageOf(svc);
    found.push({ service: name, ...(image ? { image } : {}), engines });
  }
  return found;
}

/**
 * Compose Manager as a launcher compose defines it (the service of that name), or undefined when the file has no such
 * service. The values are returned as written: whether a variable in them can be set from outside is the caller's question
 * (dstack hands a CVM only the variables its app compose lists as allowed).
 */
export function managerDefinition(composeYaml: string, service = 'compose-manager'): ManagerDefinition | undefined {
  const services = servicesOf(composeYaml);
  const manager = Object.hasOwn(services, service) ? services[service] : undefined;
  if (!isDict(manager)) return undefined;
  const image = manager['image'];
  const minTagAge = envOf(manager).get('MIN_TAG_AGE_HOURS');
  return { ...(typeof image === 'string' && image.trim() !== '' ? { image: composeValue(image) } : {}), ...(minTagAge !== undefined ? { minTagAge: composeValue(minTagAge) } : {}) };
}

/**
 * What a measured app compose (dstack's JSON) says about Compose Manager, or why that could not be read: a launcher whose
 * manager is no longer the service this looks for must read as "not read", not as "nothing to say". The caller must hold
 * an app compose the quote's compose hash covers; then these values are measured, unlike the action log.
 */
export function launcherSettings(appCompose: string): Checked<LauncherSettings> {
  const app = readAppCompose(appCompose);
  if (!app) return checked.skipped('the app compose is not JSON with a docker_compose_file');
  let manager: ManagerDefinition | undefined;
  try {
    manager = managerDefinition(app.composeFile);
  } catch (err) {
    return checked.skipped(`its compose file was not read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!manager) return checked.skipped('its compose file has no compose-manager service');
  const measured = (value: ComposeValue): MeasuredSetting => ({ ...value, settable: value.variable !== undefined && app.allowedEnvs.includes(value.variable) });
  return checked.ok({ ...(manager.image ? { image: measured(manager.image) } : {}), ...(manager.minTagAge ? { minTagAge: measured(manager.minTagAge) } : {}) });
}
