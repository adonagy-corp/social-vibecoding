const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const applicationRuntime = require('./application-runtime');
const kubernetes = require('./kubernetes');
const log = require('./logger');

const execFileAsync = promisify(execFile);

async function listDockerContainers(config) {
  if (applicationRuntime.mode(config) !== 'docker') return [];
  try {
    const { stdout } = await execFileAsync('docker', [
      'ps', '-a',
      '--format', '{{.Names}}\t{{.ID}}\t{{.State}}\t{{.Status}}\t{{.Image}}',
    ], { timeout: 5000 });
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, id, state, status, image] = line.split('\t');
        return { name, id, state, status, image, runtimeKind: 'docker' };
      });
  } catch (err) {
    log.warn('status', 'docker ps failed', { err: err.message });
    return [];
  }
}

async function getDockerStats(config) {
  if (applicationRuntime.mode(config) !== 'docker') return {};
  try {
    const { stdout } = await execFileAsync('docker', [
      'stats', '--no-stream',
      '--format', '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}',
    ], { timeout: 10000 });
    const map = {};
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const [name, mem, cpu] = line.split('\t');
      map[name] = { mem, cpu };
    }
    return map;
  } catch {
    return {};
  }
}

async function inspectDockerStarted(name, config) {
  if (applicationRuntime.mode(config) !== 'docker') return null;
  try {
    const { stdout } = await execFileAsync('docker', [
      'inspect', '--format', '{{.State.StartedAt}}', name,
    ], { timeout: 3000 });
    const value = stdout.trim();
    return value && !value.startsWith('0001-') ? value : null;
  } catch {
    return null;
  }
}

function dockerHostCapacity() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    memTotalBytes: totalMem,
    memFreeBytes: freeMem,
    memUsedPct: totalMem ? Math.round(((totalMem - freeMem) / totalMem) * 100) : null,
    loadAvg1: Math.round((os.loadavg()[0] || 0) * 100) / 100,
    cpus: os.cpus().length,
  };
}

async function snapshot(config) {
  const runtimeKind = applicationRuntime.mode(config);
  if (runtimeKind === 'kubernetes') {
    const [resources, namespaceCapacity] = await Promise.all([
      kubernetes.listStatusResources(config),
      kubernetes.listNamespaceCapacity(config),
    ]);
    return {
      runtimeKind,
      resources,
      stats: {},
      host: null,
      namespaceCapacity,
    };
  }

  const [resources, stats] = await Promise.all([
    listDockerContainers(config),
    getDockerStats(config),
  ]);
  await Promise.all(resources.map(async (resource) => {
    resource.startedAt = await inspectDockerStarted(resource.name, config);
  }));
  return {
    runtimeKind,
    resources,
    stats,
    host: dockerHostCapacity(),
    namespaceCapacity: [],
  };
}

module.exports = {
  snapshot,
  listDockerContainers,
  getDockerStats,
  _inspectDockerStartedForTest: inspectDockerStarted,
};
