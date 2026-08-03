// #851 — the staging env fingerprint (src/services/staging-env.js).
//
// The fingerprint is what makes a stale preview DETECTABLE, and the sweeper
// tears containers down on its verdict, so the properties that matter are:
//
//   1. Stable — the same env must always produce the same digest, or every
//      preview looks stale on every pass and the fleet churns forever.
//   2. Sensitive to platform-owned values and to SHAPE — a changed PEM, a
//      changed domain, an added or dropped var must all move it, otherwise a
//      preview that genuinely holds old env keeps reading as current (the
//      #848 failure this whole change exists to catch).
//   3. Insensitive to USERNODE_APP_ID's VALUE but sensitive to its absence —
//      that asymmetry is what lets one digest serve every app, so the sweeper
//      never has to load an app row to classify a container.
//   4. Leak-free — a docker label is world-readable to anything that can run
//      `docker inspect`, so no input value may appear in the output.
//
// Pure module, no docker / DB / GitHub: it only reads process.env + config.
//
// Run with: node --test tests/staging-env-fingerprint.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stagingEnv = require('../src/services/staging-env');
const { envFingerprint, platformStagingEnv, LABEL_ENV_FP } = stagingEnv;

const PEM_A = '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----';
const PEM_B = '-----BEGIN PUBLIC KEY-----\nBBBB\n-----END PUBLIC KEY-----';

function baseEnv(overrides = {}) {
  return {
    USERNODE_JWT_PUBLIC_KEY: PEM_A,
    JWT_SECRET: PEM_A,
    IFRAME_JWT_PUBLIC_KEY: PEM_A,
    USERNODE_APP_ID: '42',
    PORT: '3000',
    USERNODE_ENV: 'staging',
    ...overrides,
  };
}

// ── 1. Stability + shape ─────────────────────────────────────────────────

test('envFingerprint: stable across calls and independent of key order', () => {
  const a = envFingerprint(baseEnv());
  const b = envFingerprint(baseEnv());
  assert.equal(a, b, 'same env → same digest');

  // Same pairs, different insertion order.
  const reordered = {
    USERNODE_ENV: 'staging',
    PORT: '3000',
    USERNODE_APP_ID: '42',
    IFRAME_JWT_PUBLIC_KEY: PEM_A,
    JWT_SECRET: PEM_A,
    USERNODE_JWT_PUBLIC_KEY: PEM_A,
  };
  assert.equal(envFingerprint(reordered), a, 'key order must not matter');
});

test('envFingerprint: 16 lowercase hex chars', () => {
  const fp = envFingerprint(baseEnv());
  assert.match(fp, /^[0-9a-f]{16}$/);
});

// ── 2. Sensitivity to platform-owned values and to shape ─────────────────

test('envFingerprint: a changed public PEM moves the digest', () => {
  const before = envFingerprint(baseEnv());
  const after = envFingerprint(baseEnv({
    USERNODE_JWT_PUBLIC_KEY: PEM_B, JWT_SECRET: PEM_B, IFRAME_JWT_PUBLIC_KEY: PEM_B,
  }));
  assert.notEqual(after, before, 'a key rotation must mark every old preview stale');
});

test('envFingerprint: a changed USERNODE_DOMAIN moves the digest', () => {
  const before = envFingerprint(baseEnv({ USERNODE_DOMAIN: 'a.example' }));
  const after = envFingerprint(baseEnv({ USERNODE_DOMAIN: 'b.example' }));
  assert.notEqual(after, before);
});

test('envFingerprint: ADDING a var moves the digest (new injected var)', () => {
  const before = envFingerprint(baseEnv());
  const after = envFingerprint(baseEnv({ USERNODE_SOMETHING_NEW: 'x' }));
  assert.notEqual(after, before, 'a new platform var must invalidate old previews');
});

