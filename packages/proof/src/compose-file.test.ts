import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeValue, launcherSettings, managerDefinition, modelServices, parseImage } from './compose-file.ts';

const D1 = 'a'.repeat(64);
const D2 = 'b'.repeat(64);
const SNAPSHOT = '99f1fa70408c52b007d4fd69e02e5a522422e755';

// The shape of the files NEAR AI's Compose Manager deploys, written from scratch: images in shared anchors, merge keys,
// engines found through the proxy's backend URLs.
const COMPOSE = `
x-proxy-common: &proxy-common
  image: org/proxy@sha256:${D1}
  restart: unless-stopped
x-engine-common: &engine-common
  image: docker.io/org/engine:v1@sha256:${D2}
  command: >
    engine serve
    --model-path /root/.cache/huggingface/hub/models--some-org--Some-Model-W4/snapshots/${SNAPSHOT}
services:
  proxy-a:
    <<: *proxy-common
    container_name: proxy-a
    environment:
      - MODEL_NAME=vendor/model-a
      - VLLM_BACKEND_URLS=http://engine-a-r1:8000,http://engine-a-r2:8000,http://gone:8000
  engine-a-r1:
    <<: *engine-common
  engine-a-r2:
    <<: *engine-common
    container_name: engine-a-r2
  proxy-b:
    image: org/proxy:latest
    environment:
      MODEL_NAME: vendor/model-b
  helper:
    image: \${HELPER_IMAGE:-org/helper@sha256:${D1}}
`;

test('modelServices: the proxy of a model, its image through the anchor, its engines and the weights they point at', () => {
  const [service, ...rest] = modelServices(COMPOSE, 'vendor/model-a');
  assert.equal(rest.length, 0);
  assert.equal(service?.service, 'proxy-a');
  assert.deepEqual(service?.image, { repository: 'org/proxy', digest: `sha256:${D1}`, raw: `org/proxy@sha256:${D1}` });
  assert.deepEqual(service?.engines.map((e) => e.service), ['engine-a-r1', 'engine-a-r2'], 'a backend the file does not define is left out');
  assert.deepEqual(service?.engines[0]?.image, { repository: 'org/engine', digest: `sha256:${D2}`, tag: 'v1', raw: `docker.io/org/engine:v1@sha256:${D2}` });
  assert.deepEqual(service?.engines[0]?.weights, { repository: 'some-org/Some-Model-W4', snapshot: SNAPSHOT });
});

test('modelServices: environment as a mapping; a tag alone pins nothing; an unknown model has no service', () => {
  const [b] = modelServices(COMPOSE, 'vendor/model-b');
  assert.equal(b?.service, 'proxy-b');
  assert.deepEqual(b?.image, { repository: 'org/proxy', tag: 'latest', raw: 'org/proxy:latest' });
  assert.deepEqual(b?.engines, []);
  assert.deepEqual(modelServices(COMPOSE, 'vendor/none'), []);
});

test('modelServices: text that is not a compose file is an error, not an empty answer', () => {
  assert.throws(() => modelServices('just: text', 'm'), /no services mapping/);
  assert.throws(() => modelServices('services: [a, b]', 'm'), /no services mapping/);
});

test('parseImage: registry prefix, port, tag and digest; a variable is kept as written and pins nothing', () => {
  assert.deepEqual(parseImage(`docker.io/nearaidev/sglang@sha256:${D1.toUpperCase()}`), { repository: 'nearaidev/sglang', digest: `sha256:${D1}`, raw: `docker.io/nearaidev/sglang@sha256:${D1.toUpperCase()}` });
  assert.deepEqual(parseImage('registry.example:5000/team/app:1.2'), { repository: 'registry.example:5000/team/app', tag: '1.2', raw: 'registry.example:5000/team/app:1.2' });
  assert.equal(parseImage('org/app@sha256:short').digest, undefined);
  assert.equal(parseImage('${IMAGE:-org/app@sha256:' + D1 + '}').digest, undefined);
});

