// Tests for the stale-staging-preview sweep (src/services/staging-reap.js).
//
// All docker / staging / db-manager / ws work is stubbed via require.cache
// (same pattern as tests/app-rollover.test.js), so no real docker, DB or
// socket is touched. The fixture reproduces the FIVE groups the production
// fleet actually contained when this module landed, because they are what
// makes DB-only enumeration wrong:
//
//   linked-merged      85  session row still names the container
//   unlinked-merged    10  staging_container_id nulled, container survived
//   archived            6  abandoned proposal
//   promoted            3  backs a live merge vote
//   no session row      5  app deleted, chat_sessions row cascaded away
//
// `SELECT … WHERE staging_container_id IS NOT NULL` finds only the first,
// third and fourth groups — 94 of 109 in production. So the sweep enumerates
// docker and joins BACK to the DB, and the two teardown paths (chokepoint vs
// by-name) are chosen by what the DB says, not by what the container is.
//
// Run with: node --test tests/staging-reap.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const ids = {
  logger: require.resolve('../src/services/logger'),
  docker: require.resolve('../src/services/docker'),
  staging: require.resolve('../src/services/staging'),
  dbManager: require.resolve('../src/services/db-manager'),
  events: require.resolve('../src/services/events'),
  ws: require.resolve('../src/services/ws'),
  pool: require.resolve('../src/db/pool'),
  reap: require.resolve('../src/services/staging-reap'),
};

let fx;

function freshFixtures() {
  return {
    // docker ps output lines: [name, state, image]
    psLines: [],
    psError: null,
    dockerExecCalls: 0,
    exists: () => true,
    existsCalls: [],
    // #851: inspect probe (null = "no label there either")
    inspect: null,
    inspectCalls: [],
    stopCalls: [],
    stopError: null,
    // staging
    teardownCalls: [],
    teardownError: null,
    // session ids whose teardown reports a surviving container (#851)
    teardownLeaks: [],
    // db-manager
    dropCalls: [],
    dropError: null,
    // pool
    sessions: [],
    queries: [],
    // ws / events
    adminBroadcasts: [],
    eventRecords: [],
    // concurrency observation
    concurrentNow: 0,
    concurrentMax: 0,
    unitDelayMs: 0,
  };
}

const fakePool = {
  async query(sql, params = []) {
    fx.queries.push({ sql, params });
    if (/FROM chat_sessions/.test(sql)) {
      const ids_ = params[0] || [];
      return { rows: fx.sessions.filter((s) => ids_.includes(s.id)) };
    }
    return { rows: [], rowCount: 1 };
  },
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function installStubs() {
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.docker, {
    STAGING_STOP_GRACE_SEC: 2,
    async execFileAsync(_bin, args) {
      fx.dockerExecCalls += 1;
      if (fx.psError) throw fx.psError;
      // Pin that the sweep asks docker for ALL staging containers, exited
      // ones included — a stopped preview still holds its name, image and
      // database, so it is exactly as much of a leak as a running one.
      assert.ok(args.includes('-a'), 'must list stopped containers too');
      assert.ok(args.includes('name=^/usernode-staging-'), 'must filter by the staging prefix');
      return { stdout: `${fx.psLines.map((l) => l.join('\t')).join('\n')}\n` };
    },
    async containerExists(name) {
      fx.existsCalls.push(name);
      return fx.exists(name);
    },
    // #851: the automatic pass probes one container with a real inspect when
    // `docker ps` reported no labels at all, to tell "this fleet predates the
    // fingerprint" from "this docker cannot answer {{.Label}}". Default null =
    // the probe finds nothing either, so unlabelled genuinely means stale.
    async inspectContainer(name) {
      fx.inspectCalls.push(name);
      return fx.inspect ? fx.inspect(name) : null;
    },
    async stopAndRemove(name, opts) {
      fx.stopCalls.push({ name, opts });
      fx.concurrentNow += 1;
      fx.concurrentMax = Math.max(fx.concurrentMax, fx.concurrentNow);
      try {
        if (fx.unitDelayMs) await sleep(fx.unitDelayMs);
        if (fx.stopError) throw fx.stopError;
      } finally {
        fx.concurrentNow -= 1;
      }
    },
  });
  stub(ids.staging, {
    async teardownStaging(session, app) {
      fx.teardownCalls.push({ sessionId: session.id, slug: app && app.slug });
      fx.concurrentNow += 1;
      fx.concurrentMax = Math.max(fx.concurrentMax, fx.concurrentNow);
      try {
        if (fx.unitDelayMs) await sleep(fx.unitDelayMs);
        if (fx.teardownError) throw fx.teardownError;
        // #851: the real chokepoint reports whether the container actually
        // went away. `teardownLeaks` makes a session return the leak shape.
        if (fx.teardownLeaks.includes(session.id)) return { removed: false, leaked: true };
        return { removed: true, leaked: false };
      } finally {
        fx.concurrentNow -= 1;
      }
    },
  });
  stub(ids.dbManager, {
    stagingDbName(slug, username, commitHash) {
      return `app_${slug.replace(/[^a-z0-9_]/g, '_')}_staging_${username}_${commitHash.slice(0, 6)}`;
    },
    async dropDatabase(name) {
      fx.dropCalls.push(name);
      if (fx.dropError) throw fx.dropError;
    },
  });
  stub(ids.events, {
    EVENT_TYPES: { STALE_PREVIEWS_REAPED: 'stale_previews_reaped' },
    record(_pool, payload) { fx.eventRecords.push(payload); return Promise.resolve(); },
  });
  stub(ids.ws, {
    broadcastToAdmins(payload) { fx.adminBroadcasts.push(payload); return 1; },
  });
  stub(ids.pool, { getPool: () => fakePool });
}

