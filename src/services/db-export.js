// Platform database export — the unredacted `pg_dump` an admin can download
// from the admin console (#admin/db-export), as a gzip-compressed plain-SQL
// file (`.sql.gz`). Ephemeral mobile-push device/delivery rows are the sole
// data exception: their schemas are retained, but their rows are excluded so
// a restore cannot resurrect destinations or an old outbox in another env.
//
// WHY PLAIN SQL + GZIP: a custom-format (`-Fc`) dump can only be read by
// `pg_restore` of a compatible version, which makes the one artifact an
// admin is most likely to need in an emergency dependent on having the
// right Postgres toolchain to hand. Plain SQL is readable with `less`,
// greppable, diffable, and restores with nothing but `psql` — and gzip
// gets the size back (SQL text compresses hard; `-Fc`'s own zlib pass is
// what we're replacing, not adding to).
//
// WHY IT SHELLS OUT: pg_dump is the canonical streaming dump client and
// is installed in the platform image. It connects through DATABASE_URL (or
// DB_ADMIN_URL) over the network; it never enters the database container.
//
// TWO RULES THAT ARE NOT OPTIONAL:
//
//   1. ARGV ONLY, NEVER `sh -c`. db-manager's clone path uses a shell
//      string because it needs a pipe (`pg_dump | pg_restore`). We don't,
//      and this path is *user-triggerable*, so nothing here may ever be
//      spliced into a shell. The database name is additionally validated
//      against SAFE_IDENT before it reaches the argv. NOTE: the gzip step
//      is therefore NOT `pg_dump | gzip` in a shell — it is an in-process
//      zlib Gzip transform between the child's stdout and the response.
//      Same bytes, no shell, and no dependency on gzip existing inside
//      the postgres image.
//   2. spawn(), NEVER execFile(). execFile buffers stdout in memory; the
//      platform DB carries bytea payloads (chat_session_attachments.data
//      is up to 20 MB each, plus issue_screenshots / session_visuals), so
//      a buffered dump is an OOM against the container's 3 GB cap. The
//      child's stdout is piped chunk-by-chunk through gzip into the
//      response with backpressure at BOTH joins (compressor and socket).
//
// The HTTP surface (auth, password re-entry, the audit rows) lives in
// src/routes/admin.js. This module owns process management, the
// single-flight guard, and the short-lived download tickets.

const { spawn } = require('child_process');
const crypto = require('crypto');
const zlib = require('zlib');
const log = require('./logger');

const DB_USER = process.env.DB_USER || 'usernode';

// Same guard db-manager.js applies to every database identifier.
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/i;

// Mirrors DB_CLONE_TIMEOUT_MS in db-manager.js, but longer: a clone writes
// into a local container, an export pushes every byte over the network to
// a browser, so a slow client legitimately takes longer.
const DB_EXPORT_TIMEOUT_MS = Number(process.env.DB_EXPORT_TIMEOUT_MS) || 15 * 60 * 1000;

// Grace between SIGTERM and SIGKILL when we abandon a dump.
const KILL_GRACE_MS = 5000;

// Compression level for the .sql.gz. zlib runs on libuv's threadpool, so
// this does not block the event loop, but it IS platform-container CPU
// spent per exported byte. 6 (zlib's default) is the right trade for SQL
// text; lower it on a CPU-starved fork rather than editing this file.
const GZIP_LEVEL = (() => {
  const n = Number(process.env.DB_EXPORT_GZIP_LEVEL);
  return Number.isInteger(n) && n >= 1 && n <= 9 ? n : 6;
})();

// MIME type for the download. Deliberately NOT paired with
// `Content-Encoding: gzip` — that would tell the browser to transparently
// decompress, and the admin would end up with a `.sql.gz` file holding
// plain SQL. The gzip container IS the payload here.
const EXPORT_CONTENT_TYPE = 'application/gzip';

// Download tickets are single-use and very short-lived; the browser
// navigates to the URL immediately after the POST resolves.
const TICKET_TTL_MS = 60 * 1000;

// Cap on captured stderr so a pathological failure can't balloon an audit
// row (the text is additionally redacted before it is stored).
const STDERR_CAP = 4000;

// How many exports one admin may take per rolling 24h. The enforcement
// lives in the rate limiter (middleware/rate-limits.js dbExportLimiter);
// this constant is only for display in the capability probe. Keep the
// two in sync.
const MAX_PER_DAY = 3;

// Keep table definitions in a backup, but never restore device destinations
// or a stale delivery outbox into another deployment/environment.
const EXCLUDED_TABLE_DATA = Object.freeze([
  'mobile_push_deployment_state',
  'mobile_push_installation_mutations',
  'mobile_push_registrations',
  'mobile_push_deliveries',
]);

// ── Environment ───────────────────────────────────────────────────────

