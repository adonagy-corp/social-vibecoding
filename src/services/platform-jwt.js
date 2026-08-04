'use strict';

// Centralized platform token signing / verification.
//
// This module is the ONLY place `jsonwebtoken` is called for a token that
// carries platform authority. It exists because one shared `JWT_SECRET`
// used to sign five unrelated things at once — iframe identities, worker
// tokens, edge grants, access cookies — while also being handed verbatim
// to every app and staging container. Anything running inside a child
// container could therefore mint a credential the platform trusted.
//
// Four independent authorities, four independent keys:
//
//   authority      alg     key                       aud                    pur
//   ─────────────  ─────   ────────────────────────  ─────────────────────  ──────────────
//   app identity   RS256   IFRAME_JWT_PRIVATE_KEY    usernode:app:<appId>   iframe
//                          (verify: …_PUBLIC_KEY)
//   worker         HS256   WORKER_JWT_SECRET         usernode:worker        worker:session
//   edge grant     HS256   EDGE_JWT_SECRET           usernode:edge          edge:grant
//   edge cookie    HS256   EDGE_JWT_SECRET           usernode:edge          edge:cookie
//
// App identity is asymmetric on purpose: containers receive only the
// public key, so they can verify a user token but cannot produce one.
//
// Every sign pins algorithm, issuer, audience, a `pur` (purpose) claim
// and an expiry. Every verify pins the same three registered claims via
// jsonwebtoken options AND re-checks `pur` explicitly, so two tokens
// that share a key (the two edge purposes) are still not
// interchangeable. There is NO legacy branch and no fallback to the
// former shared secret anywhere in this file — a token signed with it
// verifies nowhere.
//
// Keys are read from process.env at call time rather than at import.
// Module load order can precede config.load(), and the middlewares that
// verify worker tokens never receive a config object.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ISSUER = 'usernode';

const AUD_WORKER = 'usernode:worker';
const AUD_EDGE = 'usernode:edge';

const PUR_IFRAME = 'iframe';
const PUR_WORKER = 'worker:session';
// Narrow, purpose-bound worker capabilities (review #2 / #6): the
// general worker:session token is reserved for build/sync mutations. Agent
// subprocesses receive only the capabilities their mode needs: proxy auth,
// issue reads, pushes, or production diagnostics. Keeping these purposes
// distinct matters for Claude scouts because unrestricted read-only Bash can
// inspect its own environment; merely renaming a general token would still
// let it call every endpoint that accepts worker:session.
const PUR_WORKER_PUSH = 'worker:push';
const PUR_ISSUES_READ = 'worker:issues-read';
const PUR_ANTHROPIC_PROXY = 'worker:anthropic-proxy';
const PUR_PROD_DEBUG = 'worker:prod-debug';
const PUR_EDGE_GRANT = 'edge:grant';
const PUR_EDGE_COOKIE = 'edge:cookie';

// Shell iframe tokens live an hour and are refreshed by the shell at 45
// min (public/js/app-view.js). Capture tokens only need to outlive one
// screenshot run. Worker tokens cover a whole chat session. The edge
// grant is one redirect hop; the access cookie is a browsing session.
const IFRAME_TTL = '1h';
const CAPTURE_TTL = '15m';
const WORKER_TTL = '24h';
// Numeric twin of WORKER_TTL for deadline arithmetic. jsonwebtoken accepts
// the human-readable value above, but multiplying "24h" produces NaN and
// caused the Kubernetes journal watcher to detach immediately while the
// coding agent kept running in the worker Pod.
const WORKER_TTL_S = 24 * 60 * 60;
const EDGE_GRANT_TTL_S = 120;
const EDGE_COOKIE_TTL_S = 12 * 60 * 60;

// Audience for an app-scoped identity token. Keyed on `apps.id` — the
// immutable integer PK — never the slug: slugs are mutable through the
// rename-PR flow, so a rename would silently invalidate live tokens or,
// worse, alias two apps onto one audience.
function appAudience(appId) {
  const n = Number(appId);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('platform-jwt: appId must be a positive integer');
  }
  return `usernode:app:${n}`;
}

// PEMs ride the .env file as a single line with literal \n escapes (the
// same convention GITHUB_PRIVATE_KEY already uses) so the deploy
// workflow's heredoc stays line-oriented.
function pem(raw) {
  return String(raw || '').replace(/\\n/g, '\n').trim();
}

