// Platform database export — service layer (src/services/db-export.js).
//
// This module is the part that can hurt: it spawns a process against the
// production database and streams unredacted bytes at a socket. The tests
// below pin the properties that keep that safe rather than the happy path
// alone:
//
//   - the child is invoked as ARGV, never through a shell, and the db name
//     is validated before it can reach that argv;
//   - it is spawn() (streaming) through an in-process gzip, so nothing
//     buffers the whole dump and nothing is piped through a shell;
//   - the download is a valid gzip member of plain SQL — it round-trips
//     through gunzip, and the trailer is never truncated;
//   - response headers are written on the FIRST BYTE, not up front, so a
//     child that dies immediately can still be answered with JSON;
//   - a client hang-up kills pg_dump instead of leaving a snapshot open;
//   - tickets are single-use, user-bound, and expire;
//   - the single-flight guard actually excludes a second export.
//
// spawn is injected via the `spawnFn` seam, so no docker is required.
//
// Run with: node --test tests/db-export-service.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, Readable } = require('node:stream');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

process.env.DATABASE_URL ||= 'postgres://usernode:test@db.example.test:5432/usernode';

const dbExport = require('../src/services/db-export');

// ── Fakes ────────────────────────────────────────────────────────────

// A stand-in for the ChildProcess returned by spawn(). Tests push stdout
// chunks and then close it with an exit code.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = (sig) => { child.killed = sig || 'SIGTERM'; return true; };
  child.emitOut = (buf) => child.stdout.emit('data', Buffer.from(buf));
  child.emitErr = (buf) => child.stderr.emit('data', Buffer.from(buf));
  child.exit = (code) => { child.exitCode = code; child.emit('close', code); };
  return child;
}

// A minimal express-ish response: records headers, status, JSON body, and
// the bytes written, and can pretend to apply backpressure.
function fakeRes({ backpressure = false } = {}) {
  const res = new EventEmitter();
  res.headers = {};
  res.statusCode = 200;
  res.body = null;
  res.chunks = [];
  res.ended = false;
  res.destroyed = false;
  res.headersSent = false;
  res.writableEnded = false;
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.headersSent = true; res.writableEnded = true; return res; };
  res.write = (chunk) => { res.chunks.push(Buffer.from(chunk)); res.headersSent = true; return !backpressure; };
  res.end = () => { res.ended = true; res.writableEnded = true; };
  res.destroy = () => { res.destroyed = true; };
  res.bytes = () => Buffer.concat(res.chunks).length;
  return res;
}

// ── Target resolution ────────────────────────────────────────────────

test('parseDbName pulls the database out of a postgres URL', () => {
  assert.equal(dbExport.parseDbName('postgresql://usernode:pw@usernode-db:5432/usernode'), 'usernode');
  assert.equal(dbExport.parseDbName('postgres://u:p@host/thedb?sslmode=require'), 'thedb');
});

test('parseDbName survives a password containing @', () => {
  // The LAST '@' separates credentials from the host — splitting on the
  // first would yield a nonsense host and a wrong database name.
  assert.equal(dbExport.parseDbName('postgresql://u:p@ss@usernode-db:5432/usernode'), 'usernode');
});

test('parseDbName returns null for junk rather than guessing', () => {
  for (const bad of [null, undefined, '', 'not a url', 'postgres://u:p@hostonly']) {
    assert.equal(dbExport.parseDbName(bad), null, `${bad} must not resolve`);
  }
});

test('resolveTargetDb refuses a database name that fails SAFE_IDENT', () => {
  // The name lands in an argv, not a shell string — but it is still
  // validated, so a mangled DATABASE_URL can never reach pg_dump.
  const t = dbExport.resolveTargetDb({ databaseUrl: 'postgres://u:p@h/bad;name' });
  assert.equal(t.dbName, null);
  assert.equal(t.reason, 'unsafe_db_name');
});

test('resolveTargetDb reports no_database_url when there is nothing to dump', () => {
  const t = dbExport.resolveTargetDb({});
  assert.equal(t.dbName, null);
  assert.equal(t.reason, 'no_database_url');
});

