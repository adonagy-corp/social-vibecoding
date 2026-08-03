'use strict';

// Before/after visuals on UI-affecting proposals (issue #195).
//
// Runs AFTER a staging preview comes up healthy: decides whether the
// commit range plausibly affects the UI (changed-file heuristic), spawns
// the one-shot headless-Chromium capture container (capture/) to shoot
// the production app ("before") and the staging container ("after") over
// the internal docker network, stores the artifacts in Postgres
// (session_visuals, latest set per session only), patches the GitHub PR
// body's marker-delimited "Before / after" block when a PR exists, and
// emits a `visuals_ready` event so open dev-chat cards upgrade in place.
//
// Capture is an automatic platform pipeline step, not an agent
// responsibility — the worker image has no browser and the coding turn is
// already over by the time staging exists. It is fire-and-forget and
// strictly best-effort: captureForSession never throws, never delays
// staging_ready, and never changes the outcome of a dev turn (same
// contract as the #183 non-fatal staging build).

const crypto = require('crypto');
const path = require('path');
const log = require('./logger');
const platformJwt = require('./platform-jwt');
const docker = require('./docker');
const kubernetes = require('./kubernetes');
const applicationRuntime = require('./application-runtime');
const github = require('./github');
const caddy = require('./caddy');
const prMetadata = require('./pr-metadata');
const sessionBus = require('./session-bus');
const appManifest = require('./app-manifest');
const checkHistory = require('./check-history');
const unitSuite = require('./unit-suite');
const { CAPTURE_MAX_PATHS, normalizeStoredPath, VIEWPORT_MOBILE } = require('./testing-notes');
const { getPool } = require('../db/pool');

const CAPTURE_IMAGE = 'usernode-capture:latest';

function captureRuntimeMode() {
  const mode = process.env.CAPTURE_RUNTIME || process.env.APP_RUNTIME || 'docker';
  if (!['docker', 'kubernetes'].includes(mode)) {
    throw new Error(`Unsupported CAPTURE_RUNTIME=${mode}`);
  }
  return mode;
}

// Pixel frame for the phone-sized capture (#768, now automatic) — an
// iPhone-14-class portrait viewport, passed per-target to the capture
// container. EVERY capture path is shot in both the desktop frame
// (full media) and this frame (PNG still only) via expandCapturePaths;
// desktop targets omit the field and get the container's fixed 1280x800
// default. The label→pixels mapping lives here (not in capture/) so the
// container stays a dumb executor of resolved targets; deviceScaleFactor
// stays governed by the app's screenshot_device_scale setting for both
// frames (stills — recordings are always 1x, see capture/capture.js).
const MOBILE_VIEWPORT = { width: 390, height: 844 };

// Dedicated capture identity (seeded by src/db/migrate.js). A non-admin
// service account so the public artifacts (/visuals/:id is unauthenticated;
// PR bodies embed them on GitHub) never show anyone's personal data or
// admin-only UI. The capture run is capped at RUN_TIMEOUT_MS (600s); 15
// minutes covers the lazy image build + retry comfortably.
const CAPTURE_USERNAME = 'usernode-capture';
// Separate view-only-admin identity (is_admin + admin_readonly; seeded by
// src/db/migrate.js) used ONLY to sign the proposal-checks assertion suite,
// so the admin-only check routes (/admin, /dashboard) render under test.
// Never signs a public screenshot — see the testsToken block below.
const CAPTURE_ADMIN_USERNAME = 'usernode-capture-admin';
const CAPTURE_AUTH_TTL_MS = 15 * 60 * 1000;

// ── "Is this UI-affecting?" heuristic ──────────────────────────────────
// Deterministic and cheap — no LLM call. A changed file counts as
// frontend if its extension is plainly presentational, OR if it lives
// under a conventionally-frontend directory segment at any depth (which
// catches .js/.ts UI code across arbitrary vibe-coded apps). One match
// in the commit range triggers capture.
const FRONTEND_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.scss', '.less', '.styl',
  '.vue', '.svelte', '.jsx', '.tsx',
]);
const FRONTEND_DIR_SEGMENTS = new Set([
  'public', 'static', 'assets', 'client', 'frontend',
  'www', 'views', 'templates', 'components', 'pages',
]);

// Per-artifact storage caps. Over-cap artifacts are dropped individually —
// the rest of the set still stores, and the PR embed falls back from GIF
// to PNG per side. 1280x800 PNGs run 100-400 KB; a 5-9s webm ~0.5-2 MB;
// the 640px/10fps GIF typically 1-4 MB.
const MAX_BYTES = {
  png: 4 * 1024 * 1024,
  webm: 8 * 1024 * 1024,
  gif: 8 * 1024 * 1024,
};
const CONTENT_TYPES = {
  png: 'image/png',
  webm: 'video/webm',
  gif: 'image/gif',
};

// Recording + GIF encoding add real seconds per page on top of load, and
// the worst-case stdout is six base64 artifacts (2 png + 2 webm + 2 gif).
//
// Raised 240s → 600s when every declared check started running: the media
// pass is unchanged, but the suite that follows it now has its own 420s
// budget, and the container needs room to finish that budget and still emit
// its sentinel. This is the OUTER bound — the suite stops dispatching at
// TESTS_DEADLINE_MS long before we get here, so hitting 600s means the
// container is genuinely wedged, not merely busy.
const RUN_TIMEOUT_MS = 600 * 1000;
const RUN_MAX_BUFFER = 128 * 1024 * 1024;

// The capture container drives up to TEST_CONCURRENCY headless pages at
// once. One Chromium page is ~50-80 MiB of renderer, so eight of them plus
// the browser process needs materially more than the 1g runOneShot default
// — an OOM-kill there loses the whole run, sentinel included, and reads to
// the platform as a crashed container.
const CAPTURE_MEMORY = process.env.CAPTURE_MEMORY || '4g';
const CAPTURE_CPUS = process.env.CAPTURE_CPUS || '4';

// Suite bounds handed to the container. Kept here rather than left to the
// image's own defaults so the platform's timeout arithmetic (below) and the
// container's agree by construction.
const TEST_CONCURRENCY = process.env.TEST_CONCURRENCY || '8';
const TEST_TIMEOUT_MS = process.env.TEST_TIMEOUT_MS || '25000';
const TESTS_DEADLINE_MS = process.env.TESTS_DEADLINE_MS || '420000';

// Mint a 15-minute capture identity token for a seeded capture identity
// row, scoped to the app being captured.
//
// Delegates to platformJwt.signAppIdentityToken, so a capture token is the
// SAME kind of credential /api/iframe-token mints — RS256, issuer
// `usernode`, audience `usernode:app:<appId>`, `pur: 'iframe'` — just with
// a shorter life (it only has to outlive one screenshot run). That
// sameness is the point: child apps verify it with the one code path they
// already have, and the self-app staging clone exchanges it for a local
// session via middleware/auth.js.
//
// Returns '' when the row is absent so callers degrade to unauthenticated
// capture — never throws on a missing user.
function mintCaptureToken(user, appId) {
  if (!user) return '';
  return platformJwt.signAppIdentityToken({
    appId,
    user: {
      id: user.id,
      username: user.username,
      usernode_pubkey: user.usernode_pubkey || null,
      locale: user.locale ?? null,
    },
    ttl: platformJwt.CAPTURE_TTL,
  });
}

// Route the two capture identities to their jobs (#47). Screenshots always
// sign as the non-admin capture user (public artifacts must never show
// admin-only UI), while the proposal-checks assertion suite prefers the
// view-only-admin token so the admin-gated check routes (/admin, /dashboard)
// render under test — falling back to the non-admin token when the admin
// identity is missing (migration not yet run / lookup failed). Pure so the
// routing + fallback is unit-testable without spinning up the pipeline.
function selectCaptureTokens({ captureToken, adminToken }) {
  const screenshot = captureToken || '';
  return {
    screenshotToken: screenshot,
    testsToken: adminToken || screenshot,
  };
}

// Append the capture JWT as a `token` query param. testing_path can
// legitimately carry its own query string (e.g. `/board?demo-pr=1`, see
// testing-notes.js), so the join must pick '?' vs '&'. An empty token
// returns the URL unchanged (unauthenticated capture — current behaviour).
//
// Fragment-safe (#353): a self-app deep link carries a `#app/...` hash
// (the SPA routes off location.hash), and a query param MUST sit before
// the fragment or it never reaches the server. So split off any `#...`
// tail, splice `token=` onto the path+query part, then re-attach the
// fragment. Plain pathname URLs (no `#`) are byte-identical to the old
// concat behaviour.
function withToken(url, token) {
  if (!token) return url;
  const hashAt = url.indexOf('#');
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const frag = hashAt === -1 ? '' : url.slice(hashAt);
  return base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) + frag;
}

// The self-app is a hash-routed SPA (#353): App.restoreFromHash() in
// public/js/app.js reads location.hash, so its internal screens are
// addressed by fragment (`#app/<slug>/...`, `#leaderboard`, ...), NOT by
// server pathname. A testing path joined as a pathname loads index.html
// with an empty hash → the home feed, for both "before" and "after".
//
// Normalise a self-app testing path into the form the SPA actually
// routes off: if its first segment is one of the SPA hash routes, move
// the whole path into the URL fragment (pathname stays '/'). Anything
// else — the bare '/', a path already written as a fragment ('/#...'),
// or a genuinely standalone server page (/cli/authorize) — is left
// exactly as-is so those real routes still resolve. Only applied for the
// self-app; child apps are genuinely path-routed and pass through
// untouched.
//
// #860 added 'admin': the seven former standalone admin pages
// (/dashboard, /admin, /status, /node-status, /debug, /gallery,
// /admin-features) are sections of the #admin console now, so
// `path: /admin/analytics` normalises straight into the fragment. Their
// OLD pathnames still work too — they fall through untouched and hit the
// client-side redirect stubs — just with one extra hop.
//
// 'apps' (plural) is the browse-all-apps screen and its per-app detail
// page (`#apps`, `#apps/<slug>`). There is no server page at that
// pathname, so before it was listed here a `path: /apps` silently loaded
// index.html with an empty hash and captured the home screen — the exact
// failure mode this whole function exists to prevent. It is distinct from
// the singular 'app' (the app-view route) and must be its own entry: the
// first path segment is matched exactly, not by prefix.
const SELF_APP_HASH_ROUTES = new Set([
  'app', 'apps', 'leaderboard', 'group-chat', 'individual-chat', 'create', 'admin', 'messages',
]);
function selfAppHashPath(p) {
  const path = typeof p === 'string' ? p : '/';
  if (!path.startsWith('/') || path.startsWith('/#')) return path;
  const firstSeg = path.slice(1).split(/[/?#]/)[0];
  if (!SELF_APP_HASH_ROUTES.has(firstSeg)) return path;
  return '/#' + path.slice(1);
}

// "Before" (production) target hostname for an app. Child apps run as
// `usernode-app-<slug>`; the platform itself is reached via
// config.selfAppContainer (default 'usernode' — under blue-green that's
// the shared network ALIAS both colors carry, not a container name), NOT
// as `usernode-app-<selfAppSlug>` — which is why self-app sessions used
// to get no "before" image at all (#195 follow-up).
function beforeContainerName(config, slug) {
  return slug === config.selfAppSlug
    ? (config.selfAppContainer || 'usernode')
    : `usernode-app-${slug}`;
}

function isFrontendFile(file) {
  const f = String(file || '').replace(/\\/g, '/');
  const ext = path.extname(f).toLowerCase();
  if (FRONTEND_EXTENSIONS.has(ext)) return true;
  const segments = f.split('/').slice(0, -1);
  return segments.some((s) => FRONTEND_DIR_SEGMENTS.has(s.toLowerCase()));
}

function isUiAffecting(files) {
  return Array.isArray(files) && files.some(isFrontendFile);
}

// ── Capture image ──────────────────────────────────────────────────────
// Built lazily by the platform from capture/, mirroring the worker-image
// pattern (worker.js ensureWorkerImage). Memoized per process: capture/
// only changes when the platform itself redeploys, which restarts the
// process anyway; Docker's layer cache makes the one build per boot fast.
let _imagePromise = null;
function ensureCaptureImage() {
  if (captureRuntimeMode() === 'kubernetes') {
    if (!(process.env.KUBERNETES_CAPTURE_IMAGE || '').includes('@sha256:')) {
      return Promise.reject(new Error('KUBERNETES_CAPTURE_IMAGE must be configured with an immutable digest'));
    }
    return Promise.resolve();
  }
  if (!_imagePromise) {
    const captureDir = path.join(__dirname, '../../capture');
    _imagePromise = docker.buildImage(captureDir, CAPTURE_IMAGE).catch((err) => {
      _imagePromise = null; // allow a retry on the next capture
      throw err;
    });
  }
  return _imagePromise;
}

// ── Output protocol parsing ────────────────────────────────────────────
// capture.js emits one frame per artifact:
//   __USERNODE_SHOT__ kind=before media=png status=200 bytes=12345 index=0
//   <base64, single line>
//   __USERNODE_SHOT_END__
// and __USERNODE_SHOT_FAIL__ kind=... media=... reason=... index=... for
// failures. `index` is the capture group (multi-route, #270); it defaults
// to 0 when absent so an older capture container is parsed as one group.
function parseShots(stdout) {
  const shots = [];
  const failures = [];
  const lines = String(stdout || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('__USERNODE_SHOT__ ')) {
      const attrs = {};
      for (const m of line.matchAll(/(\w+)=(\S+)/g)) attrs[m[1]] = m[2];
      const payload = lines[i + 1] || '';
      if (lines[i + 2] === '__USERNODE_SHOT_END__'
          && (attrs.kind === 'before' || attrs.kind === 'after')
          && CONTENT_TYPES[attrs.media]) {
        try {
          const buf = Buffer.from(payload, 'base64');
          if (buf.length) {
            shots.push({
              kind: attrs.kind,
              media: attrs.media,
              status: parseInt(attrs.status, 10) || 0,
              index: parseInt(attrs.index, 10) || 0,
              // fellback=1 tags a "before" frame that was actually shot at
              // the fallback '/' (the deep path 404'd on prod). Absent on
              // older capture images → false.
              fellBack: attrs.fellback === '1',
              buf,
            });
          }
        } catch { /* malformed base64 — treat as a missing frame */ }
        i += 2;
      }
    } else if (line.startsWith('__USERNODE_SHOT_FAIL__ ')) {
      const attrs = {};
      for (const m of line.matchAll(/(\w+)=(\S+)/g)) attrs[m[1]] = m[2];
      failures.push({
        kind: attrs.kind, media: attrs.media,
        reason: decodeURIComponent(attrs.reason || 'unknown'),
      });
    }
  }
  return { shots, failures };
}

// ── Console-error check (#381) ───────────────────────────────────────────
// capture.js emits one console frame per "after" target:
//   __USERNODE_CONSOLE__ index=<n> errors=<count> loadStatus=<n>
//   <base64 JSON array of { kind, message, source }>
//   __USERNODE_CONSOLE_END__
// Parse them into one frame per capture index (latest wins on a dup index).
const CONSOLE_MAX_ERRORS = 20;
const CONSOLE_MAX_MSG_LEN = 500;

function parseConsole(stdout) {
  const byIndex = new Map();
  const lines = String(stdout || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('__USERNODE_CONSOLE__ ')) continue;
    const attrs = {};
    for (const m of line.matchAll(/(\w+)=(\S+)/g)) attrs[m[1]] = m[2];
    const payload = lines[i + 1] || '';
    if (lines[i + 2] !== '__USERNODE_CONSOLE_END__') continue;
    const index = parseInt(attrs.index, 10) || 0;
    const loadStatus = parseInt(attrs.loadStatus, 10) || 0;
    let errors = [];
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
      if (Array.isArray(parsed)) errors = parsed;
    } catch { /* malformed base64/JSON — treat the frame as no parsed errors */ }
    byIndex.set(index, { index, loadStatus, errors });
    i += 2;
  }
  return Array.from(byIndex.values()).sort((a, b) => a.index - b.index);
}