// The staging clone's self-generated signing pair, or null. Held in module
// state and NOT in process.env deliberately — see
// generateStagingIframeKeyPair() for why writing it to
// IFRAME_JWT_PRIVATE_KEY would stop the preview booting at all.
let _stagingSigningPair = null;

function iframePrivateKey() {
  const key = pem(process.env.IFRAME_JWT_PRIVATE_KEY);
  if (key) return key;
  // A staging clone has no injected private key; it signs with the pair it
  // generated for itself at boot.
  if (_stagingSigningPair) return _stagingSigningPair.privateKey;
  throw new Error('IFRAME_JWT_PRIVATE_KEY not set — cannot sign app identity tokens');
}

function iframePublicKey() {
  const key = pem(process.env.IFRAME_JWT_PUBLIC_KEY);
  if (!key) throw new Error('IFRAME_JWT_PUBLIC_KEY not set — cannot verify app identity tokens');
  return key;
}

// The public halves this deployment trusts for app-identity tokens, in
// order. Normally exactly one: the injected IFRAME_JWT_PUBLIC_KEY.
//
// A staging clone legitimately has TWO issuers, and conflating them is what
// broke the first attempt at this fix:
//
//   1. the PRODUCTION parent shell, whose token arrives as `?token=` on the
//      preview's iframe src and is what mints the preview's own session
//      (middleware/auth.js). It is signed with production's private key, so
//      it verifies only against the injected public key — which is why that
//      value must never be overwritten in a clone.
//   2. the CLONE ITSELF, which also acts as a parent shell for the app views
//      it renders and signs those with its own ephemeral pair.
//
// Both are checked with identical pins (RS256, issuer, per-app audience,
// `pur`) — this is a two-key keyring, not a relaxed check. The second entry
// exists only when a staging clone generated a pair, so production always
// has exactly one trusted key.
function iframeVerifyKeys() {
  const keys = [];
  const injected = pem(process.env.IFRAME_JWT_PUBLIC_KEY);
  if (injected) keys.push(injected);
  if (_stagingSigningPair) keys.push(_stagingSigningPair.publicKey);
  if (!keys.length) {
    throw new Error('IFRAME_JWT_PUBLIC_KEY not set — cannot verify app identity tokens');
  }
  return keys;
}

function workerSecret() {
  const s = process.env.WORKER_JWT_SECRET;
  if (!s) throw new Error('WORKER_JWT_SECRET not set — cannot mint or verify worker tokens');
  return s;
}

function edgeSecret() {
  const s = process.env.EDGE_JWT_SECRET;
  if (!s) throw new Error('EDGE_JWT_SECRET not set — cannot mint or verify edge tokens');
  return s;
}

// Shared verify core. `algorithms`, `issuer` and `audience` are pinned
// by jsonwebtoken; `pur` is checked here. Nothing about the expected
// shape comes from the token itself.
function verifyWith(token, key, { algorithm, audience, purpose }) {
  if (!token || typeof token !== 'string') throw new Error('jwt must be provided');
  const claims = jwt.verify(token, key, {
    algorithms: [algorithm],
    issuer: ISSUER,
    audience,
  });
  if (!claims || typeof claims !== 'object') throw new Error('invalid token payload');
  if (claims.pur !== purpose) {
    throw new Error(`invalid purpose (expected ${purpose})`);
  }
  return claims;
}

// ── App identity (iframe + capture) ───────────────────────────────────
//
// The user claims are passed through verbatim: `{ id, username,
// usernode_pubkey, locale }` is the documented contract every child app
// reads (src/prompts/app-conventions.md), so only registered claims are
// added around them.
function signAppIdentityToken({ appId, user, ttl }) {
  if (!user || typeof user.id !== 'number') {
    throw new Error('platform-jwt: user.id (number) required');
  }
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      usernode_pubkey: user.usernode_pubkey ?? null,
      locale: user.locale ?? null,
      pur: PUR_IFRAME,
    },
    iframePrivateKey(),
    {
      algorithm: 'RS256',
      issuer: ISSUER,
      audience: appAudience(appId),
      expiresIn: ttl || IFRAME_TTL,
    }
  );
}

