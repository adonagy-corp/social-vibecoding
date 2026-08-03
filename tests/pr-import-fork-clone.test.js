// #866 — fork-aware, SHA-pinned staging clone (services/staging.js).
//
// The bug: buildAndDeployStaging always cloned `--branch
// session.branch_name`. For an imported PR that branch name is the PR's HEAD
// ref — and when the PR comes from a FORK that ref exists only in the fork,
// never in the app's own repo. `git clone --branch` failed outright, the
// preview never came up, and the proposal was left with a checks 'error'
// ("staging build failed") that no amount of re-running could fix.
//
// The fix leans on the one ref GitHub publishes for every PR in the BASE
// repo, fork or not: refs/pull/<N>/head. When the caller pinned a concrete
// commit AND the session carries a PR number, the clone drops --branch (the
// default branch is fine — nothing is read from it) and the pinned commit is
// fetched via that ref, then checked out detached. Same-repo imports take the
// identical path, so there's one code path rather than a fork special case.
//
// What this suite pins down:
//   - native sessions still clone their own branch, with no PR-ref fetch;
//   - a pinned + PR-numbered session clones WITHOUT --branch and fetches
//     refs/pull/<N>/head, then detaches at the exact SHA;
//   - if the PR ref is unavailable (very old PR, unusual host) it falls back
//     to fetching the bare SHA rather than giving up;
//   - a pinned session with no PR number keeps the historical
//     detach-then-fetch-SHA behaviour;
//   - when nothing can produce the pinned commit the build THROWS — building
//     whatever the clone happened to land on would preview the wrong code.
//
// Every collaborator is stubbed (same shape as
// tests/staging-build-serialize.test.js) — no docker, no git, no Postgres.
//
// Run with: node --test tests/pr-import-fork-clone.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// `gitFail(argv)` → truthy to make that git invocation reject (argv is the
// full argument array), so a test can model "this repo has no refs/pull".
function loadStaging({ gitFail = null } = {}) {
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

  const git = [];   // every git invocation's argv, in order

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
  stub(ids.docker, {
    execFileAsync: async (cmd, argv) => {
      if (cmd === 'git') {
        git.push(argv);
        if (gitFail && gitFail(argv)) throw new Error(`git ${argv.join(' ')} failed`);
      }
      return { stdout: '' };
    },
    buildImage: async () => {},
    runContainer: async () => 'cid123',
    waitForHealthy: async () => {},
    stopAndRemove: async () => {},
    getHostPort: async () => null,
  });
  stub(ids.dbManager, {
    appDbName: (slug) => `app_${slug}`,
    stagingDbName: (slug, u, hash) => `app_${slug}_staging_${u}_${String(hash).substring(0, 6)}`,
    cloneDatabase: async () => ({ password: 'pw' }),
    connectionUrl: () => 'postgres://x',
  });

  // visuals.js is loaded by this test file too and may already have loaded
  // application-runtime with the real docker module. Reload the dispatcher
  // after installing the docker stub so staging remains fully isolated.
  delete require.cache[ids.applicationRuntime];
  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  // Convenience views over the recorded argv.
  const find = (verb) => git.filter((a) => a.includes(verb));
  return { subject, git, find, restore };
}

const APP = { id: 5, slug: 'widget', name: 'Widget', repo_url: 'https://github.com/acme/widget' };
const CONFIG = { jwtSecret: 's' };
const SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

// An imported proposal: branch_name is the PR's head ref (which for a fork
// PR does not exist in acme/widget), plus the PR number and pinned head sha.
const forkSession = (over = {}) => ({
  id: 91, branch_name: 'contributor/feature', pr_number: 9401,
  source: 'imported', imported_pr_head_sha: SHA, staging_container_id: null,
  ...over,
});

