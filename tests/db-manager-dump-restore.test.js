const test = require('node:test');
const assert = require('node:assert/strict');

const dbManager = require('../src/services/db-manager');

test('pg_restore receives an explicit destination database', () => {
  assert.deepEqual(
    dbManager.pgRestoreArgs('app_lunch_picker_staging_s1_161e47'),
    [
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
      '--dbname',
      'app_lunch_picker_staging_s1_161e47',
    ]
  );
});

test('pg_restore destination rejects unsafe database names', () => {
  assert.throws(
    () => dbManager.pgRestoreArgs('app_lunch_picker; DROP DATABASE postgres'),
    /unsafe database name/
  );
});
