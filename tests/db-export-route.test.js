// Platform database export — the HTTP surface (src/routes/admin.js).
//
// The endpoint hands an admin a complete, unredacted copy of the platform
// database: every bcrypt hash, every live session token, every app
// credential. So what is pinned here is the gate and the paper trail, not
// the payload:
//
//   - GET  /api/admin/db-export/status   any admin (a capability probe)
//   - GET  /api/admin/db-export/history  any admin (append-only record)
//   - POST /api/admin/db-export/ticket   FULL admin + typed confirm +
//                                        password re-entry
//   - GET  /api/admin/db-export          FULL admin + a single-use ticket
//
// Harness mirrors tests/admin-submitted-features.test.js: getPool() is
// swapped before the route module loads, the router is mounted on a
// throwaway app, and `req.user` is varied per test. dbExport.runExport is
// stubbed so no docker (and no database) is ever touched — the streaming
// behaviour itself is covered by tests/db-export-service.test.js.
//
// Run with: node --test tests/db-export-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4); // low cost: this is a test

// Every INSERT/UPDATE the routes issue against db_exports lands here, so
// the assertions can read the audit trail the way an auditor would.
const audit = [];
let nextAuditId = 1;
const events = [];

const poolMod = require('../src/db/pool');
const mockPool = {
  async query(sql, params = []) {
    const s = String(sql);
    if (/INSERT INTO db_exports/.test(s)) {
      const row = {
        id: nextAuditId++, user_id: params[0], username: params[1], db_name: params[2],
        status: params[3], denied_reason: params[4], ip: params[5], user_agent: params[6],
        bytes_sent: 0, requested_at: '2026-07-27T00:00:00.000Z',
        started_at: null, finished_at: null, error: null,
      };
      audit.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (/UPDATE db_exports/.test(s)) {
      const row = audit.find((r) => r.id === params[0]);
      if (row) {
        row.status = params[1] ?? row.status;
        if (params.length > 2) { row.bytes_sent = params[2]; row.error = params[3]; }
        row.finished_at = '2026-07-27T00:01:00.000Z';
      }
      return { rows: [] };
    }
    if (/COUNT\(\*\)::int AS n FROM db_exports/.test(s)) {
      const n = audit.filter((r) => r.user_id === params[0] && r.status !== 'denied').length;
      return { rows: [{ n }] };
    }
    if (/COUNT\(\*\)::int AS total FROM db_exports/.test(s)) {
      return { rows: [{ total: audit.length }] };
    }
    if (/FROM db_exports/.test(s)) {
      const m = s.match(/LIMIT\s+(\d+)\s+OFFSET\s+(\d+)/);
      const limit = m ? parseInt(m[1], 10) : 25;
      const offset = m ? parseInt(m[2], 10) : 0;
      const rows = audit.slice().reverse().slice(offset, offset + limit);
      return { rows, _limit: limit, rowCount: rows.length };
    }
    if (/pg_database_size/.test(s)) return { rows: [{ size: '188743680' }] };
    if (/SELECT password FROM users/.test(s)) return { rows: [{ password: PASSWORD_HASH }] };
    if (/INSERT INTO events/.test(s)) { events.push(params); return { rows: [] }; }
    throw new Error(`unhandled mock SQL: ${s.slice(0, 80)}`);
  },
};
poolMod.getPool = () => mockPool;

const dbExport = require('../src/services/db-export');
const { adminRoutes } = require('../src/routes/admin');
const express = require('express');

const NORMAL = { id: 9, username: 'norm', isAdmin: false, canAdminWrite: false };
const VIEW_ADMIN = { id: 8, username: 'view', isAdmin: true, canAdminWrite: false, adminReadonly: true };
const FULL_ADMIN = { id: 1, username: 'snait', isAdmin: true, canAdminWrite: true };
// dbExportLimiter allows 3 successful tickets per user per 24h and its
// window is process-wide, so every test that needs a REAL ticket takes a
// distinct admin identity. (The limit itself is covered by
// tests/db-export-limits.test.js.)
let _nextAdminId = 100;
const freshAdmin = () => ({ id: _nextAdminId++, username: `admin${_nextAdminId}`, isAdmin: true, canAdminWrite: true });

const CONFIG = { jwtSecret: 'test', databaseUrl: 'postgresql://u:p@usernode-db:5432/usernode' };

let currentUser = FULL_ADMIN;
let server;
let base;
let realRunExport;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (currentUser) req.user = currentUser; next(); });
  app.use(adminRoutes(CONFIG));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // Never let a test spawn networked `pg_dump`.
  realRunExport = dbExport.runExport;
  dbExport.runExport = async ({ res, filename, onStart }) => {
    if (typeof onStart === 'function') onStart();
    res.setHeader('Content-Type', dbExport.EXPORT_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(require('node:zlib').gzipSync('-- fake SQL dump\n'));
    return { status: 'completed', bytesSent: 10, rawBytes: 17, error: null, headersSent: true };
  };
});

