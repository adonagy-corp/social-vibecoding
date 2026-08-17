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
    workerContractVersion: 'v6',
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
  assert.equal(
    deployment.spec.template.metadata.annotations['social.usernode.io/env-checksum'],
    kubernetes._envChecksumForTest({ DATABASE_URL: 'postgres://redacted', PORT: '3000' })
  );
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
  assert.equal(deployment.metadata.labels['social.usernode.io/worker-contract'], 'v6');
  assert.equal(deployment.spec.template.metadata.labels['social.usernode.io/worker-contract'], 'v6');
  assert.deepEqual(
    {
      runAsNonRoot: deployment.spec.template.spec.securityContext.runAsNonRoot,
      runAsUser: deployment.spec.template.spec.securityContext.runAsUser,
      runAsGroup: deployment.spec.template.spec.securityContext.runAsGroup,
      fsGroup: deployment.spec.template.spec.securityContext.fsGroup,
    },
    { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 }
  );
  assert.equal(
    deployment.spec.template.metadata.annotations['social.usernode.io/env-checksum'],
    kubernetes._envChecksumForTest({ WORKER_JWT: 'redacted' })
  );
  assert.equal(deployment.spec.template.spec.volumes[0].persistentVolumeClaim.claimName, result.pvcName);
});

test('worker contract version is read from the live Kubernetes Deployment', async () => {
  kubernetes._setClientsForTest({
    apps: {
      async readNamespacedDeployment() {
        return { metadata: { labels: { 'social.usernode.io/worker-contract': 'v6' } } };
      },
    },
  });
  assert.equal(await kubernetes.getWorkerContractVersion(config(), 'sv-worker-s42'), 'v6');
});

test('environment checksum is stable by key order and changes with secret values', () => {
  const first = kubernetes._envChecksumForTest({ PORT: 3000, DATABASE_URL: 'postgres://one' });
  const reordered = kubernetes._envChecksumForTest({ DATABASE_URL: 'postgres://one', PORT: '3000' });
  const changed = kubernetes._envChecksumForTest({ DATABASE_URL: 'postgres://two', PORT: '3000' });
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
  assert.match(first, /^[a-f0-9]{64}$/);
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
  assert.equal(created.body.spec.template.spec.securityContext.runAsUser, 1000);
  assert.equal(created.body.spec.template.spec.securityContext.runAsGroup, 1000);
  assert.equal(created.body.spec.template.spec.securityContext.fsGroup, 1000);
  assert.equal(logRequest.limitBytes, 64 * 1024 * 1024);
  assert.equal(result.stdout, 'result');
});

test('capture runtime transports oversized test input through a temporary Secret volume', async () => {
  let createdJob;
  let createdSecret;
  let deletedSecret;
  kubernetes._setClientsForTest({
    batch: {
      async createNamespacedJob(request) { createdJob = request; },
      async readNamespacedJob() { return { status: { succeeded: 1 } }; },
    },
    core: {
      async createNamespacedSecret(request) { createdSecret = request; },
      async deleteNamespacedSecret(request) { deletedSecret = request; },
      async listNamespacedPod() { return { items: [{ metadata: { name: 'capture-pod' } }] }; },
      async readNamespacedPodLog() { return 'result'; },
    },
  });
  const payload = JSON.stringify([{ url: 'https://preview.example.invalid/' }]);
  await kubernetes.runCaptureJob(config(), {
    sessionId: 42, env: { TESTS: '@stdin' }, stdinPayload: payload, timeoutMs: 120000,
  });
  assert.equal(createdSecret.body.stringData['tests.json'], payload);
  const podSpec = createdJob.body.spec.template.spec;
  assert.match(podSpec.containers[0].args[0], /capture\.js < \/var\/run\/usernode-capture\/tests\.json/);
  assert.equal(podSpec.volumes[0].secret.secretName, createdSecret.body.metadata.name);
  assert.equal(deletedSecret.name, createdSecret.body.metadata.name);
});

