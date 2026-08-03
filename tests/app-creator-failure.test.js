// #416: finalizeDeploy must persist apps.last_failure when the docker
// build (or boot) fails, broadcast the concise errorReason on the
// app_status WS event, and clear last_failure again on a successful
// deploy. Same require.cache stubbing pattern as
// votes-merge-deploy-failed.test.js — nothing real (docker, GitHub, WS)
// spins up; deploy-failure.js runs for real since classifying the error
// is exactly what's under test.
//
// Run with: node --test tests/app-creator-failure.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function makeRecordingPool() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return { rows: [], rowCount: 1 };
    },
  };
}

// Loads a FRESH app-creator with its collaborators stubbed. `dockerStubs`
// lets each test choose whether buildImage throws; `githubStubs` lets the
// repo-provisioning tests enable GitHub and make createRepo fail.
function loadAppCreator({ dockerStubs = {}, ws = {}, githubStubs = {} } = {}) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    github: require.resolve('../src/services/github'),
    docker: require.resolve('../src/services/docker'),
    applicationRuntime: require.resolve('../src/services/application-runtime'),
    caddy: require.resolve('../src/services/caddy'),
    dbManager: require.resolve('../src/services/db-manager'),
    appManifest: require.resolve('../src/services/app-manifest'),
    appSecrets: require.resolve('../src/services/app-secrets'),
    appLlmEnv: require.resolve('../src/services/app-llm-env'),
    template: require.resolve('../src/services/template'),
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    appCreator: require.resolve('../src/services/app-creator'),
  };
  for (const id of Object.values(ids)) delete require.cache[id];

  const pool = makeRecordingPool();
  const statusPushes = [];

  stub(ids.logger, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
  stub(ids.github, {
    isEnabled: () => false,
    parseGithubUrl: () => null,
    getBotUsername: async () => 'usernode-bot',
    createRepo: async () => ({ html_url: 'https://github.com/usernode-bot/test-app' }),
    pushFiles: async () => {},
    getCloneUrl: async () => 'https://github.com/usernode-bot/test-app.git',
    ...githubStubs,
  });
  stub(ids.docker, {
    execFileAsync: async () => ({ stdout: '', stderr: '' }),
    buildImage: async () => {},
    stopAndRemove: async () => {},
    runContainer: async () => 'container-id-123',
    waitForHealthy: async () => {},
    getHostPort: async () => null,
    ...dockerStubs,
  });
  stub(ids.caddy, { productionHostname: (slug) => `${slug}.example.test` });
  stub(ids.dbManager, {
    appDbName: (slug) => `app_${slug}`,
    createDatabase: async () => ({ password: 'pw' }),
    connectionUrl: () => 'postgres://x',
  });
  stub(ids.appManifest, {
    read: () => ({ secrets: [] }),
    reconcileAppName: async () => {},
    reconcileAppVisibility: async () => {},
    reconcileAppGovernance: async () => {},
    reconcileAppScreenshot: async () => {},
    reconcileAppIcon: async () => {},
    reconcileAppAdmins: async () => {},
  });
  stub(ids.appSecrets, {
    getRawValues: async () => ({}),
    mergeForDeploy: () => ({ missingRequired: [], env: {} }),
    platformDefaultsFromEnv: () => ({}),
  });
  stub(ids.appLlmEnv, { productionLlmEnv: async () => ({}) });
  stub(ids.template, { getTemplateFiles: () => [] });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.ws, {
    pushAppStatusUpdate: (payload) => statusPushes.push(payload),
    ...ws,
  });

  const appCreator = require(ids.appCreator);
  return { appCreator, pool, statusPushes };
}

const DEPLOY_ARGS = {
  appId: 42,
  name: 'Test App',
  slug: 'test-app',
  tempDir: '/tmp/x',
  dbUrl: 'postgres://x',
  repoUrl: 'https://github.com/x/y',
  mainSha: 'abc1234def5678',
};