function verifyAppIdentityToken(token, { appId }) {
  const opts = {
    algorithm: 'RS256',
    audience: appAudience(appId),
    purpose: PUR_IFRAME,
  };
  // Try each trusted public half. In production that is one key and this is
  // a plain call; in a staging clone it is the production parent's key then
  // the clone's own.
  //
  // The FIRST failure is what gets rethrown, not the last: the injected key
  // is the primary authority, so its error is the diagnostic one. A token
  // that is really a wrong-`pur` parent token would otherwise be reported as
  // "invalid signature" (the second key's complaint) and send whoever reads
  // the log looking for a key mismatch instead of a claim bug.
  const keys = iframeVerifyKeys();
  let firstErr = null;
  for (const key of keys) {
    try {
      return verifyWith(token, key, opts);
    } catch (err) {
      if (!firstErr) firstErr = err;
    }
  }
  throw firstErr;
}

// ── Worker → platform internal API ────────────────────────────────────
//
// `scope` is kept alongside `pur` because app-llm-auth /
// app-storage-auth still use "has a scope claim" as a belt-and-braces
// rejection of infrastructure tokens presented as user tokens.
function signWorkerPurpose({ sessionId, purpose }) {
  if (typeof sessionId === 'undefined' || sessionId === null) {
    throw new Error('platform-jwt: sessionId required');
  }
  const payload = { session_id: sessionId, scope: purpose, pur: purpose };
  return jwt.sign(payload, workerSecret(), {
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: AUD_WORKER,
    expiresIn: WORKER_TTL,
  });
}

function signWorkerToken({ sessionId, prodDebug = false }) {
  const token = signWorkerPurpose({ sessionId, purpose: PUR_WORKER });
  if (prodDebug) {
    // Re-sign with the prodDebug flag (worker:session + prod_debug).
    if (typeof sessionId === 'undefined' || sessionId === null) {
      throw new Error('platform-jwt: sessionId required');
    }
    return jwt.sign({ session_id: sessionId, scope: PUR_WORKER, pur: PUR_WORKER, prod_debug: true }, workerSecret(), {
      algorithm: 'HS256', issuer: ISSUER, audience: AUD_WORKER, expiresIn: WORKER_TTL,
    });
  }
  return token;
}

function verifyWorkerPurpose(token, purpose) {
  const claims = verifyWith(token, workerSecret(), {
    algorithm: 'HS256',
    audience: AUD_WORKER,
    purpose,
  });
  if (!claims || claims.scope !== purpose || typeof claims.session_id === 'undefined') {
    throw new Error('invalid worker scope');
  }
  return claims;
}

function verifyWorkerToken(token) {
  return verifyWorkerPurpose(token, PUR_WORKER);
}

function signWorkerPushToken({ sessionId }) {
  return signWorkerPurpose({ sessionId, purpose: PUR_WORKER_PUSH });
}
function verifyWorkerPushToken(token) {
  return verifyWorkerPurpose(token, PUR_WORKER_PUSH);
}
function signIssuesReadToken({ sessionId }) {
  return signWorkerPurpose({ sessionId, purpose: PUR_ISSUES_READ });
}
function verifyIssuesReadToken(token) {
  return verifyWorkerPurpose(token, PUR_ISSUES_READ);
}
function signAnthropicProxyToken({ sessionId }) {
  return signWorkerPurpose({ sessionId, purpose: PUR_ANTHROPIC_PROXY });
}
function verifyAnthropicProxyToken(token) {
  return verifyWorkerPurpose(token, PUR_ANTHROPIC_PROXY);
}
function signProdDebugToken({ sessionId }) {
  if (typeof sessionId === 'undefined' || sessionId === null) {
    throw new Error('platform-jwt: sessionId required');
  }
  return jwt.sign({
    session_id: sessionId,
    scope: PUR_PROD_DEBUG,
    pur: PUR_PROD_DEBUG,
    prod_debug: true,
  }, workerSecret(), {
    algorithm: 'HS256', issuer: ISSUER, audience: AUD_WORKER, expiresIn: WORKER_TTL,
  });
}
function verifyProdDebugToken(token) {
  return verifyWorkerPurpose(token, PUR_PROD_DEBUG);
}

// ── Private-app edge gate ─────────────────────────────────────────────
//
// Both edge purposes share EDGE_JWT_SECRET; the `pur` check is what
// keeps a 120s grant from being replayed as a 12h access cookie.
function signEdgeGrant({ uid, appId, host }) {
  return jwt.sign({ uid, appId, host, pur: PUR_EDGE_GRANT }, edgeSecret(), {
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: AUD_EDGE,
    expiresIn: EDGE_GRANT_TTL_S,
  });
}