test('status inventory normalizes application, preview and worker readiness from Deployments and Pods', async () => {
  const deploymentsByNamespace = {
    'social-apps': [
      {
        metadata: {
          name: 'sv-app-7-demo', uid: 'app-deploy', generation: 2,
          labels: {
            'social.usernode.io/environment': 'production',
            'social.usernode.io/app-id': '7',
          },
        },
        spec: { replicas: 1, template: { spec: { containers: [{ image: 'example/app@sha256:one' }] } } },
        status: { observedGeneration: 2, replicas: 1, readyReplicas: 1, availableReplicas: 1 },
      },
      {
        metadata: {
          name: 'sv-preview-7-s42', uid: 'preview-deploy', generation: 3,
          labels: {
            'social.usernode.io/environment': 'staging',
            'social.usernode.io/app-id': '7',
            'social.usernode.io/session-id': '42',
          },
        },
        spec: { replicas: 1, template: { spec: { containers: [{ image: 'example/app@sha256:two' }] } } },
        status: { observedGeneration: 3, replicas: 1, unavailableReplicas: 1 },
      },
    ],
    'social-workers': [
      {
        metadata: {
          name: 'sv-worker-s42', uid: 'worker-deploy', generation: 1,
          labels: {
            'social.usernode.io/environment': 'worker',
            'social.usernode.io/session-id': '42',
          },
        },
        spec: { replicas: 1, template: { spec: { containers: [{ image: 'example/worker@sha256:three' }] } } },
        status: { observedGeneration: 1, replicas: 1, readyReplicas: 1, availableReplicas: 1 },
      },
    ],
  };
  const podsByNamespace = {
    'social-apps': [{
      metadata: {
        name: 'sv-app-7-demo-pod', uid: 'app-pod', creationTimestamp: '2026-08-05T08:00:00Z',
        labels: { 'social.usernode.io/runtime-name': 'sv-app-7-demo' },
      },
      status: {
        conditions: [{ type: 'Ready', status: 'True' }],
        containerStatuses: [{ restartCount: 2 }],
      },
    }],
    'social-workers': [{
      metadata: {
        name: 'sv-worker-s42-pod', uid: 'worker-pod', creationTimestamp: '2026-08-05T08:05:00Z',
        labels: { 'social.usernode.io/runtime-name': 'sv-worker-s42' },
      },
      status: { conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ restartCount: 0 }] },
    }],
  };
  kubernetes._setClientsForTest({
    apps: {
      async listNamespacedDeployment({ namespace }) { return { items: deploymentsByNamespace[namespace] || [] }; },
    },
    core: {
      async listNamespacedPod({ namespace }) { return { items: podsByNamespace[namespace] || [] }; },
    },
  });

  const inventory = await kubernetes.listStatusResources(config());
  const app = inventory.find((item) => item.name === 'sv-app-7-demo');
  const preview = inventory.find((item) => item.name === 'sv-preview-7-s42');
  const worker = inventory.find((item) => item.name === 'sv-worker-s42');
  assert.equal(app.resourceType, 'app');
  assert.equal(app.state, 'running');
  assert.equal(app.startedAt, '2026-08-05T08:00:00Z');
  assert.match(app.status, /2 restarts/);
  assert.equal(preview.resourceType, 'staging');
  assert.equal(preview.state, 'restarting');
  assert.equal(preview.sessionId, 42);
  assert.equal(worker.resourceType, 'worker');
  assert.equal(worker.state, 'running');
});

test('namespace capacity reports requests and pod quota without claiming live usage', async () => {
  kubernetes._setClientsForTest({
    core: {
      async listNamespacedResourceQuota({ namespace }) {
        return {
          items: [{
            metadata: { name: 'social-vibecoding' },
            status: {
              hard: { pods: '100', 'requests.cpu': '16', 'requests.memory': '32Gi' },
              used: { pods: namespace === 'social-apps' ? '4' : '0', 'requests.cpu': '750m', 'requests.memory': '1536Mi' },
            },
          }],
        };
      },
    },
  });

  const capacity = await kubernetes.listNamespaceCapacity(config());
  const apps = capacity.find((item) => item.namespace === 'social-apps');
  assert.deepEqual(apps.resources.pods, { used: '4', hard: '100', percent: 4, headroomPercent: 96 });
  assert.deepEqual(apps.resources.requestsCpu, { used: '750m', hard: '16', percent: 4.7, headroomPercent: 95.3 });
  assert.deepEqual(apps.resources.requestsMemory, { used: '1536Mi', hard: '32Gi', percent: 4.7, headroomPercent: 95.3 });
  assert.equal(kubernetes._quantityNumberForTest('1Gi'), 2 ** 30);
  assert.equal(kubernetes._quantityNumberForTest('250m'), 0.25);
});
