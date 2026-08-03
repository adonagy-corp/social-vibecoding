// Per-session staging-build serialization (session 2258 friendly-fire
// incident, 2026-07-14).
//
// buildAndDeployStaging used to have no single-flight guard: a push-driven
// build racing a recovery/recheck rebuild for the SAME session would reach
// its clone step — which begins by dropping the prior staging DB via
// pg_terminate_backend — and kill the other build's in-flight pg_restore
// mid-COPY ("server closed the connection unexpectedly"). The loser then
// recorded a checks 'error' and posted a scary ⚠ to the session chat for a
// failure that was pure friendly fire.
//
// The guard chains builds per session id (concurrent triggers run
// one-at-a-time), coalesces same-commit requests onto the in-flight
// promise, keeps different sessions parallel, and never lets a failed
// build block its successor.
//
// Run with: node --test tests/staging-build-serialize.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Loads services/staging with every collaborator stubbed. The build's
// slow step (cloneDatabase — the pg_dump|pg_restore in prod) is modeled
// with a configurable async delay so tests can force overlap windows.
// Returns an event log of ['start'|'clone'|'end', sessionId, commit] plus
// a live counter of in-flight inner builds per session.
function loadStaging({ cloneDelayMs = 20, buildImageImpl = null } = {}) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    docker: require.resolve('../src/services/docker'),
    applicationRuntime: require.resolve('../src/services/application-runtime'),
    caddy: require.resolve('../src/services/caddy'),
    dbManager: require.resolve('../src/services/db-manager'),
    github: require.resolve('../src/services/github'),
    appManifest: require.resolve('../src/services/app-manifest'),
    appSecrets: require.resolve('../src/services/app-secrets'),
    appLlmEnv: require.resolve('../src/services/app-llm-env'),
    pool: require.resolve('../src/db/pool'),
    subject: require.resolve('../src/services/staging'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const events = [];
  const inFlight = new Map(); // sessionId -> count of inner builds running
  let maxConcurrent = 0;

  const bump = (sid, d) => {
    const n = (inFlight.get(sid) || 0) + d;
    inFlight.set(sid, n);
    const total = [...inFlight.values()].reduce((a, b) => a + b, 0);
    if (total > maxConcurrent) maxConcurrent = total;
  };

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.github, { getCloneUrl: async () => 'https://x/clone.git', isEnabled: () => true });
  stub(ids.appManifest, { read: () => ({}) });
  stub(ids.appSecrets, {
    getRawValues: async () => ({}),
    platformDefaultsFromEnv: () => ({}),
    mergeForDeploy: () => ({ missingRequired: [], missingPrivateStagingDefault: [], env: {} }),
  });
  stub(ids.appLlmEnv, {
    // #1213: platformStagingEnv() injects the app-platform API base URL
    // into previews (URL only, no token), so the staging path calls this.
    platformApiBaseUrl: () => 'http://usernode:3000/api/app-platform',
  });
  stub(ids.pool, { getPool: () => ({ query: async () => ({ rows: [] }) }) });
  stub(ids.caddy, {
    stagingHostname: (slug, u) => `${slug}--${u}.example.test`,
    warmCert: async () => ({ ok: true, code: 200 }),
  });

  // docker: track inner-build entry via the git clone execFileAsync call
  // (first thing the inner build does) and exit via runContainer/cleanup.
  stub(ids.docker, {
    execFileAsync: async () => ({ stdout: '' }),
    buildImage: buildImageImpl || (async () => {}),
    runContainer: async () => 'cid123',
    waitForHealthy: async () => {},
    stopAndRemove: async () => {},
    getHostPort: async () => null,
  });

  stub(ids.dbManager, {
    appDbName: (slug) => `app_${slug}`,
    stagingDbName: (slug, u, hash) => `app_${slug}_staging_${u}_${hash.substring(0, 6)}`,
    cloneDatabase: async (sourceDb, targetDb) => {
      // The slow, kill-sensitive step. Extract sessionId back out of the
      // target name (staging_s<id>_<hash>) for the event log.
      const sid = Number(/staging_s(\d+)_/.exec(targetDb)?.[1] || 0);
      events.push(['clone', sid, targetDb]);
      bump(sid, +1);
      await new Promise((r) => setTimeout(r, cloneDelayMs));
      bump(sid, -1);
      return { password: 'pw' };
    },
    connectionUrl: () => 'postgres://x',
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return {
    subject, events, restore,
    maxConcurrent: () => maxConcurrent,
  };
}

const mkSession = (id) => ({ id, branch_name: 'dev/x', staging_container_id: null });
const mkApp = { id: 5, slug: 'widget', name: 'Widget', repo_url: 'https://github.com/acme/widget' };

test('two concurrent builds for one session run sequentially, both to completion', async () => {
  const { subject, events, maxConcurrent, restore } = loadStaging({ cloneDelayMs: 30 });
  try {
    // Fire both before awaiting either — without the guard these overlap
    // and build B's clone-teardown would kill build A's restore.
    const pA = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'aaaaaa1');
    const pB = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'bbbbbb2');
    const [rA, rB] = await Promise.all([pA, pB]);

    assert.ok(rA.stagingUrl && rB.stagingUrl, 'both builds completed');
    const clones = events.filter((e) => e[0] === 'clone' && e[1] === 7);
    assert.equal(clones.length, 2, 'each distinct commit got its own build');
    assert.equal(maxConcurrent(), 1, 'the two builds never overlapped');
  } finally {
    restore();
  }
});

