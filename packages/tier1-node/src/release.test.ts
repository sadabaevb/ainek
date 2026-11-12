import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex, type ManagerAction } from '@ainek/proof';
import { failedChecks, inspectRelease, leadTimes, type InspectReleaseParams } from './release.ts';

// A compose repository of two commits, served by a fake GitHub. The images have no build policy, so no test reaches Sigstore.
const FILE = 'prod/models.yaml';
const MODEL = 'vendor/model-a';
const compose = (proxyDigest: string) => `
x-proxy: &proxy
  image: org/proxy@sha256:${proxyDigest}
services:
  proxy-a:
    <<: *proxy
    environment:
      - MODEL_NAME=${MODEL}
      - VLLM_BACKEND_URLS=http://engine-a:8000
  engine-a:
    image: org/engine@sha256:${'e'.repeat(64)}
    command: serve --model-path /hub/models--some-org--Some-Model/snapshots/${'9'.repeat(40)}
`;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const COMMITS: Record<string, { text: string; date: string; tag: string }> = {
  [A]: { text: compose('1'.repeat(64)), date: '2026-11-01T10:00:00Z', tag: 'v0.0.1' },
  [B]: { text: compose('2'.repeat(64)), date: '2026-11-03T09:49:00Z', tag: 'v0.0.2' },
};
const up = (timestamp: string, commit: string, extra: Partial<ManagerAction> = {}): ManagerAction => ({ action: 'compose_up', timestamp, commit, file: FILE, ...(COMMITS[commit] ? { tag: COMMITS[commit].tag } : {}), file_sha256: sha256Hex(COMMITS[commit]?.text ?? ''), services: ['proxy-a'], ...extra });
const MANAGER = `org/manager@sha256:${'c'.repeat(64)}`;
const ACTIONS: ManagerAction[] = [
  { action: 'compose_manager_started', timestamp: '2026-11-01T09:00:00Z', image: MANAGER },
  up('2026-11-01T12:00:00Z', A),
  { action: 'compose_up', timestamp: '2026-11-02T00:00:00Z', commit: A, file: 'prod/rotate-token.yaml' },
  up('2026-11-03T10:00:00.123456789+00:00', B),
];

