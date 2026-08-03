'use strict';

require('dotenv').config();

const { Client } = require('pg');
const { load: loadConfig } = require('../src/config');
const { migrate } = require('../src/db/migrate');
const { getPool } = require('../src/db/pool');

function databaseName(connectionString) {
  const name = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe database name in DATABASE_URL: ${JSON.stringify(name)}`);
  }
  return name;
}

async function ensureTargetDatabase(config) {
  const adminUrl = process.env.DB_ADMIN_URL;
  if (!adminUrl) throw new Error('DB_ADMIN_URL is required for the Kubernetes migration Job');

  const target = databaseName(config.databaseUrl);
  const client = new Client({ connectionString: adminUrl, application_name: 'social-vibecoding-migration' });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [target]);
    if (existing.rowCount === 0) {
      // PostgreSQL does not accept a bind parameter for an identifier. The
      // strict allow-list above makes this interpolation safe and predictable.
      await client.query(`CREATE DATABASE "${target}"`);
    }
  } finally {
    await client.end();
  }
}

async function main() {
  const config = loadConfig();
  const pool = getPool(config);
  try {
    await ensureTargetDatabase(config);
    await migrate(config);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[migration] failed', error);
    process.exitCode = 1;
  });
}

module.exports = { databaseName, ensureTargetDatabase, main };