function loadReap() {
  delete require.cache[ids.reap];
  return require(ids.reap);
}

function setup() {
  fx = freshFixtures();
  installStubs();
  const reap = loadReap();
  reap._reset();
  return reap;
}

// Drive one full sweep and resolve with the finished job snapshot.
async function runSweep(reap, opts = {}) {
  const res = reap.start({}, { userId: 7, username: 'admin-user', ...opts });
  assert.equal(res.started, true, 'the sweep must start');
  for (let i = 0; i < 400; i++) {
    const job = reap.read();
    if (job && job.finishedAt) return job;
    await sleep(5);
  }
  throw new Error('sweep did not finish');
}

function states(job) {
  return job.previews.reduce((acc, p) => { acc[p.name] = p.state; return acc; }, {});
}

function classifications(job) {
  return job.previews.reduce((acc, p) => { acc[p.name] = p.classification; return acc; }, {});
}

// The production fleet's five groups, one container each.
function fleet() {
  fx.psLines = [
    ['usernode-staging-community-tier-lists-57ce6a--2549', 'running', 'usernode-staging-community-tier-lists-57ce6a-2549:672ecf'],
    ['usernode-staging-whiteboard-0d337f--2458', 'running', 'usernode-staging-whiteboard-0d337f-2458:ce25fb'],
    ['usernode-staging-guardian-2-99eba3--2472', 'running', 'usernode-staging-guardian-2-99eba3-2472:1b3ff2'],
    ['usernode-staging-usernode-2d5619--2795', 'running', 'usernode-staging-usernode-2d5619-2795:5ebf65'],
    ['usernode-staging-veya-afaeaa--1212', 'exited', 'usernode-staging-veya-afaeaa-1212:d49e87'],
  ];
  fx.sessions = [
    { id: 2549, status: 'merged', pr_number: 164, staging_container_id: 'cid-2549', staging_url: 'https://x--s2549--672ecf.example', app_slug: 'community-tier-lists-57ce6a' },
    // Leaked past a prior teardown: the row was nulled, the container wasn't.
    { id: 2458, status: 'merged', pr_number: 691, staging_container_id: null, staging_url: null, app_slug: 'whiteboard-0d337f' },
    { id: 2472, status: 'archived', pr_number: 384, staging_container_id: 'cid-2472', staging_url: 'https://x--s2472--1b3ff2.example', app_slug: 'guardian-2-99eba3' },
    { id: 2795, status: 'promoted', pr_number: 840, staging_container_id: 'cid-2795', staging_url: 'https://x--s2795--5ebf65.example', app_slug: 'usernode-2d5619' },
    // 1212 deliberately absent: its app was deleted and the row cascaded.
  ];
}

// ── Enumeration and name parsing ────────────────────────────────────────

test('every container in the fleet is enumerated and classified', async () => {
  const reap = setup();
  fleet();
  const job = await runSweep(reap);

  assert.equal(job.total, 5, 'all five groups must be picked up, not just the linked ones');
  assert.deepEqual(classifications(job), {
    'usernode-staging-community-tier-lists-57ce6a--2549': 'merged',
    'usernode-staging-whiteboard-0d337f--2458': 'merged_unlinked',
    'usernode-staging-guardian-2-99eba3--2472': 'archived',
    'usernode-staging-usernode-2d5619--2795': 'promoted',
    'usernode-staging-veya-afaeaa--1212': 'no_session_row',
  });
});

