// Regression test for the staging-clone scrub path (src/services/db-manager.js
// scrubPrivateColumns). Production incident: onchain_accounts.registration_code
// is NOT NULL UNIQUE, and the old code wrote the same literal
// '__staging_redacted__' constant into every row, so the second row's UPDATE
// violated the UNIQUE constraint and the whole staging clone failed closed.
//
// The fix derives a per-row-unique placeholder from ctid, sized to the
// column's max length. This test doesn't touch real docker/postgres — it
// stubs child_process (same seam/pattern as tests/docker-init-flag.test.js)
// and asserts the exact UPDATE SQL scrubPrivateColumns generates for a
// NOT NULL UNIQUE VARCHAR(64) column and for an unbounded TEXT column.
//
// The SQL itself (ctid-uniqueness, left()-truncation to fit) was additionally
// verified by hand against a real Postgres instance during development.
//
// Run with: node --test tests/db-manager-scrub.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// scrubPrivateColumns issues one discovery SELECT, then one UPDATE per
// discovered column. `discoveryRows` is the canned psql -At output (one
// line per column) for the discovery query.
function loadDbManager(discoveryRows) {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://usernode:test@db.example.test:5432/usernode';
  const ids = {
    childProcess: require.resolve('child_process'),
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/db-manager'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const updateCalls = [];
  const fakeExecFile = (cmd, args) => {
    const sql = args[args.indexOf('-c') + 1];
    if (/col_description/.test(sql)) {
      return Promise.resolve({ stdout: discoveryRows.join('\n') + '\n', stderr: '' });
    }
    if (/^UPDATE/.test(sql)) {
      updateCalls.push(sql);
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  fakeExecFile[require('util').promisify.custom] = fakeExecFile;

  stub(ids.childProcess, { execFile: fakeExecFile, spawn: () => { throw new Error('unused'); } });
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  delete require.cache[ids.subject];
  const dbManager = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  };
  return { dbManager, updateCalls, restore };
}

test('scrubPrivateColumns writes a per-row-unique, length-capped placeholder for a NOT NULL UNIQUE column', async () => {
  // Mirrors public.onchain_accounts.registration_code: VARCHAR(64) NOT NULL UNIQUE.
  const { dbManager, updateCalls, restore } = loadDbManager([
    'public.onchain_accounts|registration_code|t|64',
  ]);
  try {
    const result = await dbManager.scrubPrivateColumns('app_demo_staging_x_abc123');
    assert.equal(updateCalls.length, 1);
    assert.equal(
      updateCalls[0],
      "UPDATE public.onchain_accounts SET registration_code = left('__staging_redacted__' || ctid::text, 64)"
    );
    assert.deepEqual(result.scrubbed, ['public.onchain_accounts.registration_code']);
  } finally {
    restore();
  }
});

test('scrubPrivateColumns omits the length cap for an unbounded NOT NULL column', async () => {
  const { dbManager, updateCalls, restore } = loadDbManager([
    'public.some_table|some_col|t|',
  ]);
  try {
    await dbManager.scrubPrivateColumns('app_demo_staging_x_abc123');
    assert.equal(updateCalls.length, 1);
    assert.equal(
      updateCalls[0],
      "UPDATE public.some_table SET some_col = '__staging_redacted__' || ctid::text"
    );
  } finally {
    restore();
  }
});

test('scrubPrivateColumns still NULLs out nullable columns (no per-row placeholder needed)', async () => {
  const { dbManager, updateCalls, restore } = loadDbManager([
    'public.users|email_confirmation_token|f|255',
  ]);
  try {
    await dbManager.scrubPrivateColumns('app_demo_staging_x_abc123');
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0], 'UPDATE public.users SET email_confirmation_token = NULL');
  } finally {
    restore();
  }
});
