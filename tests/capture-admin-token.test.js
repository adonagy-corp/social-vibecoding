// #47 fix: the proposal-checks ASSERTION suite must run as a view-only
// admin so the admin-gated check routes (/admin, /dashboard) render under
// test, while the public before/after SCREENSHOTS keep signing as the
// non-admin capture user. Two layers, mirroring tests/dashboard-spend-
// distribution.test.js:
//   1. Behavioural — the pure token helpers in src/services/visuals.js
//      (mintCaptureToken / selectCaptureTokens) plus withToken, exercised
//      with a real RSA key pair so the routing + fallback is verifiable.
//      Since the iframe cutover mintCaptureToken's second argument is the
//      app id (the token audience), not a secret.
//   2. Source guards — the read-only-admin capture identity seed contract
//      on src/db/migrate.js (idempotent, is_admin + admin_readonly), and
//      the visuals.js wiring that routes testsToken to the test URLs only.
//
// Run with: node --test tests/capture-admin-token.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');

const visuals = require('../src/services/visuals');
const { mintCaptureToken, selectCaptureTokens, withToken } = visuals;

const APP_ID = 11;
const CAPTURE_USER = { id: 7, username: 'usernode-capture', usernode_pubkey: null };
const ADMIN_USER = { id: 8, username: 'usernode-capture-admin', usernode_pubkey: null };

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
// Decode the `token=` query param out of a capture URL and verify it.
function tokenOf(url) {
  const m = /[?&]token=([^&#]+)/.exec(url);
  return m
    ? platformJwt.verifyAppIdentityToken(decodeURIComponent(m[1]), { appId: APP_ID })
    : null;
}

// ── 1. Behavioural: mintCaptureToken ────────────────────────────────────

test('mintCaptureToken returns "" for a missing user (degrade to unauth)', () => {
  assert.equal(mintCaptureToken(null, APP_ID), '');
  assert.equal(mintCaptureToken(undefined, APP_ID), '');
});

test('mintCaptureToken signs the iframe-token payload shape', () => {
  const tok = mintCaptureToken(ADMIN_USER, APP_ID);
  assert.ok(tok);
  const decoded = platformJwt.verifyAppIdentityToken(tok, { appId: APP_ID });
  assert.equal(decoded.id, 8);
  assert.equal(decoded.username, 'usernode-capture-admin');
  assert.equal(decoded.usernode_pubkey, null);
  // Same authority and purpose as a live iframe token — the capture
  // browser hits the staging container through the ordinary token path.
  assert.equal(decoded.pur, 'iframe');
  assert.equal(decoded.iss, 'usernode');
  assert.deepEqual(decoded.aud, `usernode:app:${APP_ID}`);
  // Short-lived: a capture run is minutes, so the token is 15m, not 1h.
  assert.equal(decoded.exp - decoded.iat, 15 * 60);
});

test('a capture token is scoped to the app it was minted for', () => {
  const tok = mintCaptureToken(ADMIN_USER, APP_ID);
  assert.throws(
    () => platformJwt.verifyAppIdentityToken(tok, { appId: APP_ID + 1 }),
    /audience/i
  );
});

// ── 1. Behavioural: selectCaptureTokens routing + fallback ──────────────

test('selectCaptureTokens: screenshots keep capture token, tests prefer admin token', () => {
  const captureToken = mintCaptureToken(CAPTURE_USER, APP_ID);
  const adminToken = mintCaptureToken(ADMIN_USER, APP_ID);
  const { screenshotToken, testsToken } = selectCaptureTokens({ captureToken, adminToken });
  // Screenshots always sign as the non-admin capture user.
  assert.equal(screenshotToken, captureToken);
  assert.equal(tokenOf(withToken('http://staging:3000/', screenshotToken)).username, 'usernode-capture');
  // Tests sign as the view-only admin so admin routes render.
  assert.equal(testsToken, adminToken);
  assert.equal(tokenOf(withToken('http://staging:3000/admin', testsToken)).username, 'usernode-capture-admin');
  assert.notEqual(screenshotToken, testsToken);
});

test('selectCaptureTokens: missing admin identity falls tests back to capture token', () => {
  const captureToken = mintCaptureToken(CAPTURE_USER, APP_ID);
  const adminToken = mintCaptureToken(null, APP_ID); // ''
  const { screenshotToken, testsToken } = selectCaptureTokens({ captureToken, adminToken });
  assert.equal(testsToken, captureToken);
  assert.equal(screenshotToken, captureToken);
  assert.equal(tokenOf(withToken('http://staging:3000/admin', testsToken)).username, 'usernode-capture');
});

test('selectCaptureTokens: both missing → tests + screenshots unauthenticated', () => {
  const { screenshotToken, testsToken } = selectCaptureTokens({ captureToken: '', adminToken: '' });
  assert.equal(screenshotToken, '');
  assert.equal(testsToken, '');
  // withToken with an empty token leaves the URL unchanged (no ?token=).
  assert.equal(withToken('http://staging:3000/admin', testsToken), 'http://staging:3000/admin');
});

test('exports name both capture identities', () => {
  assert.equal(visuals.CAPTURE_USERNAME, 'usernode-capture');
  assert.equal(visuals.CAPTURE_ADMIN_USERNAME, 'usernode-capture-admin');
});

// ── 2. Source guards: migrate seed contract ─────────────────────────────

test('migrate.js seeds usernode-capture-admin as an idempotent view-only admin', () => {
  const src = read('src/db/migrate.js');
  // The seeder exists and is invoked in the boot migration sequence.
  assert.match(src, /async function seedCaptureAdminUser\(pool\)/);
  assert.match(src, /await seedCaptureAdminUser\(pool\)/);
  // Isolate the function body and pin its contract.
  const body = src.slice(src.indexOf('async function seedCaptureAdminUser'));
  const fn = body.slice(0, body.indexOf('\n}\n') + 2);
  assert.match(fn, /usernode-capture-admin/);
  // View-only admin: is_admin TRUE + admin_readonly TRUE.
  assert.match(fn, /is_admin,\s*admin_readonly,\s*can_create_apps/);
  assert.match(fn, /VALUES\s*\(\$1,\s*\$2,\s*TRUE,\s*TRUE,\s*FALSE\)/);
  // Idempotent: existence check + ON CONFLICT DO NOTHING.
  assert.match(fn, /ON CONFLICT \(username\) DO NOTHING/);
  assert.match(fn, /SELECT id FROM users WHERE username = \$1/);
});

test('owner-scoped declared-check fixtures resolve the exact capture admin', () => {
  const src = read('src/db/migrate.js');
  const helper = src.slice(
    src.indexOf('async function getStagingCheckViewer'),
    src.indexOf('// SELF-HOSTING.md')
  );
  assert.match(helper, /WHERE username = \$1/);
  assert.match(helper, /\['usernode-capture-admin'\]/);
  for (const name of [
    'seedStagingStartScreenSession',
    'seedStagingSavedDrafts',
    'devFlowFixtureContext',
    'seedStagingCcCohortRuns',
    'seedStagingQuickReplyFallback',
    'seedStagingRestartRecoveredPills',
  ]) {
    const start = src.indexOf(`async function ${name}`);
    const next = src.indexOf('\nasync function ', start + 1);
    const fn = src.slice(start, next < 0 ? src.length : next);
    assert.match(fn, /getStagingCheckViewer/, `${name} uses the proposal-check identity`);
  }
});

// ── 2. Source guards: visuals.js routes testsToken to tests only ────────

test('visuals.js signs test URLs with testsToken and screenshots with screenshotToken', () => {
  const src = read('src/services/visuals.js');
  // The test-suite URL uses testsToken.
  assert.match(src, /url:\s*withToken\(`\$\{stagingOrigin\}\$\{visitPath\}`,\s*testsToken\)/);
  // The "after" screenshot keeps the non-admin screenshotToken.
  assert.match(src, /afterUrl\s*=\s*withToken\(`\$\{stagingOrigin\}\$\{visitPath\}`,\s*screenshotToken\)/);
  // testsToken is never wired into the screenshot TARGETS.
  assert.doesNotMatch(src, /beforeUrl\s*=\s*withToken\([^)]*testsToken\)/);
});