test('envFingerprint: DROPPING a var moves the digest (retired var)', () => {
  const full = baseEnv();
  const before = envFingerprint(full);
  const reduced = { ...full };
  delete reduced.JWT_SECRET;
  assert.notEqual(envFingerprint(reduced), before);
});

// ── 3. USERNODE_APP_ID: value exempt, name is not ────────────────────────

test('envFingerprint: USERNODE_APP_ID value is NOT hashed (one digest per fleet)', () => {
  const appOne = envFingerprint(baseEnv({ USERNODE_APP_ID: '1' }));
  const appTwo = envFingerprint(baseEnv({ USERNODE_APP_ID: '9999' }));
  assert.equal(appOne, appTwo, 'per-app values would force a per-app expected digest');
});

test('envFingerprint: USERNODE_APP_ID disappearing DOES move the digest', () => {
  const withId = baseEnv();
  const withoutId = { ...withId };
  delete withoutId.USERNODE_APP_ID;
  assert.notEqual(
    envFingerprint(withoutId), envFingerprint(withId),
    'the key NAME is part of the input even though its value is exempt'
  );
});

// ── 4. No value leaks into the label ─────────────────────────────────────

test('envFingerprint: output contains no fragment of any input value', () => {
  const secretish = 'sup3rsecretvalue';
  const fp = envFingerprint(baseEnv({ USERNODE_DOMAIN: secretish }));
  assert.equal(fp.includes(secretish), false);
  // And no 8-char window of the PEM survives either.
  for (let i = 0; i + 8 <= PEM_A.length; i++) {
    assert.equal(fp.includes(PEM_A.slice(i, i + 8)), false);
  }
});

// ── FINGERPRINT_VERSION is a real lever ──────────────────────────────────

test('FINGERPRINT_VERSION participates in the digest', () => {
  // Recompute what the module would produce with a bumped version, using the
  // module's own documented construction, and assert it differs. This pins
  // that bumping the constant actually invalidates the fleet — the deliberate
  // "rebuild everything" escape hatch.
  const crypto = require('crypto');
  const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
  const env = baseEnv();
  const lines = Object.keys(env).sort()
    .map((k) => (stagingEnv.VALUE_EXEMPT.has(k) ? k : `${k}=${sha(env[k])}`));
  const withCurrent = sha([`fpv=${stagingEnv.FINGERPRINT_VERSION}`, ...lines].join('\n')).slice(0, 16);
  const withBumped = sha([`fpv=${stagingEnv.FINGERPRINT_VERSION}-next`, ...lines].join('\n')).slice(0, 16);

  assert.equal(withCurrent, envFingerprint(env), 'construction matches the module');
  assert.notEqual(withBumped, withCurrent, 'a version bump must move every digest');
});

// ── platformStagingEnv: what is in, what is deliberately out ─────────────

test('platformStagingEnv: carries the identity trio + PORT + USERNODE_ENV', () => {
  const env = platformStagingEnv({ id: 7 }, { iframeJwtPublicKey: PEM_A });
  assert.equal(env.USERNODE_JWT_PUBLIC_KEY, PEM_A);
  assert.equal(env.IFRAME_JWT_PUBLIC_KEY, PEM_A);
  assert.equal(env.USERNODE_APP_ID, '7');
  assert.equal(env.PORT, '3000');
  assert.equal(env.USERNODE_ENV, 'staging');
});

// #1213: previews get the app-platform API's BASE URL so their server can
// reach the user-directory endpoints with the caller's forwarded iframe
// token — but never any credential. This is the assertion that keeps a
// future edit from leaking a token into unreviewed PR containers.
test('platformStagingEnv: carries USERNODE_PLATFORM_API_URL and NO platform credential', () => {
  const env = platformStagingEnv({ id: 7 }, { iframeJwtPublicKey: PEM_A });
  assert.match(env.USERNODE_PLATFORM_API_URL, /\/api\/app-platform$/);
  for (const key of [
    'USERNODE_LLM_PROXY_TOKEN', 'USERNODE_LLM_PROXY_URL',
    'USERNODE_STORAGE_TOKEN', 'USERNODE_STORAGE_URL',
  ]) {
    assert.equal(key in env, false, `${key} must never reach a preview`);
  }
});