test('failed docker build persists last_failure (stage build) and broadcasts errorReason', async () => {
  const buildErr = new Error('Command failed: docker build');
  buildErr.buildFailed = true;
  buildErr.buildLog = 'ERROR: failed to read dockerfile: open Dockerfile: no such file or directory';

  const { appCreator, pool, statusPushes } = loadAppCreator({
    dockerStubs: { buildImage: async () => { throw buildErr; } },
  });

  await appCreator.finalizeDeploy({}, DEPLOY_ARGS);

  const failureWrite = pool.queries.find((q) => /SET last_failure = \$1/.test(q.sql));
  assert.ok(failureWrite, 'expected an UPDATE apps SET last_failure write');
  const record = JSON.parse(failureWrite.params[0]);
  assert.equal(record.stage, 'build');
  assert.ok(record.reason.startsWith('Build failed:'));
  assert.ok(record.reason.includes('failed to read dockerfile'));
  assert.ok(record.log.includes('open Dockerfile'));
  assert.equal(record.sha, 'abc1234def5678');
  assert.equal(failureWrite.params[1], 42);

  const statusWrite = pool.queries.find((q) => /SET status = \$1 WHERE/.test(q.sql) && q.params[0] === 'error');
  assert.ok(statusWrite, 'expected the status=error flip');

  const push = statusPushes.find((p) => p.status === 'error');
  assert.ok(push, 'expected an error app_status broadcast');
  assert.ok(push.errorReason.includes('failed to read dockerfile'));
});

test('failed healthcheck persists stage healthcheck with the container-log reason', async () => {
  const hcErr = new Error('Healthcheck failed after 30 attempts: usernode-app-test-app');
  hcErr.healthcheckFailed = true;
  hcErr.containerStatus = 'exited (exit=1)';
  hcErr.containerLogs = "Error: Cannot find module './lib/dapp-server'";

  const { appCreator, pool, statusPushes } = loadAppCreator({
    dockerStubs: { waitForHealthy: async () => { throw hcErr; } },
  });

  await appCreator.finalizeDeploy({}, DEPLOY_ARGS);

  const failureWrite = pool.queries.find((q) => /SET last_failure = \$1/.test(q.sql));
  assert.ok(failureWrite);
  const record = JSON.parse(failureWrite.params[0]);
  assert.equal(record.stage, 'healthcheck');
  assert.equal(record.reason, "[exited (exit=1)] Error: Cannot find module './lib/dapp-server'");

  const push = statusPushes.find((p) => p.status === 'error');
  assert.ok(push && push.errorReason.includes('Cannot find module'));
});

test('successful deploy clears last_failure and broadcasts running with no errorReason', async () => {
  const { appCreator, pool, statusPushes } = loadAppCreator();

  await appCreator.finalizeDeploy({}, DEPLOY_ARGS);

  const successWrite = pool.queries.find((q) => /last_failure = NULL/.test(q.sql));
  assert.ok(successWrite, 'expected the success UPDATE to clear last_failure');
  assert.equal(successWrite.params[0], 'running');

  assert.ok(!pool.queries.some((q) => /SET last_failure = \$1/.test(q.sql)),
    'no failure record should be written on success');

  const push = statusPushes.find((p) => p.status === 'running');
  assert.ok(push, 'expected a running broadcast');
  assert.ok(!statusPushes.some((p) => p.status === 'error'));
});

