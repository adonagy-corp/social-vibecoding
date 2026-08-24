// Static safety gates for the legacy PostgreSQL source used by the external
// CloudNativePG standby. These checks deliberately pin a narrow transport and
// secret boundary: PostgreSQL is loopback-only, the existing HBA remains
// included, and deploy.sh consumes rather than generates the shared password.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const compose = read('docker-compose.yml');
const deploy = read('scripts/deploy.sh');
const installTunnelKey = read('scripts/install-cnpg-tunnel-key.sh');
const workflow = read('.github/workflows/deploy.yml');
const envExample = read('.env.example');
const gitignore = read('.gitignore');
const dockerignore = read('.dockerignore');
const hba = read('postgres/pg_hba.replication.conf');
const tunnelPublicKey = read('deploy/social-cnpg-tunnel.pub').trim();

test('production PostgreSQL publishes only the loopback migration port', () => {
  assert.match(compose, /- "127\.0\.0\.1:15432:5432"/);
  assert.doesNotMatch(compose, /- "(?:0\.0\.0\.0:)?15432:5432"/,
    'the migration listener must never bind a public interface');
});

test('the HBA wrapper adds one SCRAM replication rule and preserves existing auth', () => {
  assert.match(compose, /hba_file=\/etc\/postgresql\/pg_hba\.conf/);
  assert.match(compose,
    /\.\/postgres\/pg_hba\.replication\.conf:\/etc\/postgresql\/pg_hba\.conf:ro/);
  assert.match(hba,
    /^host replication social_cnpg_replica all scram-sha-256$/m);
  assert.match(hba,
    /^include \/var\/lib\/postgresql\/data\/pg_hba\.conf$/m);
  assert.equal(
    [...hba.matchAll(/^host\s+replication\s+/gm)].length,
    1,
    'keep replication authorization role-specific and reviewable'
  );
});

test('the source relies on PostgreSQL 17 replication defaults', () => {
  const dbService = compose.slice(
    compose.indexOf('  usernode-db:'),
    compose.indexOf('  usernode-minio:')
  );
  assert.doesNotMatch(dbService, /wal_level|max_wal_senders|wal_keep_size/,
    'the test mirror intentionally accepts re-bootstrap instead of source WAL-retention tuning');
});

test('the deployment consumes one supplied password and provisions the role idempotently', () => {
  assert.match(workflow,
    /REPLICATION_PASSWORD: \$\{\{ secrets\.SOCIAL_CNPG_REPLICATION_PASSWORD \}\}/);
  assert.match(workflow,
    /REPLICATION_PASSWORD_B64=\$\(printf '%s' "\$REPLICATION_PASSWORD" \| base64 -w0\)/);
  assert.match(workflow, /echo "::add-mask::\$REPLICATION_PASSWORD_B64"/,
    'the encoded transport value must be masked separately from the source secret');
  assert.doesNotMatch(envExample, /^SOCIAL_CNPG_REPLICATION_PASSWORD=/m,
    'the application env template must not carry the database-only secret');
  assert.match(compose,
    /env_file:\n\s+- \.\/runtime\/cnpg-replication\.env/);
  const platformService = compose.slice(0, compose.indexOf('services:'));
  assert.doesNotMatch(platformService, /SOCIAL_CNPG_REPLICATION_PASSWORD/,
    'the platform service anchor must never receive the replication password');
  assert.match(deploy, /CNPG_REPLICATION_ENV="runtime\/cnpg-replication\.env"/);
  assert.match(deploy, /chmod 600 "\$CNPG_REPLICATION_ENV\.tmp"/);
  assert.match(gitignore, /^runtime\/cnpg-replication\.env\*$/m,
    'local secret material must not be stageable');
  assert.match(dockerignore, /^runtime\/?$/m,
    'host runtime state must not enter the Docker build context');
  assert.ok(
    deploy.indexOf('CNPG_REPLICATION_ENV="runtime/cnpg-replication.env"') <
      deploy.indexOf('base64 -d > .env'),
    'a missing database secret must fail before patch mode records the target GIT_SHA'
  );
  assert.match(deploy, /\$\{SOCIAL_CNPG_REPLICATION_PASSWORD:\?SOCIAL_CNPG_REPLICATION_PASSWORD is required\}/);
  assert.match(deploy, /WHERE NOT EXISTS \([\s\S]*rolname = 'social_cnpg_replica'/);
  assert.match(deploy, /ALTER ROLE %I WITH LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS/);
  assert.doesNotMatch(deploy, /openssl rand|pwgen|generate-password/,
    'deploy.sh must consume the shared secret, never invent one that must be extracted');
});

test('deploy.sh installs a forwarding-only SSH key without replacing other keys', () => {
  assert.match(tunnelPublicKey, /^ssh-ed25519 [A-Za-z0-9+/=]+$/);
  assert.match(deploy, /bash scripts\/install-cnpg-tunnel-key\.sh/);
  assert.match(installTunnelKey, /awk '\$NF != "social-cnpg-tunnel"'/,
    'only the previously managed tunnel-key line may be replaced');
  assert.match(installTunnelKey,
    /restrict,port-forwarding,permitopen=\"127\.0\.0\.1:15432\",command=\"\/bin\/false\"/);
  assert.match(installTunnelKey, /mv "\$AUTHORIZED_KEYS_TMP" "\$AUTHORIZED_KEYS"/,
    'authorized_keys must be replaced atomically after the new file is complete');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cnpg-tunnel-home-'));
  const sshDir = path.join(home, '.ssh');
  const authorizedKeys = path.join(sshDir, 'authorized_keys');
  fs.mkdirSync(sshDir, { recursive: true });
  fs.writeFileSync(authorizedKeys, 'ssh-ed25519 EXISTING operator-key\n');

  try {
    for (let run = 0; run < 2; run += 1) {
      const result = spawnSync(
        'bash',
        ['scripts/install-cnpg-tunnel-key.sh'],
        { cwd: root, env: { ...process.env, HOME: home }, encoding: 'utf8' }
      );
      assert.equal(result.status, 0, result.stderr);
    }

    const lines = fs.readFileSync(authorizedKeys, 'utf8').trim().split('\n');
    assert.equal(lines.filter((line) => line.endsWith(' social-cnpg-tunnel')).length, 1,
      'repeated deploys must leave exactly one managed key');
    assert.ok(lines.includes('ssh-ed25519 EXISTING operator-key'),
      'the installer must preserve unrelated authorized keys');
    assert.equal(fs.statSync(authorizedKeys).mode & 0o777, 0o600);
    assert.equal(fs.statSync(sshDir).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