test('same-commit concurrent requests coalesce onto one build', async () => {
  const { subject, events, restore } = loadStaging({ cloneDelayMs: 30 });
  try {
    const pA = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'cccccc3');
    const pB = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'cccccc3');
    const [rA, rB] = await Promise.all([pA, pB]);

    const clones = events.filter((e) => e[0] === 'clone' && e[1] === 7);
    assert.equal(clones.length, 1, 'one shared build, not two identical ones');
    assert.deepEqual(rA, rB, 'both callers receive the same result');
  } finally {
    restore();
  }
});

test("'latest' never coalesces — it can point at different content over time", async () => {
  const { subject, events, maxConcurrent, restore } = loadStaging({ cloneDelayMs: 20 });
  try {
    const pA = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'latest');
    const pB = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'latest');
    await Promise.all([pA, pB]);

    const clones = events.filter((e) => e[0] === 'clone' && e[1] === 7);
    assert.equal(clones.length, 2, "two 'latest' builds run (serialized), not one");
    assert.equal(maxConcurrent(), 1, 'still never overlapping');
  } finally {
    restore();
  }
});

test('different sessions still build in parallel', async () => {
  const { subject, maxConcurrent, restore } = loadStaging({ cloneDelayMs: 40 });
  try {
    const pA = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'dddddd4');
    const pB = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(8), mkApp, 'eeeeee5');
    await Promise.all([pA, pB]);
    assert.equal(maxConcurrent(), 2, 'cross-session builds are not serialized');
  } finally {
    restore();
  }
});

test('a failed build does not block the next queued build for the session', async () => {
  let call = 0;
  const { subject, events, restore } = loadStaging({
    cloneDelayMs: 10,
    // First build's image step blows up (e.g. broken Dockerfile on the old
    // commit); the queued build with the fix must still run.
    buildImageImpl: async () => {
      call += 1;
      if (call === 1) throw new Error('docker build failed');
    },
  });
  try {
    const pA = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'ffffff6');
    const pB = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'abcdef7');
    const [rA, rB] = await Promise.allSettled([pA, pB]);

    assert.equal(rA.status, 'rejected', 'the broken build still surfaces its real error');
    assert.match(rA.reason.message, /docker build failed/);
    assert.equal(rB.status, 'fulfilled', 'the follow-up build ran and succeeded');
    const clones = events.filter((e) => e[0] === 'clone' && e[1] === 7);
    assert.equal(clones.length, 1, 'only the successful build reached the clone step');
  } finally {
    restore();
  }
});

test('sequential (non-overlapping) builds are independent — the chain self-cleans', async () => {
  const { subject, events, restore } = loadStaging({ cloneDelayMs: 5 });
  try {
    await subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, '111111a');
    // Same commit, but the first build has fully settled — this must be a
    // fresh build (a re-deploy request), not a stale coalesced result.
    await subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, '111111a');
    const clones = events.filter((e) => e[0] === 'clone' && e[1] === 7);
    assert.equal(clones.length, 2, 'settled chains do not swallow later rebuild requests');
  } finally {
    restore();
  }
});