// Classify the parsed frames into the persisted snapshot:
//   'errors'  — at least one console error / page error / failed load
//   'clean'   — every checked target navigated OK with no error output
//   'unknown' — nothing to classify (no frame parsed: container crashed,
//               no staging "after" reachable, …) → no badge
// The flattened error list is deduped by message and capped, matching the
// capture-side caps so a runaway app can't bloat the row.
function classifyConsole(frames) {
  if (!Array.isArray(frames) || !frames.length) return { state: 'unknown', errors: [] };
  const seen = new Set();
  const errors = [];
  for (const f of frames) {
    for (const e of (Array.isArray(f.errors) ? f.errors : [])) {
      const message = String((e && e.message) || '').slice(0, CONSOLE_MAX_MSG_LEN);
      if (!message || seen.has(message)) continue;
      seen.add(message);
      errors.push({
        kind: (e && typeof e.kind === 'string') ? e.kind : 'console',
        message,
        source: (e && e.source) ? String(e.source).slice(0, CONSOLE_MAX_MSG_LEN) : '',
      });
      if (errors.length >= CONSOLE_MAX_ERRORS) break;
    }
    if (errors.length >= CONSOLE_MAX_ERRORS) break;
  }
  return { state: errors.length ? 'errors' : 'clean', errors };
}

// Latest-only snapshot on the session, mirroring the merge-conflict trio.
async function storeConsoleCheck(pool, sessionId, result, expectedCommitSha) {
  const write = await pool.query(
    `UPDATE chat_sessions
       SET console_check_state = $1, console_errors = $2, console_checked_at = NOW()
     WHERE id = $3
       AND status IN ('active', 'paused', 'promoted', 'merging')
       AND checks_commit_sha IS NOT DISTINCT FROM $4::text`,
    [result.state, JSON.stringify(result.errors || []), sessionId, expectedCommitSha || null]
  );
  return write.rowCount !== 0;
}

// ── Test suite (#47, "CI for proposals") ─────────────────────────────────
// capture.js emits one frame per declared test:
//   __USERNODE_TEST__ index=<n> status=<pass|fail> loadStatus=<n>
//   <base64 JSON { name, path, consoleErrors:[...], failureReason }>
//   __USERNODE_TEST_END__
// Parse them into one record per index (latest wins on a dup index).
//
// Was 20 back when the reader itself kept only 12 declared checks. Now every
// declared check runs, so the row cap has to reach the declaration ceiling
// or the card would silently hide the tail it exists to surface. The
// serialised payload is separately byte-capped in storeChecks.
const TEST_MAX_RESULTS = appManifest.MAX_DECLARED_TESTS;

function parseTests(stdout) {
  const byIndex = new Map();
  const lines = String(stdout || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('__USERNODE_TEST__ ')) continue;
    const attrs = {};
    for (const m of line.matchAll(/(\w+)=(\S+)/g)) attrs[m[1]] = m[2];
    const payloadLine = lines[i + 1] || '';
    if (lines[i + 2] !== '__USERNODE_TEST_END__') continue;
    const index = parseInt(attrs.index, 10) || 0;
    const status = attrs.status === 'pass' ? 'pass' : 'fail';
    const loadStatus = parseInt(attrs.loadStatus, 10) || 0;
    let payload = {};
    try {
      const parsed = JSON.parse(Buffer.from(payloadLine, 'base64').toString('utf8'));
      if (parsed && typeof parsed === 'object') payload = parsed;
    } catch { /* malformed — keep the status from the header line */ }
    byIndex.set(index, {
      index,
      name: typeof payload.name === 'string' ? payload.name : `test ${index + 1}`,
      path: typeof payload.path === 'string' ? payload.path : '',
      status,
      loadStatus,
      consoleErrors: Array.isArray(payload.consoleErrors) ? payload.consoleErrors : [],
      failureReason: typeof payload.failureReason === 'string' ? payload.failureReason : '',
    });
    i += 2;
  }
  return Array.from(byIndex.values()).sort((a, b) => a.index - b.index);
}

// The suite's completion sentinel:
//   __USERNODE_TESTS_DONE__ ran=<n> expected=<n> deadline=<0|1>
// Absent when the container died before finishing, or when an OLD capture
// image (which never emitted it) served the run — both callers below treat
// `null` as "no claim made" and fall back to counting frames.
function parseTestsDone(stdout) {
  const lines = String(stdout || '').split('\n');
  let found = null;
  for (const line of lines) {
    if (!line.startsWith('__USERNODE_TESTS_DONE__ ')) continue;
    const attrs = {};
    for (const m of line.matchAll(/(\w+)=(\S+)/g)) attrs[m[1]] = m[2];
    found = {
      ran: parseInt(attrs.ran, 10) || 0,
      expected: parseInt(attrs.expected, 10) || 0,
      deadline: attrs.deadline === '1',
    };
  }
  return found;
}

function normalizeConsoleErrors(list) {
  return (Array.isArray(list) ? list : [])
    .slice(0, CONSOLE_MAX_ERRORS)
    .map((e) => ({
      kind: (e && typeof e.kind === 'string') ? e.kind : 'console',
      message: String((e && e.message) || '').slice(0, CONSOLE_MAX_MSG_LEN),
      source: (e && e.source) ? String(e.source).slice(0, CONSOLE_MAX_MSG_LEN) : '',
    }));
}

// Classify the parsed test frames into the persisted snapshot:
//   'passing' — every BLOCKING check that ran passed
//   'failing' — a blocking check failed an assertion / had console errors
//   'error'   — the run cannot be trusted: no frames at all, or a check
//               that has earned gating produced no verdict → the gate
//               blocks fail-closed, the UI shows "couldn't run"
//
// Two call shapes:
//
//   classifyTests(frames, expectedCount)
//     Legacy. Every check is blocking and ANY missing frame is an 'error'.
//     Exactly the pre-#1019 semantics, kept because it is the honest answer
//     when the caller has no history to consult.
//
//   classifyTests(frames, expectedCount, { dispatched, sentinel })
//     Earned gating. `dispatched` is [{ index, checkKey, name, path,
//     graduated }] — the suite as sent to the container, in dispatch order.
//     A check is BLOCKING iff it has been observed passing before
//     (`graduated`); everything else is ADVISORY: it runs, it shows on the
//     card, it does not block the merge.
//
// Results are matched to declarations BY INDEX, never by position. With a
// pool the frames arrive out of order, and a missing frame shifts every
// later row — positional matching would silently attribute check 40's
// failure to check 39 and, worse, judge it against check 39's graduation.
//
// `options.extraRows` are synthesised blocking rows that did not come from
// the container at all (today: the over-ceiling guard).
function classifyTests(frames, expectedCount, options) {
  const opts = options || {};
  const dispatched = Array.isArray(opts.dispatched) ? opts.dispatched : null;
  const sentinel = opts.sentinel || null;
  const extraRows = Array.isArray(opts.extraRows) ? opts.extraRows : [];

  const parsed = (Array.isArray(frames) ? frames : []).slice(0, TEST_MAX_RESULTS);

  // ── Legacy shape ───────────────────────────────────────────────────────
  // extraRows (the unit-suite row today) still ride along: the synthesized
  // baseline suite has no graduation history, but the extra rows carry
  // their own advisory flag and must not vanish just because the app
  // declares no dapp.json checks. Error verdicts stay decided by the
  // container's own frames, exactly as before.
  if (!dispatched) {
    const results = parsed.map((f) => ({
      name: String(f.name || '').slice(0, CONSOLE_MAX_MSG_LEN),
      path: String(f.path || '').slice(0, CONSOLE_MAX_MSG_LEN),
      status: f.status === 'pass' ? 'pass' : 'fail',
      consoleErrors: normalizeConsoleErrors(f.consoleErrors),
      failureReason: String(f.failureReason || '').slice(0, CONSOLE_MAX_MSG_LEN),
    }));
    const expected = Number.isInteger(expectedCount) ? expectedCount : results.length;
    if (!results.length) return { state: 'error', results: extraRows.slice() };
    if (expected > 0 && results.length < expected) {
      return { state: 'error', results: results.concat(extraRows) };
    }
    const all = results.concat(extraRows);
    // Legacy container rows carry no advisory flag (always blocking);
    // extra rows block only when non-advisory — an ungraduated unit-suite
    // failure shows on the card without closing the gate (#1019 stance).
    const anyFail = all.some((r) => r.status !== 'pass' && !r.advisory);
    return { state: anyFail ? 'failing' : 'passing', results: all };
  }

  // ── Earned-gating shape ────────────────────────────────────────────────
  const byIndex = new Map();
  for (const f of parsed) byIndex.set(Number(f.index) || 0, f);

  const rows = [];
  const missingGraduated = [];
  const missingAdvisory = [];
  let blockingFailures = 0;
  let advisoryFailures = 0;
  let passed = 0;

  for (const d of dispatched) {
    const frame = byIndex.get(Number(d.index) || 0);
    const graduated = !!d.graduated;
    if (!frame) {
      (graduated ? missingGraduated : missingAdvisory).push(d);
      continue;
    }
    const pass = frame.status === 'pass';
    if (pass) passed += 1;
    else if (graduated) blockingFailures += 1;
    else advisoryFailures += 1;
    rows.push({
      index: Number(d.index) || 0,
      name: String(frame.name || d.name || '').slice(0, CONSOLE_MAX_MSG_LEN),
      path: String(frame.path || d.path || '').slice(0, CONSOLE_MAX_MSG_LEN),
      status: pass ? 'pass' : 'fail',
      // The card renders advisory rows muted with a chip rather than
      // rewriting the name, so the check reads identically whichever power
      // it currently has.
      advisory: pass ? false : !graduated,
      consoleErrors: normalizeConsoleErrors(frame.consoleErrors),
      failureReason: pass ? '' : String(frame.failureReason || '').slice(0, CONSOLE_MAX_MSG_LEN),
    });
  }

  // Nothing at all came back: the container crashed, staging never booted,
  // stdout was lost. Never a verdict.
  if (!rows.length && dispatched.length) {
    return {
      state: 'error', results: extraRows.slice(),
      blockingCount: 0, advisoryCount: 0, passingCount: 0,
      ranCount: 0, declaredCount: dispatched.length,
    };
  }
  if (!rows.length && !dispatched.length && !extraRows.length) {
    return {
      state: 'error', results: [],
      blockingCount: 0, advisoryCount: 0, passingCount: 0,
      ranCount: 0, declaredCount: 0,
    };
  }

  // FAIL CLOSED on a graduated check with no verdict. A check that has
  // earned gating must produce an answer every run — "we ran out of time"
  // is not a pass, and letting the budget silently drop a guard rail would
  // make the deadline a merge bypass.
  if (missingGraduated.length) {
    const names = missingGraduated.slice(0, 3).map((d) => d.name || `check ${(d.index || 0) + 1}`);
    const more = missingGraduated.length > 3 ? ` (+${missingGraduated.length - 3} more)` : '';
    return {
      state: 'error',
      results: rows.concat(extraRows),
      errorDetail: `${missingGraduated.length} merge-blocking check${missingGraduated.length === 1 ? '' : 's'} produced no result: ${names.join(', ')}${more}`,
      blockingCount: blockingFailures, advisoryCount: advisoryFailures, passingCount: passed,
      ranCount: rows.length, declaredCount: dispatched.length,
    };
  }

  // Advisory checks that never reported collapse into a single honest row
  // instead of N indistinguishable "no result" lines.
  if (missingAdvisory.length) {
    const why = sentinel && sentinel.deadline
      ? 'did not finish in the run budget'
      : 'produced no result';
    rows.push({
      index: -1,
      name: `${missingAdvisory.length} check${missingAdvisory.length === 1 ? '' : 's'} ${why}`,
      path: '',
      status: 'fail',
      advisory: true,
      // This one ROW stands for `count` checks. Without it the card's
      // summary line counts rows and quietly under-reports the suite —
      // "239 checks" for a 241-check manifest, which is the same species of
      // silent undercount #1019 exists to remove.
      count: missingAdvisory.length,
      consoleErrors: [],
      failureReason: 'These checks have never been observed passing, so they do not block the merge.',
    });
    advisoryFailures += missingAdvisory.length;
  }

  const results = rows.concat(extraRows);
  const blocking = blockingFailures + extraRows.filter((r) => r && r.status !== 'pass' && !r.advisory).length;
  return {
    state: blocking > 0 ? 'failing' : 'passing',
    results,
    blockingCount: blocking,
    advisoryCount: advisoryFailures,
    passingCount: passed,
    ranCount: rows.length,
    declaredCount: dispatched.length,
  };
}

