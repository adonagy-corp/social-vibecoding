const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = (path) => fs.readFileSync(path, 'utf8');

test('status uses a runtime-specific inventory provider', () => {
  const status = read('src/services/status.js');
  const provider = read('src/services/runtime-status.js');
  assert.match(status, /runtimeStatus\.snapshot\(config\)/);
  assert.match(provider, /runtimeKind === 'kubernetes'/);
  assert.match(provider, /kubernetes\.listStatusResources\(config\)/);
  assert.match(provider, /kubernetes\.listNamespaceCapacity\(config\)/);
  assert.match(provider, /listDockerContainers\(config\)/);
  assert.match(provider, /getDockerStats\(config\)/);
  assert.match(status, /runtimeKind === 'docker'/);
});

test('Kubernetes capacity renders quota reservations, not invented live usage', () => {
  const source = read('public/js/admin-status.js');
  assert.match(source, /data\.runtimeKind === 'kubernetes'/);
  assert.match(source, /CPU requests/);
  assert.match(source, /Memory requests/);
  assert.match(source, /% headroom/);
  assert.doesNotMatch(source, /Kubernetes live (CPU|memory)/i);
  assert.match(source, /data\.runtimeKind === 'kubernetes' \? 'Capacity' : 'Capacity & host'/);
  assert.match(source, /s\.workersReady/);
  assert.match(source, /s\.stagingTotal/);
  assert.match(source, /statePill\(s\.worker\.state/);
});

test('Kubernetes stale-preview administration is exposed as an explicit gap', () => {
  const route = read('src/routes/admin.js');
  const consoleSource = read('public/js/admin-console.js');
  assert.match(route, /available: !staging && runtimeKind === 'docker'/);
  assert.match(route, /unavailableReason: staging \? 'staging' : \(runtimeKind === 'kubernetes' \? 'kubernetes' : null\)/);
  assert.match(consoleSource, /Not yet supported in Kubernetes/);
  assert.match(consoleSource, /normal per-session idle cleanup still applies/);
});

test('database export remains runtime-neutral through networked pg_dump', () => {
  const source = read('src/services/db-export.js');
  assert.match(source, /spawnFn \|\| spawn\)\('pg_dump'/);
  assert.match(source, /DB_ADMIN_URL \|\| process\.env\.DATABASE_URL/);
  assert.doesNotMatch(source, /docker exec/);
});