function verifyEdgeGrant(token) {
  return verifyWith(token, edgeSecret(), {
    algorithm: 'HS256',
    audience: AUD_EDGE,
    purpose: PUR_EDGE_GRANT,
  });
}

function signEdgeCookie({ uid, appId, host }) {
  return jwt.sign({ uid, appId, host, pur: PUR_EDGE_COOKIE }, edgeSecret(), {
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: AUD_EDGE,
    expiresIn: EDGE_COOKIE_TTL_S,
  });
}

function verifyEdgeCookie(token) {
  return verifyWith(token, edgeSecret(), {
    algorithm: 'HS256',
    audience: AUD_EDGE,
    purpose: PUR_EDGE_COOKIE,
  });
}

// Non-throwing wrapper for call sites that branch on validity rather
// than reporting an error (the edge gate falls through to the next
// credential instead of 401-ing).
function orNull(fn) {
  try { return fn(); } catch { return null; }
}

// ── Staging self-signing ──────────────────────────────────────────────
//
// The platform runs inside its own staging clone, and that clone is
// injected NO platform keys — deliberately: a preview built from
// unreviewed branch code must never hold production's signing key. But
// the clone is also a PARENT SHELL: it renders app views, and each one
// fetches /api/iframe-token for the embedded child. With no
// IFRAME_JWT_PRIVATE_KEY, signAppIdentityToken() throws, the endpoint
// answers its structured 503, and every app view logs a console error —
// which fails the console-error baseline check on every route that frames
// an app, even though the preview itself works.
//
// So a staging clone MINTS ITS OWN KEYPAIR at boot. The pair is:
//
//   ephemeral   — generated per process, never persisted, never in .env.
//                 A restart invalidates outstanding tokens; they are
//                 15m-1h TTL and the shell refreshes on demand, so the
//                 cost is one refresh, not a broken session.
//   self-consistent — the clone is both signer and verifier (its own
//                 middleware/auth.js verifies against
//                 IFRAME_JWT_PUBLIC_KEY for SELF_APP_ID), so both halves
//                 must come from the same generation. They do: both env
//                 vars are set together, here, or neither is.
//   confined    — it can only ever authenticate against THIS clone.
//                 Production verifies with production's public key, so a
//                 token minted here is refused everywhere that matters.
//
// WHY THIS IS NOT A SHIM, and not a USERNODE_ENV feature gate. The code
// path is byte-identical to production: the same signAppIdentityToken /
// verifyAppIdentityToken, the same RS256 pin, the same issuer, the same
// per-app audience, the same `pur` claim. Only the ORIGIN of the key
// material differs — which is the sanctioned "swap the data behind the
// path" use of USERNODE_ENV, not a swap of the path itself. There is no
// second verify branch to keep in sync and no weaker token shape: a
// forged HS256 token, a wrong audience or a wrong issuer is refused here
// exactly as it is in production.
//
// GATED ON THE PRIVATE KEY ALONE, and that is the whole bug in the first
// attempt at this fix. A staging clone DOES receive IFRAME_JWT_PUBLIC_KEY:
// services/app-identity-env.js injects it into every container, including
// the clone, precisely so the clone can verify the production parent's
// token. Bailing out when "either half is set" therefore never generated
// anything, the signer kept throwing, and the 503 survived the fix.
//
// The pair lives in MODULE STATE, not process.env, for two reasons:
//   - config.load() runs assertIframeKeyPair() whenever BOTH env halves are
//     present. Writing an ephemeral private key next to production's
//     injected public key would make that probe fail on a mismatched pair
//     and hard-exit — the preview would not boot at all.
//   - IFRAME_JWT_PUBLIC_KEY must keep its injected value so parent-issued
//     tokens still verify (see iframeVerifyKeys()). Overwriting it would
//     break the session handoff that gets the checks runner into the
//     preview in the first place, failing every check harder.
//
// Two independent locks keep this out of production:
//   1. it throws unless USERNODE_ENV === 'staging';
//   2. config.load() only calls it on the staging branch, and production
//      cannot boot without a real private key anyway (REQUIRED_PROD).
// An injected private key is never clobbered — an operator who DOES give a
// preview a real signing key keeps it.
function generateStagingIframeKeyPair() {
  if (process.env.USERNODE_ENV !== 'staging') {
    throw new Error('platform-jwt: refusing to self-sign outside staging');
  }
  if (process.env.IFRAME_JWT_PRIVATE_KEY) {
    return { generated: false, bits: 0 };
  }
  if (_stagingSigningPair) {
    // Idempotent: a second call must not rotate the key out from under
    // tokens already minted in this process.
    return { generated: false, bits: 0, alreadyGenerated: true };
  }
  const modulusLength = 2048;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  _stagingSigningPair = { privateKey, publicKey };

  // Prove the generated pair actually round-trips before declaring success,
  // the same property assertIframeKeyPair() guarantees for an injected pair.
  // A clone that reports "self-signed ok" and then mints unverifiable
  // tokens would be worse than one that plainly 503s.
  try {
    const probe = signAppIdentityToken({
      appId: 1,
      user: { id: 1, username: '__staging_probe__', usernode_pubkey: null, locale: null },
      ttl: '1m',
    });
    verifyWith(probe, publicKey, {
      algorithm: 'RS256',
      audience: appAudience(1),
      purpose: PUR_IFRAME,
    });
  } catch (err) {
    _stagingSigningPair = null;
    throw new Error(`self-signed pair failed its probe: ${err.message}`);
  }
  return { generated: true, bits: modulusLength };
}