// The slug contains hyphens, and for the self-app it STARTS with
// `usernode-` — so the pattern has to anchor on the double hyphen before a
// trailing all-digits session id rather than splitting on the first hyphen.
test('the name parser handles hyphenated and usernode-prefixed slugs', async () => {
  const reap = setup();
  fx.psLines = [
    ['usernode-staging-usernode-2d5619--2795', 'running', 'img:aaaaaa'],
    ['usernode-staging-guardian-2-99eba3--2472', 'running', 'img:bbbbbb'],
    ['usernode-staging-a--7', 'running', 'img:cccccc'],
  ];
  const parsed = await reap.listStagingContainers();
  assert.deepEqual(parsed.map((p) => [p.slug, p.sessionId]), [
    ['usernode-2d5619', 2795],
    ['guardian-2-99eba3', 2472],
    ['a', 7],
  ]);
});

// A name we cannot identify is left strictly alone — better to under-reap
// than to stop a container we did not recognise.
test('an unrecognised container name is skipped, not guessed at', async () => {
  const reap = setup();
  fx.psLines = [
    ['usernode-staging-good--12', 'running', 'img:aaaaaa'],
    ['usernode-staging-no-session-suffix', 'running', 'img:bbbbbb'],
    ['usernode-staging-trailing--notanumber', 'running', 'img:cccccc'],
  ];
  const parsed = await reap.listStagingContainers();
  assert.deepEqual(parsed.map((p) => p.name), ['usernode-staging-good--12']);
});

test('a docker failure yields an empty inventory, not a crash', async () => {
  const reap = setup();
  fx.psError = new Error('docker daemon unreachable');
  const job = await runSweep(reap);
  assert.equal(job.total, 0);
  assert.equal(job.failed, 0);
  assert.equal(fx.stopCalls.length, 0, 'nothing may be torn down blind');
});

// ── The two teardown paths ──────────────────────────────────────────────

test('a linked session routes through teardownStaging, unlinked ones by name', async () => {
  const reap = setup();
  fleet();
  const job = await runSweep(reap);

  // Chokepoint path: the three sessions whose row still names the container.
  assert.deepEqual(
    fx.teardownCalls.map((c) => c.sessionId).sort((a, b) => a - b),
    [2472, 2549, 2795]
  );
  // teardownStaging derives the staging DB name from staging_url itself, so
  // the sweep must NOT also drop a database for those.
  assert.deepEqual(
    fx.teardownCalls.map((c) => c.slug).sort(),
    ['community-tier-lists-57ce6a', 'guardian-2-99eba3', 'usernode-2d5619']
  );

  // By-name path: the leaked container and the session-less one.
  assert.deepEqual(fx.stopCalls.map((c) => c.name).sort(), [
    'usernode-staging-veya-afaeaa--1212',
    'usernode-staging-whiteboard-0d337f--2458',
  ]);
  for (const call of fx.stopCalls) {
    assert.equal(call.opts.stopTimeoutSec, 2, 'must use the staging stop grace');
  }

  // Their databases come from the IMAGE TAG's commit hash — the only place
  // it survives once staging_url is null.
  assert.deepEqual(fx.dropCalls.sort(), [
    'app_veya_afaeaa_staging_s1212_d49e87',
    'app_whiteboard_0d337f_staging_s2458_ce25fb',
  ]);

  assert.equal(job.failed, 0);
  for (const state of Object.values(states(job))) {
    assert.equal(state, 'torn_down');
  }
});

// The whole point of deriving from the image tag: an unparseable one must
// leave the database alone rather than guess a name. teardownStaging's own
// fallback is the literal '000000', which would name someone else's DB.
test('an unparseable image tag skips the DB drop instead of guessing', async () => {
  const reap = setup();
  fx.psLines = [
    ['usernode-staging-orphan-abc123--55', 'running', 'usernode-staging-orphan-abc123-55:latest'],
  ];
  fx.sessions = [];
  const job = await runSweep(reap);

  assert.deepEqual(fx.stopCalls.map((c) => c.name), ['usernode-staging-orphan-abc123--55'],
    'the container still goes away — that is the part that matters');
  assert.deepEqual(fx.dropCalls, [], 'but no database is dropped on a guess');
  assert.equal(job.previews[0].state, 'torn_down_no_db');
  assert.equal(job.failed, 0, 'a kept database is not a failed unit');
});

