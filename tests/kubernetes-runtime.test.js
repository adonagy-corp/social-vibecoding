const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');

function notFound() {
  const error = new Error('not found');
  error.code = 404;
  return error;
}

function config() {
  return {
    kubernetes: {
      buildNamespace: 'social-builds', appNamespace: 'social-apps', workerNamespace: 'social-workers',
      buildServiceAccount: 'social-kpack-builder', generatedAppServiceAccount: 'social-generated-app',
      repositoryPrefix: 'ghcr.io/example/social-apps', cacheRepositoryPrefix: 'ghcr.io/example/social-cache',
      builderImage: 'builder.example/image@sha256:abc', nodeVersion: '22.*', activeDeadlineSeconds: 30,
      appDomain: 'apps.example.test', ingressClassName: 'cilium', clusterIssuer: 'letsencrypt-public',
      workerServiceAccount: 'social-worker', workerImage: 'ghcr.io/example/social-worker@sha256:cafe',
      captureImage: 'ghcr.io/example/social-capture@sha256:babe', workerStorageClass: 'openebs-lvm-retain',
      workerStorageSize: '5Gi',
    },
  };
}

test.afterEach(() => kubernetes._setClientsForTest(null));

test('kpack Build is isolated in social-builds and returns status.latestImage', async () => {
  let created;
  kubernetes._setClientsForTest({
    custom: {
      async createNamespacedCustomObject(request) { created = request; },
      async getNamespacedCustomObject() {
        return { status: { conditions: [{ type: 'Succeeded', status: 'True' }], latestImage: 'ghcr.io/example/social-apps/demo@sha256:deadbeef' } };
      },
    },
  });
  const revision = 'a'.repeat(40);
  const result = await kubernetes.createBuild(config(), {
    app: { id: 7, slug: 'Demo App', repo_url: 'https://github.com/example/demo' },
    revision, environment: 'production',
  });
  assert.equal(created.namespace, 'social-builds');
  assert.equal(created.body.spec.source.git.revision, revision);
  assert.equal(created.body.spec.serviceAccountName, 'social-kpack-builder');
  assert.equal(result.imageRef, 'ghcr.io/example/social-apps/demo@sha256:deadbeef');
  assert.match(result.buildRef, /^social-builds\//);
});

test('application deploy reconciles Secret, Deployment, Service and Ingress with a digest', async () => {
  const written = [];
  const missingReads = {
    readNamespacedSecret: async () => { throw notFound(); },
    readNamespacedService: async () => { throw notFound(); },
    readNamespacedDeployment: async ({ name }) => {
      if (written.some((item) => item.kind === 'Deployment')) {
        return { metadata: { name, generation: 1 }, status: { observedGeneration: 1, availableReplicas: 1 } };
      }
      throw notFound();
    },
    readNamespacedIngress: async () => { throw notFound(); },
  };
  const record = (kind) => async ({ body }) => { written.push({ kind, body }); return body; };
  kubernetes._setClientsForTest({
    core: { ...missingReads, createNamespacedSecret: record('Secret'), createNamespacedService: record('Service') },
    apps: { ...missingReads, createNamespacedDeployment: record('Deployment') },
    networking: { ...missingReads, createNamespacedIngress: record('Ingress') },
  });
  const result = await kubernetes.deployApplication(config(), {
    app: { id: 7, slug: 'demo' }, environment: 'production',
    imageRef: 'ghcr.io/example/social-apps/demo@sha256:deadbeef',
    env: { DATABASE_URL: 'postgres://redacted', PORT: '3000' },
  });
  assert.deepEqual(written.map((item) => item.kind).sort(), ['Deployment', 'Ingress', 'Secret', 'Service']);
  const deployment = written.find((item) => item.kind === 'Deployment').body;
  assert.equal(deployment.spec.template.spec.containers[0].image, 'ghcr.io/example/social-apps/demo@sha256:deadbeef');
  assert.equal(deployment.spec.template.spec.serviceAccountName, 'social-generated-app');
  const ingress = written.find((item) => item.kind === 'Ingress').body;
  assert.equal(ingress.spec.ingressClassName, 'cilium');
  assert.equal(ingress.metadata.annotations['cert-manager.io/cluster-issuer'], 'letsencrypt-public');
  assert.equal(result.url, 'https://demo.apps.example.test');
});

test('mutable image tags are refused before any Kubernetes write', async () => {
  await assert.rejects(
    kubernetes.deployApplication(config(), {
      app: { id: 7, slug: 'demo' }, environment: 'production', imageRef: 'ghcr.io/example/demo:latest', env: {},
    }),
    /immutable image digest/
  );
});

test('worker runtime reconciles a retained PVC, Secret and warm Deployment', async () => {
  const written = [];
  const record = (kind) => async ({ body }) => { written.push({ kind, body }); return body; };
  kubernetes._setClientsForTest({
    core: {
      createNamespacedPersistentVolumeClaim: record('PersistentVolumeClaim'),
      readNamespacedSecret: async () => { throw notFound(); },
      createNamespacedSecret: record('Secret'),
      listNamespacedPod: async () => ({ items: [{ metadata: { name: 'worker-pod' } }] }),
      readNamespacedPodLog: async () => '__USERNODE_PHASE__ warm-ready',
    },
    apps: {
      readNamespacedDeployment: async ({ name }) => {
        if (written.some((item) => item.kind === 'Deployment')) {
          return { metadata: { name, generation: 1 }, status: { observedGeneration: 1, availableReplicas: 1 } };
        }
        throw notFound();
      },
      createNamespacedDeployment: record('Deployment'),
    },
  });
  const result = await kubernetes.ensureWorker(config(), { sessionId: 42, env: { WORKER_JWT: 'redacted' } });
  assert.deepEqual(written.map((item) => item.kind), ['PersistentVolumeClaim', 'Secret', 'Deployment']);
  const pvc = written.find((item) => item.kind === 'PersistentVolumeClaim').body;
  assert.equal(pvc.spec.storageClassName, 'openebs-lvm-retain');
  const deployment = written.find((item) => item.kind === 'Deployment').body;
  assert.equal(deployment.spec.strategy.type, 'Recreate');
  assert.equal(deployment.spec.template.spec.volumes[0].persistentVolumeClaim.claimName, result.pvcName);
});

test('capture runtime uses a bounded Job and caps log retrieval', async () => {
  let created;
  let logRequest;
  kubernetes._setClientsForTest({
    batch: {
      async createNamespacedJob(request) { created = request; },
      async readNamespacedJob() { return { status: { succeeded: 1 } }; },
    },
    core: {
      async listNamespacedPod() { return { items: [{ metadata: { name: 'capture-pod' } }] }; },
      async readNamespacedPodLog(request) { logRequest = request; return 'result'; },
    },
  });
  const result = await kubernetes.runCaptureJob(config(), { sessionId: 42, env: { CAPTURE_INPUT: '{}' }, timeoutMs: 120000 });
  assert.equal(created.namespace, 'social-workers');
  assert.equal(created.body.spec.backoffLimit, 0);
  assert.equal(created.body.spec.activeDeadlineSeconds, 120);
  assert.equal(created.body.spec.ttlSecondsAfterFinished, 3600);
  assert.equal(created.body.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(logRequest.limitBytes, 64 * 1024 * 1024);
  assert.equal(result.stdout, 'result');
});