test.after(() => {
  if (realRunExport) dbExport.runExport = realRunExport;
  if (server) server.close();
});

function reset(user = FULL_ADMIN) {
  currentUser = user;
  audit.length = 0;
  events.length = 0;
  dbExport._resetTickets();
  dbExport.endExport();
  delete process.env.USERNODE_ENV;
}

const req = (path, init) => fetch(`${base}${path}`, { redirect: 'manual', ...init });
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

function ticket(body = { confirm: 'EXPORT', password: PASSWORD }) {
  return req('/api/admin/db-export/ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json);
}

// ─── The capability probe ─────────────────────────────────────────

test('status is readable by any admin and reports a ready target', async () => {
  reset();
  const { status, body } = await json(await req('/api/admin/db-export/status'));
  assert.equal(status, 200);
  assert.equal(body.available, true);
  assert.equal(body.reason, 'ok');
  assert.equal(body.dbName, 'usernode');
  assert.equal(body.dbSizeBytes, 188743680);
  assert.equal(body.maxPerDay, 3);
  assert.equal(body.canWrite, true);
});

test('a view-only admin can read the probe but is told they cannot write', async () => {
  reset(VIEW_ADMIN);
  const { status, body } = await json(await req('/api/admin/db-export/status'));
  assert.equal(status, 200);
  assert.equal(body.canWrite, false);
});

test('the probe carries a machine-readable reason so the client needs no env check', async () => {
  // This indirection is what keeps frontend/src/features/admin/admin-console.js free of any
  // USERNODE_ENV literal (pinned by tests/admin-console-page.test.js).
  reset();
  process.env.USERNODE_ENV = 'staging';
  const { body } = await json(await req('/api/admin/db-export/status'));
  assert.equal(body.available, false);
  assert.equal(body.reason, 'staging');
  delete process.env.USERNODE_ENV;
});

test('an in-flight export closes the door in the probe', async () => {
  reset();
  dbExport.beginExport({ userId: 99, username: 'someone' });
  const { body } = await json(await req('/api/admin/db-export/status'));
  assert.equal(body.available, false);
  assert.equal(body.reason, 'in_progress');
  assert.equal(body.inProgress, true);
  dbExport.endExport();
});

test('non-admins never reach the probe', async () => {
  reset(NORMAL);
  const res = await req('/api/admin/db-export/status');
  assert.ok(res.status >= 300 && res.status < 400, `expected a redirect away, got ${res.status}`);
});

// ─── The ticket: the actual authorization ─────────────────────────

test('a view-only admin is refused — and the attempt is on the record', async () => {
  reset(VIEW_ADMIN);
  const { status, body } = await ticket();
  assert.equal(status, 403);
  assert.match(body.error, /Full admin/);
  const denied = audit.find((r) => r.denied_reason === 'view_only');
  assert.ok(denied, 'the refused attempt is written to db_exports');
  assert.equal(denied.status, 'denied');
  assert.equal(denied.username, 'view');
});

test('the typed confirmation is required, exactly', async () => {
  reset();
  for (const confirm of [undefined, '', 'export', 'EXPORT ', 'yes']) {
    const { status, body } = await ticket({ confirm, password: PASSWORD });
    assert.equal(status, 400, `confirm=${JSON.stringify(confirm)} must be refused`);
    assert.equal(body.code, 'confirm_required');
  }
});

test('the password is required and must be the admin\'s own', async () => {
  reset();
  const missing = await ticket({ confirm: 'EXPORT' });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'password_required');

  const wrong = await ticket({ confirm: 'EXPORT', password: 'not my password' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 'bad_password');
  // The message must not distinguish "no such user" from "wrong password".
  assert.equal(wrong.body.error, 'Password verification failed.');
  const denied = audit.find((r) => r.denied_reason === 'bad_password');
  assert.ok(denied, 'a failed password attempt on a credential dump is audited');
});

test('staging is refused server-side, regardless of what the client believes', async () => {
  reset();
  process.env.USERNODE_ENV = 'staging';
  const { status, body } = await ticket();
  assert.equal(status, 403);
  assert.equal(body.code, 'staging');
  assert.ok(audit.some((r) => r.denied_reason === 'staging'));
  delete process.env.USERNODE_ENV;
});

test('a valid confirmation returns a single-use ticket URL and audits BEFORE issuing it', async () => {
  const me = freshAdmin();
  reset(me);
  const { status, body } = await ticket();
  assert.equal(status, 200);
  assert.match(body.token, /^[0-9a-f]{64}$/);
  assert.equal(body.url, `/api/admin/db-export?t=${body.token}`);
  assert.match(body.filename, /^usernode-platform-usernode-\d{8}T\d{6}Z\.sql\.gz$/);
  assert.equal(body.expiresInSeconds, 60);

  const row = audit.at(-1);
  assert.equal(row.status, 'requested', 'the row is committed before the ticket exists');
  assert.equal(row.db_name, 'usernode');
  assert.equal(row.username, me.username);
  assert.ok(row.ip, 'the requesting IP is recorded');
});

test('a second export is refused while one is in flight', async () => {
  const me = freshAdmin();
  reset(me);
  dbExport.beginExport({ userId: 99 });
  const { status, body } = await ticket();
  assert.equal(status, 409);
  assert.equal(body.code, 'in_progress');
  assert.ok(audit.some((r) => r.denied_reason === 'in_progress'));
  dbExport.endExport();
});

// ─── The download ─────────────────────────────────────────────────

test('the download requires a ticket — a bare GET is refused', async () => {
  reset();
  const { status, body } = await json(await req('/api/admin/db-export'));
  assert.equal(status, 403);
  assert.equal(body.code, 'ticket_invalid');
});

test('the download re-checks full admin — the ticket is not the authorization', async () => {
  const me = freshAdmin();
  reset(me);
  const { body } = await ticket();
  currentUser = VIEW_ADMIN;
  const res = await req(`/api/admin/db-export?t=${body.token}`);
  assert.equal(res.status, 403);
});

test('a ticket cannot be redeemed by a different admin', async () => {
  const me = freshAdmin();
  reset(me);
  const { body } = await ticket();
  currentUser = FULL_ADMIN;
  const stolen = await json(await req(`/api/admin/db-export?t=${body.token}`));
  assert.equal(stolen.status, 403);
  assert.equal(stolen.body.code, 'ticket_invalid');
});

test('a valid ticket streams the gzipped SQL as an attachment, once', async () => {
  const me = freshAdmin();
  reset(me);
  const { body } = await ticket();
  const res = await req(`/api/admin/db-export?t=${body.token}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/gzip');
  assert.match(res.headers.get('content-disposition'),
    /^attachment; filename="usernode-platform-.*\.sql\.gz"$/,
    'the browser saves it as .sql.gz');
  assert.equal(res.headers.get('content-encoding'), null,
    'Content-Encoding: gzip would make the browser silently unpack the file');
  await res.text();

  const row = audit.find((r) => r.status === 'completed');
  assert.ok(row, 'the audit row is closed out as completed');
  assert.equal(Number(row.bytes_sent), 10);
  assert.ok(events.some((p) => p.includes('db_exported')), 'a db_exported analytics event is emitted');

  // Replay of the same URL is dead on arrival.
  const replay = await json(await req(`/api/admin/db-export?t=${body.token}`));
  assert.equal(replay.status, 403);
  assert.equal(replay.body.code, 'ticket_invalid');
});

test('the single-flight guard is released after a download', async () => {
  const me = freshAdmin();
  reset(me);
  const { body } = await ticket();
  await (await req(`/api/admin/db-export?t=${body.token}`)).text();
  assert.equal(dbExport.isExportInProgress(), false, 'a finished export never wedges the guard');
});

// ─── The append-only history ──────────────────────────────────────

test('history is readable by any admin and clamps its page size', async () => {
  reset(VIEW_ADMIN);
  audit.push({ id: 900, username: 'someone', db_name: 'usernode', status: 'completed' });
  const { status, body } = await json(await req('/api/admin/db-export/history?limit=9999'));
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.exports));
  assert.ok(body.limit <= 200, `page size clamped, got ${body.limit}`);
  assert.equal(body.total, audit.length);
});

test('history offers no way to delete or edit a row', async () => {
  reset();
  for (const method of ['DELETE', 'PUT', 'PATCH']) {
    const res = await req('/api/admin/db-export/history', { method });
    assert.ok(res.status === 404 || res.status === 405,
      `${method} on the audit log must not be routed (got ${res.status})`);
  }
});