test('modelServices: a file whose aliases multiply is refused by the parser, not expanded', () => {
  const row = (name: string, of: string) => `${name}: &${name} [${Array(9).fill(of).join(',')}]`;
  const bomb = [row('a', 'x'), row('b', '*a'), row('c', '*b'), row('d', '*c'), row('e', '*d'), 'services: { s: { image: i, labels: [*e, *e, *e] } }'].join('\n');
  assert.throws(() => modelServices(bomb, 'm'), /alias count/);
});

test('composeValue: one substitution is split into its variable and fallback; anything else is plain', () => {
  assert.deepEqual(composeValue('${AGE:-0}'), { raw: '${AGE:-0}', variable: 'AGE', fallback: '0' });
  assert.deepEqual(composeValue('${AGE-}'), { raw: '${AGE-}', variable: 'AGE', fallback: '' });
  assert.deepEqual(composeValue('${AGE}'), { raw: '${AGE}', variable: 'AGE' });
  assert.deepEqual(composeValue('48'), { raw: '48' });
  assert.deepEqual(composeValue('pre-${AGE:-0}'), { raw: 'pre-${AGE:-0}' }, 'a substitution inside other text is not one value');
});

test('managerDefinition: the image a launcher compose starts the manager as and the tag age it is given', () => {
  const launcher = `
services:
  compose-manager:
    image: \${MANAGER_IMAGE:-org/manager@sha256:${D1}}
    environment:
      - GITHUB_REPO=https://github.com/org/files
      - MIN_TAG_AGE_HOURS=\${CM_MIN_TAG_AGE_HOURS:-0}
  sidecar:
    image: org/sidecar@sha256:${D2}
`;
  const manager = managerDefinition(launcher);
  assert.deepEqual(manager?.image, { raw: `\${MANAGER_IMAGE:-org/manager@sha256:${D1}}`, variable: 'MANAGER_IMAGE', fallback: `org/manager@sha256:${D1}` });
  assert.deepEqual(manager?.minTagAge, { raw: '${CM_MIN_TAG_AGE_HOURS:-0}', variable: 'CM_MIN_TAG_AGE_HOURS', fallback: '0' });
  assert.equal(parseImage(manager?.image?.fallback ?? '').digest, `sha256:${D1}`);
  assert.deepEqual(managerDefinition(launcher, 'sidecar'), { image: { raw: `org/sidecar@sha256:${D2}` } }, 'no tag age set: the manager\'s own default applies');
  assert.equal(managerDefinition(launcher, 'absent'), undefined);
  assert.equal(managerDefinition(launcher, '__proto__'), undefined);
});

test('launcherSettings: the manager\'s image and tag age from a measured app compose, each with whether the operator may set it; or the reason', () => {
  const composeFile = `services:\n  compose-manager:\n    image: \${MANAGER_IMAGE:-org/manager@sha256:${D1}}\n    environment:\n      - MIN_TAG_AGE_HOURS=\${CM_MIN_TAG_AGE_HOURS:-0}\n`;
  const read = launcherSettings(JSON.stringify({ docker_compose_file: composeFile, allowed_envs: ['CM_MIN_TAG_AGE_HOURS', 7] }));
  assert.deepEqual(read, {
    status: 'ok',
    value: {
      image: { raw: `\${MANAGER_IMAGE:-org/manager@sha256:${D1}}`, variable: 'MANAGER_IMAGE', fallback: `org/manager@sha256:${D1}`, settable: false },
      minTagAge: { raw: '${CM_MIN_TAG_AGE_HOURS:-0}', variable: 'CM_MIN_TAG_AGE_HOURS', fallback: '0', settable: true },
    },
  });
  // A launcher this does not recognise reads as "not read", with the reason, never as "nothing to say".
  assert.deepEqual(launcherSettings('{}'), { status: 'skipped', why: 'the app compose is not JSON with a docker_compose_file' });
  assert.deepEqual(launcherSettings('services: {}'), { status: 'skipped', why: 'the app compose is not JSON with a docker_compose_file' });
  assert.deepEqual(launcherSettings(JSON.stringify({ docker_compose_file: 'services:\n  manager-v2:\n    image: x\n' })), { status: 'skipped', why: 'its compose file has no compose-manager service' });
  assert.match(JSON.stringify(launcherSettings(JSON.stringify({ docker_compose_file: 'just: text' }))), /its compose file was not read: not a compose file/);
});