// Session-2585 fix: with GitHub enabled, a repo-creation failure is FATAL
// (status='error', last_failure stage 'repo') instead of silently falling
// back to a local build that leaves repo_url NULL on a 'running' app.
test('GitHub enabled + createRepo failure ends status=error with stage repo', async () => {
  const { appCreator, pool, statusPushes } = loadAppCreator({
    githubStubs: {
      isEnabled: () => true,
      createRepo: async () => { throw new Error('API rate limit exceeded'); },
    },
  });

  await appCreator.createApp({ jwtSecret: 's' }, {
    id: 42, name: 'Test App', slug: 'test-app', self_hosted: false,
  });

  const failureWrite = pool.queries.find((q) => /SET last_failure = \$1/.test(q.sql));
  assert.ok(failureWrite, 'expected an UPDATE apps SET last_failure write');
  const record = JSON.parse(failureWrite.params[0]);
  assert.equal(record.stage, 'repo');
  assert.ok(record.reason.includes('GitHub repo creation failed'));
  assert.ok(record.reason.includes('API rate limit exceeded'));

  const statusWrite = pool.queries.find((q) => /SET status = \$1 WHERE/.test(q.sql) && q.params[0] === 'error');
  assert.ok(statusWrite, 'expected the status=error flip');
  assert.ok(!pool.queries.some((q) => /SET repo_url/.test(q.sql)),
    'repo_url must not be written when provisioning failed');

  const push = statusPushes.find((p) => p.status === 'error');
  assert.ok(push && push.errorReason.includes('GitHub repo creation failed'));
});

// Adopt-existing (mypage-777ed2 incident): a Retry after a create that
// died between the GitHub create call and the repo_url persist re-runs
// with the SAME slug — the repo already exists on the bot account. The
// real createRepo resolves that 422 to the existing repo when the caller
// passes adoptExisting; this test pins that createApp opts in, so the
// retry proceeds to a running deploy instead of flipping to error.
test('GitHub enabled + repo already exists on retry adopts it and deploys to running', async () => {
  let sawAdoptOption = false;
  const { appCreator, pool, statusPushes } = loadAppCreator({
    githubStubs: {
      isEnabled: () => true,
      createRepo: async (owner, slug, opts = {}) => {
        sawAdoptOption = !!opts.adoptExisting;
        if (!opts.adoptExisting) {
          const err = new Error('Repository creation failed.: name already exists on this account');
          err.status = 422;
          throw err;
        }
        // Real createRepo adopts: fetches and returns the existing repo.
        return { html_url: `https://github.com/${owner}/${slug}` };
      },
    },
  });

  await appCreator.createApp({ jwtSecret: 's' }, {
    id: 42, name: 'Test App', slug: 'test-app', self_hosted: false,
  });

  assert.equal(sawAdoptOption, true, 'createApp must opt into adopt-existing');

  const repoWrite = pool.queries.find((q) => /SET repo_url = \$1/.test(q.sql));
  assert.ok(repoWrite, 'expected repo_url persisted from the adopted repo');
  assert.equal(repoWrite.params[0], 'https://github.com/usernode-bot/test-app');

  assert.ok(!pool.queries.some((q) => /SET status = \$1 WHERE/.test(q.sql) && q.params[0] === 'error'),
    'no error flip when the existing repo is adopted');
  const successWrite = pool.queries.find((q) => /last_failure = NULL/.test(q.sql));
  assert.ok(successWrite, 'expected the success UPDATE');
  assert.equal(successWrite.params[0], 'running');
  assert.ok(statusPushes.some((p) => p.status === 'running'));
});

test('GitHub disabled keeps the local-template fallback deploying to running', async () => {
  const { appCreator, pool, statusPushes } = loadAppCreator(); // isEnabled: () => false

  await appCreator.createApp({ jwtSecret: 's' }, {
    id: 42, name: 'Test App', slug: 'test-app', self_hosted: false,
  });

  assert.ok(!pool.queries.some((q) => /SET status = \$1 WHERE/.test(q.sql) && q.params[0] === 'error'),
    'no error flip in the no-GitHub mode');
  const successWrite = pool.queries.find((q) => /last_failure = NULL/.test(q.sql));
  assert.ok(successWrite, 'expected the success UPDATE clearing last_failure');
  assert.equal(successWrite.params[0], 'running');
  assert.ok(statusPushes.some((p) => p.status === 'running'));
});