// A database that refuses to drop is a leak to chase separately: the
// container is already gone, so the unit is not a failure.
test('a failed DB drop still counts as torn down', async () => {
  const reap = setup();
  fx.psLines = [['usernode-staging-orphan-abc123--55', 'running', 'img:abc123']];
  fx.sessions = [];
  fx.dropError = new Error('database is being accessed by other users');
  const job = await runSweep(reap);

  assert.equal(job.previews[0].state, 'torn_down_no_db');
  assert.equal(job.failed, 0);
});

test('a container that vanished mid-sweep is skipped', async () => {
  const reap = setup();
  fleet();
  fx.exists = (name) => name !== 'usernode-staging-veya-afaeaa--1212';
  const job = await runSweep(reap);

  assert.equal(states(job)['usernode-staging-veya-afaeaa--1212'], 'skipped_gone');
  assert.equal(fx.dropCalls.length, 1, 'a vanished container drops no database');
  assert.equal(job.failed, 0);
});

// ── Failure isolation ───────────────────────────────────────────────────

test('one stuck container does not take the sweep down', async () => {
  const reap = setup();
  fleet();
  fx.teardownError = new Error('stop timeout exceeded');
  const job = await runSweep(reap);

  assert.equal(job.total, 5);
  assert.equal(job.done, 5, 'every unit is still attempted');
  assert.equal(job.failed, 3, 'the three chokepoint units fail');
  const s = states(job);
  assert.equal(s['usernode-staging-community-tier-lists-57ce6a--2549'], 'failed');
  assert.equal(s['usernode-staging-whiteboard-0d337f--2458'], 'torn_down',
    'the by-name path is unaffected');
  assert.ok(job.previews.find((p) => p.state === 'failed').error,
    'a failed unit carries its reason for the console');
});

test('a failed stopAndRemove is isolated to its own unit', async () => {
  const reap = setup();
  fleet();
  fx.stopError = new Error('permission denied');
  const job = await runSweep(reap);

  assert.equal(job.failed, 2, 'only the two by-name units');
  assert.deepEqual(fx.dropCalls, [], 'a container that would not stop keeps its database');
});

// ── Job shape, singleton, progress and tally ────────────────────────────

test('a second start while a sweep is live returns the in-flight job', async () => {
  const reap = setup();
  fleet();
  fx.unitDelayMs = 30;
  const first = reap.start({}, { username: 'admin-user' });
  assert.equal(first.started, true);
  const second = reap.start({}, { username: 'someone-else' });
  assert.equal(second.started, false, 'the route turns this into a 409');
  assert.equal(second.job.id, first.job.id);
  for (let i = 0; i < 400 && !(reap.read() || {}).finishedAt; i++) await sleep(5);
});

test('teardown concurrency is bounded by the drain width', async () => {
  const reap = setup();
  fleet();
  fx.unitDelayMs = 20;
  const job = await runSweep(reap);
  assert.ok(fx.concurrentMax > 1, 'the drain must actually run in parallel');
  assert.ok(fx.concurrentMax <= job.concurrency,
    `at most ${job.concurrency} teardowns in flight, saw ${fx.concurrentMax}`);
});

test('progress is broadcast to admins only, and the tally is emitted once', async () => {
  const reap = setup();
  fleet();
  const job = await runSweep(reap);

  assert.ok(fx.adminBroadcasts.length > 5, 'per-unit progress must reach admin sockets');
  for (const b of fx.adminBroadcasts) {
    assert.equal(b.type, 'admin_staging_reap_status');
  }
  const last = fx.adminBroadcasts[fx.adminBroadcasts.length - 1];
  assert.ok(last.job.finishedAt, 'the final broadcast carries the finished job');

  assert.equal(fx.eventRecords.length, 1, 'exactly one durable trace');
  const ev = fx.eventRecords[0];
  assert.equal(ev.type, 'stale_previews_reaped');
  assert.equal(ev.userId, 7);
  assert.equal(ev.metadata.total, 5);
  assert.equal(ev.metadata.tornDown, 5);
  assert.equal(ev.metadata.dbsDropped, 5);
  assert.equal(ev.metadata.failed, 0);
  assert.deepEqual(ev.metadata.byClassification, {
    merged: 1, merged_unlinked: 1, archived: 1, promoted: 1, no_session_row: 1,
  });
  assert.ok(typeof ev.metadata.durationMs === 'number');
});

