// Tests for src/services/platform-jwt.js — the centralized signer/
// verifier that replaced one shared JWT_SECRET signing five unrelated
// things.
//
// The point of the split is negative: a token minted by ANY authority
// must be rejected by EVERY other authority, even when the underlying
// key is the same (the two edge purposes share EDGE_JWT_SECRET). So the
// bulk of this file is a cross-authority rejection matrix, plus the
// classic JWT confusion attacks — wrong algorithm, `alg: none`, an
// HS256 token forged with the RSA public PEM as the HMAC key, wrong
// issuer, wrong audience, wrong app.
//
// Run with: node --test tests/platform-jwt.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const { keyPair } = require('./platform-keys');

const WORKER_SECRET = 'platform-jwt-test-worker-secret-0123456789';
const EDGE_SECRET = 'platform-jwt-test-edge-secret-0123456789ab';
const LEGACY_SECRET = 'platform-jwt-test-legacy-shared-secret';

const { publicKey, privateKey } = keyPair();
process.env.IFRAME_JWT_PRIVATE_KEY = privateKey;
process.env.IFRAME_JWT_PUBLIC_KEY = publicKey;
process.env.WORKER_JWT_SECRET = WORKER_SECRET;
process.env.EDGE_JWT_SECRET = EDGE_SECRET;

const pj = require('../src/services/platform-jwt');

const APP_ID = 42;
const OTHER_APP_ID = 43;
const USER = { id: 7, username: 'alice', usernode_pubkey: 'ut1abc', locale: 'en' };

// ── positive controls ──────────────────────────────────────────────────

test('app identity token round-trips and preserves the documented claims', () => {
  const token = pj.signAppIdentityToken({ appId: APP_ID, user: USER });
  const claims = pj.verifyAppIdentityToken(token, { appId: APP_ID });
  assert.equal(claims.id, 7);
  assert.equal(claims.username, 'alice');
  assert.equal(claims.usernode_pubkey, 'ut1abc');
  assert.equal(claims.locale, 'en');
  assert.equal(claims.pur, 'iframe');
  assert.equal(claims.iss, 'usernode');
  assert.equal(claims.aud, `usernode:app:${APP_ID}`);
  // RS256, so the header must not be an HMAC alg.
  const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  assert.equal(header.alg, 'RS256');
});

test('missing optional user fields become explicit nulls, not undefined', () => {
  const token = pj.signAppIdentityToken({ appId: APP_ID, user: { id: 9, username: 'bob' } });
  const claims = pj.verifyAppIdentityToken(token, { appId: APP_ID });
  assert.equal(claims.usernode_pubkey, null);
  assert.equal(claims.locale, null);
});

test('worker token round-trips with its scope and session id', () => {
  const claims = pj.verifyWorkerToken(pj.signWorkerToken({ sessionId: 5 }));
  assert.equal(claims.session_id, 5);
  assert.equal(claims.scope, 'worker:session');
  assert.equal(claims.pur, 'worker:session');
  assert.equal(claims.aud, 'usernode:worker');
  assert.ok(!('prod_debug' in claims));
  assert.equal(claims.exp - claims.iat, pj.WORKER_TTL_S);
});

test('prodDebug adds the prod_debug claim and nothing else', () => {
  const claims = pj.verifyWorkerToken(pj.signWorkerToken({ sessionId: 5, prodDebug: true }));
  assert.equal(claims.prod_debug, true);
});

test('narrow worker capabilities round-trip only under their own purposes', () => {
  const proxy = pj.signAnthropicProxyToken({ sessionId: 5 });
  const debug = pj.signProdDebugToken({ sessionId: 5 });
  assert.equal(pj.verifyAnthropicProxyToken(proxy).scope, 'worker:anthropic-proxy');
  const debugClaims = pj.verifyProdDebugToken(debug);
  assert.equal(debugClaims.scope, 'worker:prod-debug');
  assert.equal(debugClaims.prod_debug, true);
  assert.throws(() => pj.verifyWorkerToken(proxy), /purpose|scope/);
  assert.throws(() => pj.verifyWorkerToken(debug), /purpose|scope/);
});

test('edge grant and edge cookie both round-trip', () => {
  const args = { uid: 7, appId: APP_ID, host: 'app.example.com' };
  const grant = pj.verifyEdgeGrant(pj.signEdgeGrant(args));
  assert.equal(grant.pur, 'edge:grant');
  assert.equal(grant.exp - grant.iat, pj.EDGE_GRANT_TTL_S);

  const cookie = pj.verifyEdgeCookie(pj.signEdgeCookie(args));
  assert.equal(cookie.pur, 'edge:cookie');
  assert.equal(cookie.exp - cookie.iat, pj.EDGE_COOKIE_TTL_S);
});

