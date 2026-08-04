const crypto = require('crypto');
const stream = require('stream');
const k8s = require('@kubernetes/client-node');

const MANAGED_BY = 'social-vibecoding-runtime';
const PART_OF = 'social-vibecoding';

let clients;

function setClientsForTest(value) { clients = value; }

function getClients() {
  if (clients) return clients;
  const kc = new k8s.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
  else kc.loadFromDefault();
  clients = {
    kc,
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    batch: kc.makeApiClient(k8s.BatchV1Api),
    networking: kc.makeApiClient(k8s.NetworkingV1Api),
    custom: kc.makeApiClient(k8s.CustomObjectsApi),
  };
  return clients;
}

function isNotFound(err) {
  return err?.code === 404 || err?.response?.statusCode === 404 || err?.response?.status === 404;
}

function dnsName(value, max = 63) {
  const clean = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app';
  if (clean.length <= max) return clean;
  return clean.slice(0, max).replace(/-+$/g, '');
}

function withSuffix(value, suffix, max = 63) {
  const cleanSuffix = `-${dnsName(suffix, max)}`;
  const base = dnsName(value, max - cleanSuffix.length);
  return `${base}${cleanSuffix}`;
}

function envChecksum(env) {
  const entries = Object.entries(env || {})
    .map(([key, value]) => [key, String(value)])
    .sort(([left], [right]) => left.localeCompare(right));
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function labels({ appId, sessionId, environment }) {
  const result = {
    'app.kubernetes.io/part-of': PART_OF,
    'app.kubernetes.io/managed-by': MANAGED_BY,
    'social.usernode.io/environment': environment,
  };
  if (appId !== undefined && appId !== null) result['social.usernode.io/app-id'] = String(appId);
  if (sessionId !== undefined && sessionId !== null) result['social.usernode.io/session-id'] = String(sessionId);
  return result;
}

async function upsert(api, readMethod, createMethod, replaceMethod, namespace, body) {
  const name = body.metadata.name;
  try {
    const current = await api[readMethod]({ name, namespace });
    body.metadata.resourceVersion = current.metadata.resourceVersion;
    if (body.kind === 'Service') {
      for (const field of ['clusterIP', 'clusterIPs', 'ipFamilies', 'ipFamilyPolicy', 'healthCheckNodePort']) {
        if (current.spec?.[field] !== undefined) body.spec[field] = current.spec[field];
      }
    }
    return api[replaceMethod]({ name, namespace, body });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    return api[createMethod]({ namespace, body });
  }
}

async function deleteIfPresent(api, method, name, namespace, options = {}) {
  try {
    await api[method]({ name, namespace, ...options });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

function requireBuildConfig(config) {
  const cfg = config.kubernetes;
  const missing = [];
  for (const key of ['repositoryPrefix', 'cacheRepositoryPrefix', 'builderImage']) {
    if (!cfg[key]) missing.push(key);
  }
  if (missing.length) {
    throw new Error(`Kubernetes build configuration missing: ${missing.join(', ')}`);
  }
  return cfg;
}

async function createBuild(config, { app, revision, environment, sessionId }) {
  if (!/^[a-f0-9]{40}$/i.test(revision || '')) {
    throw new Error('Kubernetes builds require a full 40-character Git commit SHA');
  }
  if (!/^https:\/\/github\.com\//.test(app.repo_url || '')) {
    throw new Error('Kubernetes builds require an HTTPS GitHub repository URL');
  }
  const cfg = requireBuildConfig(config);
  const suffix = sessionId ? `s${sessionId}-` : '';
  const buildName = dnsName(`sv-${app.id}-${suffix}${revision.slice(0, 12)}`);
  const repository = `${cfg.repositoryPrefix}/${dnsName(app.slug)}`;
  const cacheTag = `${cfg.cacheRepositoryPrefix}/${dnsName(app.slug)}:cache`;
  const tag = `${repository}:git-${revision}`;
  const body = {
    apiVersion: 'kpack.io/v1alpha2',
    kind: 'Build',
    metadata: { name: buildName, namespace: cfg.buildNamespace, labels: labels({ appId: app.id, sessionId, environment }) },
    spec: {
      tags: [tag],
      serviceAccountName: cfg.buildServiceAccount,
      builder: { image: cfg.builderImage },
      cache: { registry: { tag: cacheTag } },
      source: { git: { url: app.repo_url.replace(/\.git$/, ''), revision } },
      activeDeadlineSeconds: cfg.activeDeadlineSeconds,
      env: [{ name: 'BP_NODE_VERSION', value: cfg.nodeVersion }],
      resources: {
        requests: { cpu: process.env.BUILD_REQUESTS_CPU || '500m', memory: process.env.BUILD_REQUESTS_MEMORY || '1Gi', 'ephemeral-storage': process.env.BUILD_REQUESTS_EPHEMERAL_STORAGE || '2Gi' },
        limits: { cpu: process.env.BUILD_LIMITS_CPU || '2', memory: process.env.BUILD_LIMITS_MEMORY || '2Gi', 'ephemeral-storage': process.env.BUILD_LIMITS_EPHEMERAL_STORAGE || '8Gi' },
      },
    },
  };
  const { custom } = getClients();
  try {
    await custom.createNamespacedCustomObject({ group: 'kpack.io', version: 'v1alpha2', namespace: cfg.buildNamespace, plural: 'builds', body });
  } catch (err) {
    if (err?.code !== 409 && err?.response?.statusCode !== 409) throw err;
  }
  const result = await waitForBuild(config, buildName);
  return { buildRef: `${cfg.buildNamespace}/${buildName}`, imageRef: result.status.latestImage, requestedTag: tag };
}

async function waitForBuild(config, name) {
  const cfg = config.kubernetes;
  const deadline = Date.now() + (cfg.activeDeadlineSeconds + 60) * 1000;
  const { custom } = getClients();
  while (Date.now() < deadline) {
    const build = await custom.getNamespacedCustomObject({ group: 'kpack.io', version: 'v1alpha2', namespace: cfg.buildNamespace, plural: 'builds', name });
    const succeeded = build.status?.conditions?.find((condition) => condition.type === 'Succeeded');
    if (succeeded?.status === 'True' && build.status?.latestImage) return build;
    if (succeeded?.status === 'False') {
      throw new Error(`kpack Build ${name} failed: ${succeeded.message || succeeded.reason || 'unknown error'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Timed out waiting for kpack Build ${name}`);
}

function appResourceName(app, environment, sessionId) {
  return dnsName(environment === 'production' ? `sv-app-${app.id}-${app.slug}` : `sv-preview-${app.id}-s${sessionId}`);
}

function podSecurityContext() {
  return { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } };
}

function nodePodSecurityContext() {
  return {
    ...podSecurityContext(),
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
  };
}

function containerSecurityContext() {
  return { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, readOnlyRootFilesystem: false };
}

async function deployApplication(config, { app, environment, sessionId, imageRef, env }) {
  if (!imageRef?.includes('@sha256:')) throw new Error('Kubernetes deployments require an immutable image digest');
  const cfg = config.kubernetes;
  const namespace = cfg.appNamespace;
  const name = appResourceName(app, environment, sessionId);
  const resourceLabels = labels({ appId: app.id, sessionId, environment });
  const selectorLabels = { 'social.usernode.io/runtime-name': name };
  const secretName = withSuffix(name, 'env');
  const hostname = environment === 'production'
    ? `${app.slug}.${cfg.appDomain}`
    : `${app.slug}--s${sessionId}.${cfg.appDomain}`;
  const { core, apps, networking } = getClients();

  await upsert(core, 'readNamespacedSecret', 'createNamespacedSecret', 'replaceNamespacedSecret', namespace, {
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: secretName, namespace, labels: resourceLabels },
    type: 'Opaque', stringData: Object.fromEntries(Object.entries(env || {}).map(([key, value]) => [key, String(value)])),
  });
  await upsert(core, 'readNamespacedService', 'createNamespacedService', 'replaceNamespacedService', namespace, {
    apiVersion: 'v1', kind: 'Service', metadata: { name, namespace, labels: resourceLabels },
    spec: { selector: selectorLabels, ports: [{ name: 'http', port: 3000, targetPort: 3000 }], type: 'ClusterIP' },
  });
  await upsert(apps, 'readNamespacedDeployment', 'createNamespacedDeployment', 'replaceNamespacedDeployment', namespace, {
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace, labels: resourceLabels },
    spec: {
      replicas: 1,
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      selector: { matchLabels: selectorLabels },
      template: {
        metadata: {
          labels: { ...resourceLabels, ...selectorLabels },
          annotations: { 'social.usernode.io/env-checksum': envChecksum(env) },
        },
        spec: {
          serviceAccountName: cfg.generatedAppServiceAccount,
          automountServiceAccountToken: false,
          securityContext: podSecurityContext(),
          containers: [{
            name: 'app', image: imageRef, imagePullPolicy: 'IfNotPresent',
            ports: [{ name: 'http', containerPort: 3000 }],
            envFrom: [{ secretRef: { name: secretName } }],
            startupProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 3, failureThreshold: 40 },
            readinessProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 5, failureThreshold: 3 },
            livenessProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 15, failureThreshold: 3 },
            resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '1Gi' } },
            securityContext: containerSecurityContext(),
          }],
        },
      },
    },
  });
  await upsert(networking, 'readNamespacedIngress', 'createNamespacedIngress', 'replaceNamespacedIngress', namespace, {
    apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: {
      name, namespace, labels: resourceLabels,
      annotations: { 'cert-manager.io/cluster-issuer': cfg.clusterIssuer },
    },
    spec: {
      ingressClassName: cfg.ingressClassName,
      rules: [{ host: hostname, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name, port: { number: 3000 } } } }] } }],
      tls: [{ hosts: [hostname], secretName: withSuffix(name, 'tls') }],
    },
  });
  await waitForDeployment(namespace, name);
  return { runtimeKind: 'kubernetes', runtimeName: name, imageRef, hostname, url: `https://${hostname}` };
}