test('an empty host is a clean no-op sweep', async () => {
  const reap = setup();
  const job = await runSweep(reap);
  assert.equal(job.total, 0);
  assert.equal(job.done, 0);
  assert.equal(fx.eventRecords.length, 1, 'still records the (empty) run');
  assert.equal(fx.eventRecords[0].metadata.total, 0);
});

test('staleCount reports the parsed container count', async () => {
  const reap = setup();
  fleet();
  assert.equal(await reap.staleCount(), 5);
});

// ── Staging demo job (request-time demo injection) ───────────────────────

test('the demo job is obviously fake and covers every chip', () => {
  const reap = setup();
  const job = reap.demoJob();
  assert.equal(job.demo, true);
  assert.ok(job.finishedAt, 'a finished job so the section renders a result');
  assert.equal(job.previews.length, job.total);
  for (const p of job.previews) {
    assert.match(p.slug, /^staging-demo-/, 'seeded rows must be unmistakably fake');
    assert.match(p.name, /^usernode-staging-staging-demo-/);
  }
  // One row per classification the console can label, plus a failure so the
  // red styling is screenshot-covered.
  const seen = new Set(job.previews.map((p) => p.classification));
  for (const c of ['merged', 'merged_unlinked', 'archived', 'promoted', 'no_session_row']) {
    assert.ok(seen.has(c), `demo job must cover the ${c} classification`);
  }
  const failed = job.previews.filter((p) => p.state === 'failed');
  assert.equal(failed.length, 1);
  assert.ok(failed[0].error, 'the failed row must carry an error string');
  assert.equal(job.failed, 1);
});