// A full-ceiling snapshot (400 rows since PR #1125) with console errors
// attached can get large, and
// `test_results` rides along in every proposal payload the API serves. Cap
// the SERIALISED size and shed PASSING rows from the tail first: a passing
// row carries no diagnostic weight (the summary line already counts them),
// while every failure — blocking or advisory — is the reason someone opened
// the card. 256 KB is far above a realistic suite and far below anything
// that would bloat a proposal response.
const TEST_RESULTS_MAX_BYTES = 256 * 1024;

function serializeTestResults(results) {
  const rows = Array.isArray(results) ? results.slice() : [];
  let json = JSON.stringify(rows);
  if (Buffer.byteLength(json, 'utf8') <= TEST_RESULTS_MAX_BYTES) return json;
  let dropped = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (Buffer.byteLength(json, 'utf8') <= TEST_RESULTS_MAX_BYTES) break;
    if (rows[i] && rows[i].status === 'pass') {
      rows.splice(i, 1);
      dropped += 1;
      json = JSON.stringify(rows);
    }
  }
  // Still over after every pass is gone: the failures themselves are the
  // bulk. Truncate them too rather than write a row nobody can read.
  while (rows.length && Buffer.byteLength(json, 'utf8') > TEST_RESULTS_MAX_BYTES) {
    rows.pop();
    dropped += 1;
    json = JSON.stringify(rows);
  }
  if (dropped) {
    log.info('visuals', 'Trimmed oversized test_results payload', { dropped, kept: rows.length });
  }
  return json;
}

// Latest-only checks snapshot, tied to the commit it describes (staleness
// signal for the merge gate). The console_* columns are kept written in
// parallel (deriving an advisory clean/errors/unknown from the same run)
// for one release so a rolling deploy's old readers don't break.
async function storeChecks(pool, sessionId, commitSha, result, errorDetail = null) {
  if (result && result.state === 'error') {
    // A build/boot/capture failure — record a TERMINAL 'error' verdict plus
    // the failure-streak bookkeeping that powers the sweeper's backoff and
    // the owner escalation. Backoff on check_next_retry_at grows
    // 2m → 4m → 8m → 16m → … capped at 30m; it uses the PRE-increment
    // failure count (so the first failure waits ~2m). `errorDetail` is the
    // concise reason (see summarizeBootFailure) — kept across retries via
    // COALESCE so a later retry that fails to collect logs doesn't blank it.
    const write = await pool.query(
      `UPDATE chat_sessions
          SET check_state = $1,
              test_results = $2,
              checks_commit_sha = $3::text,
              checks_checked_at = NOW(),
              check_phase = NULL,
              check_error_detail = COALESCE($5, check_error_detail),
              consecutive_check_failures = consecutive_check_failures + 1,
              first_check_failure_at = COALESCE(first_check_failure_at, NOW()),
              last_check_failure_at = NOW(),
              check_next_retry_at = NOW() + make_interval(
                secs => LEAST(120 * power(2, consecutive_check_failures), 1800)::double precision)
        WHERE id = $4
          AND status IN ('active', 'paused', 'promoted', 'merging')
          AND checks_commit_sha IS NOT DISTINCT FROM $3::text`,
      [result.state, serializeTestResults(result.results), commitSha || null, sessionId, errorDetail]
    );
    return write.rowCount !== 0;
  }
  // A real verdict ('passing' / 'failing'): clear the failure streak so a
  // later transient error starts its backoff fresh, and drop the now-stale
  // error detail / retry schedule / notify stamp.
  const write = await pool.query(
    `UPDATE chat_sessions
       SET check_state = $1, test_results = $2, checks_commit_sha = $3::text, checks_checked_at = NOW(),
           check_phase = NULL,
           check_error_detail = NULL,
           consecutive_check_failures = 0,
           first_check_failure_at = NULL,
           last_check_failure_at = NULL,
           check_next_retry_at = NULL,
           check_error_notified_at = NULL
     WHERE id = $4
       AND status IN ('active', 'paused', 'promoted', 'merging')
       AND checks_commit_sha IS NOT DISTINCT FROM $3::text`,
    [result.state, serializeTestResults(result.results), commitSha || null, sessionId]
  );
  return write.rowCount !== 0;
}

// #461: record an explicit terminal 'skipped' verdict for a proposal whose
// checks genuinely cannot / need not run (branch has no commits beyond main,
// GitHub not configured). The merge gate treats 'skipped' like 'passing', so
// this is the "either run, or skipped from running" half of #461 — before it,
// these paths left check_state NULL and the proposal blocked on "still
// running its tests" forever. `reason` lands in check_error_detail (the same
// column the badge tooltip / gate message already surface). Clears the
// failure-streak bookkeeping exactly like a real passing/failing verdict.
// `expectedCommitSha` is normally the same SHA, but recovery may discover
// that a branch has no commits beyond a newer main commit. In that case it
// atomically replaces the prior pin with the compared base SHA without
// allowing a concurrent newer build to be overwritten.
async function storeChecksSkipped(
  pool, sessionId, commitSha, reason, expectedCommitSha = commitSha
) {
  const write = await pool.query(
    `UPDATE chat_sessions
       SET check_state = 'skipped', test_results = '[]', checks_commit_sha = $1::text,
           checks_checked_at = NOW(),
           check_phase = NULL,
           check_error_detail = $2,
           consecutive_check_failures = 0,
           first_check_failure_at = NULL,
           last_check_failure_at = NULL,
           check_next_retry_at = NULL,
           check_error_notified_at = NULL
     WHERE id = $3
       AND status IN ('active', 'paused', 'promoted', 'merging')
       AND checks_commit_sha IS NOT DISTINCT FROM $4::text`,
    [commitSha || null, reason || null, sessionId, expectedCommitSha || null]
  );
  return write.rowCount !== 0;
}

// Set 'pending' the instant a (re)check starts so a stale 'passing' can't
// slip through the merge gate while the fresh build is being tested.
//
// Reset the failure streak ONLY when a genuinely new commit is being checked.
// A backoff RETRY of the same failing commit also flows through here (every
// captureForSession calls setChecksPending), and zeroing the counter on those
// would defeat the escalation + crash-loop short-circuit — so the streak is
// preserved when checks_commit_sha is unchanged.
//
// `phase` ('building' | 'testing') records WHICH half of the run is in
// flight so the card can name it; anything else is stored as NULL, which is
// the legacy display. It is deliberately a plain assignment rather than
// another CASE arm — the phase describes the run happening right now, not
// the commit, so a backoff retry of the same commit still updates it.
//
// `trigger` records WHY the run started (see CHECK_TRIGGERS). Written on
// every stamp, including as NULL when the caller does not name one, so a
// label can never outlive the run it described.
async function setChecksPending(pool, sessionId, commitSha, phase = null, trigger = null) {
  // $2 is spliced into both an assignment to checks_commit_sha (varchar) and
  // IS DISTINCT FROM comparisons (inferred text). Without the explicit ::text
  // casts postgres refuses to prepare the statement — "inconsistent types
  // deduced for parameter $2: text versus character varying" — which made
  // this UPDATE silently no-op (it's .catch'd non-fatal at every call site)
  // from the day the CASE clauses landed. Stale 'passing'/'error' verdicts
  // then survived into the merge gate while a rebuild was in flight.
  // $3 needs the same explicit ::text treatment as $2 for the same reason —
  // an uncast parameter in this statement is how it silently no-op'd before.
  const write = await pool.query(
    `UPDATE chat_sessions
       SET check_state = 'pending', checks_commit_sha = $2::text, checks_checked_at = NOW(),
           check_phase = $3::text,
           check_trigger = $4::text,
           check_next_retry_at = NULL,
           consecutive_check_failures = CASE WHEN checks_commit_sha IS DISTINCT FROM $2::text
                                             THEN 0 ELSE consecutive_check_failures END,
           first_check_failure_at  = CASE WHEN checks_commit_sha IS DISTINCT FROM $2::text
                                          THEN NULL ELSE first_check_failure_at END,
           check_error_detail      = CASE WHEN checks_commit_sha IS DISTINCT FROM $2::text
                                          THEN NULL ELSE check_error_detail END,
           check_error_notified_at = CASE WHEN checks_commit_sha IS DISTINCT FROM $2::text
                                          THEN NULL ELSE check_error_notified_at END
     WHERE id = $1
       AND status IN ('active', 'paused', 'promoted', 'merging')`,
    [sessionId, commitSha || null, normalizeCheckPhase(phase), normalizeCheckTrigger(trigger)]
  );
  return write.rowCount !== 0;
}

// The two stages a 'pending' run can be in. Anything else (undefined, a
// typo, a value from a newer writer) collapses to NULL — the card's legacy
// wording — rather than rendering an unknown caption.
const CHECK_PHASES = new Set(['building', 'testing']);
function normalizeCheckPhase(phase) {
  return CHECK_PHASES.has(phase) ? phase : null;
}

// Why a check run started. The merge-gate trace used to record trigger
// 'capture' for every single run — the name of the function that opened it,
// which tells a reader nothing. Production runs 1.81 checks per proposal and
// 91 of 204 runs are re-runs; "who asked for this one" is the difference
// between a redundant re-run worth eliminating and a legitimate one.
//
// A closed vocabulary, normalised at the boundary: an unrecognised value
// stores as NULL rather than leaking a caller's private string into the card.
const CHECK_TRIGGERS = new Set([
  'proposal-open',     // the proposal's first run
  'commit-push',       // a new commit landed on the branch
  'sync-main',         // the branch was refreshed from main
  'pr-import',         // an imported GitHub PR moved its head
  'manual-recheck',    // a human pressed "Re-run checks"
  'promote-kick',      // promotion re-ran checks before merging
  'boot-reconcile',    // server boot re-drove an interrupted run
  'stuck-sweep',       // the recovery sweeper re-drove a stalled run
  'fleet-maintenance', // a fleet-wide rebuild
]);
function normalizeCheckTrigger(trigger) {
  return CHECK_TRIGGERS.has(trigger) ? trigger : null;
}