// ── cross-authority rejection matrix ───────────────────────────────────
//
// Every verifier against every token that is not its own.

function tokens() {
  return {
    app: pj.signAppIdentityToken({ appId: APP_ID, user: USER }),
    worker: pj.signWorkerToken({ sessionId: 5 }),
    grant: pj.signEdgeGrant({ uid: 7, appId: APP_ID, host: 'app.example.com' }),
    cookie: pj.signEdgeCookie({ uid: 7, appId: APP_ID, host: 'app.example.com' }),
  };
}

const VERIFIERS = {
  app: (t) => pj.verifyAppIdentityToken(t, { appId: APP_ID }),
  worker: (t) => pj.verifyWorkerToken(t),
  grant: (t) => pj.verifyEdgeGrant(t),
  cookie: (t) => pj.verifyEdgeCookie(t),
};

test('every authority rejects every other authority\'s token', () => {
  const toks = tokens();
  let checked = 0;
  for (const [vName, verify] of Object.entries(VERIFIERS)) {
    for (const [tName, token] of Object.entries(toks)) {
      if (vName === tName) continue;
      assert.throws(
        () => verify(token),
        (err) => err instanceof Error,
        `${vName} verifier accepted a ${tName} token`
      );
      checked += 1;
    }
  }
  // 4 verifiers × 3 foreign tokens.
  assert.equal(checked, 12);
});

test('the two edge purposes share a key but are not interchangeable', () => {
  const args = { uid: 7, appId: APP_ID, host: 'app.example.com' };
  const grant = pj.signEdgeGrant(args);
  const cookie = pj.signEdgeCookie(args);
  // Signature-valid under the same key — it is `pur` alone that rejects.
  jwt.verify(grant, EDGE_SECRET, { algorithms: ['HS256'], issuer: 'usernode', audience: 'usernode:edge' });
  jwt.verify(cookie, EDGE_SECRET, { algorithms: ['HS256'], issuer: 'usernode', audience: 'usernode:edge' });
  assert.throws(() => pj.verifyEdgeCookie(grant), /invalid purpose \(expected edge:cookie\)/);
  assert.throws(() => pj.verifyEdgeGrant(cookie), /invalid purpose \(expected edge:grant\)/);
});

// ── the retired shared secret buys nothing ─────────────────────────────

test('nothing signed with the legacy shared secret verifies anywhere', () => {
  for (const [name, verify] of Object.entries(VERIFIERS)) {
    const forged = jwt.sign(
      { id: 7, uid: 7, session_id: 5, appId: APP_ID, host: 'app.example.com', scope: 'worker:session' },
      LEGACY_SECRET,
      { algorithm: 'HS256', issuer: 'usernode', expiresIn: '1h' }
    );
    assert.throws(() => verify(forged), (err) => err instanceof Error, `${name} accepted a legacy-secret token`);
  }
});

// ── algorithm confusion ────────────────────────────────────────────────

test('an HS256 token forged with the RSA PUBLIC key is rejected', () => {
  // The classic algorithm-confusion attack: a child container holds the
  // public PEM, so if the verifier let the token pick its own algorithm
  // the container could sign identities with that PEM as an HMAC key.
  const forged = jwt.sign(
    { id: 7, username: 'attacker', pur: 'iframe' },
    publicKey,
    { algorithm: 'HS256', issuer: 'usernode', audience: `usernode:app:${APP_ID}`, expiresIn: '1h' }
  );
  assert.throws(() => pj.verifyAppIdentityToken(forged, { appId: APP_ID }), /invalid algorithm/);
});

test('an unsigned (alg: none) token is rejected by every authority', () => {
  const payload = Buffer.from(JSON.stringify({
    id: 7, uid: 7, session_id: 5, appId: APP_ID, host: 'app.example.com',
    pur: 'iframe', iss: 'usernode', aud: `usernode:app:${APP_ID}`,
    exp: Math.floor(Number(process.env.PJ_TEST_NOW || 4000000000)),
  })).toString('base64url');
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const unsigned = `${header}.${payload}.`;
  for (const [name, verify] of Object.entries(VERIFIERS)) {
    assert.throws(() => verify(unsigned), (err) => err instanceof Error, `${name} accepted alg:none`);
  }
});