async function waitForDeployment(namespace, name, timeoutMs = 5 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  const { apps } = getClients();
  while (Date.now() < deadline) {
    const deployment = await apps.readNamespacedDeployment({ name, namespace });
    if (deployment.status?.availableReplicas >= 1 && deployment.status?.observedGeneration >= deployment.metadata.generation) return deployment;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for Deployment ${namespace}/${name}`);
}

async function getApplicationStatus(config, runtimeName) {
  try {
    const deployment = await getClients().apps.readNamespacedDeployment({ name: runtimeName, namespace: config.kubernetes.appNamespace });
    if (deployment.status?.availableReplicas >= 1) return 'running';
    if (deployment.status?.unavailableReplicas) return 'restarting';
    return 'created';
  } catch (err) {
    if (isNotFound(err)) return 'not_found';
    throw err;
  }
}

async function getApplicationLogs(config, runtimeName, tailLines = 200) {
  const namespace = config.kubernetes.appNamespace;
  const pods = await getClients().core.listNamespacedPod({ namespace, labelSelector: `social.usernode.io/runtime-name=${runtimeName}` });
  const pod = pods.items?.[0];
  if (!pod) return '';
  return getClients().core.readNamespacedPodLog({ name: pod.metadata.name, namespace, container: 'app', tailLines });
}

async function restartApplication(config, runtimeName) {
  const namespace = config.kubernetes.appNamespace;
  const deployment = await getClients().apps.readNamespacedDeployment({ name: runtimeName, namespace });
  deployment.spec.template.metadata ||= {};
  deployment.spec.template.metadata.annotations ||= {};
  deployment.spec.template.metadata.annotations['social.usernode.io/restarted-at'] = new Date().toISOString();
  await getClients().apps.replaceNamespacedDeployment({ name: runtimeName, namespace, body: deployment });
  return waitForDeployment(namespace, runtimeName);
}

async function deleteApplication(config, runtimeName) {
  const namespace = config.kubernetes.appNamespace;
  const { apps, core, networking } = getClients();
  await Promise.all([
    deleteIfPresent(networking, 'deleteNamespacedIngress', runtimeName, namespace),
    deleteIfPresent(core, 'deleteNamespacedService', runtimeName, namespace),
    deleteIfPresent(core, 'deleteNamespacedSecret', withSuffix(runtimeName, 'env'), namespace),
    deleteIfPresent(core, 'deleteNamespacedSecret', withSuffix(runtimeName, 'tls'), namespace),
    deleteIfPresent(apps, 'deleteNamespacedDeployment', runtimeName, namespace, { propagationPolicy: 'Foreground' }),
  ]);
}

async function deleteBuilds(config, appId) {
  await getClients().custom.deleteCollectionNamespacedCustomObject({
    group: 'kpack.io', version: 'v1alpha2', namespace: config.kubernetes.buildNamespace,
    plural: 'builds', labelSelector: `social.usernode.io/app-id=${appId}`,
    propagationPolicy: 'Background',
  });
}

async function ensureWorker(config, { sessionId, env }) {
  const cfg = config.kubernetes;
  if (!cfg.workerImage?.includes('@sha256:')) throw new Error('KUBERNETES_WORKER_IMAGE must be an immutable digest');
  const namespace = cfg.workerNamespace;
  const name = dnsName(`sv-worker-s${sessionId}`);
  const pvcName = withSuffix(name, 'state');
  const secretName = withSuffix(name, 'env');
  const resourceLabels = labels({ sessionId, environment: 'worker' });
  const selectorLabels = { 'social.usernode.io/runtime-name': name };
  const { core, apps } = getClients();
  try {
    const pvc = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace, labels: resourceLabels }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: cfg.workerStorageSize } } } };
    if (cfg.workerStorageClass) pvc.spec.storageClassName = cfg.workerStorageClass;
    await core.createNamespacedPersistentVolumeClaim({ namespace, body: pvc });
  } catch (err) { if (err?.code !== 409 && err?.response?.statusCode !== 409) throw err; }
  await upsert(core, 'readNamespacedSecret', 'createNamespacedSecret', 'replaceNamespacedSecret', namespace, {
    apiVersion: 'v1', kind: 'Secret', metadata: { name: secretName, namespace, labels: resourceLabels }, type: 'Opaque',
    stringData: Object.fromEntries(Object.entries(env || {}).map(([key, value]) => [key, String(value)])),
  });
  await upsert(apps, 'readNamespacedDeployment', 'createNamespacedDeployment', 'replaceNamespacedDeployment', namespace, {
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace, labels: resourceLabels },
    spec: {
      replicas: 1,
      selector: { matchLabels: selectorLabels },
      strategy: { type: 'Recreate' },
      template: {
        metadata: {
          labels: { ...resourceLabels, ...selectorLabels },
          annotations: { 'social.usernode.io/env-checksum': envChecksum(env) },
        },
        spec: {
          serviceAccountName: cfg.workerServiceAccount,
          automountServiceAccountToken: false,
          securityContext: nodePodSecurityContext(),
          containers: [{
            name: 'worker', image: cfg.workerImage, imagePullPolicy: 'IfNotPresent',
            envFrom: [{ secretRef: { name: secretName } }],
            volumeMounts: [{ name: 'state', mountPath: '/home/node/.claude' }],
            resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: config.workerCpus || '2', memory: (config.workerMemory || '2Gi').replace(/g$/i, 'Gi') } },
            securityContext: containerSecurityContext(),
          }],
          volumes: [{ name: 'state', persistentVolumeClaim: { claimName: pvcName } }],
        },
      },
    },
  });
  await waitForDeployment(namespace, name);
  const warmDeadline = Date.now() + 5 * 60 * 1000;
  let warmReady = false;
  while (Date.now() < warmDeadline) {
    const pods = await core.listNamespacedPod({ namespace, labelSelector: `social.usernode.io/runtime-name=${name}` });
    const pod = pods.items?.[0];
    if (pod) {
      const output = await core.readNamespacedPodLog({ name: pod.metadata.name, namespace, container: 'worker' }).catch(() => '');
      if (output.includes('__USERNODE_PHASE__ warm-ready')) {
        warmReady = true;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!warmReady) throw new Error(`Timed out waiting for worker ${name} warm-ready marker`);
  return { runtimeKind: 'kubernetes', runtimeName: name, pvcName };
}

async function getWorkerStatus(config, runtimeName) {
  try {
    const deployment = await getClients().apps.readNamespacedDeployment({ name: runtimeName, namespace: config.kubernetes.workerNamespace });
    return deployment.status?.availableReplicas >= 1 ? 'running' : 'created';
  } catch (err) {
    if (isNotFound(err)) return 'not_found';
    throw err;
  }
}

async function deleteWorker(config, sessionId, { deleteVolume = false } = {}) {
  const namespace = config.kubernetes.workerNamespace;
  const name = dnsName(`sv-worker-s${sessionId}`);
  const { apps, core } = getClients();
  await Promise.all([
    deleteIfPresent(apps, 'deleteNamespacedDeployment', name, namespace, { propagationPolicy: 'Foreground' }),
    deleteIfPresent(core, 'deleteNamespacedSecret', withSuffix(name, 'env'), namespace),
  ]);
  if (deleteVolume) await deleteIfPresent(core, 'deleteNamespacedPersistentVolumeClaim', withSuffix(name, 'state'), namespace);
}

async function listWorkers(config) {
  const namespace = config.kubernetes.workerNamespace;
  const deployments = await getClients().apps.listNamespacedDeployment({
    namespace,
    labelSelector: 'app.kubernetes.io/managed-by=social-vibecoding-runtime,social.usernode.io/environment=worker',
  });
  return (deployments.items || []).map((deployment) => ({
    name: deployment.metadata.name,
    sessionId: Number(deployment.metadata.labels?.['social.usernode.io/session-id']),
    state: deployment.status?.availableReplicas >= 1 ? 'running' : 'created',
  })).filter((item) => Number.isFinite(item.sessionId));
}

async function cloneWorkerVolume(config, sourceSessionId, targetSessionId) {
  const cfg = config.kubernetes;
  const namespace = cfg.workerNamespace;
  const sourceRuntime = dnsName(`sv-worker-s${sourceSessionId}`);
  const sourcePvc = withSuffix(sourceRuntime, 'state');
  const targetPvc = withSuffix(dnsName(`sv-worker-s${targetSessionId}`), 'state');
  const { core, batch } = getClients();
  const source = await core.readNamespacedPersistentVolumeClaim({ name: sourcePvc, namespace });
  try {
    const body = {
      apiVersion: 'v1', kind: 'PersistentVolumeClaim',
      metadata: { name: targetPvc, namespace, labels: labels({ sessionId: targetSessionId, environment: 'worker' }) },
      spec: {
        accessModes: source.spec.accessModes || ['ReadWriteOnce'],
        resources: { requests: { storage: source.spec.resources?.requests?.storage || cfg.workerStorageSize } },
      },
    };
    if (source.spec.storageClassName) body.spec.storageClassName = source.spec.storageClassName;
    await core.createNamespacedPersistentVolumeClaim({ namespace, body });
  } catch (err) { if (err?.code !== 409 && err?.response?.statusCode !== 409) throw err; }

  const sourcePods = await core.listNamespacedPod({ namespace, labelSelector: `social.usernode.io/runtime-name=${sourceRuntime}` });
  const sourceNode = sourcePods.items?.[0]?.spec?.nodeName;
  const name = dnsName(`sv-worker-copy-${sourceSessionId}-${targetSessionId}-${Date.now().toString(36)}`);
  const podSpec = {
    restartPolicy: 'Never', serviceAccountName: cfg.workerServiceAccount, automountServiceAccountToken: false,
    securityContext: nodePodSecurityContext(),
    containers: [{ name: 'copy', image: cfg.workerImage, command: ['sh', '-c', 'cp -a /from/. /to/'], volumeMounts: [{ name: 'from', mountPath: '/from', readOnly: true }, { name: 'to', mountPath: '/to' }], securityContext: containerSecurityContext(), resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '1Gi' } } }],
    volumes: [{ name: 'from', persistentVolumeClaim: { claimName: sourcePvc, readOnly: true } }, { name: 'to', persistentVolumeClaim: { claimName: targetPvc } }],
  };
  if (sourceNode) podSpec.nodeName = sourceNode;
  await batch.createNamespacedJob({ namespace, body: { apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace, labels: labels({ sessionId: targetSessionId, environment: 'worker' }) }, spec: { backoffLimit: 0, activeDeadlineSeconds: 300, ttlSecondsAfterFinished: 3600, template: { metadata: { labels: labels({ sessionId: targetSessionId, environment: 'worker' }) }, spec: podSpec } } } });
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const job = await batch.readNamespacedJob({ name, namespace });
    if (job.status?.succeeded) return;
    if (job.status?.failed) throw new Error(`Worker PVC copy Job ${name} failed`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for worker PVC copy Job ${name}`);
}