test('exportFilename is timestamped, .sql.gz, and filesystem-safe', () => {
  const name = dbExport.exportFilename('usernode', new Date('2026-07-27T12:13:14.567Z'));
  assert.equal(name, 'usernode-platform-usernode-20260727T121314Z.sql.gz');
  assert.ok(name.endsWith('.sql.gz'), 'the extension tells the admin it is gunzip + psql, not pg_restore');
  assert.ok(!/[/\\"']/.test(name), 'no quote or separator can break Content-Disposition');
});

// ── Single-flight guard ──────────────────────────────────────────────

test('only one export may run platform-wide', () => {
  dbExport.endExport();
  assert.equal(dbExport.isExportInProgress(), false);
  assert.equal(dbExport.beginExport({ userId: 1 }), true);
  assert.equal(dbExport.isExportInProgress(), true);
  assert.equal(dbExport.beginExport({ userId: 2 }), false, 'second export is refused');
  assert.equal(dbExport.currentExport().userId, 1);
  dbExport.endExport();
  assert.equal(dbExport.isExportInProgress(), false);
  assert.equal(dbExport.beginExport({ userId: 2 }), true, 'reusable after release');
  dbExport.endExport();
});

// ── Tickets ──────────────────────────────────────────────────────────

test('a ticket is single-use', () => {
  dbExport._resetTickets();
  const { token } = dbExport.issueTicket({ userId: 7, ip: '203.0.113.5', auditId: 42, dbName: 'usernode' });
  const first = dbExport.consumeTicket(token, 7);
  assert.equal(first.auditId, 42);
  assert.equal(dbExport.consumeTicket(token, 7), null, 'replay is refused');
});

test('a ticket is bound to the admin who was verified for it', () => {
  dbExport._resetTickets();
  const { token } = dbExport.issueTicket({ userId: 7, auditId: 1, dbName: 'usernode' });
  assert.equal(dbExport.consumeTicket(token, 8), null, 'another admin cannot redeem it');
  // …and the failed attempt must not burn it for the rightful owner.
  assert.ok(dbExport.consumeTicket(token, 7), 'owner can still redeem');
});

test('unknown and malformed tokens are refused', () => {
  dbExport._resetTickets();
  for (const bad of ['', null, undefined, 'deadbeef', 123]) {
    assert.equal(dbExport.consumeTicket(bad, 7), null);
  }
});

test('tokens are long random hex, and the TTL is short', () => {
  dbExport._resetTickets();
  const { token, expiresInSeconds } = dbExport.issueTicket({ userId: 7 });
  assert.match(token, /^[0-9a-f]{64}$/, '32 random bytes, hex-encoded');
  assert.equal(expiresInSeconds, 60);
  assert.ok(dbExport.TICKET_TTL_MS <= 5 * 60 * 1000, 'a download ticket must be short-lived');
  dbExport._resetTickets();
});

// ── The dump ─────────────────────────────────────────────────────────
//
// The bytes on the wire are gzip, produced by an in-process zlib stream
// between pg_dump's stdout and the response. zlib works on libuv's
// threadpool and only emits once its output buffer fills (or is flushed on
// end), so these tests `await settle()` after feeding the child rather
// than asserting synchronously, and use INCOMPRESSIBLE data whenever they
// need output to appear mid-stream — a megabyte of 'AAAA' compresses to
// nothing and would still be sitting in the compressor.

const settle = () => new Promise((r) => setTimeout(r, 50));

// Random bytes don't compress, so ~64 KB in forces ~64 KB out, which is
// past zlib's 16 KB chunk size — i.e. it reaches the socket immediately.
const incompressible = (n = 64 * 1024) => crypto.randomBytes(n);

test('pg_dump is invoked as argv — plain SQL, no shell anywhere', async () => {
  let seen = null;
  const child = fakeChild();
  const res = fakeRes();
  const p = dbExport.runExport({
    dbName: 'usernode', res, filename: 'x.sql.gz',
    spawnFn: (cmd, args, opts) => { seen = { cmd, args, opts }; return child; },
  });
  child.emitOut('-- PostgreSQL database dump\n');
  child.exit(0);
  await p;

  assert.equal(seen.cmd, 'pg_dump');
  assert.ok(Array.isArray(seen.args), 'args is an argv array, not a command string');
  assert.deepEqual(seen.args, [
    '-Fp', '--no-owner', '--no-privileges', '--no-password',
    ...dbExport.EXCLUDED_TABLE_DATA.map((table) => `--exclude-table-data=${table}`),
    'usernode',
  ]);
  assert.equal(seen.opts.env.PGDATABASE, 'usernode');
  assert.equal(seen.opts.env.PGHOST, 'db.example.test');
  assert.equal(seen.opts.env.PGPASSWORD, 'test');
  assert.ok(!seen.args.includes('-Fc'), 'the custom format is gone — this is plain SQL');
  // The gzip step is a Node stream, NOT a shell pipeline: nothing may be
  // spliced into a shell on a user-triggerable path.
  assert.ok(!seen.args.includes('-c'), 'never `sh -c`');
  assert.ok(!seen.args.some((a) => a === 'sh' || a === 'bash'));
  assert.ok(!seen.args.some((a) => typeof a === 'string' && a.includes('|')), 'no pipe character anywhere');
  assert.ok(!seen.args.includes('gzip'), 'compression is in-process, not a piped binary');
  assert.notEqual(seen.opts && seen.opts.shell, true, 'shell option must never be set');
});

test('an unsafe db name is refused before anything is spawned', async () => {
  let spawned = false;
  const res = fakeRes();
  const out = await dbExport.runExport({
    dbName: 'usernode; rm -rf /', res, filename: 'x.sql.gz',
    spawnFn: () => { spawned = true; return fakeChild(); },
  });
  assert.equal(spawned, false, 'nothing may be spawned for an invalid identifier');
  assert.equal(out.status, 'failed');
});

test('a successful export is a valid gzip of the SQL, and the count is what went on the wire', async () => {
  const sql = '-- PostgreSQL database dump\nCREATE TABLE users (id int);\n';
  const child = fakeChild();
  const res = fakeRes();
  const p = dbExport.runExport({ dbName: 'usernode', res, filename: 'dump.sql.gz', spawnFn: () => child });
  child.emitOut(sql.slice(0, 20));
  child.emitOut(sql.slice(20));
  child.exit(0);
  const out = await p;

  assert.equal(out.status, 'completed');
  assert.ok(res.ended, 'the response is ended cleanly');
  const body = Buffer.concat(res.chunks);
  assert.equal(body[0], 0x1f, 'gzip magic byte 1');
  assert.equal(body[1], 0x8b, 'gzip magic byte 2');
  assert.equal(zlib.gunzipSync(body).toString('utf8'), sql, 'it round-trips to the exact SQL');
  assert.equal(out.rawBytes, sql.length, 'rawBytes is the uncompressed SQL');
  assert.equal(out.bytesSent, body.length, 'bytesSent is the COMPRESSED size the browser downloaded');
  assert.equal(res.bytes(), body.length, 'the bytes reached the socket, not a buffer');
});

test('the gzip trailer is never truncated by ending the socket at pg_dump exit', async () => {
  // A `.gz` is only valid once zlib has flushed its final block, so the
  // response must be ended by the compressor, not by the child's exit.
  const child = fakeChild();
  const res = fakeRes();
  const p = dbExport.runExport({ dbName: 'usernode', res, filename: 'd.sql.gz', spawnFn: () => child });
  child.emitOut(incompressible());
  await settle();
  assert.ok(res.bytes() > 0, 'bytes are already streaming before the child exits');
  assert.ok(!res.ended, 'not ended yet — the compressor still holds the trailer');
  child.exit(0);
  await p;
  assert.doesNotThrow(() => zlib.gunzipSync(Buffer.concat(res.chunks)),
    'the completed download is a complete gzip member');
});

test('an empty database still yields a valid, downloadable .gz', async () => {
  const child = fakeChild();
  const res = fakeRes();
  const p = dbExport.runExport({ dbName: 'usernode', res, filename: 'd.sql.gz', spawnFn: () => child });
  child.exit(0);
  const out = await p;
  assert.equal(out.status, 'completed');
  assert.equal(res.headers['content-type'], 'application/gzip');
  assert.equal(zlib.gunzipSync(Buffer.concat(res.chunks)).length, 0);
});

test('download headers are set on the first byte, and no Content-Length is claimed', async () => {
  const child = fakeChild();
  const res = fakeRes();
  const p = dbExport.runExport({ dbName: 'usernode', res, filename: 'dump.sql.gz', spawnFn: () => child });
  assert.equal(Object.keys(res.headers).length, 0, 'nothing committed before the first byte');
  child.emitOut(incompressible());
  await settle();
  assert.equal(res.headers['content-type'], 'application/gzip');
  assert.equal(res.headers['content-disposition'], 'attachment; filename="dump.sql.gz"');
  assert.equal(res.headers['cache-control'], 'no-store', 'a credential dump is never cached');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(!('content-length' in res.headers), 'the size is unknown up front — chunked');
  assert.ok(!('content-encoding' in res.headers),
    'gzip is the file, not a transfer encoding — the browser must not unpack it');
  child.exit(0);
  await p;
});

test('onStart fires once, when the stream actually begins', async () => {
  const child = fakeChild();
  const res = fakeRes();
  let starts = 0;
  const p = dbExport.runExport({
    dbName: 'usernode', res, filename: 'd.sql.gz', onStart: () => { starts++; }, spawnFn: () => child,
  });
  assert.equal(starts, 0);
  child.emitOut(incompressible());
  child.emitOut(incompressible());
  await settle();
  assert.equal(starts, 1, 'marked streaming exactly once');
  child.exit(0);
  await p;
  assert.equal(starts, 1, 'and not again at the flush');
});

test('a child that dies before the first byte still yields a JSON error', async () => {
  const child = fakeChild();
  const res = fakeRes();
  const p = dbExport.runExport({ dbName: 'usernode', res, filename: 'd.sql.gz', spawnFn: () => child });
  child.emitErr('pg_dump: error: connection to server failed');
  child.exit(1);
  const out = await p;

  assert.equal(out.status, 'failed');
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, 'export_failed');
  assert.ok(!res.destroyed, 'no need to destroy — nothing was on the wire');
  assert.match(out.error, /pg_dump exited 1/);
});

test('the response is committed on pg_dump\'s first byte, gzip header and all', async () => {
  // zlib emits its 10-byte gzip header as soon as anything is written, so
  // the "headers on the first byte" contract is unchanged by compression:
  // a failure after that point cannot be answered with a status code, and
  // the socket is destroyed instead of quietly truncating the file.
  const child = fakeChild();
  const res = fakeRes();
  const p = dbExport.runExport({ dbName: 'usernode', res, filename: 'd.sql.gz', spawnFn: () => child });
  child.emitOut('-- PostgreSQL database dump\n');
  await settle();
  assert.equal(res.headers['content-disposition'], 'attachment; filename="d.sql.gz"');
  assert.ok(res.bytes() > 0, 'the gzip header is already on the wire');

  child.emitErr('pg_dump: error: query failed');
  child.exit(1);
  const out = await p;
  assert.equal(out.status, 'failed');
  assert.ok(res.destroyed, 'a partial .gz is never handed over as a clean download');
  assert.ok(!res.ended);
});

test('a mid-stream failure destroys the socket instead of ending it truthfully', async () => {
  // Headers are already committed, so a 500 is impossible. Destroying is
  // what makes the browser record a failed download rather than keep a
  // silently truncated .gz.
  const child = fakeChild();
  const res = fakeRes();
  const p = dbExport.runExport({ dbName: 'usernode', res, filename: 'd.sql.gz', spawnFn: () => child });
  child.emitOut(incompressible());
  await settle();
  assert.ok(res.bytes() > 0, 'bytes are on the wire');
  child.emitErr('pg_dump: error: query failed');
  child.exit(1);
  const out = await p;

  assert.equal(out.status, 'failed');
  assert.ok(res.destroyed, 'the truncated response is destroyed');
  assert.ok(!res.ended, 'never ended cleanly on a partial dump');
});

test('a client hang-up kills pg_dump and reports cancelled', async () => {
  const child = fakeChild();
  const res = fakeRes();
  const p = dbExport.runExport({ dbName: 'usernode', res, filename: 'd.sql.gz', spawnFn: () => child });
  child.emitOut('-- PostgreSQL database dump\n');
  res.emit('close');              // browser cancelled the download
  assert.equal(child.killed, 'SIGTERM', 'the dump is not left running against production');
  child.exit(null);
  const out = await p;
  assert.equal(out.status, 'cancelled');
});

test('a spawn failure resolves rather than rejecting', async () => {
  const res = fakeRes();
  const out = await dbExport.runExport({
    dbName: 'usernode', res, filename: 'd.sql.gz',
    spawnFn: () => { throw new Error('pg_dump not found'); },
  });
  assert.equal(out.status, 'failed');
  assert.match(out.error, /pg_dump not found/);
});

test('backpressure pauses the child instead of buffering the dump', async () => {
  const child = fakeChild();
  const res = fakeRes({ backpressure: true });
  let paused = false;
  child.stdout.pause = () => { paused = true; };
  child.stdout.resume = () => { paused = false; };
  const p = dbExport.runExport({ dbName: 'usernode', res, filename: 'd.sql.gz', spawnFn: () => child });
  child.emitOut(incompressible());
  await settle();
  assert.equal(paused, true, 'a slow client pauses pg_dump');
  res.emit('drain');
  assert.equal(paused, false, 'and it resumes when the socket drains');
  child.exit(0);
  await p;
});

test('stderr never reaches the client body', async () => {
  const child = fakeChild();
  const res = fakeRes();
  const p = dbExport.runExport({ dbName: 'usernode', res, filename: 'd.sql.gz', spawnFn: () => child });
  child.emitErr('pg_dump: connection string password=hunter2');
  child.emitOut('A');
  child.exit(0);
  await p;
  const sql = zlib.gunzipSync(Buffer.concat(res.chunks)).toString('utf8');
  assert.equal(sql, 'A', 'only dump bytes are compressed into the response');
  assert.ok(!sql.includes('hunter2'));
});