test('a worker token re-signed with RS256 by a real RSA key is rejected', () => {
  const rogue = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const forged = jwt.sign(
    { session_id: 5, scope: 'worker:session', pur: 'worker:session' },
    rogue.privateKey,
    { algorithm: 'RS256', issuer: 'usernode', audience: 'usernode:worker', expiresIn: '1h' }
  );
  assert.throws(() => pj.verifyWorkerToken(forged), /invalid algorithm/);
});

// ── registered-claim pinning ───────────────────────────────────────────

test('wrong issuer is rejected', () => {
  const forged = jwt.sign(
    { session_id: 5, scope: 'worker:session', pur: 'worker:session' },
    WORKER_SECRET,
    { algorithm: 'HS256', issuer: 'not-usernode', audience: 'usernode:worker', expiresIn: '1h' }
  );
  assert.throws(() => pj.verifyWorkerToken(forged), /jwt issuer invalid/);
});

test('missing issuer is rejected', () => {
  const forged = jwt.sign(
    { session_id: 5, scope: 'worker:session', pur: 'worker:session' },
    WORKER_SECRET,
    { algorithm: 'HS256', audience: 'usernode:worker', expiresIn: '1h' }
  );
  assert.throws(() => pj.verifyWorkerToken(forged), /jwt issuer invalid/);
});

test('an app identity token for one app does not verify for another', () => {
  const token = pj.signAppIdentityToken({ appId: APP_ID, user: USER });
  assert.throws(
    () => pj.verifyAppIdentityToken(token, { appId: OTHER_APP_ID }),
    /jwt audience invalid/
  );
});

test('missing audience is rejected', () => {
  const forged = jwt.sign(
    { id: 7, username: 'alice', pur: 'iframe' },
    privateKey,
    { algorithm: 'RS256', issuer: 'usernode', expiresIn: '1h' }
  );
  assert.throws(() => pj.verifyAppIdentityToken(forged, { appId: APP_ID }), /jwt audience invalid/);
});

test('a correctly-keyed token with no purpose claim is rejected', () => {
  const forged = jwt.sign(
    { session_id: 5, scope: 'worker:session' },
    WORKER_SECRET,
    { algorithm: 'HS256', issuer: 'usernode', audience: 'usernode:worker', expiresIn: '1h' }
  );
  assert.throws(() => pj.verifyWorkerToken(forged), /invalid purpose \(expected worker:session\)/);
});

test('an expired token is rejected even when everything else is right', () => {
  const expired = jwt.sign(
    { session_id: 5, scope: 'worker:session', pur: 'worker:session' },
    WORKER_SECRET,
    { algorithm: 'HS256', issuer: 'usernode', audience: 'usernode:worker', expiresIn: '-10s' }
  );
  assert.throws(() => pj.verifyWorkerToken(expired), /jwt expired/);
});

test('every signer sets an expiry', () => {
  const toks = tokens();
  for (const [name, token] of Object.entries(toks)) {
    const claims = jwt.decode(token);
    assert.ok(typeof claims.exp === 'number', `${name} token has no exp`);
    assert.ok(claims.exp > claims.iat, `${name} token expiry is not in the future`);
  }
});

// ── audience derivation ────────────────────────────────────────────────

test('appAudience keys on the immutable integer id', () => {
  assert.equal(pj.appAudience(42), 'usernode:app:42');
  assert.equal(pj.appAudience('42'), 'usernode:app:42');
});

test('appAudience refuses a slug or a non-positive id', () => {
  for (const bad of ['my-app', 0, -1, 1.5, null, undefined, {}]) {
    assert.throws(() => pj.appAudience(bad), /positive integer/);
  }
});

// ── argument validation ────────────────────────────────────────────────

test('signAppIdentityToken requires a numeric user id', () => {
  assert.throws(() => pj.signAppIdentityToken({ appId: APP_ID, user: { username: 'x' } }), /user\.id/);
  assert.throws(() => pj.signAppIdentityToken({ appId: APP_ID, user: null }), /user\.id/);
  // A string id would silently break every child app's `req.user.id`
  // integer comparison.
  assert.throws(
    () => pj.signAppIdentityToken({ appId: APP_ID, user: { id: '7', username: 'x' } }),
    /user\.id/
  );
});

test('signWorkerToken requires a session id', () => {
  assert.throws(() => pj.signWorkerToken({}), /sessionId required/);
  assert.throws(() => pj.signWorkerToken({ sessionId: null }), /sessionId required/);
  // 0 is a legitimate id shape; only null/undefined are refused.
  assert.doesNotThrow(() => pj.signWorkerToken({ sessionId: 0 }));
});