async function runCaptureJob(config, { sessionId, env, timeoutMs = 180000 }) {
  const cfg = config.kubernetes;
  if (!cfg.captureImage?.includes('@sha256:')) throw new Error('KUBERNETES_CAPTURE_IMAGE must be an immutable digest');
  const namespace = cfg.workerNamespace;
  const name = dnsName(`sv-capture-s${sessionId}-${Date.now().toString(36)}`);
  const body = { apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace, labels: labels({ sessionId, environment: 'capture' }) }, spec: {
    backoffLimit: 0, activeDeadlineSeconds: Math.ceil(timeoutMs / 1000), ttlSecondsAfterFinished: 3600,
    template: { metadata: { labels: labels({ sessionId, environment: 'capture' }) }, spec: { restartPolicy: 'Never', serviceAccountName: cfg.workerServiceAccount, automountServiceAccountToken: false, securityContext: nodePodSecurityContext(), containers: [{ name: 'capture', image: cfg.captureImage, imagePullPolicy: 'IfNotPresent', env: Object.entries(env || {}).map(([key, value]) => ({ name: key, value: String(value) })), resources: { requests: { cpu: '250m', memory: '512Mi', 'ephemeral-storage': '1Gi' }, limits: { cpu: '2', memory: '2Gi', 'ephemeral-storage': '4Gi' } }, securityContext: containerSecurityContext() }] } },
  } };
  const { batch, core } = getClients();
  await batch.createNamespacedJob({ namespace, body });
  const deadline = Date.now() + timeoutMs + 15000;
  while (Date.now() < deadline) {
    const job = await batch.readNamespacedJob({ name, namespace });
    if (job.status?.failed) throw new Error(`Capture Job ${name} failed`);
    if (job.status?.succeeded) {
      const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${name}` });
      const pod = pods.items?.[0];
      return { stdout: pod ? await core.readNamespacedPodLog({ name: pod.metadata.name, namespace, container: 'capture', limitBytes: 64 * 1024 * 1024 }) : '', runtimeName: name };
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for capture Job ${name}`);
}