// ── Capture-outcome snapshot (screenshot-reliability spec) ──────────────
// Persist WHAT the capture run produced and WHY anything is missing, so
// "this proposal has no screenshots" stops being unattributable. Latest
// run only, mirroring the checks columns. States:
//   'captured'     — media run, every expected artifact stored
//   'partial'      — media stored, but some artifact failed / was dropped
//   'console_only' — non-UI-affecting range; media intentionally skipped
//   'failed'       — media run produced no usable "after" (or the run threw)
// `detail` is the diagnostics jsonb (see schema.sql). Best-effort at every
// call site — an outcome write must never fail the capture pipeline.
async function storeCaptureOutcome(pool, sessionId, state, detail) {
  await pool.query(
    `UPDATE chat_sessions
        SET capture_state = $1, capture_detail = $2, captured_at = NOW()
      WHERE id = $3`,
    [state, JSON.stringify(detail || {}), sessionId]
  );
}

// Expand the deduped capture-path list into the ordered capture targets:
// EVERY path is shot in BOTH the desktop frame (full media — png/webm/gif)
// and a phone-sized frame (PNG still only). Desktop and mobile land on
// adjacent capture indexes (i*2 / i*2+1) so the rendered rows pair up.
// This supersedes the per-path `@mobile` opt-in (#768): the annotation is
// still parsed and validated, but every route now gets the phone frame
// automatically. Pure so it's unit-testable without the pipeline.
//
// One entry per path, carrying the phone frame as a `companion`. It used to
// emit TWO sibling entries per path, which the container turned into two
// full navigations per side — a two-route proposal loaded 8 pages instead
// of 4 and paid a cold page + networkidle2 wait for each, the single
// biggest cost inside the capture run.
function expandCapturePaths(paths) {
  const out = [];
  (Array.isArray(paths) ? paths : []).forEach((path, i) => {
    out.push({
      index: i * 2,
      path,
      viewport: null,
      still: false,
      // The phone frame is a COMPANION of this target, not a target of its
      // own: the container shoots it by reloading the page it already has
      // open (see shootCompanion in capture/capture.js) instead of opening
      // a second one. Same capture indexes as before — i*2 desktop,
      // i*2+1 mobile — so every renderer, the PR-body block and
      // session_visuals.captured_viewport are untouched; only the number
      // of page loads changes (4 per two-route proposal, not 8).
      companion: { index: i * 2 + 1, viewport: VIEWPORT_MOBILE },
    });
  });
  return out;
}

// Extract a concise, human-readable reason from a staging build/boot failure
// (docker.waitForHealthy attaches containerLogs/containerStatus to the thrown
// error) for storage in check_error_detail + display in the merge gate, the
// proposal thread, and the checks badge tooltip. Prefers the most specific
// error line in the container's boot logs — the app's own crash message, e.g.
// a Postgres "no unique or exclusion constraint matching the ON CONFLICT
// specification" — and falls back to the container status / raw error
// message. Length-bounded so it fits a chat line and a tooltip.
// Implementation moved to services/deploy-failure.js (issue #416) so the
// production deploy paths (app-creator / staging.rebuildProduction) share
// the same error-line extraction; this thin delegate keeps the legacy
// string shape for check_error_detail consumers.
function summarizeBootFailure(err) {
  return require('./deploy-failure').summarizeBootFailure(err);
}

// Map the structured test result onto the legacy advisory console snapshot
// so the dual-written console_* columns stay coherent for one release.
//
// Advisory rows are skipped. The console snapshot's whole meaning is "the
// staging build is clean", and folding in errors from checks that have
// never been observed passing would report a long-broken tail route as if
// this proposal had dirtied the build.
function consoleSnapshotFromTests(result) {
  if (!result || result.state === 'error') return { state: 'unknown', errors: [] };
  const seen = new Set();
  const errors = [];
  for (const r of (result.results || [])) {
    if (r && r.advisory) continue;
    for (const e of (Array.isArray(r.consoleErrors) ? r.consoleErrors : [])) {
      const message = String((e && e.message) || '').slice(0, CONSOLE_MAX_MSG_LEN);
      if (!message || seen.has(message)) continue;
      seen.add(message);
      errors.push({ kind: e.kind || 'console', message, source: e.source || '' });
      if (errors.length >= CONSOLE_MAX_ERRORS) break;
    }
    if (errors.length >= CONSOLE_MAX_ERRORS) break;
  }
  return { state: errors.length ? 'errors' : 'clean', errors };
}

// ── Storage ────────────────────────────────────────────────────────────
// Client shape (#270): an ordered list of capture groups —
//   { captures: [ { index, path, viewport, before: {png,webm,gif}, after: {...} } ] }
// one group per captured route, ascending by capture_index; `viewport` is
// 'mobile' for a `@mobile`-annotated route (#768), null otherwise. A group
// is only kept when it has an "after" artifact (nothing to show otherwise).
// A single-route proposal yields a one-element list, so the common case is
// unchanged in substance — just wrapped. Renderers (pr-metadata.js,
// app-view.js) iterate `captures` and label each row with its `path`.

// Assemble rows ([{kind, media, capture_index, captured_path,
// captured_viewport, id}]) into the ordered { captures: [...] } shape.
// Groups missing an "after" are dropped. Shared by storeArtifacts /
// getForSession / shapeAgg so all three surfaces emit byte-identical
// shapes. Each group's `viewport` is the label it was shot at ('mobile'
// for a `@mobile` path, #768) or null for the desktop default — pre-#768
// rows carry no viewport and land on null.
function groupRows(rows) {
  const byIndex = new Map();
  for (const r of rows) {
    const idx = Number.isInteger(r.index) ? r.index : (parseInt(r.capture_index, 10) || 0);
    let g = byIndex.get(idx);
    if (!g) { g = { index: idx, path: null, viewport: null }; byIndex.set(idx, g); }
    if (!g[r.kind]) g[r.kind] = {};
    g[r.kind][r.media] = r.id;
    const p = r.path || r.captured_path;
    if (p && !g.path) g.path = p;
    const vp = r.viewport || r.captured_viewport;
    if (vp && !g.viewport) g.viewport = vp;
    // A "before" side actually shot at the fallback '/' — renderers caption
    // the pair so the mismatched comparison is explained.
    if (r.kind === 'before' && (r.before_fell_back || r.fellBack)) g.beforeFellBack = true;
  }
  const captures = [];
  for (const idx of Array.from(byIndex.keys()).sort((a, b) => a - b)) {
    const g = byIndex.get(idx);
    if (!g.after) continue; // nothing to show without an "after"
    captures.push({
      index: g.index, path: g.path || '/', viewport: g.viewport || null,
      before: g.before || null, after: g.after,
      // Only present when true so pre-existing shapes stay byte-identical.
      ...(g.beforeFellBack ? { beforeFellBack: true } : {}),
    });
  }
  return captures.length ? { captures } : null;
}

