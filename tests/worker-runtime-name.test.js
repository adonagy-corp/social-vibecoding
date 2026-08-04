const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const worker = require('../src/services/worker');

const originalWorkerRuntime = process.env.WORKER_RUNTIME;
const originalAppRuntime = process.env.APP_RUNTIME;

test.afterEach(() => {
  if (originalWorkerRuntime === undefined) delete process.env.WORKER_RUNTIME;
  else process.env.WORKER_RUNTIME = originalWorkerRuntime;
  if (originalAppRuntime === undefined) delete process.env.APP_RUNTIME;
  else process.env.APP_RUNTIME = originalAppRuntime;
});

test('worker runtime name preserves the Docker single-server name', () => {
  process.env.WORKER_RUNTIME = 'docker';
  assert.equal(worker.workerRuntimeName(17), 'usernode-worker-17');
});

test('worker runtime name matches the Kubernetes worker Deployment', () => {
  process.env.WORKER_RUNTIME = 'kubernetes';
  assert.equal(worker.workerRuntimeName(17), 'sv-worker-s17');
});

test('push proxy resolves the active runtime name instead of the Docker-only name', () => {
  const source = fs.readFileSync(require.resolve('../src/services/worker'), 'utf8');
  const start = source.indexOf('async function execPushFromWorker');
  const body = source.slice(start, source.indexOf('\n}', start) + 2);
  assert.match(body, /_registryGet\(sessionId\)\?\.containerName \|\| workerRuntimeName\(sessionId\)/);
  assert.doesNotMatch(body, /const containerName = workerContainerName\(sessionId\)/);
});