async function execInWorker(config, runtimeName, command, stdinText = null) {
  const namespace = config.kubernetes.workerNamespace;
  const pods = await getClients().core.listNamespacedPod({ namespace, labelSelector: `social.usernode.io/runtime-name=${runtimeName}` });
  const pod = pods.items?.[0];
  if (!pod) throw new Error(`Worker Pod for ${runtimeName} not found`);
  const stdout = new stream.PassThrough();
  const stderr = new stream.PassThrough();
  let out = ''; let err = '';
  stdout.on('data', (chunk) => { out += chunk.toString(); });
  stderr.on('data', (chunk) => { err += chunk.toString(); });
  const input = stdinText === null ? null : stream.Readable.from([stdinText]);
  let status;
  const exec = new k8s.Exec(getClients().kc);
  const socket = await exec.exec(namespace, pod.metadata.name, 'worker', command, stdout, stderr, input, false, (value) => { status = value; });
  await new Promise((resolve, reject) => { socket.onclose = resolve; socket.onerror = reject; });
  if (status?.status === 'Failure') throw new Error(err || status.message || 'Worker exec failed');
  return { stdout: out, stderr: err };
}

module.exports = {
  dnsName, withSuffix, labels, createBuild, deployApplication, getApplicationStatus,
  getApplicationLogs, restartApplication, deleteApplication, deleteBuilds, ensureWorker,
  runCaptureJob, execInWorker, _getClients: getClients,
  getWorkerStatus, deleteWorker, listWorkers, cloneWorkerVolume,
  _setClientsForTest: setClientsForTest, _envChecksumForTest: envChecksum,
};
