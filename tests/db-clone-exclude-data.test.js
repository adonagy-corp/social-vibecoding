// Tests for the staging clone's dump-exclusion pass (src/services/db-manager.js
// privateDataExclusions + dumpRestore's --exclude-table-data flags).
//
// Why this exists: cloneDatabase used to dump and restore every row of the
// source, then TRUNCATE the `staging:private` tables. For the self-app that
// meant copying ~9.4 GB — 99.3% of the database — purely to delete it, which
// measured as ~4m35s of every single proposal-checks run in production
// (sessions 2951/2955, 2026-08-03). The fix skips those tables' data at
// pg_dump time.
//
// The load-bearing subtlety, and the reason for the FK-closure test below:
// truncatePrivateTables runs `TRUNCATE … CASCADE`, so it also empties every
// table holding a foreign key INTO a private table, transitively. Production
// has three such PUBLIC tables (pr_votes, pr_undo_votes,
// maintenance_campaign_apps — all FK chat_sessions, which is private).
// Excluding a parent's data without excluding the child's restores rows
// pointing at nothing; pg_restore reports FK violations, dumpRestore treats
// any "errors ignored on restore" tally as fatal, and EVERY staging build
// fails. So the closure is a correctness requirement, not an optimisation.
//
// The closure SQL and this exact failure mode were additionally verified by
// hand against a real Postgres 15 instance during development, using the
// production FK shape: excluding only the private tables produced FK errors
// on restore, adding the closure produced none, public rows survived, and
// the 'staging:private' COMMENTs survived so the scrub passes still find
// their targets.
//
// No real postgres here — child_process is stubbed at the same seam
// tests/db-manager-scrub.test.js uses.
//
// Run with: node --test tests/db-clone-exclude-data.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Loads db-manager with child_process stubbed. `discovery` is the canned
// psql -At output for the exclusion-discovery query (one qualified table name
// per line), or an Error to simulate a discovery failure. Records every
// PostgreSQL command the module issues so tests can assert on the networked
// dump/restore pipeline and on the ordering of the scrub passes.
function loadDbManager({ discovery = [], truncateDiscovery = [], columnDiscovery = [] } = {}) {
  const originalDbAdminUrl = process.env.DB_ADMIN_URL;
  process.env.DB_ADMIN_URL = 'postgres://usernode:test@db.example.test:5432/usernode';
  const ids = {
    childProcess: require.resolve('child_process'),
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/db-manager'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const calls = [];
  const fakeExecFile = (cmd, args, opts = {}) => {
    const dashC = args.indexOf('-c');
    const sql = dashC >= 0 ? args[dashC + 1] : '';
    calls.push({ cmd, args, sql, env: opts.env || {} });

    // The exclusion discovery: the only query with the recursive closure.
    if (/WITH RECURSIVE/.test(sql) && /obj_description/.test(sql)) {
      if (discovery instanceof Error) return Promise.reject(discovery);
      return Promise.resolve({ stdout: discovery.join('\n') + '\n', stderr: '' });
    }
    // truncatePrivateTables' table-level discovery.
    if (/obj_description/.test(sql) && /relkind/.test(sql)) {
      return Promise.resolve({ stdout: truncateDiscovery.join('\n') + '\n', stderr: '' });
    }
    // scrubPrivateColumns' column-level discovery.
    if (/col_description/.test(sql)) {
      return Promise.resolve({ stdout: columnDiscovery.join('\n') + '\n', stderr: '' });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  fakeExecFile[require('util').promisify.custom] = fakeExecFile;

  const fakeSpawn = (cmd, args, opts = {}) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    calls.push({ cmd, args, env: opts.env || {} });
    setImmediate(() => child.emit('close', 0, null));
    return child;
  };

  stub(ids.childProcess, { execFile: fakeExecFile, spawn: fakeSpawn });
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  delete require.cache[ids.subject];
  const dbManager = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    if (originalDbAdminUrl === undefined) delete process.env.DB_ADMIN_URL;
    else process.env.DB_ADMIN_URL = originalDbAdminUrl;
  };
  return { dbManager, calls, restore };
}

const spawned = (calls, command) => calls.find((c) => c.cmd === command);
const excludedFrom = (call) => (call?.args || [])
  .filter((arg) => arg.startsWith('--exclude-table-data='))
  .map((arg) => arg.slice('--exclude-table-data='.length));

// ── privateDataExclusions: discovery ───────────────────────────────────

test('privateDataExclusions closes over inbound foreign keys, not just staging:private', async () => {
  // The discovery SQL must ask postgres for the closure itself; assert the
  // recursive shape is present and walks confrelid → conrelid (the child
  // direction CASCADE takes), skipping self-references.
  const { dbManager, calls, restore } = loadDbManager({ discovery: ['public.chat_sessions'] });
  try {
    await dbManager.privateDataExclusions('app_demo');
    const sql = calls[0].sql;
    assert.match(sql, /WITH RECURSIVE/);
    assert.match(sql, /obj_description\(c\.oid, 'pg_class'\) = 'staging:private'/);
    assert.match(sql, /con\.contype = 'f'/);
    assert.match(sql, /JOIN closure cl ON cl\.oid = con\.confrelid/);
    assert.match(sql, /con\.conrelid <> con\.confrelid/);
  } finally { restore(); }
});

test('privateDataExclusions returns the parsed, trimmed table list', async () => {
  const { dbManager, restore } = loadDbManager({
    discovery: ['public.chat_sessions', '  public.pr_votes  ', '', 'public.session_visuals'],
  });
  try {
    assert.deepEqual(await dbManager.privateDataExclusions('app_demo'), [
      'public.chat_sessions', 'public.pr_votes', 'public.session_visuals',
    ]);
  } finally { restore(); }
});

test('privateDataExclusions drops a non-standard identifier instead of splicing it', async () => {
  // Dropping it is safe — the table's data is still dumped AND the truncate
  // pass still empties it, so we lose the speedup for that one table and
  // nothing else. Passing it to pg_dump would not be safe.
  const { dbManager, restore } = loadDbManager({
    discovery: [
      'public.chat_sessions',
      'public.evil"; rm -rf /',   // shell metacharacters
      'unqualified_name',         // no schema separator
      'x.y.z',                    // over-qualified
      'public.has space',         // whitespace
    ],
  });
  try {
    assert.deepEqual(await dbManager.privateDataExclusions('app_demo'), ['public.chat_sessions']);
  } finally { restore(); }
});

test('privateDataExclusions refuses an unsafe source db name', async () => {
  const { dbManager, restore } = loadDbManager();
  try {
    await assert.rejects(() => dbManager.privateDataExclusions('bad name; drop'), /unsafe identifier/);
  } finally { restore(); }
});

test('a discovery failure aborts rather than guessing', async () => {
  // Not knowing what is private means we cannot know what is safe to skip.
  const { dbManager, restore } = loadDbManager({ discovery: new Error('connection refused') });
  try {
    await assert.rejects(
      () => dbManager.privateDataExclusions('app_demo'),
      /Failed to discover staging:private tables in app_demo/
    );
  } finally { restore(); }
});

// ── FK-CLOSURE REGRESSION: the production shape ────────────────────────

test('REGRESSION: pr_votes lands in the exclusion set alongside private chat_sessions', async () => {
  // This is the case that would take production's staging builds down if the
  // closure were dropped from the discovery query. pr_votes is a PUBLIC table
  // (no staging:private comment) that FKs the private chat_sessions, so
  // TRUNCATE … CASCADE empties it today and the dump must skip it too.
  // Verified against production 2026-08-03: the closure over the real schema
  // returns 42 tables — 39 staging:private plus exactly pr_votes,
  // pr_undo_votes and maintenance_campaign_apps.
  const productionClosure = [
    'public.chat_sessions',              // staging:private
    'public.session_visuals',            // staging:private
    'public.vrf_obligations',            // staging:private
    'public.maintenance_campaign_apps',  // PUBLIC, FK → chat_sessions
    'public.pr_undo_votes',              // PUBLIC, FK → chat_sessions
    'public.pr_votes',                   // PUBLIC, FK → chat_sessions
  ];
  const { dbManager, calls, restore } = loadDbManager({ discovery: productionClosure });
  try {
    const resolved = await dbManager.privateDataExclusions('app_usernode_2d5619');
    for (const t of ['public.pr_votes', 'public.pr_undo_votes', 'public.maintenance_campaign_apps']) {
      assert.ok(resolved.includes(t), `${t} must be excluded — CASCADE empties it anyway`);
    }
    // And the query must be the one that can actually find them: a
    // private-tables-only discovery would silently reintroduce the failure.
    assert.match(calls[0].sql, /UNION\s+SELECT con\.conrelid/);
  } finally { restore(); }
});

// ── dumpRestore: the generated pg_dump pipeline ────────────────────────

test('cloneDatabase passes one --exclude-table-data per discovered table and no others', async () => {
  const discovery = ['public.chat_sessions', 'public.pr_votes', 'public.session_visuals'];
  const { dbManager, calls, restore } = loadDbManager({ discovery });
  try {
    await dbManager.cloneDatabase('app_demo', 'app_demo_staging_x_abc123');
    const dump = spawned(calls, 'pg_dump');
    const restoreCall = spawned(calls, 'pg_restore');
    assert.deepEqual(excludedFrom(dump), discovery);
    // Shape of the pipeline is otherwise untouched: custom format streamed
    // directly into pg_restore, with both child exit codes checked by the
    // implementation so a dump failure cannot be masked.
    assert.ok(dump.args.includes('-Fc'));
    assert.equal(dump.env.PGDATABASE, 'app_demo');
    assert.deepEqual(restoreCall.args, [
      '--exit-on-error', '--no-owner', '--no-privileges',
      '--dbname', 'app_demo_staging_x_abc123',
    ]);
    assert.equal(restoreCall.env.PGDATABASE, 'app_demo_staging_x_abc123');
    // COMMENTs must survive — the scrub passes discover their targets from
    // them, so --no-comments would silently disable redaction.
    assert.ok(!dump.args.includes('--no-comments'), 'comments must be kept in the dump');
  } finally { restore(); }
});

test('the dump is unfiltered when nothing is marked private', async () => {
  const { dbManager, calls, restore } = loadDbManager({ discovery: [] });
  try {
    await dbManager.cloneDatabase('app_demo', 'app_demo_staging_x_abc123');
    const dump = spawned(calls, 'pg_dump');
    assert.deepEqual(excludedFrom(dump), []);
    assert.ok(dump.args.includes('-Fc'));
    assert.equal(dump.env.PGDATABASE, 'app_demo');
  } finally { restore(); }
});

test('the exclusion set is discovered from the SOURCE, before the clone has data', async () => {
  const { dbManager, calls, restore } = loadDbManager({ discovery: ['public.chat_sessions'] });
  try {
    await dbManager.cloneDatabase('app_demo', 'app_demo_staging_x_abc123');
    const discoveryCall = calls.find((c) => /WITH RECURSIVE/.test(c.sql));
    assert.ok(discoveryCall, 'discovery ran');
    // PGDATABASE=<source>: the clone is still empty at this point, so asking
    // it what is private would return nothing and skip nothing.
    assert.equal(discoveryCall.env.PGDATABASE, 'app_demo');
    const discoveryAt = calls.indexOf(discoveryCall);
    const dumpAt = calls.findIndex((c) => c.cmd === 'pg_dump');
    assert.ok(discoveryAt < dumpAt, 'discovery precedes the dump');
  } finally { restore(); }
});

// ── the scrub passes stay as the backstop ──────────────────────────────

test('truncate + scrub still run after the copy, and still reset identities', async () => {
  // They are near-instant on now-empty tables, but they remain the redaction
  // guarantee if discovery and the dump ever disagree — and
  // TRUNCATE … RESTART IDENTITY is what resets sequences, which
  // --exclude-table-data does NOT do (it leaves them at prod positions).
  const { dbManager, calls, restore } = loadDbManager({
    discovery: ['public.chat_sessions'],
    truncateDiscovery: ['public.chat_sessions'],
    columnDiscovery: ['public.users|password_hash|f|'],
  });
  try {
    await dbManager.cloneDatabase('app_demo', 'app_demo_staging_x_abc123');
    const truncate = calls.find((c) => /^TRUNCATE/.test(c.sql));
    assert.ok(truncate, 'the truncate backstop still runs');
    assert.equal(truncate.sql, 'TRUNCATE public.chat_sessions RESTART IDENTITY CASCADE');
    assert.ok(calls.some((c) => /^UPDATE public\.users SET password_hash/.test(c.sql)),
      'the column scrub still runs');
    const dumpAt = calls.findIndex((c) => c.cmd === 'pg_dump');
    assert.ok(dumpAt < calls.indexOf(truncate), 'the copy precedes the scrub passes');
  } finally { restore(); }
});