test('a native session still clones its own branch and never touches refs/pull', async () => {
  const { subject, find, restore } = loadStaging();
  try {
    await subject.buildAndDeployStaging(
      CONFIG, { id: 7, branch_name: 'dev/native-work', staging_container_id: null }, APP, 'latest'
    );
    const clone = find('clone')[0];
    assert.ok(clone, 'cloned once');
    assert.ok(clone.includes('--branch'), 'native clone still selects the branch');
    assert.equal(clone[clone.indexOf('--branch') + 1], 'dev/native-work');
    assert.equal(find('fetch').length, 0, "'latest' pins nothing, so nothing is fetched");
    assert.equal(find('checkout').length, 0, 'and HEAD is left on the branch tip');
  } finally { restore(); }
});

test('an imported PR clones without --branch and fetches refs/pull/<N>/head', async () => {
  const { subject, find, git, restore } = loadStaging();
  try {
    await subject.buildAndDeployStaging(CONFIG, forkSession(), APP, SHA);
    const clone = find('clone')[0];
    assert.ok(!clone.includes('--branch'),
      "a fork's head ref does not exist in the app's repo — cloning it would fail");
    assert.ok(!clone.includes('contributor/feature'), 'the head ref is not passed to clone at all');

    const fetches = find('fetch');
    assert.equal(fetches.length, 1, 'exactly one fetch — the PR head ref resolved first try');
    assert.ok(fetches[0].includes('refs/pull/9401/head'),
      'the PR head ref is what makes a fork commit reachable through the base repo');
    assert.ok(fetches[0].includes('--depth'), 'still a shallow fetch');

    const checkout = find('checkout')[0];
    assert.ok(checkout.includes('--detach') && checkout.includes(SHA),
      'HEAD is detached at exactly the reviewed commit');
    // Order matters: the pinned commit cannot be checked out before it exists.
    assert.ok(git.indexOf(fetches[0]) < git.indexOf(checkout), 'fetch precedes checkout');
  } finally { restore(); }
});

test('the PR-ref path never attempts a bare detach first (it could only fail)', async () => {
  const { subject, git, restore } = loadStaging();
  try {
    await subject.buildAndDeployStaging(CONFIG, forkSession(), APP, SHA);
    const firstCheckout = git.findIndex((a) => a.includes('checkout'));
    const firstFetch = git.findIndex((a) => a.includes('fetch'));
    assert.ok(firstFetch >= 0 && firstFetch < firstCheckout,
      'no speculative pre-fetch detach — we cloned the default branch, so it cannot contain the commit');
  } finally { restore(); }
});

test('an unavailable PR ref falls back to fetching the bare SHA', async () => {
  // Model a host that refuses refs/pull (or a PR whose ref was reaped):
  // only the refs/pull fetch fails.
  const { subject, find, restore } = loadStaging({
    gitFail: (argv) => argv.includes('fetch') && argv.some((a) => String(a).startsWith('refs/pull/')),
  });
  try {
    const res = await subject.buildAndDeployStaging(CONFIG, forkSession(), APP, SHA);
    assert.ok(res.stagingUrl, 'the build still completed');
    const fetches = find('fetch');
    assert.equal(fetches.length, 2, 'tried the PR ref, then the SHA');
    assert.ok(fetches[1].includes(SHA), 'the fallback fetches the commit directly');
    assert.ok(find('checkout').some((a) => a.includes(SHA)), 'and still pins that commit');
  } finally { restore(); }
});

test('a pinned session with no PR number keeps the branch clone + plain detach', async () => {
  const { subject, find, restore } = loadStaging();
  try {
    await subject.buildAndDeployStaging(
      CONFIG,
      { id: 8, branch_name: 'dev/pinned', pr_number: null, staging_container_id: null },
      APP, SHA
    );
    const clone = find('clone')[0];
    assert.ok(clone.includes('--branch'), 'no PR number → historical branch clone');
    assert.equal(find('fetch').length, 0,
      'the branch tip already IS the pinned commit here, so the plain detach suffices');
    assert.ok(find('checkout')[0].includes(SHA), 'detached at the pinned commit');
  } finally { restore(); }
});