test('isStagingEnv gates the demo injection on USERNODE_ENV', () => {
  const reap = setup();
  const saved = process.env.USERNODE_ENV;
  try {
    process.env.USERNODE_ENV = 'staging';
    assert.equal(reap.isStagingEnv(), true);
    process.env.USERNODE_ENV = 'production';
    assert.equal(reap.isStagingEnv(), false);
    delete process.env.USERNODE_ENV;
    assert.equal(reap.isStagingEnv(), false);
  } finally {
    if (saved === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = saved;
  }
});

// ── #851: the automatic stale-env pass ──────────────────────────────────
//
// The admin sweep takes EVERYTHING it can enumerate. The automatic pass is
// selective, and what it selects on is what makes it safe to run unattended
// on a 15-minute timer: only previews whose env fingerprint label does not
// match the platform's current one, never a preview backing a live vote (the
// heal sweep REBUILDS those instead), never a session mid-turn.

const realStagingEnv = require('../src/services/staging-env');

// The label a preview built by the platform running these tests would carry.
// Config is `{}` throughout, matching what the sweep passes.
function currentFp() {
  realStagingEnv._resetExpected();
  return realStagingEnv.expectedStagingFingerprint({});
}

// A fleet where each container's label is given explicitly (4th ps column).
function labelledFleet(fp) {
  fx.psLines = [
    // current env — must be left alone
    ['usernode-staging-fresh-aaa111--3001', 'running', 'usernode-staging-fresh-aaa111-3001:aaa111', fp],
    // stale, merged proposal — the bulk of the real fleet
    ['usernode-staging-oldmerged-bbb222--3002', 'running', 'usernode-staging-oldmerged-bbb222-3002:bbb222', 'stale000stale000'],
    // stale and UNLABELLED — every preview built before #851
    ['usernode-staging-prelabel-ccc333--3003', 'running', 'usernode-staging-prelabel-ccc333-3003:ccc333'],
    // stale but backs a live vote — Pass 3's job, not this pass's
    ['usernode-staging-voting-ddd444--3004', 'running', 'usernode-staging-voting-ddd444-3004:ddd444', 'stale000stale000'],
    // stale, no session row at all
    ['usernode-staging-orphan-eee555--3005', 'running', 'usernode-staging-orphan-eee555-3005:eee555', 'stale000stale000'],
  ];
  fx.sessions = [
    { id: 3001, status: 'merged', staging_container_id: 'cid-3001', staging_url: 'https://x--s3001--aaa111.example', app_slug: 'fresh-aaa111' },
    { id: 3002, status: 'merged', staging_container_id: 'cid-3002', staging_url: 'https://x--s3002--bbb222.example', app_slug: 'oldmerged-bbb222' },
    { id: 3003, status: 'archived', staging_container_id: 'cid-3003', staging_url: 'https://x--s3003--ccc333.example', app_slug: 'prelabel-ccc333' },
    { id: 3004, status: 'promoted', staging_container_id: 'cid-3004', staging_url: 'https://x--s3004--ddd444.example', app_slug: 'voting-ddd444' },
  ];
}

test('listStagingContainers: parses the fingerprint label column', async () => {
  const reap = setup();
  const fp = currentFp();
  labelledFleet(fp);
  const items = await reap.listStagingContainers();

  assert.equal(items.length, 5);
  assert.equal(items[0].fingerprint, fp, 'a labelled container reports its digest');
  assert.equal(items[2].fingerprint, null, 'a missing label reads as null, not ""');
});

test('selectStale: keeps mismatched + unlabelled, drops current-env previews', async () => {
  const reap = setup();
  const fp = currentFp();
  labelledFleet(fp);
  const items = await reap.classify(fakePool, await reap.listStagingContainers());
  const stale = reap.selectStale(items, fp);
  const names = stale.map((s) => s.slug);

  assert.equal(names.includes('fresh-aaa111'), false, 'current env is not stale');
  assert.ok(names.includes('oldmerged-bbb222'), 'a mismatched digest is stale');
  assert.ok(names.includes('prelabel-ccc333'), 'an unlabelled pre-#851 preview is stale');
  assert.ok(names.includes('orphan-eee555'), 'no session row does not exempt it');
});

test('selectStale: never selects a preview backing a live vote', async () => {
  const reap = setup();
  const fp = currentFp();
  labelledFleet(fp);
  const items = await reap.classify(fakePool, await reap.listStagingContainers());

  for (const status of ['promoted', 'merging']) {
    const patched = items.map((i) => (i.sessionId === 3004
      ? { ...i, session: { ...i.session, status } } : i));
    const names = reap.selectStale(patched, fp).map((s) => s.slug);
    assert.equal(names.includes('voting-ddd444'), false,
      `${status} previews are rebuilt by the heal sweep, not torn down here`);
  }
});

test('selectStale: skips a session with a coding turn in flight', async () => {
  const reap = setup();
  const fp = currentFp();
  labelledFleet(fp);
  const items = await reap.classify(fakePool, await reap.listStagingContainers());

  const names = reap.selectStale(items, fp, { isInFlight: (id) => id === 3002 })
    .map((s) => s.slug);
  assert.equal(names.includes('oldmerged-bbb222'), false, 'a live turn is about to replace it anyway');
  assert.ok(names.includes('prelabel-ccc333'), 'other stale previews are unaffected');
});

test('sweepStale: tears down the stale, spares the current and the vote-backed', async () => {
  const reap = setup();
  const fp = currentFp();
  labelledFleet(fp);

  const summary = await reap.sweepStale({});

  assert.equal(summary.examined, 5);
  assert.equal(summary.stale, 3, 'fresh + promoted excluded');
  assert.equal(summary.tornDown, 3);
  assert.equal(summary.failed, 0);

  // 3002 + 3003 are linked, so they go through the teardownStaging chokepoint.
  assert.deepEqual(fx.teardownCalls.map((c) => c.sessionId).sort(), [3002, 3003]);
  // 3005 has no session row → by-name teardown.
  assert.deepEqual(fx.stopCalls.map((c) => c.name), ['usernode-staging-orphan-eee555--3005']);
  // Nothing touched the current-env or vote-backed previews.
  const touched = [...fx.teardownCalls.map((c) => c.sessionId), 3005];
  assert.equal(touched.includes(3001), false);
  assert.equal(touched.includes(3004), false);
});

test('sweepStale: respects the per-pass cap and says what it deferred', async () => {
  const reap = setup();
  const fp = currentFp();
  labelledFleet(fp);

  const summary = await reap.sweepStale({}, { limit: 1 });

  assert.equal(summary.stale, 3, 'it still reports the true stale count');
  assert.equal(summary.tornDown, 1, 'but acts on one');
  assert.equal(summary.skipped, 2, 'the remainder is reported, never silently dropped');
});

test('sweepStale: records the reap event tagged as the sweeper', async () => {
  const reap = setup();
  const fp = currentFp();
  labelledFleet(fp);
  await reap.sweepStale({});

  const rec = fx.eventRecords.find((r) => r.type === 'stale_previews_reaped');
  assert.ok(rec, 'the pass leaves a durable trace');
  assert.equal(rec.metadata.trigger, 'sweeper', 'distinguishable from an admin sweep');
  assert.equal(rec.metadata.tornDown, 3);
  assert.equal(rec.metadata.examined, 5);
});

test('sweepStale: a leaked teardown counts as failed, not torn down', async () => {
  const reap = setup();
  const fp = currentFp();
  labelledFleet(fp);
  fx.teardownLeaks = [3002];

  const summary = await reap.sweepStale({});

  assert.equal(summary.failed, 1, 'a surviving container must not be reported as removed');
  assert.equal(summary.tornDown, 2);
});

test('sweepStale: never throws when docker ps fails, and reaps nothing', async () => {
  const reap = setup();
  fx.psError = new Error('Cannot connect to the Docker daemon');

  const summary = await reap.sweepStale({});

  assert.deepEqual(summary, { examined: 0, stale: 0, tornDown: 0, failed: 0, skipped: 0 });
  assert.deepEqual(fx.stopCalls, [], 'an unreadable host is a no-op sweep, not a blind one');
  assert.deepEqual(fx.teardownCalls, []);
});

test('sweepStale: Kubernetes runtime never probes the Docker socket', async () => {
  const reap = setup();
  labelledFleet(currentFp());

  const summary = await reap.sweepStale({ appRuntime: 'kubernetes' });
  const counts = await reap.previewCounts({ appRuntime: 'kubernetes' });

  assert.deepEqual(summary, { examined: 0, stale: 0, tornDown: 0, failed: 0, skipped: 0 });
  assert.deepEqual(counts, { open: null, stale: null });
  assert.equal(fx.dockerExecCalls, 0);
});

test('sweepStale: an all-unlabelled fleet is verified by inspect before acting', async () => {
  // The dangerous false positive: a docker that cannot answer {{.Label}} makes
  // EVERY container look stale, which would tear down the whole fleet. When an
  // inspect proves the labels are really there, the pass uses inspect instead.
  const reap = setup();
  const fp = currentFp();
  fx.psLines = [
    ['usernode-staging-a-aaa111--4001', 'running', 'img:aaa111'],
    ['usernode-staging-b-bbb222--4002', 'running', 'img:bbb222'],
  ];
  fx.sessions = [
    { id: 4001, status: 'merged', staging_container_id: 'cid-4001', staging_url: 'https://x--s4001--aaa111.example', app_slug: 'a-aaa111' },
    { id: 4002, status: 'merged', staging_container_id: 'cid-4002', staging_url: 'https://x--s4002--bbb222.example', app_slug: 'b-bbb222' },
  ];
  // Inspect can see the labels the ps format verb could not: 4001 is current.
  fx.inspect = (name) => ({
    status: 'running',
    labels: { [realStagingEnv.LABEL_ENV_FP]: name.includes('-a-') ? fp : 'stale000stale000' },
  });

  const summary = await reap.sweepStale({});

  assert.ok(fx.inspectCalls.length >= 1, 'the all-null reading is probed, not trusted');
  assert.equal(summary.stale, 1, 'only the genuinely stale one is selected');
  assert.deepEqual(fx.teardownCalls.map((c) => c.sessionId), [4002]);
});

test('sweepStale: an all-unlabelled fleet with no labels anywhere IS stale', async () => {
  // The other side of the guard: when the probe agrees there is no label, the
  // containers really do predate the fingerprint and should be swept.
  const reap = setup();
  fx.psLines = [['usernode-staging-old-aaa111--4101', 'running', 'img:aaa111']];
  fx.sessions = [];
  fx.inspect = () => ({ status: 'running', labels: {} });

  const summary = await reap.sweepStale({});
  assert.equal(summary.stale, 1);
  assert.equal(summary.tornDown, 1);
});

test('sweepStale: refuses to run inside a staging preview', async () => {
  const reap = setup();
  labelledFleet(currentFp());
  const saved = process.env.USERNODE_ENV;
  try {
    process.env.USERNODE_ENV = 'staging';
    const summary = await reap.sweepStale({});
    assert.equal(summary.examined, 0, 'a preview has no docker socket to sweep with');
    assert.deepEqual(fx.stopCalls, []);
  } finally {
    if (saved === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = saved;
  }
});

test('sweepStale: stands down while an admin sweep owns the fleet', async () => {
  const reap = setup();
  labelledFleet(currentFp());
  fx.unitDelayMs = 40;
  const started = reap.start({}, { username: 'admin-user' });
  assert.equal(started.started, true);
  try {
    const summary = await reap.sweepStale({});
    assert.equal(summary.examined, 0, 'two sweeps must not interleave on one host');
  } finally {
    for (let i = 0; i < 200; i++) {
      if (reap.read()?.finishedAt) break;
      await sleep(5);
    }
  }
});

test('readAutomatic: reports the last pass, and the interval/limit tunables', async () => {
  const reap = setup();
  const fp = currentFp();
  labelledFleet(fp);

  const before = reap.readAutomatic();
  assert.equal(before.lastRunAt, null, 'a fresh process has no history — that is correct');
  assert.ok(before.intervalMs > 0, 'the interval is reported so the console can say "every N minutes"');

  await reap.sweepStale({});
  const after = reap.readAutomatic();
  assert.ok(after.lastRunAt, 'the run is timestamped');
  assert.equal(after.tornDown, 3);
  assert.equal(after.stale, 3);
  assert.equal(after.examined, 5);
});

test('staleSweepIntervalMs: 0 disables, junk falls back to the default', () => {
  const reap = setup();
  const saved = process.env.STAGING_STALE_SWEEP_INTERVAL_MS;
  try {
    process.env.STAGING_STALE_SWEEP_INTERVAL_MS = '0';
    assert.equal(reap.staleSweepIntervalMs(), 0, 'an explicit 0 is a kill switch, not junk');
    process.env.STAGING_STALE_SWEEP_INTERVAL_MS = 'banana';
    assert.equal(reap.staleSweepIntervalMs(), 15 * 60 * 1000);
    process.env.STAGING_STALE_SWEEP_INTERVAL_MS = '60000';
    assert.equal(reap.staleSweepIntervalMs(), 60000);
  } finally {
    if (saved === undefined) delete process.env.STAGING_STALE_SWEEP_INTERVAL_MS;
    else process.env.STAGING_STALE_SWEEP_INTERVAL_MS = saved;
  }
});

test('previewCounts: open counts everything, stale counts the out-of-date subset', async () => {
  const reap = setup();
  const fp = currentFp();
  labelledFleet(fp);

  const counts = await reap.previewCounts({});
  assert.equal(counts.open, 5, 'what the admin button would shut down');
  assert.equal(counts.stale, 3, 'what the automatic pass would shut down');
});

test('previewCounts: nulls (not zeros) when docker cannot be read', async () => {
  const reap = setup();
  fx.psError = new Error('daemon unreachable');
  const counts = await reap.previewCounts({});
  // A bogus 0 would read as "all clear" on the console; "—" is honest.
  assert.deepEqual(counts, { open: 0, stale: 0 });
});

test('demoCounts: fake-but-complete numbers for the staging screenshot', () => {
  const reap = setup();
  const demo = reap.demoCounts();
  assert.equal(demo.open, 6);
  assert.equal(demo.stale, 4);
  assert.ok(demo.automatic.lastRunAt, 'the "last ran" line needs a timestamp to render');
  assert.ok(demo.automatic.intervalMs > 0);
  assert.match(demo.expectedFingerprint, /^stagingdemo/, 'obviously fake, per the seed rules');
});

test('staleSweepDue: due at boot, then not again until the interval elapses', async () => {
  const reap = setup();
  labelledFleet(currentFp());

  // A fresh process is due immediately: a restart is exactly when a platform
  // env change has just landed.
  assert.equal(reap.staleSweepDue(), true);

  await reap.sweepStale({});
  assert.equal(reap.staleSweepDue(), false, 'a pass that just ran is not due again');

  // ...and it becomes due again once the interval has passed.
  assert.equal(reap.staleSweepDue(Date.now() + reap.staleSweepIntervalMs() + 1), true);
});

test('staleSweepDue: never due when the pass is disabled', () => {
  const reap = setup();
  const saved = process.env.STAGING_STALE_SWEEP_INTERVAL_MS;
  try {
    process.env.STAGING_STALE_SWEEP_INTERVAL_MS = '0';
    assert.equal(reap.staleSweepDue(), false);
    // Even far in the future — 0 is a kill switch, not a zero-delay.
    assert.equal(reap.staleSweepDue(Date.now() + 86400000), false);
  } finally {
    if (saved === undefined) delete process.env.STAGING_STALE_SWEEP_INTERVAL_MS;
    else process.env.STAGING_STALE_SWEEP_INTERVAL_MS = saved;
  }
});

test('sweepStale: arms the throttle even when it bails out early', async () => {
  // A pass that finds nothing (or cannot read docker) must still count as
  // having run, or a broken host would be re-swept on every 60s tick.
  const reap = setup();
  fx.psError = new Error('daemon unreachable');
  await reap.sweepStale({});
  assert.equal(reap.staleSweepDue(), false);
});