test('platformStagingEnv: never carries DATABASE_URL or app-declared secrets', () => {
  const env = platformStagingEnv({ id: 7 }, { iframeJwtPublicKey: PEM_A });
  // DATABASE_URL holds a per-clone random password — including it would make
  // every preview permanently stale. App secrets resolve from the branch's
  // cloned dapp.json, which a sweeper cannot recompute.
  assert.equal('DATABASE_URL' in env, false);
  assert.equal('STRIPE_SECRET_KEY' in env, false);
});

test('platformStagingEnv: forwards the inherited locators only when set', () => {
  const prevDomain = process.env.USERNODE_DOMAIN;
  const prevRepo = process.env.USERNODE_PLATFORM_REPO;
  try {
    delete process.env.USERNODE_DOMAIN;
    delete process.env.USERNODE_PLATFORM_REPO;
    const bare = platformStagingEnv({ id: 7 }, { iframeJwtPublicKey: PEM_A });
    assert.equal('USERNODE_DOMAIN' in bare, false);

    process.env.USERNODE_DOMAIN = 'fork.example';
    const forked = platformStagingEnv({ id: 7 }, { iframeJwtPublicKey: PEM_A });
    assert.equal(forked.USERNODE_DOMAIN, 'fork.example');
    // ... and the fingerprint of the two differs, so a fork's previews are
    // not confused with upstream's.
    assert.notEqual(envFingerprint(forked), envFingerprint(bare));
  } finally {
    if (prevDomain === undefined) delete process.env.USERNODE_DOMAIN;
    else process.env.USERNODE_DOMAIN = prevDomain;
    if (prevRepo === undefined) delete process.env.USERNODE_PLATFORM_REPO;
    else process.env.USERNODE_PLATFORM_REPO = prevRepo;
  }
});

test('expectedStagingFingerprint: memoised, and equals the digest of a real build env', () => {
  stagingEnv._resetExpected();
  const config = { iframeJwtPublicKey: PEM_A };
  const first = stagingEnv.expectedStagingFingerprint(config);
  const second = stagingEnv.expectedStagingFingerprint(config);
  assert.equal(first, second);
  // Any app id must land on the same expected value — that is the whole
  // point of value-exempting USERNODE_APP_ID.
  assert.equal(first, envFingerprint(platformStagingEnv({ id: 12345 }, config)));
  stagingEnv._resetExpected();
});

test('LABEL_ENV_FP is the namespaced label name the sweeper reads', () => {
  assert.equal(LABEL_ENV_FP, 'usernode.env.fp');
});

// ── #816: the preview container's resourcing is STATED, not inherited ────
//
// The label assertions above prove the build stamps the env it injected.
// This proves the same call states its CPU/memory instead of silently
// inheriting docker.js's production-app defaults — which is how previews
// ended up on half a core while the post-build screenshot + checks pass
// drove a headless browser against them.

test('#816 the staging build passes explicit memory + cpus to the runtime dispatcher', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'staging.js'), 'utf8'
  );
  // Scope to the staging container launch (the prod rebuild in the same
  // file deliberately keeps the app defaults).
  const start = src.indexOf('const deployed = await applicationRuntime.deploy(config, {');
  assert.notStrictEqual(start, -1, 'staging runtime deploy call not found');
  const call = src.slice(start, src.indexOf('});', start));
  assert.match(call, /memory:\s*docker\.STAGING_MEMORY/, 'memory comes from the named constant');
  assert.match(call, /cpus:\s*docker\.STAGING_CPUS/, 'cpus comes from the named constant');
  assert.match(call, new RegExp(`${LABEL_ENV_FP.replace(/\./g, '\\.')}|LABEL_ENV_FP`),
    'and the env fingerprint label is still stamped alongside it');
});
