const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = (path) => fs.readFileSync(path, 'utf8');

test('Kubernetes platform image contains PostgreSQL tools but no Docker CLI', () => {
  const dockerfile = read('Dockerfile.kubernetes');
  assert.match(dockerfile, /postgresql-client/);
  assert.doesNotMatch(dockerfile, /docker-cli|docker\.sock/);
  assert.match(dockerfile, /USER node/);
});

test('Docker keeps boot migrations while Kubernetes can delegate them to a Job', () => {
  const source = read('server.js');
  assert.match(source, /RUN_MIGRATIONS_ON_STARTUP !== 'false'/);
  assert.match(source, /await migrate\(config\)/);
});

test('Kubernetes workflow publishes all three SHA-addressable images', () => {
  const workflow = read('.github/workflows/build-kubernetes-images.yml');
  for (const component of ['platform', 'worker', 'capture']) {
    assert.match(workflow, new RegExp(`component: ${component}`));
  }
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /sha-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /steps\.build\.outputs\.digest/);
});

test('migration command validates the target database identifier', () => {
  const { databaseName } = require('../scripts/migrate-kubernetes');
  assert.equal(databaseName('postgres://user:pass@db:5432/app_usernode_2d5619'), 'app_usernode_2d5619');
  assert.throws(() => databaseName('postgres://user:pass@db:5432/bad-name'), /Unsafe database name/);
});

test('migration Job receives the canonical production origin', () => {
  const migrationJob = read('deploy/helm/social-vibecoding-platform/templates/migration-job.yaml');
  assert.match(migrationJob, /name: USERNODE_DOMAIN, value: \{\{ \.Values\.config\.domain \| quote \}\}/);
  assert.match(migrationJob, /name: CLI_CANONICAL_ORIGIN, value: \{\{ printf "https:\/\/%s" \.Values\.config\.domain \| quote \}\}/);
});

test('PostgreSQL claim template uses only release-stable labels', () => {
  const postgresql = read('deploy/helm/social-vibecoding-platform/templates/postgresql.yaml');
  const claimTemplate = postgresql.split('volumeClaimTemplates:')[1];
  assert.ok(claimTemplate, 'volumeClaimTemplates exists');
  assert.match(claimTemplate, /social-vibecoding-platform\.selectorLabels/);
  assert.doesNotMatch(claimTemplate, /social-vibecoding-platform\.labels/);
});

test('public platform ingress is restricted to the Cilium ingress identity', () => {
  const policy = read('deploy/helm/social-vibecoding-platform/templates/networkpolicy.yaml');
  const platformPolicy = policy.split('kind: NetworkPolicy')[2].split('---')[0];
  assert.match(platformPolicy, /internalCallerNamespaces/);
  assert.doesNotMatch(platformPolicy, /ingress:\s*\n\s*- ports:/);
  assert.match(policy, /fromEntities: \[ingress\]/);
  assert.match(policy, /\{port: "3000", protocol: TCP\}/);
});

test('Kubernetes status inventory does not invoke Docker helpers', async () => {
  const status = require('../src/services/status');
  assert.deepEqual(await status.listContainers({ appRuntime: 'kubernetes' }), []);
  assert.deepEqual(await status.getStats({ appRuntime: 'kubernetes' }), {});
});