// Latest set per session only: each successful capture deletes the
// session's prior rows and inserts the fresh set inside one transaction.
// Growth is bounded at <= 8 artifacts per capture path (a full-media
// desktop group + a PNG-only mobile group); with CAPTURE_MAX_PATHS paths
// that's <= 24 rows/session ever. `targets` is the ordered capture target
// list ([{ index, path }]) so each row records its capture_index +
// captured_path (the group label). Each row also persists its shot's HTTP
// status and, for a "before", whether it fell back to '/'. `dropped`, when
// provided, collects { kind, media, index, bytes } for every over-cap
// artifact so the caller can persist WHY a recording is missing (the
// capture_detail snapshot) instead of only logging it. Returns the grouped
// shape, or null when nothing usable was stored (no group has an "after").
async function storeArtifacts(pool, sessionId, commitHash, targets, shots, dropped = null) {
  const pathByIndex = new Map();
  const viewportByIndex = new Map();
  for (const t of (Array.isArray(targets) ? targets : [])) {
    pathByIndex.set(t.index, t.path);
    if (t.viewport) viewportByIndex.set(t.index, t.viewport);
  }

  const rows = [];
  for (const s of shots) {
    if (s.buf.length > MAX_BYTES[s.media]) {
      log.warn('visuals', 'Artifact over size cap — dropped', {
        sessionId, kind: s.kind, media: s.media, bytes: s.buf.length, index: s.index,
      });
      if (Array.isArray(dropped)) {
        dropped.push({ kind: s.kind, media: s.media, index: s.index || 0, bytes: s.buf.length });
      }
      continue;
    }
    const index = Number.isInteger(s.index) ? s.index : 0;
    rows.push({
      id: crypto.randomBytes(16).toString('hex'),
      index,
      capturedPath: pathByIndex.has(index) ? pathByIndex.get(index) : null,
      capturedViewport: viewportByIndex.get(index) || null,
      ...s,
    });
  }
  if (!rows.some((r) => r.kind === 'after')) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM session_visuals WHERE session_id = $1', [sessionId]);
    for (const r of rows) {
      await client.query(
        `INSERT INTO session_visuals (id, session_id, commit_hash, kind, media, content_type, data, captured_path, capture_index, captured_viewport, shot_status, before_fell_back)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [r.id, sessionId, commitHash || null, r.kind, r.media, CONTENT_TYPES[r.media], r.buf, r.capturedPath || null, r.index, r.capturedViewport,
          Number.isInteger(r.status) && r.status > 0 ? r.status : null,
          r.kind === 'before' && !!r.fellBack]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return groupRows(rows.map((r) => ({
    kind: r.kind, media: r.media, id: r.id, index: r.index,
    captured_path: r.capturedPath, captured_viewport: r.capturedViewport,
    fellBack: r.fellBack,
  })));
}

// Shape a session's stored artifact ids for clients into the grouped
// { captures: [...] } form (ascending by capture_index). Used by GET
// /api/sessions/:id (history reloads) and exported for any other surface
// that wants the same shape. Pre-#270 rows all carry capture_index 0, so
// they collapse into a single legacy group — back-compatible by default.
async function getForSession(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT id, kind, media, captured_path, capture_index, captured_viewport, before_fell_back FROM session_visuals WHERE session_id = $1`,
    [sessionId]
  );
  if (!rows.length) return null;
  return groupRows(rows);
}

// Shape the jsonb_object_agg(...) form produced by the /promoted
// vote-panel query into the grouped client shape. The agg key is
// `kind_index_media` (#270); the legacy `kind_media` key (pre-#270 stored
// rows, or an older query) is also accepted, mapping to capture group 0.
// The agg VALUE is either a bare artifact id string (legacy query) or an
// object { id, path, viewport, fellBack } (current query) — the object
// form carries the group label, frame, and before-fallback flag so the
// vote-panel tiles render real path labels and the fallback caption.
function shapeAgg(agg) {
  if (!agg || typeof agg !== 'object') return null;
  const rows = [];
  for (const [key, val] of Object.entries(agg)) {
    const id = (val && typeof val === 'object') ? val.id : val;
    if (typeof id !== 'string' || !id) continue;
    const extra = (val && typeof val === 'object')
      ? {
        captured_path: val.path || null,
        captured_viewport: val.viewport || null,
        fellBack: !!val.fellBack,
      }
      : {};
    let m = key.match(/^(before|after)_(\d+)_(png|webm|gif)$/);
    if (m) {
      rows.push({ kind: m[1], index: parseInt(m[2], 10) || 0, media: m[3], id, ...extra });
      continue;
    }
    m = key.match(/^(before|after)_(png|webm|gif)$/);
    if (m) rows.push({ kind: m[1], index: 0, media: m[2], id, ...extra });
  }
  return groupRows(rows);
}

// ── PR body patch ──────────────────────────────────────────────────────
// Targeted text patch for the interactive ordering (PR exists before the
// capture finishes): fetch the live body, replace/append the
// marker-delimited block, write it back, and stamp pr_visuals_applied so
// the next applyPrMetadata turn sees an up-to-date snapshot.
async function patchPrBody(pool, session, repoOwner, repoName, block) {
  const pr = await github.getPR(repoOwner, repoName, session.pr_number);
  const body = pr.body || '';
  const next = prMetadata.upsertVisualsBlock(body, block);
  if (next !== body) {
    await github.updatePR(repoOwner, repoName, session.pr_number, { body: next });
  }
  await pool.query(
    `UPDATE chat_sessions SET pr_visuals_applied = $1 WHERE id = $2`,
    [block || null, session.id]
  );
}

// One capture in flight per session — a fast follow-up turn that rebuilds
// staging while the previous capture is still shooting can't run
// concurrently (they'd race on the latest-set-per-session delete/insert).
//
// It used to just SKIP, which silently dropped the newer commit's
// screenshots: the stored set stayed the older run's, and nothing ever
// re-ran (screenshot-reliability spec, improvement 5). Now the skip
// RE-QUEUES: the session id is parked in _queued with the newer run's
// arguments, and the in-flight run re-drives it exactly once from its
// finally block. Depth is capped at one per session (a later request
// overwrites the parked args — the freshest commit is the one worth
// shooting), so a burst of rebuilds can never fan out into a queue.
const _inFlight = new Set();
const _queued = new Map();

function captureKey(sessionId) {
  return String(sessionId);
}

// Shared local/web proposal submission uses this to avoid adopting a new
// commit while an older revision can still write screenshots or checks.
// Include the depth-one queue: after a newer web build supersedes an active
// capture, that queued run is still part of the current proposal pipeline.
function hasInFlightCapture(sessionId) {
  const key = captureKey(sessionId);
  return _inFlight.has(key) || _queued.has(key);
}

// Main entry point. Fire-and-forget from the staging-success sites
// (routes/sessions.js interactive + headless tails, routes/votes.js
// post-promote clone build) — always AFTER staging_ready is sent so the
// preview button is never delayed. Never throws.
//
// `send` (optional) is the turn's SSE/bus emitter; when absent (promote
// path) we publish straight to the session bus + global WS so open
// clients still upgrade in place.
// Resolve the capture pixel density from an apps row (issue #360).
// 1 only when the app explicitly opted out via dapp.json's
// `screenshot.deviceScaleFactor: 1` (persisted on
// apps.screenshot_device_scale); everything else — including a missing
// row/column — defaults to 2× (HiDPI).
function resolveCaptureScale(row) {
  return row && row.screenshot_device_scale === 1 ? 1 : 2;
}

// #451: re-drive the app-level auto-merge drain after a proposal's checks
// reach a terminal verdict, so a PR that already had a winning vote merges
// the moment its checks turn green (the "checks were the last thing to pass"
// ordering the vote-triggered path never covered). A no-op unless the verdict
// is 'passing' (or, since #461, 'skipped' — the gate treats both as
// non-blocking), GitHub is wired up (staging / standalone runs have nothing
// to merge), and the session is STILL 'promoted' — the capture can take
// minutes, so we re-read the row rather than trust the in-memory snapshot
// (it may have been voted, force-merged, or archived meanwhile). The drain
// owns all the real gating (majority, locked-app admin-yes, behind-main,
// check_state, the atomic promoted→merging claim); this is purely an extra
// trigger, never a second merge path. Fire-and-forget and best-effort: any
// failure is logged, never thrown, so the capture pipeline's contract is
// unchanged.
function maybeAutoMergeAfterChecks(config, pool, session, state) {
  if ((state !== 'passing' && state !== 'skipped') || !github.isEnabled()) return;
  pool.query(
    `SELECT status, app_id FROM chat_sessions WHERE id = $1`,
    [session.id]
  ).then(({ rows }) => {
    const fresh = rows[0];
    if (!fresh || fresh.status !== 'promoted' || fresh.app_id == null) return undefined;
    // Lazy require: conflict-resolver lazy-requires routes/votes, which
    // requires this module — a top-level import would close the cycle. By
    // call time the module graph is fully settled.
    const { checkAndResolveConflicts } = require('./conflict-resolver');
    return checkAndResolveConflicts(config, { app_id: fresh.app_id });
  }).catch((err) => {
    log.warn('visuals', 'Post-checks auto-merge drain failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    });
  });
}

// #866: which git ref identifies this session's code in the app's OWN repo.
// Ordinary native rows push their work to a platform-owned branch, so the
// branch name resolves. Two sources require an immutable commit instead:
// imported PRs may be fork-headed (their branch name need not exist in the
// base repo), and native CLI handoffs allow the local checkout to push the
// managed branch directly while an older capture is running. Pin both to the
// recorded/build SHA so changed-file detection and dapp.json test discovery
// describe the same code as the staging container and terminal verdict.
function sessionGitRef(session, commitHash) {
  if (session && session.source === 'imported') {
    return session.imported_pr_head_sha || commitHash || null;
  }
  if (session && session.source === 'cli_handoff') {
    return commitHash || session.checks_commit_sha || session.handoff_head_sha || null;
  }
  return (session && session.branch_name) || null;
}

// Is a run for exactly this commit already decided? Reads the row rather than
// trusting the caller's `session` snapshot, which may have been selected
// minutes earlier and several runs ago.
//
// 'passing' only. A 'failing' row is NOT skipped: the retry machinery, the
// sweeper and a human pressing Re-run all legitimately re-drive a failure,
// and a flaky failure that never gets a second chance is a stuck proposal.
async function checksAlreadyDecided(pool, sessionId, commitHash) {
  if (!commitHash) return false;
  try {
    const { rows } = await pool.query(
      'SELECT check_state, checks_commit_sha FROM chat_sessions WHERE id = $1', [sessionId]
    );
    const row = rows[0];
    return !!row && row.check_state === 'passing' && row.checks_commit_sha === commitHash;
  } catch (err) {
    // Unreadable state means RUN, never skip — a skipped run leaves the gate
    // reading whatever was there before.
    log.warn('visuals', 'Redundancy probe failed — running checks anyway', {
      sessionId, err: err.message,
    });
    return false;
  }
}

// `trigger` names why this run started (see CHECK_TRIGGERS) and rides into
// both the merge-debug trace and chat_sessions.check_trigger.
//
// `force` runs the suite even when the row already reads 'passing' for this
// exact commit. The callers that set it are the ones where a fresh verdict is
// the whole point of the request — a human pressing "Re-run checks", and the
// promote-time kick that must not merge on a verdict it did not just take.
async function captureForSession(config, session, app, commitHash, stagingResult, opts = {}) {
  const { send, trigger = null, force = false } = opts || {};
  const key = captureKey(session.id);
  if (_inFlight.has(key)) {
    // Re-queue instead of dropping: park the NEWER run's arguments (latest
    // wins, depth 1) for the in-flight run's finally block to re-drive.
    // `send` is deliberately NOT carried over — by the time the queued run
    // fires, the requesting turn's SSE stream is long closed, so the queued
    // run publishes via the session bus + global WS instead.
    _queued.set(key, { config, session, app, commitHash, stagingResult, trigger, force });
    log.info('visuals', 'Capture already in flight — re-queued for after it finishes', {
      sessionId: session.id, commitHash: commitHash || null, trigger,
    });
    return;
  }
  _inFlight.add(key);
  const pool = getPool(config);

  // ── Skip a provably redundant run (#1144) ──
  //
  // Production runs 1.81 checks runs per proposal — 91 of 204 are re-runs —
  // and each one is ~106s of a merge gate a human is waiting behind. Several
  // of those callers fire unconditionally on a path that also runs for
  // reasons unrelated to the commit (a boot reconcile, the stuck sweeper, a
  // second staging build of an unchanged head), so they re-tested a commit
  // whose verdict was already recorded and could not change.
  //
  // The bar is deliberately narrow: same session, same commit, already
  // 'passing'. That combination cannot produce new information — the suite is
  // run against a build of that exact tree. Anything else runs.
  if (!force && await checksAlreadyDecided(pool, session.id, commitHash)) {
    log.info('visuals', 'Checks already passing for this commit — skipping redundant run', {
      sessionId: session.id, commitHash, trigger,
    });
    _inFlight.delete(key);
    drainQueued(key, session.id, commitHash, null);
    return;
  }

  // Per-run timing trace (kind='checks'). Nothing recorded how long a checks
  // run took, so diagnosing the slowdown that motivated this meant reading a
  // few hundred lines of container log before they rotated away. This is the
  // one chokepoint every verdict flows through, so the run is opened here and
  // the build half's phases are replayed from stagingResult.timings (absent
  // when the caller reused a live preview — then the trace is capture-only).
  // Best-effort throughout: merge-debug's helpers no-op on a null runId and
  // never throw, so tracing can't fail a capture.
  const runStartedAt = Date.now();
  const mergeDebug = require('./merge-debug');
  const debugRunId = await mergeDebug.startRun(pool, {
    appId: app.id, sessionId: session.id, prNumber: session.pr_number || null,
    // Every run used to record trigger='capture' — the name of this function.
    // With the real trigger, the same trace query that measures re-run COUNT
    // can finally attribute it.
    kind: 'checks', trigger: normalizeCheckTrigger(trigger) || 'capture',
  });
  const traceStep = (phase, message, detail) =>
    mergeDebug.step(pool, debugRunId, { phase, message, detail });
  // Verdict the trace closes on. A checks run ends on its suite's outcome
  // ('passing' | 'failing' | 'skipped' | 'error') rather than a merge
  // outcome; 'error' is the default so a run that throws before reaching a
  // verdict is not left reading 'running' forever.
  let traceStatus = 'error';
  try {
    const buildTimings = (stagingResult && stagingResult.timings) || null;
    if (buildTimings) {
      if (buildTimings.sourceFetchMs != null) {
        // Everything before the image build: the shallow clone of the branch,
        // its submodules, and the manifest/secrets gating. It was the one leg
        // of the build half with no phase of its own, so its cost showed up
        // only as the gap between the run's start and its first step — which
        // is exactly where an unexplained regression hides.
        traceStep('source_fetch', 'Branch source fetched', { durationMs: buildTimings.sourceFetchMs });
      }
      if (buildTimings.imageBuildMs != null) {
        traceStep('image_build', 'Staging image built', { durationMs: buildTimings.imageBuildMs });
      }
      if (buildTimings.cloneMs != null) {
        // Historically the single largest phase of the whole run: a full
        // logical dump/restore of the app's database. See
        // db-manager.privateDataExclusions for what shrank it.
        traceStep('clone', 'Preview database cloned', { durationMs: buildTimings.cloneMs });
      }
      if (buildTimings.healthMs != null) {
        traceStep('staging_health', 'Preview answered its healthcheck', { durationMs: buildTimings.healthMs });
      }
    }
    const [, repoOwner, repoName] = (app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];

    // #47: mark the checks 'pending' for this commit the moment the run
    // starts, so the merge gate (votes.checkAndMerge) can't act on a stale
    // 'passing' while the fresh build is being tested. Best-effort.
    // Phase 'testing': the staging preview is already up by the time capture
    // starts, so everything from here is the suite running against it.
    await setChecksPending(pool, session.id, commitHash, 'testing', trigger).catch((err) => {
      log.warn('visuals', 'setChecksPending failed (non-fatal)', { sessionId: session.id, err: err.message });
    });
    // #607: flip open clients' badges to "Checks running…" right away —
    // the terminal notifyChecks below can be minutes out.
    notifyChecksPending(session.id, commitHash, 'testing', trigger);

    // Heuristic gate. If the compare call fails, default to capturing —
    // staging exists, and a wasted screenshot is cheaper than a missed one.
    let uiAffecting = true;
    const gitRef = sessionGitRef(session, commitHash);
    if (github.isEnabled() && repoOwner && repoName && gitRef) {
      try {
        const files = await github.listChangedFiles(
          repoOwner, repoName, `main...${gitRef}`
        );
        uiAffecting = isUiAffecting(files);
      } catch (err) {
        log.warn('visuals', 'Changed-file compare failed — defaulting to capture', {
          sessionId: session.id, err: err.message,
        });
      }
    }
    // #381: the headless run now ALWAYS happens so every proposal gets a
    // console-error check. The UI-affecting heuristic only decides whether
    // to also shoot the before/after media (the expensive part) — when
    // it's false we run a lightweight console-only pass (MEDIA=0): navigate
    // just the staging "after" target(s), collect console errors, skip
    // screenshots/recordings and the prod "before" leg.
    const media = uiAffecting;
    if (!media) {
      log.info('visuals', 'No frontend files in commit range — console-only check', {
        sessionId: session.id, ref: gitRef,
      });
    }

    await ensureCaptureImage();

    // Capture identity: sign every target visit as the seeded non-admin
    // usernode-capture user so screenshots show the real logged-in app
    // instead of the login screen. Strictly best-effort — a missing row
    // (migration not yet run) degrades to unauthenticated capture, never
    // a failed one. JWT payload mirrors /api/iframe-token (server.js):
    // child apps verify it in prod and staging, and the self-app staging
    // clone exchanges it for a local session via middleware/auth.js.
    let captureUser = null;
    let captureToken = '';
    try {
      const { rows } = await pool.query(
        'SELECT id, username, usernode_pubkey FROM users WHERE username = $1',
        [CAPTURE_USERNAME]
      );
      captureUser = rows[0] || null;
      if (captureUser) {
        captureToken = mintCaptureToken(captureUser, app.id);
      } else {
        log.warn('visuals', 'Capture user missing — capturing unauthenticated', {
          sessionId: session.id, username: CAPTURE_USERNAME,
        });
      }
    } catch (err) {
      log.warn('visuals', 'Capture user lookup failed — capturing unauthenticated', {
        sessionId: session.id, err: err.message,
      });
    }

    // #47: the proposal-checks ASSERTION suite signs its per-test
    // navigations as a separate VIEW-ONLY admin (usernode-capture-admin,
    // seeded in migrate.js) so the admin-only check routes (/admin,
    // /dashboard) render their gated content instead of "Admin access
    // required". Kept distinct from captureToken because test frames are
    // pass/fail + console errors only — never a published image — so this
    // admin visibility leaks nothing public, whereas the non-admin
    // captureToken still signs every screenshot. Degrades gracefully:
    // falls back to captureToken (then to unauthenticated when even that
    // is absent), never throws.
    let adminToken = '';
    try {
      const { rows } = await pool.query(
        'SELECT id, username, usernode_pubkey FROM users WHERE username = $1',
        [CAPTURE_ADMIN_USERNAME]
      );
      const adminUser = rows[0] || null;
      if (adminUser) {
        adminToken = mintCaptureToken(adminUser, app.id);
      } else {
        log.warn('visuals', 'Capture admin user missing — tests run as non-admin capture user', {
          sessionId: session.id, username: CAPTURE_ADMIN_USERNAME,
        });
      }
    } catch (err) {
      log.warn('visuals', 'Capture admin lookup failed — tests run as non-admin capture user', {
        sessionId: session.id, err: err.message,
      });
    }
    // Screenshots keep the non-admin token; tests prefer the admin token.
    const { screenshotToken, testsToken } = selectCaptureTokens({ captureToken, adminToken });

    // Capture routes, reached directly over the shared docker network —
    // same access model waitForHealthy uses, bypassing Caddy's forward-auth
    // gate. The routes are the validated testing_paths list (#270), falling
    // back to [testing_path || '/'] for pre-#270 rows; each entry
    // normalized via normalizeStoredPath (#768 — pre-#768 rows hold plain
    // strings), deduped by PATH alone (every route now gets both the
    // desktop and the phone frame automatically, so a legacy `@mobile`
    // duplicate collapses), capped at CAPTURE_MAX_PATHS, always non-empty
    // (a change with nothing to point at still shoots '/').
    //
    // pathDefaulted records that the agent emitted NO testing path at all —
    // the shots default to '/' and may show a screen the change never
    // touched. Persisted in capture_detail so the rate is trackable.
    const pathDefaulted = !(Array.isArray(session.testing_paths) && session.testing_paths.length)
      && !session.testing_path;
    const capturePaths = (() => {
      const raw = (Array.isArray(session.testing_paths) && session.testing_paths.length)
        ? session.testing_paths
        : [session.testing_path || '/'];
      const seen = new Set();
      const out = [];
      for (const p of raw) {
        const v = normalizeStoredPath(p);
        if (!v || seen.has(v.path)) continue;
        seen.add(v.path);
        out.push(v.path);
        if (out.length >= CAPTURE_MAX_PATHS) break;
      }
      return out.length ? out : ['/'];
    })();

    const kubernetesCapture = config.captureRuntime === 'kubernetes';
    const appNamespace = config.kubernetes?.appNamespace || 'social-apps';
    const stagingName = stagingResult?.runtimeName || session.staging_runtime_name
      || `usernode-staging-${app.slug}--${session.id}`;
    const isSelfApp = app.slug === config.selfAppSlug;
    const prodName = app.runtime_name || beforeContainerName(config, app.slug);
    const prodRuntimeKind = app.runtime_kind || 'docker';
    const prodRunning = (await applicationRuntime.status(config, {
      runtimeKind: prodRuntimeKind, runtimeName: prodName,
    })) === 'running';
    const stagingOrigin = kubernetesCapture
      ? `http://${stagingName}.${appNamespace}.svc.cluster.local:3000`
      : `http://${stagingName}:3000`;
    const prodOrigin = kubernetesCapture && prodRuntimeKind === 'kubernetes'
      ? `http://${prodName}.${appNamespace}.svc.cluster.local:3000`
      : `http://${prodName}:3000`;

    // Self-app "before" auth: the production platform never honours the
    // query token by design (replay protection — middleware/auth.js gates
    // the iframe-JWT path on USERNODE_ENV === 'staging'). For the self-app,
    // `pool` IS the platform's own DB, so mint ONE transient sessions-table
    // cookie for the capture user and reuse it across every before-path
    // (same origin, same TTL); deleted once in the finally below, with the
    // short expiry as the backstop if the process dies.
    let beforeCookie = '';
    let beforeSessionToken = '';
    if (media && prodRunning && isSelfApp && captureUser) {
      try {
        beforeSessionToken = crypto.randomBytes(32).toString('hex');
        await pool.query(
          'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
          [beforeSessionToken, captureUser.id, new Date(Date.now() + CAPTURE_AUTH_TTL_MS)]
        );
        beforeCookie = `session=${beforeSessionToken}`;
      } catch (err) {
        beforeSessionToken = '';
        log.warn('visuals', 'Capture session-cookie mint failed — "before" unauthenticated', {
          sessionId: session.id, err: err.message,
        });
      }
    }

    // One capture target per path (expandCapturePaths), each carrying the
    // phone frame as a companion still: the desktop frame gets the full
    // media set, the phone frame a PNG shot from the same reloaded page.
    // The "after" (staging) target always exists; the "before"
    // (prod) target only when prod is running. A newly-added deep page 404s
    // on prod, so each before-target falls back to '/' (capture.js retries
    // and tags the frames fellback=1) — "before" shows the prior root state
    // rather than an error page. Child-app prod verifies the query token
    // directly (scaffold middleware); the self-app uses the minted cookie.
    //
    // Self-app (#353): the visited path is normalised into a `#`-fragment
    // deep link so the hash-routed SPA renders the changed screen instead
    // of the home feed. For a fragment target the server pathname is
    // always '/', so prod never 404s on a deep page — the '/' fallback is
    // moot and skipped (the bare-'/' and standalone-page cases keep it).
    const targets = expandCapturePaths(capturePaths).map((entry) => {
      const p = entry.path;
      const mobile = entry.viewport === VIEWPORT_MOBILE;
      const visitPath = isSelfApp ? selfAppHashPath(p) : p;
      const isFragmentTarget = visitPath.startsWith('/#');
      const afterUrl = withToken(`${stagingOrigin}${visitPath}`, screenshotToken);
      let beforeUrl = '';
      let beforeFallbackUrl = '';
      if (media && prodRunning) {
        if (isSelfApp) {
          beforeUrl = `${prodOrigin}${visitPath}`;
          if (p !== '/' && !isFragmentTarget) beforeFallbackUrl = `${prodOrigin}/`;
        } else {
          beforeUrl = withToken(`${prodOrigin}${visitPath}`, screenshotToken);
          if (p !== '/') beforeFallbackUrl = withToken(`${prodOrigin}/`, screenshotToken);
        }
      }
      return {
        index: entry.index, path: p, afterUrl, beforeUrl, beforeFallbackUrl,
        still: entry.still,
        viewport: mobile ? VIEWPORT_MOBILE : null,
        viewportPixels: mobile ? MOBILE_VIEWPORT : null,
        // The phone-frame still shot from this target's own page. Same
        // capture index the sibling target used to carry, so the stored
        // artifact lands in exactly the same rendered row.
        companion: entry.companion
          ? { index: entry.companion.index, viewportPixels: MOBILE_VIEWPORT }
          : null,
        beforeCookie: (beforeUrl && isSelfApp) ? beforeCookie : '',
        // Plumbed for symmetry; unused today (the after side always
        // authenticates via the query token).
        afterCookie: '',
      };
    });

    // Pixel density for the shots (issue #360). Default 2× (HiDPI), with
    // a per-app 1× opt-out persisted on apps.screenshot_device_scale by
    // the deploy-time reconcile (app-manifest.reconcileAppScreenshot).
    // Read fresh from the DB so we don't depend on the width of the `app`
    // row the caller happened to pass; an unreadable/absent value falls
    // back to 2× (the capture container also defaults to 2× regardless).
    let deviceScaleFactor = 2;
    try {
      const { rows } = await pool.query(
        'SELECT screenshot_device_scale FROM apps WHERE id = $1', [app.id]
      );
      deviceScaleFactor = resolveCaptureScale(rows[0]);
    } catch (err) {
      log.warn('visuals', 'Screenshot-scale lookup failed — defaulting to 2×', {
        sessionId: session.id, err: err.message,
      });
    }

    // #47: resolve the proposal's automated test suite. Declared tests live
    // in the branch's dapp.json `tests` array (fetched from GitHub so we
    // don't depend on the now-deleted staging clone). When none are
    // declared we synthesize the baseline — one "loads with no console
    // errors" test per capture path — so every proposal gets at least the
    // #381 coverage. Each test's route is resolved to the same staging
    // origin + token (and self-app hash normalisation) as the after target.
    const declared = await resolveDeclaredTests(repoOwner, repoName, gitRef);
    const declaredTests = declared.tests;
    const tests = (declaredTests.length
      ? declaredTests
      : capturePaths.map((p) => ({ name: `Loads ${p}`, path: p, expectSelector: '', expectText: '', allowConsoleErrors: false }))
    ).map((t, index) => {
      const visitPath = isSelfApp ? selfAppHashPath(t.path) : t.path;
      return {
        index,
        name: t.name,
        path: t.path,
        // Tests sign as the view-only-admin so admin-gated check routes
        // render; screenshots (TARGETS) keep the non-admin captureToken.
        url: withToken(`${stagingOrigin}${visitPath}`, testsToken),
        expectSelector: t.expectSelector || '',
        expectText: t.expectText || '',
        allowConsoleErrors: !!t.allowConsoleErrors,
      };
    });

    // Earned gating (#1019). Every declared check runs on every build, but a
    // check only BLOCKS the merge once this app has been observed passing it
    // — otherwise switching a long-neglected tail of checks on would block
    // the next proposal on hundreds of failures it did not cause.
    //
    // The SYNTHESIZED baseline suite (no declared tests) is exempt: it keeps
    // the pre-#1019 all-blocking semantics, because it is one "loads without
    // console errors" check per capture path and has always gated.
    let dispatched = null;
    if (declaredTests.length) {
      try {
        // First run for this app pre-graduates the head the merge gate used
        // to enforce, so turning this on never OPENS a gate that was closed.
        await checkHistory.bootstrapIfEmpty(pool, app.id, declaredTests);
        const graduated = await checkHistory.loadGraduated(pool, app.id);
        dispatched = tests.map((t) => {
          const key = appManifest.checkKey(t.name, t.path);
          return {
            index: t.index, checkKey: key, name: t.name, path: t.path,
            graduated: graduated.has(key),
          };
        });
      } catch (err) {
        log.warn('visuals', 'Check-history lookup failed — legacy gating for this run', {
          sessionId: session.id, err: err.message,
        });
        dispatched = null;
      }
    }

    // Repo unit suite (aggregate `npm test` check). Launched BEFORE the
    // capture container and awaited after it, so the suite runs in its own
    // one-shot container CONCURRENTLY with the browser checks and adds
    // ~zero wall clock unless it outlasts the whole capture run. The
    // .catch collapses every failure mode to null (no row) — the checks
    // run must never die because the unit-suite runner did.
    const unitSuitePromise = unitSuite.maybeRunUnitSuite({
      pool, appId: app.id, sessionId: session.id,
      repoOwner, repoName, ref: gitRef,
      prNumber: Number(session.pr_number) || null,
    }).catch((err) => {
      log.warn('visuals', 'Unit-suite check failed to run (non-fatal)', {
        sessionId: session.id, err: err.message,
      });
      return null;
    });

    log.info('visuals', 'Starting capture', {
      sessionId: session.id, slug: app.slug, before: media && prodRunning,
      paths: capturePaths, pathDefaulted, targets: targets.length,
      authenticated: !!captureToken, selfApp: isSelfApp, deviceScaleFactor, media,
      tests: tests.length, declaredTests: declaredTests.length,
      blocking: dispatched ? dispatched.filter((d) => d.graduated).length : tests.length,
    });
    let stdout;
    let runPartial = false;
    let runPartialReason = '';
    const captureStartedAt = Date.now();
    try {
      // #47 payload routing: a Linux exec caps any single argv/env string at
      // 128KB (MAX_ARG_STRLEN). A manifest-scale suite — this repo's own 232
      // checks, each carrying a tokenized staging URL — exceeds that as one
      // `-e TESTS=...` string, and the docker spawn dies with E2BIG before
      // the container starts (that was every self-app proposal fail-closing
      // to "Checks couldn't run"). Large suites ride the container's stdin
      // instead (TESTS='@stdin' marker; docker.runOneShot pipes it); small
      // ones keep the env var, which older capture images also understand.
      const testsJson = JSON.stringify(tests);
      const testsViaStdin = testsJson.length > 90 * 1024;
      let res;
      const captureEnv = {
          // Multi-target protocol (#270). The container loops over these
          // sequentially and tags each shot frame with its index=. The
          // optional per-target `viewport` (#768) is the resolved pixel
          // frame ({ width, height }) for a `@mobile` path; absent →
          // the container's desktop default. An older capture image
          // ignores the extra field (desktop shot) — graceful rolling
          // deploy, same stance as the scalar fallback below.
          TARGETS: JSON.stringify(targets.map((t) => ({
            index: t.index,
            beforeUrl: t.beforeUrl,
            afterUrl: t.afterUrl,
            beforeFallbackUrl: t.beforeFallbackUrl,
            beforeCookie: t.beforeCookie,
            afterCookie: t.afterCookie,
            viewport: t.viewportPixels || undefined,
            // PNG-only phone-frame companion (no recording). An older
            // capture image ignores the field and records anyway —
            // graceful rolling deploy, same stance as `viewport`.
            still: t.still || undefined,
            // The phone-frame still this target shoots from its own page.
            // An older capture image ignores the field, which costs the run
            // its mobile stills for one rolling deploy but breaks nothing —
            // same stance as `viewport` / `still` above.
            companion: t.companion
              ? { index: t.companion.index, viewport: t.companion.viewportPixels }
              : undefined,
          }))),
          // Scalar single-target fallback (first target) so an older
          // capture image still works during a rolling platform deploy.
          BEFORE_URL: targets[0].beforeUrl,
          AFTER_URL: targets[0].afterUrl,
          BEFORE_FALLBACK_URL: targets[0].beforeFallbackUrl,
          BEFORE_COOKIE: targets[0].beforeCookie,
          AFTER_COOKIE: '',
          // Pixel density (#360). Global to the run — all of a proposal's
          // screens share one density, matching the single shared viewport.
          DEVICE_SCALE_FACTOR: String(deviceScaleFactor),
          // #381: MEDIA=0 → console-only run (no screenshots/recordings,
          // no prod "before"). The console-error check still runs.
          MEDIA: media ? '1' : '0',
          // #47: the proposal's automated test suite (each entry pre-resolved
          // to a staging url + assertions). The container runs these and
          // emits one __USERNODE_TEST__ frame each. '@stdin' → the real
          // payload is on stdin (see testsViaStdin above).
          TESTS: testsViaStdin ? '@stdin' : testsJson,
          // Pool bounds (#1019). An older capture image ignores all three
          // and runs the suite sequentially — slower, but correct, so a
          // rolling deploy degrades rather than breaks.
          TEST_CONCURRENCY,
          TEST_TIMEOUT_MS,
          TESTS_DEADLINE_MS,
      };
      if (kubernetesCapture) {
        ({ stdout, ...res } = await kubernetes.runCaptureJob(config, {
          sessionId: session.id,
          env: captureEnv,
          stdinPayload: testsViaStdin ? testsJson : null,
          timeoutMs: RUN_TIMEOUT_MS,
        }));
      } else {
        ({ stdout, ...res } = await docker.runOneShot(`usernode-capture-${session.id}`, {
          image: CAPTURE_IMAGE,
          env: captureEnv,
          stdinPayload: testsViaStdin ? testsJson : null,
          // Eight concurrent Chromium pages need materially more than the
          // 1g/1cpu one-shot default.
          memory: CAPTURE_MEMORY,
          cpus: CAPTURE_CPUS,
          timeoutMs: RUN_TIMEOUT_MS,
          maxBuffer: RUN_MAX_BUFFER,
        // Improvement 5: the output protocol is a stream of independently
        // parseable frames, so a run killed at RUN_TIMEOUT_MS still carries
        // every frame it already emitted. Salvage them instead of losing the
        // whole proposal's screenshots to one slow page.
          salvagePartial: true,
        }));
      }
      runPartial = !!res.partial;
      runPartialReason = res.partialReason || '';
      if (runPartial) {
        log.warn('visuals', 'Capture run cut short — parsing partial output', {
          sessionId: session.id, reason: runPartialReason,
        });
      }
    } finally {
      if (beforeSessionToken) {
        await pool.query('DELETE FROM sessions WHERE token = $1', [beforeSessionToken])
          .catch((err) => log.warn('visuals', 'Capture session-cookie cleanup failed', {
            sessionId: session.id, err: err.message,
          }));
      }
    }

    const captureMs = Date.now() - captureStartedAt;
    traceStep('capture', 'Capture container finished', {
      durationMs: captureMs,
      targets: targets.length, tests: tests.length, media,
      partial: runPartial || undefined,
      partialReason: runPartialReason || undefined,
    });

    const { shots, failures } = parseShots(stdout);
    for (const f of failures) {
      log.warn('visuals', 'Capture frame failed', { sessionId: session.id, ...f });
    }

    // #47: the test suite result is stored FIRST so it lands even on the
    // console-only path (no media artifacts; storeArtifacts returns early).
    // Best-effort: a missing/partial set degrades to 'error' (the gate
    // blocks fail-closed, the card shows "couldn't run"), never throws.
    // The advisory console_* columns are dual-written from the same run for
    // one release so a rolling deploy's old readers stay coherent.
    const extraRows = [];
    try {
      const overRow = await overCeilingCheckRow(repoOwner, repoName, declared.ceilingDropped);
      if (overRow) extraRows.push(overRow);
    } catch (err) {
      log.warn('visuals', 'Over-ceiling guard failed (non-fatal)', {
        sessionId: session.id, err: err.message,
      });
    }
    // The unit-suite container started before the capture run; by now it
    // has usually been finished for minutes. Its own timeoutMs bounds this
    // await, and the .catch at launch made rejection impossible.
    const unitOutcome = await unitSuitePromise;
    if (unitOutcome) extraRows.push(unitOutcome.row);
    const checksResult = classifyTests(parseTests(stdout), tests.length, dispatched
      ? { dispatched, sentinel: parseTestsDone(stdout), extraRows }
      : { extraRows });
    const blockingCount = Number.isInteger(checksResult.blockingCount)
      ? checksResult.blockingCount
      : checksResult.results.filter((r) => r.status !== 'pass' && !r.advisory).length;
    const advisoryCount = Number.isInteger(checksResult.advisoryCount) ? checksResult.advisoryCount : 0;
    const failingCount = blockingCount;
    traceStatus = checksResult.state;
    traceStep('tests', `Suite verdict: ${checksResult.state}`, {
      state: checksResult.state,
      tests: checksResult.results.length,
      failing: failingCount,
      advisory: advisoryCount || undefined,
      // The suite runs inside the same container invocation as the shots, so
      // this is the whole run's wall clock rather than a tests-only slice.
      durationMs: Date.now() - runStartedAt,
    });
    try {
      const stored = await storeChecks(
        pool, session.id, commitHash, checksResult, checksResult.errorDetail || null
      );
      if (stored) {
        await storeConsoleCheck(
          pool, session.id, consoleSnapshotFromTests(checksResult), commitHash
        );
        // History moves only when the snapshot actually landed: a run whose
        // result was discarded as stale must not graduate anything either.
        // Rows the container never produced are absent here, so a check that
        // did not run neither graduates nor records a failure.
        if (dispatched || unitOutcome) {
          const historyRows = [];
          if (dispatched) {
            const byIndex = new Map(dispatched.map((d) => [d.index, d]));
            for (const r of checksResult.results) {
              const d = byIndex.get(r.index);
              if (!d) continue;
              historyRows.push({
                checkKey: d.checkKey, name: d.name, path: d.path, passed: r.status === 'pass',
              });
            }
          }
          // The unit-suite row graduates through the same history: its
          // first observed pass flips it from advisory to merge-blocking,
          // and (recordRun's COALESCE) no later failure demotes it.
          if (unitOutcome) historyRows.push(unitOutcome.history);
          await checkHistory.recordRun(pool, app.id, historyRows);
        }
        log.info('visuals', 'Checks stored', {
          sessionId: session.id, state: checksResult.state,
          tests: checksResult.results.length,
          failing: failingCount,
          advisory: advisoryCount || undefined,
          durationMs: Date.now() - runStartedAt,
        });
        notifyChecks(session.id, checksResult, commitHash, send);
      } else {
        log.info('visuals', 'Discarded stale checks result', {
          sessionId: session.id, commitHash: commitHash || null,
        });
      }
    } catch (err) {
      log.warn('visuals', 'Checks store failed (non-fatal)', {
        sessionId: session.id, err: err.message,
      });
    }

    // Platform-variables check. Piggybacks on the same recompute trigger
    // as the test suite so the Checks card fills in together, but it is
    // computed from the branch's dapp.json diff, not from this run — a
    // capture failure above leaves the test verdict 'error' while this
    // one still resolves correctly. Display only: the merge gate in
    // routes/votes.js re-evaluates live. Fire-and-forget.
    try {
      // eslint-disable-next-line global-require
      const platformEnvCheck = require('./platform-env-check');
      const { rows: appRows } = await pool.query(
        'SELECT id, repo_url, self_hosted FROM apps WHERE id = $1',
        [session.app_id]
      );
      if (appRows[0]?.self_hosted) {
        const verdict = await platformEnvCheck.refreshPlatformEnvCheck({
          pool,
          app: appRows[0],
          session: session.source === 'cli_handoff'
            ? { ...session, checks_commit_sha: commitHash || null }
            : session,
        });
        if (verdict) {
          log.info('visuals', 'Platform-env check stored', {
            sessionId: session.id, state: verdict.state,
          });
          // Reuse the existing checks_ready broadcast: every client that
          // cares about the Checks card already listens for it and
          // re-fetches the proposal, so a second event type would only
          // add a code path with the same effect.
          notifyChecks(session.id, checksResult, commitHash, null);
        }
      }
    } catch (err) {
      log.warn('visuals', 'Platform-env check failed (non-fatal)', {
        sessionId: session.id, err: err.message,
      });
    }

    // #451: a passing verdict is the *other* half of the merge gate (the
    // first being a winning vote). The vote path already re-drives a merge
    // when a vote lands, but nothing re-drove it when the checks were the
    // last thing to turn green — so a PR that crossed the vote threshold
    // before its checks finished sat in review forever. Re-drive the
    // app-level merge drain so "checks finished after the votes were in"
    // auto-merges just like "votes landed after checks were green".
    // Fire-and-forget; never blocks or fails the capture pipeline.
    maybeAutoMergeAfterChecks(config, pool, session, checksResult.state);

    const dropped = [];
    const stored = await storeArtifacts(pool, session.id, commitHash, targets, shots, dropped);

    // Persist the capture outcome (state + why anything is missing) so a
    // proposal with no / partial screenshots is attributable from the DB
    // instead of from short-lived container logs. Best-effort.
    const captureState = !media
      ? 'console_only'
      : (!stored
        ? 'failed'
        : ((failures.length || dropped.length || runPartial) ? 'partial' : 'captured'));
    const captureDetail = {
      media,
      pathDefaulted,
      prodRunning,
      paths: capturePaths,
      failures: failures.slice(0, 20),
      droppedOverCap: dropped.slice(0, 20),
      beforeFellBack: Array.from(new Set(
        shots.filter((s) => s.kind === 'before' && s.fellBack).map((s) => s.index)
      )),
      // A run killed at the timeout / buffer cap whose already-emitted
      // frames were salvaged (improvement 5) — the stored set is real but
      // knowingly incomplete.
      runCutShort: runPartial ? (runPartialReason || true) : false,
    };
    if (!media) captureDetail.reason = 'No frontend files in commit range — console/tests-only run';
    else if (!stored) captureDetail.reason = 'No usable "after" artifact was produced';
    else if (runPartial) captureDetail.reason = `Capture run cut short (${runPartialReason || 'unknown'}) — partial set stored`;
    await storeCaptureOutcome(pool, session.id, captureState, captureDetail).catch((err) => {
      log.warn('visuals', 'Capture-outcome store failed (non-fatal)', {
        sessionId: session.id, err: err.message,
      });
    });

    if (!stored) {
      if (media) log.warn('visuals', 'No usable "after" artifact — nothing stored', { sessionId: session.id });
      return;
    }

    // Interactive ordering: a PR already exists, so patch its body now.
    // (Headless → lazy-PR ordering is covered by applyPrMetadata's suffix
    // assembly reading session_visuals at promote time.)
    if (session.pr_number && repoOwner && repoName && github.isEnabled()) {
      const block = prMetadata.buildVisualsBlock(stored, caddy.USERNODE_DOMAIN);
      try {
        await patchPrBody(pool, session, repoOwner, repoName, block);
      } catch (err) {
        log.warn('visuals', 'PR body visuals patch failed', {
          sessionId: session.id, pr: session.pr_number, err: err.message,
        });
      }
    }

    notifyVisualsReady(session.id, stored, send);
    log.info('visuals', 'Capture complete', {
      sessionId: session.id,
      artifacts: shots.map((s) => `${s.kind}.${s.media}`).join(','),
      durationMs: Date.now() - runStartedAt,
    });
  } catch (err) {
    traceStep('capture_error', 'Checks run threw', { error: err.message, level: 'error' });
    log.warn('visuals', 'Capture failed (non-fatal)', { sessionId: session.id, err: err.message });
    // The run broke before an outcome could be computed (container build,
    // docker timeout, DB error mid-pipeline) — record a 'failed' capture
    // outcome carrying the error so the absence is attributable.
    await storeCaptureOutcome(pool, session.id, 'failed', {
      reason: String(err.message || 'capture run failed').slice(0, 300),
    }).catch(() => { /* best-effort */ });
    // #47: the capture/test pipeline broke before it could record a
    // verdict. Don't leave the proposal stuck 'pending' forever — record
    // 'error' so the gate blocks fail-closed with a visible "couldn't run"
    // rather than an indefinite spinner. Best-effort.
    try {
      const stored = await storeChecks(pool, session.id, commitHash, { state: 'error', results: [] });
      if (stored) notifyChecks(session.id, { state: 'error', results: [] }, commitHash, send);
    } catch { /* nothing more we can do */ }
  } finally {
    // Close the timing trace whatever happened, so a run never sits at
    // 'running' in the admin view. The total is the figure this exists for:
    // it is what "the checks step got slower" is measured in.
    const totalMs = Date.now() - runStartedAt;
    mergeDebug.endRun(pool, debugRunId, {
      status: traceStatus,
      summary: `checks ${traceStatus} in ${Math.round(totalMs / 1000)}s`,
    });
    _inFlight.delete(key);
    drainQueued(key, session.id, commitHash, traceStatus);
  }
}

// Improvement 5: drain a re-queued capture (a rebuild that arrived while this
// run was shooting). Dispatched detached — awaiting it would hold the finished
// run's call open for the queued run's whole duration, and every caller is
// fire-and-forget. The recursive call re-enters the _inFlight guard normally,
// so a request that lands during the queued run parks itself in turn (still
// depth 1 — latest wins).
//
// `justRanSha` / `verdict` are the run that is releasing the slot. A queued
// run for the SAME commit that has just been given a real verdict is dropped
// (#1144): the two builds are of one tree, and the parked request exists
// because the request ARRIVED late, not because anything changed. That is the
// single most common redundant run in production — a second staging build of
// an unchanged head landing while the first one's suite is still going.
// 'error' and 'skipped' are not verdicts in that sense, so they still drain.
function drainQueued(key, sessionId, justRanSha, verdict) {
  const next = _queued.get(key);
  if (!next) return;
  _queued.delete(key);
  const decided = verdict === 'passing' || verdict === 'failing';
  if (!next.force && decided && justRanSha && next.commitHash === justRanSha) {
    log.info('visuals', 'Dropping re-queued capture — same commit already decided', {
      sessionId, commitHash: justRanSha, verdict, trigger: next.trigger || null,
    });
    return;
  }
  log.info('visuals', 'Draining re-queued capture', {
    sessionId, commitHash: next.commitHash || null, trigger: next.trigger || null,
  });
  // Calling the async function directly claims _inFlight synchronously
  // before its first await. This avoids a one-tick gap where another
  // surface could observe neither an active nor queued capture.
  captureForSession(next.config, next.session, next.app, next.commitHash, next.stagingResult,
    { trigger: next.trigger || null, force: !!next.force })
    .catch((err) => log.warn('visuals', 'Re-queued capture failed (non-fatal)', {
      sessionId, err: err.message,
    }));
}

// #47: fetch the proposal's declared dapp.json `tests` from GitHub (the
// staging clone is gone by now) and normalise via the manifest reader.
// `ref` is anything getFileContent accepts — a branch for native rows, a
// head SHA for imported (possibly fork-headed) ones, see sessionGitRef.
// Returns an empty suite when GitHub is disabled, the file is absent, or
// anything goes wrong — the caller then synthesizes the baseline suite.
//
// The shape is { tests, rawCount, ceilingDropped, ok } rather than a bare
// array because the over-ceiling guard has to tell "the base branch declares
// zero checks" apart from "we could not read the base branch". Both give
// tests.length === 0; only the second must NOT be used as a baseline to
// accuse a proposal of deleting checks. `ok: false` says so explicitly.
async function resolveDeclaredTests(repoOwner, repoName, ref) {
  const empty = (ok) => ({ tests: [], rawCount: 0, ceilingDropped: 0, ok });
  if (!github.isEnabled() || !repoOwner || !repoName || !ref) return empty(false);
  try {
    const raw = await github.getFileContent(repoOwner, repoName, appManifest.MANIFEST_FILENAME, ref);
    // A repo with no dapp.json genuinely declares no checks — that IS a
    // successful read of an empty suite, not a failure.
    if (!raw) return empty(true);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return empty(false); }
    const meta = appManifest.readTestsWithMeta(parsed);
    return { tests: meta.tests, rawCount: meta.rawCount, ceilingDropped: meta.ceilingDropped, ok: true };
  } catch (err) {
    log.warn('visuals', 'Declared-test fetch failed — using baseline', {
      repo: `${repoOwner}/${repoName}`, ref, err: err.message,
    });
    return empty(false);
  }
}

// The declaration ceiling is a real limit, and silently discarding the
// checks past it would be the exact failure this whole change exists to
// end. So when a proposal's manifest declares MORE checks than the reader
// will accept, the run carries one synthesised BLOCKING row saying so.
//
// Two things make it safe to block on:
//
//  * It only fires when the reader actually refused entries for CEILING
//    reasons (`ceilingDropped`), not when it dropped malformed ones. Those
//    are two different complaints and only one of them is about the limit.
//  * It only fires when the head is over the ceiling BY MORE than the base
//    already was. A repo that merged its way over the limit shouldn't block
//    every subsequent unrelated proposal on a pre-existing condition — only
//    the proposal that adds to the overflow answers for it. A base we could
//    not read (`ok: false`) is not evidence of anything, so the guard stays
//    quiet rather than guessing.
async function overCeilingCheckRow(repoOwner, repoName, headCeilingDropped) {
  const over = Number(headCeilingDropped) || 0;
  if (over <= 0) return null;
  const base = await resolveDeclaredTests(repoOwner, repoName, 'main');
  if (!base.ok) {
    log.warn('visuals', 'Over-ceiling guard skipped — base manifest unreadable', {
      repo: `${repoOwner}/${repoName}`, over,
    });
    return null;
  }
  const baseOver = Number(base.ceilingDropped) || 0;
  if (over <= baseOver) return null;
  return {
    index: -2,
    name: `Manifest declares more than ${appManifest.MAX_DECLARED_TESTS} checks`,
    path: appManifest.MANIFEST_FILENAME,
    status: 'fail',
    advisory: false,
    consoleErrors: [],
    failureReason: `${over} declared check${over === 1 ? '' : 's'} past the ${appManifest.MAX_DECLARED_TESTS}-check ceiling were not run (base: ${baseOver}). Remove or consolidate checks so every declared check can run.`,
  };
}

// Capture completes after staging_ready fired, so the staging card needs a
// follow-up event to upgrade in place. Prefer the turn's own `send` (POST
// SSE + global WS + session bus, all dedup'd by _seq client-side); fall
// back to bus + WS directly when no turn is alive (promote-time capture).
let _notifySeq = 0;
function notifyVisualsReady(sessionId, visuals, send) {
  const data = { sessionId, visuals };
  try {
    if (send) {
      send('visuals_ready', data);
      return;
    }
    const event = { type: 'visuals_ready', _seq: `vis${Date.now().toString(36)}-${++_notifySeq}`, ...data };
    sessionBus.publish(sessionId, event);
    const { broadcastGlobal } = require('./ws');
    broadcastGlobal({ type: 'session_event', sessionId, event: 'visuals_ready', ...event });
  } catch (err) {
    log.warn('visuals', 'visuals_ready notify failed', { sessionId, err: err.message });
  }
}

// #47: the per-check WS push lives in notifyChecks below. (The #381
// console-only `console_check_ready` notifier was retired when the
// console check became one test in the suite — clients now listen for
// `checks_ready`.)

// #607: tell open clients a checks run just STARTED so badges flip to the
// spinning "Checks running…" state immediately (proposal creation, manual
// re-run, sweeper retry) instead of waiting minutes for the terminal
// verdict. Always broadcastGlobal (never the turn's `send`) — the pending
// transition matters to every open vote panel / home strip, not just the
// focused dev chat, and app.js's existing `checks_ready` handler already
// refreshes both on any state.
//
// `phase` rides along so a card that re-renders from the event alone shows
// the right stage caption without waiting for its next fetch.
function notifyChecksPending(sessionId, commitSha, phase = null, trigger = null) {
  try {
    const event = {
      type: 'checks_ready',
      _seq: `chk${Date.now().toString(36)}-${++_notifySeq}`,
      sessionId,
      checkState: 'pending',
      failingCount: 0,
      commitSha: commitSha || null,
      checkPhase: normalizeCheckPhase(phase),
      checkTrigger: normalizeCheckTrigger(trigger),
    };
    sessionBus.publish(sessionId, event);
    const { broadcastGlobal } = require('./ws');
    broadcastGlobal({ type: 'session_event', sessionId, event: 'checks_ready', ...event });
  } catch (err) {
    log.warn('visuals', 'checks_pending notify failed', { sessionId, err: err.message });
  }
}

// #47: tell open clients the checks landed so the checks badge upgrades in
// place without a full panel reload. Same emit strategy as
// notifyVisualsReady — prefer the turn's `send`, else bus + global WS.
//
// `failingCount` is the BLOCKING count and nothing else — it drives the
// "Checks failing · N" badge, and a badge that counts advisory failures
// would tell a reviewer their merge is blocked when it isn't. Advisory
// failures ride along separately for surfaces that want to show both.
function notifyChecks(sessionId, result, commitSha, send) {
  const blocking = Number.isInteger(result.blockingCount)
    ? result.blockingCount
    : (result.results || []).filter((r) => r.status !== 'pass' && !r.advisory).length;
  const data = {
    sessionId,
    checkState: result.state,
    failingCount: blocking,
    blockingCount: blocking,
    advisoryCount: Number.isInteger(result.advisoryCount)
      ? result.advisoryCount
      : (result.results || []).filter((r) => r.status !== 'pass' && r.advisory).length,
    commitSha: commitSha || null,
  };
  try {
    if (send) {
      send('checks_ready', data);
      return;
    }
    const event = { type: 'checks_ready', _seq: `chk${Date.now().toString(36)}-${++_notifySeq}`, ...data };
    sessionBus.publish(sessionId, event);
    const { broadcastGlobal } = require('./ws');
    broadcastGlobal({ type: 'session_event', sessionId, event: 'checks_ready', ...event });
  } catch (err) {
    log.warn('visuals', 'checks_ready notify failed', { sessionId, err: err.message });
  }
}

module.exports = {
  captureForSession,
  hasInFlightCapture,
  storeArtifacts,
  getForSession,
  shapeAgg,
  storeCaptureOutcome,
  expandCapturePaths,
  // Exported so the admin /gallery endpoint groups artifacts through the
  // SAME implementation the proposal cards and PR bodies use, instead of a
  // third copy that would drift (routes/gallery.js).
  groupRows,
  parseConsole,
  classifyConsole,
  storeConsoleCheck,
  parseTests,
  parseTestsDone,
  classifyTests,
  serializeTestResults,
  overCeilingCheckRow,
  storeChecks,
  storeChecksSkipped,
  setChecksPending,
  notifyChecksPending,
  checksAlreadyDecided,
  normalizeCheckTrigger,
  CHECK_TRIGGERS,
  summarizeBootFailure,
  maybeAutoMergeAfterChecks,
  consoleSnapshotFromTests,
  resolveDeclaredTests,
  sessionGitRef,
  isFrontendFile,
  isUiAffecting,
  parseShots,
  withToken,
  mintCaptureToken,
  selectCaptureTokens,
  CAPTURE_USERNAME,
  CAPTURE_ADMIN_USERNAME,
  selfAppHashPath,
  beforeContainerName,
  resolveCaptureScale,
  CAPTURE_IMAGE,
  MOBILE_VIEWPORT,
};