test('verify rejects a non-string token instead of throwing something opaque', () => {
  for (const bad of [null, undefined, '', 42, {}]) {
    assert.throws(() => pj.verifyWorkerToken(bad), /jwt must be provided/);
  }
});

// ── missing key material ───────────────────────────────────────────────

test('a missing key is an operator-readable error, not a silent pass', () => {
  const saved = process.env.WORKER_JWT_SECRET;
  delete process.env.WORKER_JWT_SECRET;
  try {
    assert.throws(() => pj.signWorkerToken({ sessionId: 1 }), /WORKER_JWT_SECRET not set/);
    assert.throws(() => pj.verifyWorkerToken('x.y.z'), /WORKER_JWT_SECRET not set/);
  } finally {
    process.env.WORKER_JWT_SECRET = saved;
  }
});

test('keys are read at call time, so a rotation takes effect immediately', () => {
  const before = pj.signWorkerToken({ sessionId: 1 });
  const saved = process.env.WORKER_JWT_SECRET;
  process.env.WORKER_JWT_SECRET = 'a-completely-different-worker-secret-value';
  try {
    assert.throws(() => pj.verifyWorkerToken(before), /invalid signature/);
    // …and a token minted under the new key verifies.
    assert.equal(pj.verifyWorkerToken(pj.signWorkerToken({ sessionId: 1 })).session_id, 1);
  } finally {
    process.env.WORKER_JWT_SECRET = saved;
  }
});

// ── orNull ─────────────────────────────────────────────────────────────

test('orNull turns a rejection into null and passes claims through', () => {
  assert.equal(pj.orNull(() => pj.verifyWorkerToken('nonsense')), null);
  const ok = pj.orNull(() => pj.verifyWorkerToken(pj.signWorkerToken({ sessionId: 3 })));
  assert.equal(ok.session_id, 3);
});

// ── boot validation ────────────────────────────────────────────────────

test('assertIframeKeyPair accepts a matched RSA-2048 pair', () => {
  const { bits } = pj.assertIframeKeyPair();
  assert.equal(bits, 2048);
});

test('assertIframeKeyPair rejects a mismatched pair', () => {
  const other = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const saved = process.env.IFRAME_JWT_PUBLIC_KEY;
  process.env.IFRAME_JWT_PUBLIC_KEY = other.publicKey;
  try {
    // The probe token signs fine and then fails to verify — exactly the
    // failure that would otherwise show up as "every app login broke".
    assert.throws(() => pj.assertIframeKeyPair(), /invalid signature/);
  } finally {
    process.env.IFRAME_JWT_PUBLIC_KEY = saved;
  }
});

test('assertIframeKeyPair rejects a non-RSA private key', () => {
  const ec = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const savedPriv = process.env.IFRAME_JWT_PRIVATE_KEY;
  process.env.IFRAME_JWT_PRIVATE_KEY = ec.privateKey;
  try {
    assert.throws(() => pj.assertIframeKeyPair(), /must be an RSA key/);
  } finally {
    process.env.IFRAME_JWT_PRIVATE_KEY = savedPriv;
  }
});

test('assertIframeKeyPair rejects an undersized modulus', () => {
  const small = crypto.generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const savedPriv = process.env.IFRAME_JWT_PRIVATE_KEY;
  process.env.IFRAME_JWT_PRIVATE_KEY = small.privateKey;
  try {
    assert.throws(() => pj.assertIframeKeyPair(), /1024 bits — 2048 minimum/);
  } finally {
    process.env.IFRAME_JWT_PRIVATE_KEY = savedPriv;
  }
});

// ── PEM carriage ───────────────────────────────────────────────────────

test('single-line PEMs with literal \\n escapes work (the .env convention)', () => {
  const savedPriv = process.env.IFRAME_JWT_PRIVATE_KEY;
  const savedPub = process.env.IFRAME_JWT_PUBLIC_KEY;
  process.env.IFRAME_JWT_PRIVATE_KEY = privateKey.replace(/\n/g, '\\n');
  process.env.IFRAME_JWT_PUBLIC_KEY = publicKey.replace(/\n/g, '\\n');
  try {
    const token = pj.signAppIdentityToken({ appId: APP_ID, user: USER });
    assert.equal(pj.verifyAppIdentityToken(token, { appId: APP_ID }).id, 7);
  } finally {
    process.env.IFRAME_JWT_PRIVATE_KEY = savedPriv;
    process.env.IFRAME_JWT_PUBLIC_KEY = savedPub;
  }
});