interface Seen { paths: string[]; auth: (string | null)[] }
/** `tags` moves a tag to another commit, as the repository's writers could. */
function fakeGitHub(over: (path: string) => Response | undefined = () => undefined, tags: Record<string, string> = {}): { fetch: typeof globalThis.fetch; seen: Seen } {
  const seen: Seen = { paths: [], auth: [] };
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    seen.paths.push(path);
    seen.auth.push(new Headers(init?.headers).get('authorization'));
    const forced = over(path);
    if (forced) return forced;
    const contents = /^\/repos\/nearai\/cvm-compose-files\/contents\/(.+)\?ref=(\w+)$/.exec(path);
    if (contents) {
      const commit = COMMITS[contents[2] ?? ''];
      if (decodeURIComponent(contents[1] ?? '') === 'prod/rotate-token.yaml') return new Response('job: rotate', { status: 200 });
      return commit ? new Response(commit.text, { status: 200 }) : new Response('{}', { status: 404 });
    }
    // A tag name is resolved by the commits endpoint; a commit id is read as a git object, a smaller answer of another shape.
    const tag = /^\/repos\/nearai\/cvm-compose-files\/commits\/([\w.-]+)$/.exec(path)?.[1];
    if (tag) {
      const sha = tags[tag] ?? Object.keys(COMMITS).find((id) => COMMITS[id]?.tag === tag);
      return sha ? Response.json({ sha, commit: { committer: { date: COMMITS[sha]?.date } } }) : new Response('{}', { status: 422 });
    }
    const id = /^\/repos\/nearai\/cvm-compose-files\/git\/commits\/(\w+)$/.exec(path)?.[1];
    if (id) return COMMITS[id] ? Response.json({ sha: id, committer: { date: COMMITS[id].date } }) : new Response('{}', { status: 404 });
    return new Response('{}', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}
/** A deployment whose measured app compose starts the manager as `bootImage` and lets the operator set what `allowed` lists. */
const deploymentOf = (actions: ManagerAction[], bootImage = MANAGER, allowed: string[] = ['CM_MIN_TAG_AGE_HOURS']): InspectReleaseParams['deployment'] =>
  ({
    appCompose: JSON.stringify({
      allowed_envs: allowed,
      docker_compose_file: `services:\n  compose-manager:\n    image: \${MANAGER_IMAGE:-${bootImage}}\n    environment:\n      - MIN_TAG_AGE_HOURS=\${CM_MIN_TAG_AGE_HOURS:-0}\n`,
    }),
    runtimeMeasurements: {},
    composeManager: { actions, tcbStatus: 'UpToDate', advisoryIds: [], runtimeMeasurements: {} },
  }) as InspectReleaseParams['deployment'];

test('inspectRelease: the latest release of the model, its file and tag checked, images and the previous build', async () => {
  const { fetch, seen } = fakeGitHub();
  const found = await inspectRelease({ deployment: deploymentOf(ACTIONS), model: MODEL, fetch });
  assert.ok(found);
  assert.deepEqual(found.log, { actions: 4, since: '2026-11-01T09:00:00Z', until: '2026-11-03T10:00:00.123456789+00:00', tcbStatus: 'UpToDate', instance: { status: 'skipped', why: 'an event log names no instance id' } });
  assert.equal(found.file, FILE);
  assert.equal(found.unresolved, undefined);
  const [service] = found.services;
  assert.equal(service?.service, 'proxy-a');
  assert.equal(service?.release.commit, B);
  assert.deepEqual(service?.history.map((r) => r.commit), [A, B]);
  assert.deepEqual(service?.file, { status: 'ok', value: { sha256: sha256Hex(COMMITS[B]?.text ?? '') } });
  assert.deepEqual(service?.tag, { status: 'ok', value: 'v0.0.2' });
  assert.equal(service?.proxy?.image.digest, `sha256:${'2'.repeat(64)}`);
  assert.deepEqual(service?.proxy?.provenance, { status: 'skipped', why: 'no build policy for this image' });
  assert.deepEqual(service?.engines.map((e) => [e.service, e.weights?.repository]), [['engine-a', 'some-org/Some-Model']]);
  assert.deepEqual(service?.committedAt, { status: 'ok', value: '2026-11-03T09:49:00Z' });
  assert.equal(service?.previousBuild?.release.commit, A);
  assert.equal(service?.previousBuild?.proxy.image.digest, `sha256:${'1'.repeat(64)}`);
  assert.equal(service?.previousBuild?.change.status, 'skipped', 'no verified source commits to compare');
  assert.equal(found.manager?.image.repository, 'org/manager');
  assert.ok(seen.auth.every((a) => a === null), 'no token, no Authorization header');
  assert.equal(seen.paths.filter((p) => p.includes('/contents/')).length, 2, 'each commit of the file is fetched once');
  assert.deepEqual(seen.paths.filter((p) => p.includes('/commits/')), ['/repos/nearai/cvm-compose-files/commits/v0.0.2'], 'one request answers for the tag and the commit time');
});

test('inspectRelease: a file that differs from the recorded hash is a failure; a token goes to GitHub and nowhere else', async () => {
  const { fetch, seen } = fakeGitHub();
  const tampered = ACTIONS.map((a) => (a.commit === B ? { ...a, file_sha256: 'f'.repeat(64) } : a));
  const found = await inspectRelease({ deployment: deploymentOf(tampered), model: MODEL, githubToken: 'test-token', fetch });
  assert.equal(found?.services[0]?.file.status, 'fail');
  assert.match(found?.services[0]?.file.status === 'fail' ? found.services[0].file.why : '', /the enclave recorded f{64}/);
  assert.ok(seen.auth.every((a) => a === 'Bearer test-token'));
});

test('inspectRelease: a tag that points at another commit is a failure; a tag that could be a commit id is not looked up by name', async () => {
  // The repository's tag was moved: the recorded commit may be nobody's release.
  const moved = await inspectRelease({ deployment: deploymentOf(ACTIONS), model: MODEL, fetch: fakeGitHub(undefined, { 'v0.0.2': A }).fetch });
  const tag = moved?.services[0]?.tag;
  assert.equal(tag?.status, 'fail');
  assert.match(tag?.status === 'fail' ? tag.why : '', new RegExp(`tag v0\\.0\\.2 of nearai/cvm-compose-files points at ${A}, the enclave recorded ${B}`));
  assert.equal(moved?.services[0]?.committedAt.status, 'skipped', 'the time of another commit is not this release\'s');
  // A log that puts a commit id where the tag goes would have GitHub resolve the id itself, fork commits included.
  const { fetch, seen } = fakeGitHub();
  const hexTag = await inspectRelease({ deployment: deploymentOf(ACTIONS.map((a) => (a.commit === B ? { ...a, tag: B } : a))), model: MODEL, fetch });
  assert.deepEqual(hexTag?.services[0]?.tag, { status: 'skipped', why: 'the tag is not a name this looks up' });
  assert.equal(hexTag?.services[0]?.committedAt.status, 'ok', 'the commit time is still read, by commit id');
  assert.deepEqual(seen.paths.filter((p) => p.includes('/commits/')), [`/repos/nearai/cvm-compose-files/git/commits/${B}`]);
  // No tag at all: said so, and a GitHub failure afterwards does not replace that reason.
  const untagged = ACTIONS.map(({ tag: _tag, ...rest }) => rest as ManagerAction);
  const down = await inspectRelease({ deployment: deploymentOf(untagged), model: MODEL, fetch: fakeGitHub((path) => (path.includes('/commits/') ? new Response('{}', { status: 500 }) : undefined)).fetch });
  assert.deepEqual(down?.services[0]?.tag, { status: 'skipped', why: 'the action names no tag' });
  assert.equal(down?.services[0]?.committedAt.status, 'skipped');
});

test('inspectRelease: a path or commit that would leave the repository never reaches GitHub', async () => {
  for (const bad of [{ file: '../../../evil/repo/contents/x.yaml' }, { commit: `${A}/../../../../evil/repo/commits/x` }, { commit: 'main' }]) {
    const { fetch, seen } = fakeGitHub();
    const found = await inspectRelease({ deployment: deploymentOf([...ACTIONS, up('2026-11-04T00:00:00Z', B, bad)]), model: MODEL, fetch });
    assert.match(found?.unresolved ?? '', /malformed commit or file path/, JSON.stringify(bad));
    assert.deepEqual(found?.services, []);
    assert.ok(seen.paths.every((p) => !p.includes('evil') && !p.includes('..') && !p.includes('main')), seen.paths.join(' '));
  }
});

test('inspectRelease: the manager the log names against the image the measured compose starts it as; the tag age it is given', async () => {
  const same = await inspectRelease({ deployment: deploymentOf(ACTIONS), model: MODEL, fetch: fakeGitHub().fetch });
  assert.deepEqual(same?.manager?.boot, { raw: `\${MANAGER_IMAGE:-${MANAGER}}`, variable: 'MANAGER_IMAGE', fallback: MANAGER, settable: false, image: { repository: 'org/manager', digest: `sha256:${'c'.repeat(64)}`, raw: MANAGER }, same: true });
  assert.deepEqual(same?.launcher.status === 'ok' ? same.launcher.value.minTagAge : undefined, { raw: '${CM_MIN_TAG_AGE_HOURS:-0}', variable: 'CM_MIN_TAG_AGE_HOURS', fallback: '0', settable: true });
  // Replaced after boot: the log names an image the compose hash does not cover.
  const swapped = await inspectRelease({ deployment: deploymentOf(ACTIONS, `org/manager@sha256:${'d'.repeat(64)}`), model: MODEL, fetch: fakeGitHub().fetch });
  assert.equal(swapped?.manager?.boot?.same, false);
  // The operator may set the image variable: the fallback is then only a default.
  const settable = await inspectRelease({ deployment: deploymentOf(ACTIONS, MANAGER, ['MANAGER_IMAGE']), model: MODEL, fetch: fakeGitHub().fetch });
  assert.deepEqual([settable?.manager?.boot?.same, settable?.manager?.boot?.settable], [true, true]);
  // An app compose this cannot read says so, and the release is resolved all the same.
  const opaque = await inspectRelease({ deployment: { ...deploymentOf(ACTIONS), appCompose: '{}' }, model: MODEL, fetch: fakeGitHub().fetch });
  assert.deepEqual([opaque?.manager?.boot, opaque?.launcher, opaque?.services.length], [undefined, { status: 'skipped', why: 'the app compose is not JSON with a docker_compose_file' }, 1]);
});

test('inspectRelease: the log must be quoted by the CVM instance that quoted the signing key, not by another replica', async () => {
  const events = (instance: string) => [{ imr: 3, event_type: 0x08000001, event: 'instance-id', event_payload: instance }];
  const reportOf = (keyInstance: string, logInstance: string): InspectReleaseParams['report'] => ({ eventLog: events(keyInstance), composeManagerAttestation: { eventLog: JSON.stringify(events(logInstance)) } });
  const run = async (report: InspectReleaseParams['report']) => (await inspectRelease({ deployment: deploymentOf(ACTIONS), report, model: MODEL, fetch: fakeGitHub().fetch }))?.log.instance;
  assert.deepEqual(await run(reportOf('a8a2', 'a8a2')), { status: 'ok', value: 'a8a2' });
  assert.deepEqual(await run(reportOf('a8a2', 'b7b1')), { status: 'fail', why: 'the log was quoted by instance b7b1, the signing key by instance a8a2' });
  assert.equal((await run({ eventLog: events('a8a2') }))?.status, 'skipped');
});

test('failedChecks: what was checked and did not hold, and nothing that could not be checked', async () => {
  const clean = await inspectRelease({ deployment: deploymentOf(ACTIONS), model: MODEL, fetch: fakeGitHub().fetch });
  assert.ok(clean);
  assert.deepEqual(failedChecks(clean), [], 'no build policy and no event logs: not checked is not failed');
  // A file that does not match, a tag moved elsewhere and a log from another replica: three failures, each named.
  const events = (instance: string) => [{ imr: 3, event_type: 0x08000001, event: 'instance-id', event_payload: instance }];
  const bad = await inspectRelease({
    deployment: deploymentOf(ACTIONS.map((a) => (a.commit === B ? { ...a, file_sha256: 'f'.repeat(64) } : a))),
    report: { eventLog: events('a8a2'), composeManagerAttestation: { eventLog: events('b7b1') } },
    model: MODEL,
    fetch: fakeGitHub(undefined, { 'v0.0.2': A }).fetch,
  });
  assert.ok(bad);
  assert.deepEqual(failedChecks(bad).map((f) => f.split(':').slice(0, -1).join(':').replace(/: (the public file|tag v).*$/, '')), ['the instance behind the action log', "proxy-a: the release's file", "proxy-a: the release's tag"]);
  // GitHub refusing everything fails nothing: the checks were not made.
  const refused = await inspectRelease({ deployment: deploymentOf(ACTIONS), model: MODEL, fetch: fakeGitHub(() => new Response('{}', { status: 500 })).fetch });
  assert.ok(refused);
  assert.deepEqual(failedChecks(refused), []);
});

test('inspectRelease: without an action log there is nothing to inspect; a model no file names stays unresolved', async () => {
  assert.equal(await inspectRelease({ deployment: { appCompose: '{}', runtimeMeasurements: {} }, model: MODEL, fetch: fakeGitHub().fetch }), undefined);
  const other = await inspectRelease({ deployment: deploymentOf(ACTIONS), model: 'vendor/none', fetch: fakeGitHub().fetch });
  assert.deepEqual(other?.services, []);
  assert.match(other?.unresolved ?? '', /no compose file the log deployed has a service with MODEL_NAME=vendor\/none; not read as a compose file: prod\/rotate-token\.yaml: /);
});

test('inspectRelease: when GitHub refuses, the log is still reported and the checks say why they were not made', async () => {
  const limited = () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
  const found = await inspectRelease({ deployment: deploymentOf(ACTIONS), model: MODEL, fetch: fakeGitHub(limited).fetch });
  assert.equal(found?.log.actions, 4);
  assert.deepEqual(found?.services, []);
  assert.match(found?.unresolved ?? '', /rate limit is used up \(60 anonymous requests an hour; GITHUB_TOKEN raises it\)/);
  // GitHub answering for the file but not for the commit: the release is resolved, its tag and age are not checked.
  const partial = await inspectRelease({ deployment: deploymentOf(ACTIONS), model: MODEL, fetch: fakeGitHub((path) => (path.includes('/commits/') ? new Response('{}', { status: 500 }) : undefined)).fetch });
  assert.equal(partial?.services[0]?.file.status, 'ok');
  assert.equal(partial?.services[0]?.tag.status, 'skipped');
  assert.equal(partial?.services[0]?.committedAt.status, 'skipped');
});

test('leadTimes: from the commit to its first compose_up, and no more requests after GitHub refuses once', async () => {
  const times = await leadTimes(ACTIONS, FILE, { fetch: fakeGitHub().fetch });
  assert.deepEqual(times.map((t) => [t.release.commit, t.leadMs]), [[A, 2 * 3_600_000], [B, 11 * 60_000 + 123]]);
  const { fetch, seen } = fakeGitHub(() => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }));
  const refused = await leadTimes(ACTIONS, FILE, { fetch });
  assert.deepEqual(refused.map((t) => t.committedAt.status), ['skipped', 'skipped']);
  assert.equal(seen.paths.length, 1);
  // A malformed commit is skipped by itself, without a request and without stopping the rest.
  const odd = fakeGitHub();
  const mixed = await leadTimes([up('2026-11-01T12:00:00Z', 'main'), ...ACTIONS], FILE, { fetch: odd.fetch });
  assert.deepEqual(mixed.map((t) => [t.release.commit, t.committedAt.status]), [['main', 'skipped'], [A, 'ok'], [B, 'ok']]);
  assert.equal(odd.seen.paths.length, 2);
});