// Staging previews must never be able to export. The server-side check and
// disabled capability keep the endpoint unavailable even though database
// administration now uses a normal network connection. Kubernetes previews
// additionally receive only their own app database URL, never DB_ADMIN_URL.
// This is a DELIBERATE exception to the "never gate features on
// USERNODE_ENV" convention in src/prompts/app-conventions.md, and it must
// stay: the self-staging auth path (middleware/auth.js) hands out a real
// session for a cloned `users` row that kept is_admin, so an admin
// session is trivially reachable in a preview — and a preview must not be
// able to export any database. Do not "fix" this by deleting the check; the
// client stays env-literal-free instead.
function isStaging() {
  return process.env.USERNODE_ENV === 'staging';
}

function postgresEnv(dbName) {
  const value = process.env.DB_ADMIN_URL || process.env.DATABASE_URL;
  if (!value) throw new Error('DB_ADMIN_URL or DATABASE_URL is required');
  const url = new URL(value);
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username || DB_USER),
    PGPASSWORD: decodeURIComponent(url.password || ''),
    PGDATABASE: dbName,
    ...(url.searchParams.get('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode') } : {}),
  };
}

// ── Target database ───────────────────────────────────────────────────

// Pull the database name out of a postgres:// URL. Handles passwords
// containing '@' (the last '@' separates credentials from the host) and
// strips any query string.
function parseDbName(databaseUrl) {
  if (!databaseUrl || typeof databaseUrl !== 'string') return null;
  const withoutScheme = databaseUrl.replace(/^[a-z+]+:\/\//i, '');
  const at = withoutScheme.lastIndexOf('@');
  const hostAndPath = at === -1 ? withoutScheme : withoutScheme.slice(at + 1);
  const slash = hostAndPath.indexOf('/');
  if (slash === -1) return null;
  let name = hostAndPath.slice(slash + 1);
  const q = name.search(/[?#]/);
  if (q !== -1) name = name.slice(0, q);
  name = name.trim();
  if (!name) return null;
  try { name = decodeURIComponent(name); } catch { /* keep raw */ }
  return name;
}

// Resolve (and validate) what we would dump. Returns
// { dbName, dbUser, reason } — dbName is null when we can't
// safely export, with `reason` explaining why.
function resolveTargetDb(config) {
  const base = { dbName: null, dbUser: DB_USER, reason: null };
  const parsed = parseDbName(config && config.databaseUrl);
  if (!parsed) return { ...base, reason: 'no_database_url' };
  if (!SAFE_IDENT.test(parsed)) {
    log.warn('db-export', 'Refusing to export: database name failed SAFE_IDENT', { dbName: parsed });
    return { ...base, reason: 'unsafe_db_name' };
  }
  // A fork may legitimately have renamed the platform DB — warn, don't fail.
  if (config && config.selfAppDbName && config.selfAppDbName !== parsed) {
    log.warn('db-export', 'Export target differs from config.selfAppDbName', {
      target: parsed, selfAppDbName: config.selfAppDbName,
    });
  }
  return { ...base, dbName: parsed };
}

// usernode-platform-<db>-20260727T121314Z.sql.gz
function exportFilename(dbName, now) {
  const d = now instanceof Date ? now : new Date();
  const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `usernode-platform-${dbName}-${stamp}.sql.gz`;
}

// ── Single-flight guard ───────────────────────────────────────────────
//
// `usernode-db` runs on 4 GB / 4 CPUs and already competes with staging
// `pg_dump | pg_restore` clones. One export at a time, platform-wide.

let _current = null;

function isExportInProgress() { return !!_current; }
function currentExport() { return _current ? { ..._current } : null; }

function beginExport(info) {
  if (_current) return false;
  _current = { startedAt: Date.now(), ...(info || {}) };
  return true;
}

function endExport() { _current = null; }

// ── Download tickets ──────────────────────────────────────────────────
//
// The confirm step needs a password in a request BODY (a POST), but the
// deliverable is a real browser download (a navigated GET carrying
// Content-Disposition). A single-use, 60-second, user-bound ticket
// bridges the two. In-memory only: never persisted, never logged in full.

const _tickets = new Map();

function _sweepTickets(now) {
  for (const [token, t] of _tickets) {
    if (t.expiresAt <= now) _tickets.delete(token);
  }
}

function issueTicket({ userId, ip, auditId, dbName }) {
  const now = Date.now();
  _sweepTickets(now);
  const token = crypto.randomBytes(32).toString('hex');
  _tickets.set(token, {
    token, userId, ip: ip || null, auditId: auditId || null,
    dbName: dbName || null, expiresAt: now + TICKET_TTL_MS,
  });
  return { token, expiresInSeconds: Math.round(TICKET_TTL_MS / 1000) };
}

// Single-use: a valid ticket is deleted on the first successful consume.
// Returns the ticket, or null when it is unknown / expired / belongs to
// another user.
function consumeTicket(token, userId) {
  const now = Date.now();
  _sweepTickets(now);
  if (!token || typeof token !== 'string') return null;
  const t = _tickets.get(token);
  if (!t) return null;
  if (t.expiresAt <= now) { _tickets.delete(token); return null; }
  if (t.userId !== userId) return null; // do NOT delete — not this user's to burn
  _tickets.delete(token);
  return t;
}

function _resetTickets() { _tickets.clear(); }

// ── The dump itself ───────────────────────────────────────────────────

// Stream
// `pg_dump -Fp --no-owner --no-privileges --no-password`
// through an in-process gzip into `res`. Always resolves (never rejects)
// with { status, bytesSent, rawBytes, error }, where status is one of
// 'completed' | 'failed' | 'cancelled'. `bytesSent` is COMPRESSED bytes
// (what the browser actually downloaded); `rawBytes` is the SQL before
// compression, for the log line.
//
// WHY --no-owner --no-privileges: the documented restore is a plain
// `psql` replay, and unlike pg_restore, psql has no restore-time flag to
// skip `ALTER … OWNER TO` / `GRANT` statements — so they have to be left
// out at dump time or a restore into any database whose roles differ from
// production fails on the first one.
//
// Headers are written lazily, on the FIRST COMPRESSED byte: if the child
// dies immediately (bad container name, missing database) nothing has been
// committed yet and we can still answer with a JSON error. Note that zlib
// emits its 10-byte gzip header as soon as the first chunk is written, so
// that window closes on pg_dump's first byte — exactly as it did for the
// raw `-Fc` stream. A failure after it still destroys the socket rather
// than handing the browser a truncated file that looks complete.
function runExport({ dbName, res, filename, onStart, spawnFn }) {
  return new Promise((resolve) => {
    if (!SAFE_IDENT.test(String(dbName || ''))) {
      resolve({ status: 'failed', bytesSent: 0, rawBytes: 0, error: 'unsafe database name' });
      return;
    }

    // Argv form. No shell, no interpolation, nothing splice-able. `-Fp` is
    // pg_dump's default, but it is spelled out so the file format this
    // route promises is visible at the call site.
    const args = [
      '-Fp', '--no-owner', '--no-privileges', '--no-password',
      ...EXCLUDED_TABLE_DATA.map((table) => `--exclude-table-data=${table}`),
      dbName,
    ];

    let child;
    try {
      child = (spawnFn || spawn)('pg_dump', args, {
        stdio: ['ignore', 'pipe', 'pipe'], env: postgresEnv(dbName),
      });
    } catch (err) {
      resolve({ status: 'failed', bytesSent: 0, rawBytes: 0, error: err.message });
      return;
    }

    // The compressor sits between pg_dump and the socket. Errors from it
    // are handled like any other mid-stream failure.
    const gzip = zlib.createGzip({ level: GZIP_LEVEL });

    let headersSent = false;
    let bytesSent = 0;     // compressed, on the wire
    let rawBytes = 0;      // plain SQL out of pg_dump
    let stderr = '';
    let clientGone = false;
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    let gzipFlushed = false;
    let paused = false;

    const finish = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (!gzipFlushed) { try { gzip.destroy(); } catch { /* already gone */ } }
      resolve({ status, bytesSent, rawBytes, error: error || null, headersSent });
    };

    // TWO independent backpressure sources now sit downstream of pg_dump:
    // the compressor's input buffer and the socket. They are tracked
    // separately and pg_dump only resumes once BOTH have drained — a
    // single shared flag would let the compressor's drain un-pause the
    // child while the browser is still behind, which is how you end up
    // buffering the dump in memory after all.
    let gzipFull = false;
    let resFull = false;

    const applyFlow = () => {
      const shouldPause = gzipFull || resFull;
      if (shouldPause === paused) return;
      paused = shouldPause;
      try { paused ? child.stdout.pause() : child.stdout.resume(); } catch { /* already gone */ }
    };
    const resumeChild = () => { gzipFull = false; resFull = false; applyFlow(); };

    const killChild = () => {
      if (child.exitCode !== null || child.signalCode) return;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      if (killTimer) return;
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, KILL_GRACE_MS);
      if (killTimer.unref) killTimer.unref();
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      log.error('db-export', 'Export timed out — killing pg_dump', { dbName, bytesSent });
      killChild();
    }, DB_EXPORT_TIMEOUT_MS);
    if (timeoutTimer.unref) timeoutTimer.unref();

    const sendHeaders = () => {
      headersSent = true;
      // gzip container, NOT Content-Encoding — see EXPORT_CONTENT_TYPE.
      res.setHeader('Content-Type', EXPORT_CONTENT_TYPE);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      // No Content-Length: the compressed size isn't known up front, so
      // this is a chunked response and the browser shows an indeterminate
      // progress.
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (typeof onStart === 'function') {
        try { onStart(); } catch { /* audit bookkeeping must not break the stream */ }
      }
    };

    child.stderr.on('data', (chunk) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.toString('utf8');
    });

    // pg_dump → gzip. Written by hand rather than .pipe() so the child's
    // exit (not its stdout EOF) is what flushes the compressor.
    child.stdout.on('data', (chunk) => {
      if (clientGone || settled) return;
      rawBytes += chunk.length;
      if (gzip.write(chunk) === false) {
        gzipFull = true;
        applyFlow();
        gzip.once('drain', () => { gzipFull = false; applyFlow(); });
      }
    });

    // gzip → socket. This is where the response is actually committed.
    gzip.on('data', (chunk) => {
      if (clientGone || settled) return;
      if (!headersSent) sendHeaders();
      bytesSent += chunk.length;
      // Backpressure: a slow browser must not make us buffer the dump.
      if (res.write(chunk) === false) {
        resFull = true;
        applyFlow();
        res.once('drain', () => { resFull = false; applyFlow(); });
      }
    });

    gzip.on('error', (err) => {
      log.error('db-export', 'gzip stream failed', { dbName, message: err.message });
      gzipFlushed = true; // nothing left to flush; don't re-destroy in finish()
      killChild();
      if (headersSent) { try { res.destroy(); } catch { /* socket already gone */ } }
      else if (!res.headersSent) {
        try { res.status(500).json({ error: 'Export failed', code: 'export_failed' }); } catch {}
      }
      finish('failed', `gzip failed: ${err.message}`);
    });

    // The compressor has flushed its final block. Only now is the file
    // complete, so this — not the child's exit — is what ends the response
    // on the success path.
    gzip.on('end', () => {
      gzipFlushed = true;
      if (settled || clientGone) return;
      if (!headersSent) sendHeaders(); // an empty database still gets a valid .gz
      try { res.end(); } catch { /* socket already gone */ }
      finish('completed', null);
    });

    child.on('error', (err) => {
      log.error('db-export', 'Failed to spawn pg_dump', { message: err.message });
      if (!headersSent && !res.headersSent) {
        try { res.status(500).json({ error: 'Export failed to start', code: 'export_failed' }); } catch {}
      } else {
        try { res.destroy(); } catch {}
      }
      finish('failed', err.message);
    });

    // The client hung up (cancelled the download, closed the tab, lost the
    // network). Kill the child so pg_dump isn't left holding a snapshot
    // open against the production database.
    res.on('close', () => {
      if (settled) return;
      if (!res.writableEnded) {
        clientGone = true;
        log.warn('db-export', 'Client disconnected mid-export — killing pg_dump', { dbName, bytesSent });
        killChild();
      }
    });

    child.on('close', (code) => {
      if (clientGone) { finish('cancelled', null); return; }
      if (timedOut) {
        if (headersSent) { try { res.destroy(); } catch {} }
        else if (!res.headersSent) {
          try { res.status(504).json({ error: 'Export timed out', code: 'export_timeout' }); } catch {}
        }
        finish('failed', `timed out after ${DB_EXPORT_TIMEOUT_MS}ms`);
        return;
      }
      if (code === 0) {
        // Flush the compressor and let its 'end' finish the response —
        // ending the socket here would truncate the gzip trailer.
        resumeChild();
        try { gzip.end(); } catch (err) { finish('failed', `gzip flush failed: ${err.message}`); }
        return;
      }
      // Non-zero exit. If bytes are already on the wire we CANNOT send an
      // error status — destroy the socket so the browser records a failed
      // download instead of silently keeping a truncated file.
      const detail = log.redactString
        ? log.redactString(stderr.slice(0, STDERR_CAP))
        : stderr.slice(0, STDERR_CAP);
      log.error('db-export', 'pg_dump exited non-zero', { dbName, code, stderr: detail });
      if (headersSent) { try { res.destroy(); } catch {} }
      else if (!res.headersSent) {
        try { res.status(500).json({ error: 'Export failed', code: 'export_failed' }); } catch {}
      }
      finish('failed', `pg_dump exited ${code}: ${detail}`.slice(0, STDERR_CAP));
    });
  });
}

module.exports = {
  DB_USER,
  DB_EXPORT_TIMEOUT_MS,
  EXPORT_CONTENT_TYPE,
  GZIP_LEVEL,
  TICKET_TTL_MS,
  MAX_PER_DAY,
  EXCLUDED_TABLE_DATA,
  SAFE_IDENT,
  isStaging,
  parseDbName,
  resolveTargetDb,
  exportFilename,
  isExportInProgress,
  currentExport,
  beginExport,
  endExport,
  issueTicket,
  consumeTicket,
  runExport,
  _resetTickets,
};