test('a pinned commit that cannot be produced fails the build instead of previewing the wrong code', async () => {
  const { subject, find, restore } = loadStaging({
    gitFail: (argv) => argv.includes('fetch') || argv.includes('checkout'),
  });
  try {
    await assert.rejects(
      () => subject.buildAndDeployStaging(CONFIG, forkSession(), APP, SHA),
      /failed/i,
      'every route to the commit failed, so the build must surface it (→ checks error)'
    );
    assert.equal(find('fetch').length, 2, 'both the PR ref and the bare SHA were tried first');
  } finally { restore(); }
});

// ── the same question, one layer up: visuals.sessionGitRef ──────────────
//
// The clone isn't the only place that has to name this session's code. The
// checks capture asks GitHub two things — which files changed
// (`main...<ref>`) and what dapp.json declares as tests (getFileContent at
// <ref>) — and both used to pass `branch_name`. For a fork-headed import that
// ref is absent from the app's repo: the compare 404s (so every proposal
// looked UI-affecting) and the manifest read fails (so the declared test
// suite silently degraded to the baseline). Worse, if the base repo happens
// to have a same-named branch, both resolve to unrelated code. The head SHA
// is exact and always reachable, so imported rows use it.

// visuals loads platform-jwt (→ jsonwebtoken) and pg at require time; neither
// is installed in the test tree and neither is reached here.
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'jsonwebtoken') return { sign: () => 'tok', verify: () => ({}) };
  if (request === 'pg') return { Pool: class { async query() { return { rows: [] }; } } };
  return _origLoad.call(this, request, ...rest);
};
const visuals = require('../src/services/visuals');

test('sessionGitRef: an imported session resolves to its recorded head SHA', () => {
  assert.equal(
    visuals.sessionGitRef({ source: 'imported', imported_pr_head_sha: SHA, branch_name: 'contributor/feature' }),
    SHA,
    "the branch name is the fork's, not something this repo can resolve"
  );
});

test('sessionGitRef: an imported session with no recorded SHA falls back to the build commit', () => {
  assert.equal(
    visuals.sessionGitRef({ source: 'imported', imported_pr_head_sha: null, branch_name: 'x' }, 'abc1234'),
    'abc1234', 'the commit just built is still exact — better than a ref that may not exist');
  assert.equal(
    visuals.sessionGitRef({ source: 'imported', imported_pr_head_sha: null, branch_name: 'x' }, null),
    null, 'nothing to name → the callers skip their GitHub reads rather than guess');
});

test('sessionGitRef: a CLI handoff stays pinned to the commit being checked', () => {
  assert.equal(
    visuals.sessionGitRef({
      source: 'cli_handoff',
      branch_name: 'dev/cli-u7-feature',
      checks_commit_sha: 'older-reviewed-head',
    }, SHA),
    SHA,
    'a direct branch push cannot change the GitHub inputs for an in-flight capture'
  );
  assert.equal(
    visuals.sessionGitRef({
      source: 'cli_handoff',
      branch_name: 'dev/cli-u7-feature',
      checks_commit_sha: SHA,
    }),
    SHA,
    'recovery without an explicit argument still uses the durable checked SHA'
  );
});

test('sessionGitRef: native sessions keep their branch (unchanged behaviour)', () => {
  assert.equal(visuals.sessionGitRef({ branch_name: 'dev/native' }, 'ignored'), 'dev/native');
  assert.equal(visuals.sessionGitRef({ source: 'chat', branch_name: 'dev/native' }), 'dev/native');
  assert.equal(visuals.sessionGitRef(null), null, 'no session → no ref, never a crash');
});

test('both capture-time GitHub reads go through the resolved ref', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'services', 'visuals.js'), 'utf8'
  );
  assert.match(src, /const gitRef = sessionGitRef\(session, commitHash\);/);
  assert.match(src, /`main\.\.\.\$\{gitRef\}`/, 'the changed-file compare uses it');
  assert.match(src, /resolveDeclaredTests\(repoOwner, repoName, gitRef\)/,
    'and so does the dapp.json read — a fork import must run its OWN declared tests');
});