// Test seam: drop the self-generated pair so a suite can assert the
// pre-generation state.
function _resetStagingSigningPair() {
  _stagingSigningPair = null;
}

// ── Boot validation ───────────────────────────────────────────────────
//
// A mismatched RSA pair breaks every app login silently — the platform
// happily mints tokens no container can verify. Catch it at boot by
// round-tripping a probe token through both halves, and refuse an
// undersized modulus while we're here. Throws with an operator-readable
// message; config.load() turns that into a hard exit.
function assertIframeKeyPair() {
  const priv = crypto.createPrivateKey(iframePrivateKey());
  if (priv.asymmetricKeyType !== 'rsa') {
    throw new Error(`IFRAME_JWT_PRIVATE_KEY must be an RSA key (got ${priv.asymmetricKeyType})`);
  }
  const bits = priv.asymmetricKeyDetails?.modulusLength || 0;
  if (bits < 2048) {
    throw new Error(`IFRAME_JWT_PRIVATE_KEY modulus is ${bits} bits — 2048 minimum`);
  }
  const pub = crypto.createPublicKey(iframePublicKey());
  if (pub.asymmetricKeyType !== 'rsa') {
    throw new Error(`IFRAME_JWT_PUBLIC_KEY must be an RSA key (got ${pub.asymmetricKeyType})`);
  }
  const probe = signAppIdentityToken({
    appId: 1,
    user: { id: 1, username: '__boot_probe__', usernode_pubkey: null, locale: null },
    ttl: '1m',
  });
  verifyAppIdentityToken(probe, { appId: 1 });
  return { bits };
}

module.exports = {
  ISSUER,
  AUD_WORKER,
  AUD_EDGE,
  PUR_IFRAME,
  PUR_WORKER,
  PUR_WORKER_PUSH,
  PUR_ISSUES_READ,
  PUR_ANTHROPIC_PROXY,
  PUR_PROD_DEBUG,
  PUR_EDGE_GRANT,
  PUR_EDGE_COOKIE,
  IFRAME_TTL,
  CAPTURE_TTL,
  WORKER_TTL,
  WORKER_TTL_S,
  EDGE_GRANT_TTL_S,
  EDGE_COOKIE_TTL_S,
  appAudience,
  signAppIdentityToken,
  verifyAppIdentityToken,
  signWorkerToken,
  verifyWorkerToken,
  signWorkerPurpose,
  verifyWorkerPurpose,
  signWorkerPushToken,
  verifyWorkerPushToken,
  signIssuesReadToken,
  verifyIssuesReadToken,
  signAnthropicProxyToken,
  verifyAnthropicProxyToken,
  signProdDebugToken,
  verifyProdDebugToken,
  signEdgeGrant,
  verifyEdgeGrant,
  signEdgeCookie,
  verifyEdgeCookie,
  orNull,
  assertIframeKeyPair,
  generateStagingIframeKeyPair,
  iframeVerifyKeys,
  _resetStagingSigningPair,
};
