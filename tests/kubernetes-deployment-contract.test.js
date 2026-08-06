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

test('Kubernetes workloads receive the canonical repository and release revision', () => {
  const migrationJob = read('deploy/helm/social-vibecoding-platform/templates/migration-job.yaml');
  const platform = read('deploy/helm/social-vibecoding-platform/templates/platform.yaml');
  assert.match(migrationJob, /name: USERNODE_DOMAIN, value: \{\{ \.Values\.config\.domain \| quote \}\}/);
  assert.match(migrationJob, /name: CLI_CANONICAL_ORIGIN, value: \{\{ printf "https:\/\/%s" \.Values\.config\.domain \| quote \}\}/);
  assert.match(migrationJob, /name: USERNODE_PLATFORM_REPO, value: \{\{ \.Values\.config\.platformRepository \| quote \}\}/);
  assert.match(migrationJob, /name: GIT_SHA, value: \{\{ \.Values\.release\.sourceRevision \| quote \}\}/);
  assert.match(platform, /name: USERNODE_PLATFORM_REPO, value: \{\{ \.Values\.config\.platformRepository \| quote \}\}/);
  assert.match(platform, /name: GIT_SHA, value: \{\{ \.Values\.release\.sourceRevision \| quote \}\}/);
  assert.match(platform, /name: NODE_RPC_URL, value: \{\{ \.Values\.config\.nodeRpcUrl \| quote \}\}/);
  assert.match(platform, /name: EXPLORER_UPSTREAM, value: \{\{ \.Values\.config\.explorerUpstream \| quote \}\}/);
  assert.match(platform, /name: EXPLORER_UPSTREAM_BASE, value: \{\{ \.Values\.config\.explorerUpstreamBase \| quote \}\}/);
  assert.match(platform, /name: EXPLORER_USE_HTTP, value: \{\{ \.Values\.config\.explorerUseHttp \| quote \}\}/);
});

test('platform node RPC egress is restricted to the configured namespace and Pod labels', () => {
  const policy = read('deploy/helm/social-vibecoding-platform/templates/networkpolicy.yaml');
  const platformPolicy = policy.split('kind: NetworkPolicy')[2].split('---')[0];
  assert.match(platformPolicy, /networkPolicy\.nodeRpc\.enabled/);
  assert.match(platformPolicy, /kubernetes\.io\/metadata\.name/);
  assert.match(platformPolicy, /networkPolicy\.nodeRpc\.podSelector/);
  assert.match(platformPolicy, /networkPolicy\.nodeRpc\.port/);
  assert.match(platformPolicy, /networkPolicy\.explorer\.enabled/);
  assert.match(platformPolicy, /networkPolicy\.explorer\.podSelector/);
  assert.match(platformPolicy, /networkPolicy\.explorer\.port/);
});

test('all explorer consumers honor the explicit internal HTTP transport', () => {
  for (const sourcePath of [
    'server.js',
    'src/services/node-status.js',
    'src/services/chain-poller.js',
    'src/services/genesis-accounts.js',
  ]) {
    assert.match(read(sourcePath), /process\.env\.EXPLORER_USE_HTTP === 'true'/, sourcePath);
  }
});

test('/api/version uses the canonical configured platform repository', () => {
  const server = read('server.js');
  assert.match(server, /repoUrl: config\.platformRepoUrl/);
  assert.doesNotMatch(server, /repoUrl: process\.env\.USERNODE_REPO_URL/);
});

test('PostgreSQL claim template uses only release-stable labels', () => {
  const postgresql = read('deploy/helm/social-vibecoding-platform/templates/postgresql.yaml');
  const claimTemplate = postgresql.split('volumeClaimTemplates:')[1];
  assert.ok(claimTemplate, 'volumeClaimTemplates exists');
  assert.match(claimTemplate, /social-vibecoding-platform\.selectorLabels/);
  assert.doesNotMatch(claimTemplate, /social-vibecoding-platform\.labels/);
});

test('generated app database URLs use cross-namespace PostgreSQL DNS', () => {
  const secret = read('deploy/helm/social-vibecoding-platform/templates/secret.yaml');
  assert.match(secret, /-postgresql\.%s\.svc\.%s:5432/);
  assert.match(secret, /\.Release\.Namespace/);
  assert.match(secret, /\.Values\.clusterDomain/);
});

test('PostgreSQL ingress permits only runtime-managed generated app pods', () => {
  const policy = read('deploy/helm/social-vibecoding-platform/templates/networkpolicy.yaml');
  const postgresqlPolicy = policy.split('kind: NetworkPolicy')[4].split('---')[0];
  assert.match(postgresqlPolicy, /databaseCallerNamespaces/);
  assert.match(postgresqlPolicy, /app\.kubernetes\.io\/managed-by: social-vibecoding-runtime/);
  assert.match(postgresqlPolicy, /app\.kubernetes\.io\/part-of: social-vibecoding/);
  assert.match(postgresqlPolicy, /port: 5432/);
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
