const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const log = require('./logger');

const execFileAsync = promisify(execFile);

const DB_USER = process.env.DB_USER || 'usernode';

// All app DBs and their dedicated roles use these names. Slugs are
// already passed through the same regex on the way in, so the worst
// case here is a name we refuse to act on; better than splicing user
// input into DDL even by accident.
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/i;
const SAFE_QUALIFIED_IDENT = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i;

// The role name suffix is hard-coded so callers don't need to think
// about it. Every DB `app_xyz` has role `app_xyz_owner`.
const ROLE_SUFFIX = '_owner';

// pg_dump | pg_restore (cloneDatabase's copy step) can take a while for
// larger app DBs, so it gets a far more generous ceiling than
// execInTarget's fixed 30s. The copy is streamed through a pipe inside
// the container, so stdout stays tiny; this budget is purely for the
// copy itself. Override via DB_CLONE_TIMEOUT_MS if an app DB grows large
// enough to outrun the default.
const DUMP_RESTORE_TIMEOUT_MS = Number(process.env.DB_CLONE_TIMEOUT_MS) || 10 * 60 * 1000;

// Sentinel for NOT NULL columns scrubbed by `staging:private`. Chosen
// to be obviously non-functional in any auth or token-comparison path:
// bcrypt-style hashes start with `$2{a,b,y}$`, so bcrypt.compare
// against this string returns false for every input. Same shape works
// for any opaque-token column (wallet links, API keys); the auth path
// would need to special-case the literal to ever accept it, and we
// don't.
const STAGING_REDACTED_SENTINEL = '__staging_redacted__';

function appDbName(slug) {
  return `app_${slug.replace(/[^a-z0-9_]/g, '_')}`;
}

function stagingDbName(slug, username, commitHash) {
  const shortHash = commitHash.substring(0, 6);
  return `app_${slug.replace(/[^a-z0-9_]/g, '_')}_staging_${username.replace(/[^a-z0-9_]/g, '_')}_${shortHash}`;
}

function ownerRoleName(dbName) {
  return `${dbName}${ROLE_SUFFIX}`;
}

function generatePassword() {
  // 24 random bytes → 48 hex chars. Hex contains no URL- or SQL-special
  // characters, so the password is safe to splice into a `postgres://`
  // URL or a `CREATE ROLE … PASSWORD '…'` statement without escaping.
  return crypto.randomBytes(24).toString('hex');
}

// Build the connection URL for an app or staging DB using its
// dedicated role. The password is required — passing it explicitly at
// every call site rather than reading it from env makes the
// per-DB-credential model visible in the code: every place that opens
// a connection has to come up with the right credential, instead of
// silently falling back to the superuser. See SELF-HOSTING.md
// "Per-app postgres roles".
function connectionUrl(dbName, password) {
  if (!dbName || !SAFE_IDENT.test(dbName)) {
    throw new Error(`connectionUrl: unsafe dbName ${JSON.stringify(dbName)}`);
  }
  if (!password || typeof password !== 'string') {
    throw new Error(
      `connectionUrl: password required for ${dbName}. ` +
      `If this is a legacy app row that pre-dates the per-role migration, ` +
      `db/migrate.js's migrateAppDbsToPerRole should have populated apps.db_password ` +
      `before any caller invoked connectionUrl. Likely cause: race between migration ` +
      `and a subsystem that started before it finished.`
    );
  }
  const role = ownerRoleName(dbName);
  const admin = adminConnection();
  admin.username = role;
  admin.password = password;
  admin.pathname = `/${dbName}`;
  return admin.toString();
}

function adminConnection() {
  const value = process.env.DB_ADMIN_URL || process.env.DATABASE_URL;
  if (!value) throw new Error('DB_ADMIN_URL or DATABASE_URL is required for database administration');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('DB_ADMIN_URL/DATABASE_URL is not a valid URL'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DB_ADMIN_URL/DATABASE_URL must use postgres:// or postgresql://');
  }
  return parsed;
}

function adminUser() {
  return decodeURIComponent(adminConnection().username || DB_USER);
}

function postgresEnv(dbName) {
  const admin = adminConnection();
  return {
    ...process.env,
    PGHOST: admin.hostname,
    PGPORT: admin.port || '5432',
    PGUSER: decodeURIComponent(admin.username || DB_USER),
    PGPASSWORD: decodeURIComponent(admin.password || ''),
    PGDATABASE: dbName,
    ...(admin.searchParams.get('sslmode') ? { PGSSLMODE: admin.searchParams.get('sslmode') } : {}),
  };
}

// Create a fresh database with a dedicated owner role. Caller MUST
// persist the returned password (e.g. into apps.db_password) — it
// can't be recovered after this call returns. Throws on any failure;
// no half-state is left behind because both CREATE statements run as
// independent commands and the caller will see the error.
async function createDatabase(dbName) {
  if (!SAFE_IDENT.test(dbName)) {
    throw new Error(`createDatabase: unsafe dbName ${JSON.stringify(dbName)}`);
  }
  const role = ownerRoleName(dbName);
  if (!SAFE_IDENT.test(role)) {
    throw new Error(`createDatabase: unsafe role ${JSON.stringify(role)}`);
  }
  const password = generatePassword();

  log.info('db-manager', 'Creating database with dedicated role', { dbName, role });

  // CREATE ROLE is independent of database existence. If the role
  // already exists from a partial earlier run, ALTER its password
  // instead so the caller's persisted value is what actually grants
  // access.
  await execInDb(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
      CREATE ROLE ${role} LOGIN PASSWORD '${password}';
    ELSE
      ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}';
    END IF;
  END $$;`);

  try {
    await execInDb(`CREATE DATABASE ${dbName} OWNER ${role}`);
  } catch (err) {
    if (err.message?.includes('already exists')) {
      // Pre-existing DB. Adopt it instead — set the owner, lock down
      // PUBLIC, hand back the new password. Idempotent if the DB is
      // already owned by this role.
      log.info('db-manager', 'Database already exists; adopting under per-role model', { dbName, role });
      await execInDb(`ALTER DATABASE ${dbName} OWNER TO ${role}`);
    } else {
      throw err;
    }
  }

  // Belt-and-suspenders: lock down PUBLIC so even a hypothetical
  // future role (with default permissions) can't connect. Owner +
  // superuser still can.
  await execInDb(`REVOKE CONNECT ON DATABASE ${dbName} FROM PUBLIC`);
  await execInDb(`GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${role}`);

  // Reassign any objects in the DB currently owned by the superuser
  // to the new role — a no-op for fresh CREATEs (no objects yet) but
  // important for the adoption branch above. We can't use
  // `REASSIGN OWNED BY ${DB_USER}` here because the superuser also
  // owns pg_toast tables pinned to pg_catalog, and postgres refuses
  // the whole REASSIGN when any system-required objects are involved
  // — see reassignUserObjectsTo for the full rationale.
  await reassignUserObjectsTo(dbName, adminUser(), role).catch((err) => {
    log.warn('db-manager', 'reassignUserObjectsTo skipped (likely no objects yet)', {
      dbName, err: err.message,
    });
  });

  log.info('db-manager', 'Database created with role', { dbName, role });
  return { password };
}

// Drop a database AND its dedicated role. Order matters: postgres
// won't drop a role that owns objects, so the DB has to go first.
// `DROP OWNED BY <role>` cleans up any cluster-level privileges
// (none in our model, but defensive).
async function dropDatabase(dbName) {
  log.info('db-manager', 'Dropping database', { dbName });

  if (!SAFE_IDENT.test(dbName)) {
    log.warn('db-manager', 'Refusing to drop database with unsafe name', { dbName });
    return;
  }

  // Terminate any open connections so DROP DATABASE doesn't error.
  await execInDb(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`
  ).catch(() => {});

  try {
    await execInDb(`DROP DATABASE IF EXISTS ${dbName}`);
  } catch (err) {
    log.warn('db-manager', 'Failed to drop database', { dbName, err: err.message });
    // Don't try to drop the role if the DB drop failed — the role
    // still owns it.
    return;
  }

  const role = ownerRoleName(dbName);
  if (!SAFE_IDENT.test(role)) return;

  await execInDb(`DROP OWNED BY ${role} CASCADE`).catch(() => {});
  await execInDb(`DROP ROLE IF EXISTS ${role}`).catch((err) => {
    log.warn('db-manager', 'Failed to drop role (may still own objects in another DB)', {
      role, err: err.message,
    });
  });

  log.info('db-manager', 'Database and role dropped', { dbName, role });
}

async function cloneDatabase(sourceDb, targetDb) {
  log.info('db-manager', 'Cloning database', { sourceDb, targetDb });

  if (!SAFE_IDENT.test(sourceDb) || !SAFE_IDENT.test(targetDb)) {
    throw new Error(`cloneDatabase: unsafe identifiers ${sourceDb}/${targetDb}`);
  }

  // Drop any prior clone (and its role) before cloning fresh. The
  // dropDatabase below also takes care of the role.
  await dropDatabase(targetDb);

  // Create the per-clone role first so we can hand it the fresh clone
  // as OWNER. No need to terminate the source's connections any more —
  // the dump/restore below copies the source while it stays actively in
  // use (see the note on the copy step).
  const targetRole = ownerRoleName(targetDb);
  if (!SAFE_IDENT.test(targetRole)) {
    throw new Error(`cloneDatabase: unsafe target role ${targetRole}`);
  }
  const password = generatePassword();
  await execInDb(`CREATE ROLE ${targetRole} LOGIN PASSWORD '${password}'`);

  // Copy the source into the clone with a logical pg_dump | pg_restore
  // rather than CREATE DATABASE … TEMPLATE. TEMPLATE requires ZERO other
  // sessions connected to the source at copy time, but the source here
  // is the LIVE prod DB whose app container holds a persistent
  // connection pool. The old terminate-then-TEMPLATE step therefore
  // raced the pool's near-instant reconnect: it failed intermittently
  // under light traffic and effectively always under sustained load
  // (GitHub #73 — "source database … is being accessed by other users").
  // pg_dump instead reads a consistent MVCC snapshot inside a
  // transaction (ACCESS SHARE locks only), so the prod app keeps serving
  // uninterrupted and there is no exclusive-access race.
  //
  // The clone starts from template0 (pristine, never-connected, so it's
  // always clonable) owned by the new role; pg_restore --no-owner then
  // lands every object owned by the psql superuser, and the
  // reassignUserObjectsTo(DB_USER → targetRole) pass below hands them to
  // the clone role — exactly the end-state the TEMPLATE path produced.
  await execInDb(`CREATE DATABASE ${targetDb} TEMPLATE template0 OWNER ${targetRole}`);

  // Don't dump data we are about to throw away. The scrub passes below
  // TRUNCATE every `staging:private` table anyway, so copying their rows
  // across the pipe is pure cost — and for the self-app it is the
  // DOMINANT cost of the whole proposal-checks pipeline: 99.3% of that
  // database's ~9.8 GB lives in private tables (vrf_obligations,
  // session_visuals, …), so each preview build spent ~4.5 minutes
  // dumping and restoring ~9.4 GB purely to delete it a moment later.
  // Discovering the set from the SOURCE (before the clone exists) and
  // handing it to pg_dump as --exclude-table-data drops the payload to
  // the ~80 MB that actually survives.
  const excludeData = await privateDataExclusions(sourceDb);
  const dumpStartedAt = Date.now();
  await dumpRestore(sourceDb, targetDb, excludeData);
  log.info('db-manager', 'Clone copy complete', {
    sourceDb, targetDb,
    excludedTables: excludeData.length,
    durationMs: Date.now() - dumpStartedAt,
  });

  // Lock down PUBLIC connect on the clone — the clone is single-tenant
  // (one staging container) and nothing else should be able to reach it.
  await execInDb(`REVOKE CONNECT ON DATABASE ${targetDb} FROM PUBLIC`);
  await execInDb(`GRANT ALL PRIVILEGES ON DATABASE ${targetDb} TO ${targetRole}`);

  // CREATE DATABASE … TEMPLATE copies tables but each one keeps its
  // original owner from the source DB. For a clone of a per-role-
  // migrated source, that owner is `<sourceDb>_owner`; for a clone
  // of a not-yet-migrated source (the self-app — db/migrate.js skips
  // self_hosted rows in migrateAppDbsToPerRole) it's the superuser.
  // Reassign every object inside the target DB to the new clone role
  // so it can ALTER, SELECT, INSERT, and DROP without privilege errors.
  //
  // Why not plain `REASSIGN OWNED BY sourceRole TO targetRole`? It
  // looks like the right tool — and was used here historically — but
  // it has a critical cluster-wide side effect: REASSIGN OWNED also
  // walks shared catalogs (`pg_database`, `pg_tablespace`,
  // `pg_auth_members`), reassigning ownership of *databases* the
  // source role owns. In our setup `app_<slug>_owner` owns the prod
  // database `app_<slug>`, so cloning prod into a staging clone
  // silently transferred prod's `pg_database` row + its grants to the
  // throwaway staging role. The prod container kept its existing
  // pool connections alive, so nothing broke until the container was
  // next restarted (merge rebuild, drift redeploy, host reboot) —
  // at which point the new container couldn't connect to its own DB
  // with FATAL 42501 "permission denied for database … User does not
  // have CONNECT privilege." See the post-mortem in the commit that
  // introduced this comment.
  //
  // The superuser-owned fast path has its own reason to avoid
  // REASSIGN OWNED: the superuser also owns pg_toast tables pinned
  // to pg_catalog, and postgres aborts the whole REASSIGN with
  // "cannot reassign ownership of objects owned by role X because
  // they are required by the database system" — which used to be
  // swallowed at .catch(debug), silently leaving tables owned by
  // the superuser and producing clones the new role couldn't ALTER
  // (staging crash-looped with `42501 must be owner of table users`
  // on the first migration).
  //
  // reassignUserObjectsTo enumerates only user-schema objects in
  // the target DB and ALTERs each one individually — no shared-
  // catalog side effects, no pg_catalog interference. Calling it
  // once per source role (the prod owner if it exists, and the
  // superuser as a fallback for the self-app case) covers both
  // template variants without the REASSIGN OWNED footgun.
  const sourceRole = ownerRoleName(sourceDb);
  if (SAFE_IDENT.test(sourceRole)) {
    await reassignUserObjectsTo(targetDb, sourceRole, targetRole).catch((err) => {
      log.warn('db-manager', 'reassignUserObjectsTo from source-role failed', {
        targetDb, sourceRole, err: err.message,
      });
    });
  }
  await reassignUserObjectsTo(targetDb, adminUser(), targetRole).catch((err) => {
    log.warn('db-manager', 'reassignUserObjectsTo from superuser failed', {
      targetDb, err: err.message,
    });
  });

  // Enforce the public/private convention documented in
  // src/prompts/app-conventions.md. The copy above brings schema
  // wholesale; the two passes below redact prod rows so staging clients
  // see the structure but none of the production data.
  //
  // Pass 1 is now mostly a BACKSTOP rather than the primary mechanism:
  // privateDataExclusions already kept those tables' data out of the dump
  // (see the copy step above), so the TRUNCATEs run against empty tables.
  // It stays, deliberately and unchanged, for three reasons: it is the
  // redaction guarantee if the exclusion set and this discovery ever
  // disagree; it covers a table whose identifier the exclusion pass
  // refused to splice; and `TRUNCATE … RESTART IDENTITY` is what resets
  // sequences — --exclude-table-data leaves them at their prod positions,
  // so dropping this pass would silently change clone behaviour.
  //
  // Pass 1 — table-level: any table tagged
  //   COMMENT ON TABLE foo IS 'staging:private'
  // is TRUNCATEd. Use this for tables whose every row is sensitive
  // (sessions, app_secrets, llm_usage, …).
  //
  // Pass 2 — column-level: any column tagged
  //   COMMENT ON COLUMN foo.bar IS 'staging:private'
  // is UPDATE'd to NULL (or a sentinel for NOT NULL columns), with the
  // surrounding row left intact. Use this for tables where the row
  // identity is useful in staging (FK targets for attribution) but a
  // few columns carry secrets — the canonical case is `users`, where
  // username + id + pubkey survive but password / API keys / wallet
  // tokens get redacted; and `apps`, where the app row identity is
  // visible but per-app db_password values get NULL'd.
  //
  // Failures in either pass are fatal — refusing to spawn a staging
  // container is strictly safer than spawning one that leaks. Tables
  // truncated in pass 1 are no-ops for pass 2 (UPDATE on empty), so
  // tagging both levels on the same table is harmless.
  await truncatePrivateTables(targetDb);
  await scrubPrivateColumns(targetDb);

  log.info('db-manager', 'Database cloned with new role', { sourceDb, targetDb, targetRole });
  return { password };
}

// Replacement for `REASSIGN OWNED BY <fromRole> TO <toRole>` in cases
// where `fromRole` is a postgres superuser (in our setup, the
// `usernode` user that owns every per-app database). Postgres refuses
// `REASSIGN OWNED BY` for any role that also owns pinned objects in
// pg_catalog — and every superuser does, because pg_toast tables
// attached to system catalogs are owned by whichever role created
// the database. The error reads:
//
//   ERROR: cannot reassign ownership of objects owned by role <r>
//   because they are required by the database system
//
// …which aborts the entire REASSIGN even though the user-schema
// objects we actually want to move are perfectly reassignable. This
// helper enumerates only objects in non-system schemas and ALTERs
// each one individually, which is exactly what REASSIGN OWNED BY
// would have done if it had a "skip system objects" mode. Indexes,
// pg_toast tables, and other dependent objects follow their parent
// table automatically. We cover:
//
//   - relations    (tables, partitioned tables, views, matviews,
//                   sequences, foreign tables) via pg_class
//   - functions    via pg_proc
//   - types        (enum/domain/standalone composite — we skip the
//                   row types autogenerated for tables, those follow
//                   the table via the relation pass)
//   - schemas      (any user-created schema; we leave `public`
//                   alone because postgres special-cases its owner)
//
// Names are validated by SAFE_IDENT before being spliced. The DO
// block uses format(%I) for inner identifiers belt-and-suspenders.
async function reassignUserObjectsTo(dbName, fromRole, toRole) {
  if (!SAFE_IDENT.test(dbName)) {
    throw new Error(`reassignUserObjectsTo: unsafe dbName ${JSON.stringify(dbName)}`);
  }
  if (!SAFE_IDENT.test(fromRole)) {
    throw new Error(`reassignUserObjectsTo: unsafe fromRole ${JSON.stringify(fromRole)}`);
  }
  if (!SAFE_IDENT.test(toRole)) {
    throw new Error(`reassignUserObjectsTo: unsafe toRole ${JSON.stringify(toRole)}`);
  }

  const sql = `
DO $$
DECLARE r RECORD;
BEGIN
  -- Relations: tables, partitioned tables, views, matviews,
  -- sequences, foreign tables. Indexes (relkind='i') and toast
  -- tables (relkind='t') are deliberately omitted; they inherit
  -- ownership from their parent table on ALTER TABLE OWNER TO.
  --
  -- The NOT EXISTS clause skips sequences (and any other relation)
  -- that pg_depend marks as auto/internal-linked to a parent table
  -- — i.e. the SERIAL/IDENTITY sequences postgres creates implicitly
  -- when you declare an auto-increment column. Postgres refuses to
  -- ALTER … OWNER TO those independently of their parent ("cannot
  -- change owner of sequence X: linked to table Y"), and ALTER TABLE
  -- on the parent already transfers them. Filtering here keeps the
  -- DO block side-effect-clean instead of relying on per-statement
  -- error swallowing.
  FOR r IN
    SELECT n.nspname, c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles role  ON role.oid = c.relowner
     WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
       AND role.rolname = '${fromRole}'
       AND c.relkind IN ('r','p','v','m','S','f')
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.objid = c.oid
            AND d.classid = 'pg_class'::regclass
            AND d.deptype IN ('a','i')
       )
  LOOP
    EXECUTE format(
      'ALTER %s %I.%I OWNER TO %I',
      CASE r.relkind
        WHEN 'r' THEN 'TABLE'
        WHEN 'p' THEN 'TABLE'
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'S' THEN 'SEQUENCE'
        WHEN 'f' THEN 'FOREIGN TABLE'
      END,
      r.nspname, r.relname, '${toRole}'
    );
  END LOOP;

  -- Functions and procedures.
  FOR r IN
    SELECT n.nspname, p.proname,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles role  ON role.oid = p.proowner
     WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
       AND role.rolname = '${fromRole}'
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) OWNER TO %I',
      r.nspname, r.proname, r.args, '${toRole}'
    );
  END LOOP;

  -- Types: enums (e), domains (d), standalone composites (c). We
  -- exclude composite types autogenerated for tables (they have a
  -- matching pg_class row whose reltype points back at the type) —
  -- those follow ALTER TABLE OWNER above.
  FOR r IN
    SELECT n.nspname, t.typname
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_roles role  ON role.oid = t.typowner
     WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
       AND role.rolname = '${fromRole}'
       AND t.typtype IN ('e','d','c')
       AND NOT EXISTS (
         SELECT 1 FROM pg_class c WHERE c.reltype = t.oid
       )
  LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO %I', r.nspname, r.typname, '${toRole}');
  END LOOP;

  -- User-created schemas. 'public' is intentionally skipped — its
  -- ownership is a global postgres concern (default schema), and
  -- our app DBs only put objects in 'public' anyway.
  FOR r IN
    SELECT n.nspname
      FROM pg_namespace n
      JOIN pg_roles role ON role.oid = n.nspowner
     WHERE n.nspname NOT LIKE 'pg_%'
       AND n.nspname NOT IN ('information_schema','public')
       AND role.rolname = '${fromRole}'
  LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', r.nspname, '${toRole}');
  END LOOP;
END $$;`;

  await execInTarget(dbName, sql);
}

// One-shot per-app DB adoption used by the boot migration in
// src/db/migrate.js. For an existing DB owned by the superuser:
// create the dedicated role, transfer ownership, lock down PUBLIC,
// reassign in-DB objects. Idempotent: if the role already exists,
// rotates its password (callers must persist the returned value);
// if ownership is already correct, ALTER DATABASE is a no-op.
//
// Run only against DBs that the platform owns. Calling this for the
// platform's own database (`app_usernode_2d5619`) would orphan the
// platform from its tables — db/migrate.js skips self_hosted rows.
async function adoptExistingDatabase(dbName) {
  if (!SAFE_IDENT.test(dbName)) {
    throw new Error(`adoptExistingDatabase: unsafe dbName ${JSON.stringify(dbName)}`);
  }
  const role = ownerRoleName(dbName);
  const password = generatePassword();

  log.info('db-manager', 'Adopting existing database under per-role model', { dbName, role });

  // 1. Ensure role exists with the new password.
  await execInDb(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
      CREATE ROLE ${role} LOGIN PASSWORD '${password}';
    ELSE
      ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}';
    END IF;
  END $$;`);

  // 2. Transfer DB ownership.
  await execInDb(`ALTER DATABASE ${dbName} OWNER TO ${role}`);

  // 3. Lock down PUBLIC + grant to owner.
  await execInDb(`REVOKE CONNECT ON DATABASE ${dbName} FROM PUBLIC`);
  await execInDb(`GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${role}`);

  // 4. Reassign every user-schema object currently owned by the
  // superuser to the new role. Without this the app's pool (now
  // connecting as the new role) couldn't ALTER its own tables,
  // INSERT into sequences it doesn't own, or DROP anything during
  // schema migrations. Scoped to user schemas in the target DB only
  // (see reassignUserObjectsTo), so this can't reach into other DBs
  // in the cluster and never touches system catalogs.
  await reassignUserObjectsTo(dbName, adminUser(), role);

  log.info('db-manager', 'Adoption complete', { dbName, role });
  return { password };
}

// Used by the boot migration's verify path: if apps.db_password is
// already populated but the role got dropped (manual postgres
// intervention, restored backup, etc.), recreate it with the stored
// password so the running container's URL keeps working.
async function ensureRoleExists(dbName, password) {
  if (!SAFE_IDENT.test(dbName)) {
    throw new Error(`ensureRoleExists: unsafe dbName ${JSON.stringify(dbName)}`);
  }
  if (!password || typeof password !== 'string') {
    throw new Error('ensureRoleExists: password required');
  }
  const role = ownerRoleName(dbName);
  await execInDb(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
      CREATE ROLE ${role} LOGIN PASSWORD '${password}';
    ELSE
      ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}';
    END IF;
  END $$;`);
  await execInDb(`ALTER DATABASE ${dbName} OWNER TO ${role}`).catch(() => {});
  await execInDb(`REVOKE CONNECT ON DATABASE ${dbName} FROM PUBLIC`).catch(() => {});
  await execInDb(`GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${role}`).catch(() => {});
}

async function databaseExists(dbName) {
  if (!SAFE_IDENT.test(dbName)) return false;
  try {
    const stdout = await execInDb(
      `SELECT 1 FROM pg_database WHERE datname = '${dbName}'`,
      { tuplesOnly: true }
    );
    return (stdout || '').trim() === '1';
  } catch {
    return false;
  }
}

async function roleExists(roleName) {
  if (!SAFE_IDENT.test(roleName)) return false;
  try {
    const stdout = await execInDb(
      `SELECT 1 FROM pg_roles WHERE rolname = '${roleName}'`,
      { tuplesOnly: true }
    );
    return (stdout || '').trim() === '1';
  } catch {
    return false;
  }
}

async function execInDb(sql, opts = {}) {
  return execInTarget('usernode', sql, opts);
}

async function execInTarget(dbName, sql, opts = {}) {
  if (!SAFE_IDENT.test(dbName)) throw new Error(`execInTarget: unsafe dbName ${JSON.stringify(dbName)}`);
  const args = ['-X', '-v', 'ON_ERROR_STOP=1'];
  if (opts.tuplesOnly) {
    // -A unaligned, -t tuples-only — produces clean newline-separated
    // values with no header/footer, suitable for parsing.
    args.push('-At');
  }
  args.push('-c', sql);

  const { stdout, stderr } = await execFileAsync('psql', args, {
    timeout: 30000,
    env: postgresEnv(dbName),
  });

  if (stderr && !stderr.includes('NOTICE')) {
    throw new Error(stderr);
  }
  return stdout;
}

// Which tables' DATA can be skipped by the clone's pg_dump — i.e. exactly
// the set truncatePrivateTables is going to empty anyway.
//
// It is NOT just the `staging:private` tables. That pass runs
// `TRUNCATE … CASCADE`, so it also empties every table holding a foreign
// key INTO a private table, transitively. Production has three of those:
// pr_votes, pr_undo_votes and maintenance_campaign_apps all FK
// chat_sessions (which is private). Excluding a parent's data without
// excluding the child's would restore rows pointing at nothing, pg_restore
// would report FK violations, and dumpRestore's "errors ignored on
// restore" check would fail EVERY staging build. So the closure is a
// correctness requirement, not an optimisation — hence the recursive CTE
// below, which mirrors CASCADE's own reachability exactly.
//
// Discovery runs against the SOURCE db (the clone has no data yet) and a
// failure is FATAL: not knowing what is private means we can't know what
// is safe to skip, and guessing risks shipping prod rows into a preview.
// Names are re-validated with SAFE_QUALIFIED_IDENT before they reach the
// pg_dump argv, same stance as truncatePrivateTables.
async function privateDataExclusions(sourceDb) {
  if (!SAFE_IDENT.test(sourceDb)) {
    throw new Error(`privateDataExclusions: unsafe identifier ${sourceDb}`);
  }

  const discoverySql = `
WITH RECURSIVE priv AS (
  SELECT c.oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE obj_description(c.oid, 'pg_class') = 'staging:private'
     AND c.relkind = 'r'
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
), closure AS (
  SELECT oid FROM priv
  UNION
  SELECT con.conrelid
    FROM pg_constraint con
    JOIN closure cl ON cl.oid = con.confrelid
   WHERE con.contype = 'f'
     AND con.conrelid <> con.confrelid
)
SELECT n.nspname || '.' || c.relname
  FROM closure cl
  JOIN pg_class c     ON c.oid = cl.oid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'r'
   AND n.nspname NOT IN ('pg_catalog', 'information_schema')
 ORDER BY 1`.trim();

  let stdout;
  try {
    stdout = await execInTarget(sourceDb, discoverySql, { tuplesOnly: true });
  } catch (err) {
    log.error('db-manager', 'staging:private dump-exclusion discovery failed', {
      sourceDb, err: err.message,
    });
    throw new Error(
      `Failed to discover staging:private tables in ${sourceDb}: ${err.message}`
    );
  }

  const names = (stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const safe = [];
  for (const qualified of names) {
    if (!SAFE_QUALIFIED_IDENT.test(qualified)) {
      // Don't splice a non-standard identifier into the dump command.
      // Omitting it is safe: its data is still dumped and the truncate
      // pass still empties it — we only lose the speedup for that table.
      log.warn('db-manager', 'Refusing to exclude non-standard identifier from dump', {
        sourceDb, qualified,
      });
      continue;
    }
    safe.push(qualified);
  }

  log.debug('db-manager', 'Clone dump exclusions resolved', {
    sourceDb, count: safe.length,
  });
  return safe;
}

// Logical copy of one database into another via a networked
// pg_dump | pg_restore pipeline. cloneDatabase uses this instead of
// CREATE DATABASE … TEMPLATE so the source can be copied while it is
// actively serving traffic (see the note in cloneDatabase). Both names
// are SAFE_IDENT-validated by the caller; we re-check defensively before
// splicing them into the shell command.
//
// `excludeData` is the qualified-table list whose rows to skip (see
// privateDataExclusions) — schema, constraints and comments still ship.
async function dumpRestore(sourceDb, targetDb, excludeData = []) {
  if (!SAFE_IDENT.test(sourceDb) || !SAFE_IDENT.test(targetDb)) {
    throw new Error(`dumpRestore: unsafe identifiers ${sourceDb}/${targetDb}`);
  }
  for (const qualified of excludeData) {
    if (!SAFE_QUALIFIED_IDENT.test(qualified)) {
      throw new Error(`dumpRestore: unsafe exclude-table-data ${JSON.stringify(qualified)}`);
    }
  }

  // -Fc custom format piped straight into pg_restore (no temp file on
  // disk). --no-owner / --no-privileges: ownership and ACLs are
  // re-established by cloneDatabase's reassign + GRANT/REVOKE passes, so
  // we deliberately don't carry the source's role grants across (they
  // reference the prod-side role). Comments are KEPT — the scrub passes
  // (truncatePrivateTables / scrubPrivateColumns) discover their targets
  // via the 'staging:private' COMMENTs, so --no-comments would silently
  // disable redaction. Both child exit codes are checked so a pg_dump
  // failure cannot be masked by pg_restore's exit code.
  //
  // --exclude-table-data skips the COPY body for a table while still
  // dumping its schema, indexes, constraints, sequences and COMMENTs — so
  // the clone keeps the structure staging needs (and the 'staging:private'
  // comments the scrub passes discover their targets from), it just
  // arrives empty. See privateDataExclusions for how the set is derived
  // and why it must include the FK closure.
  const dumpArgs = [
    '-Fc',
    ...excludeData.map((qualified) => `--exclude-table-data=${qualified}`),
  ];
  const dump = spawn('pg_dump', dumpArgs, {
    env: postgresEnv(sourceDb), stdio: ['ignore', 'pipe', 'pipe'],
  });
  // pg_restore does not infer "restore into a database" from PGDATABASE:
  // without -d/--dbname it expects -f and exits before reading stdin. Keep
  // the explicit target in argv as well as postgresEnv(targetDb), which
  // provides the network credentials.
  const restore = spawn('pg_restore', pgRestoreArgs(targetDb), {
    env: postgresEnv(targetDb), stdio: ['pipe', 'ignore', 'pipe'],
  });
  dump.stdout.pipe(restore.stdin);
  let dumpStderr = '';
  let restoreStderr = '';
  dump.stderr.on('data', (chunk) => { dumpStderr = (dumpStderr + chunk).slice(-64 * 1024); });
  restore.stderr.on('data', (chunk) => { restoreStderr = (restoreStderr + chunk).slice(-64 * 1024); });
  const timer = setTimeout(() => {
    dump.kill('SIGKILL');
    restore.kill('SIGKILL');
  }, DUMP_RESTORE_TIMEOUT_MS);
  const waitChild = (child) => new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let dumpResult;
  let restoreResult;
  try {
    [dumpResult, restoreResult] = await Promise.all([waitChild(dump), waitChild(restore)]);
  } finally {
    clearTimeout(timer);
  }
  const stderr = `${dumpStderr}\n${restoreStderr}`.trim();
  if (dumpResult.code !== 0 || restoreResult.code !== 0) {
    throw new Error(
      `dumpRestore ${sourceDb} → ${targetDb} failed ` +
      `(pg_dump=${dumpResult.code ?? dumpResult.signal}, pg_restore=${restoreResult.code ?? restoreResult.signal}): ` +
      stderr.slice(0, 2000)
    );
  }

  // pg_restore continues past per-object errors by default and prints a
  // tally at the end ("errors ignored on restore: N"). Treat any such
  // tally as fatal: a partially-populated clone would boot staging with
  // missing schema/rows, which is worse than failing the build loudly.
  const ignored = /errors ignored on restore:\s*(\d+)/i.exec(stderr || '');
  if (ignored && Number(ignored[1]) > 0) {
    throw new Error(
      `dumpRestore ${sourceDb} → ${targetDb}: pg_restore reported ${ignored[1]} ` +
      `error(s). stderr: ${stderr.slice(0, 2000)}`
    );
  }
  if (stderr && stderr.trim()) {
    log.debug('db-manager', 'pg_dump|pg_restore stderr (non-fatal)', {
      sourceDb, targetDb, stderr: stderr.slice(0, 2000),
    });
  }
}

function pgRestoreArgs(targetDb) {
  if (!SAFE_IDENT.test(targetDb)) {
    throw new Error(`pgRestoreArgs: unsafe database name ${JSON.stringify(targetDb)}`);
  }
  return ['--exit-on-error', '--no-owner', '--no-privileges', '--dbname', targetDb];
}

async function truncatePrivateTables(targetDb) {
  // Discovery query. obj_description on pg_class returns the comment
  // attached via `COMMENT ON TABLE foo IS '...'`. relkind='r' filters
  // to ordinary tables (not views/indexes/sequences). We exclude
  // pg_catalog/information_schema defensively even though they
  // shouldn't have user comments.
  const discoverySql = `
SELECT n.nspname || '.' || c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE obj_description(c.oid, 'pg_class') = 'staging:private'
   AND c.relkind = 'r'
   AND n.nspname NOT IN ('pg_catalog', 'information_schema')
 ORDER BY 1`.trim();

  let stdout;
  try {
    stdout = await execInTarget(targetDb, discoverySql, { tuplesOnly: true });
  } catch (err) {
    // Discovery failure is fatal: we don't know what's private, so we
    // can't safely ship the staging clone.
    log.error('db-manager', 'staging:private discovery failed', {
      targetDb, err: err.message,
    });
    throw new Error(
      `Failed to discover staging:private tables in ${targetDb}: ${err.message}`
    );
  }

  const qualifiedNames = (stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (qualifiedNames.length === 0) {
    log.info('db-manager', 'No staging:private tables to truncate', { targetDb });
    return { truncated: [] };
  }

  log.info('db-manager', 'Truncating staging:private tables', {
    targetDb, count: qualifiedNames.length, tables: qualifiedNames,
  });

  // Per-table failures are collected rather than short-circuiting so
  // we don't leave half the private tables full because one failed.
  // After the pass, if anything failed, throw — a partial truncate is
  // still a leaky clone.
  const failures = [];
  const truncated = [];
  for (const qualified of qualifiedNames) {
    if (!SAFE_QUALIFIED_IDENT.test(qualified)) {
      log.warn('db-manager', 'Refusing to TRUNCATE non-standard identifier', {
        targetDb, qualified,
      });
      failures.push({ table: qualified, error: 'unsafe identifier' });
      continue;
    }
    try {
      await execInTarget(targetDb, `TRUNCATE ${qualified} RESTART IDENTITY CASCADE`);
      truncated.push(qualified);
    } catch (err) {
      log.error('db-manager', 'TRUNCATE failed', {
        targetDb, table: qualified, err: err.message,
      });
      failures.push({ table: qualified, error: err.message });
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Failed to truncate ${failures.length} staging:private table(s) in ${targetDb}: ` +
      failures.map((f) => `${f.table} (${f.error})`).join('; ')
    );
  }

  return { truncated };
}

async function scrubPrivateColumns(targetDb) {
  // Discovery query mirrors truncatePrivateTables but at the column
  // level. col_description is the column-comment counterpart of
  // obj_description. attnum > 0 filters out system columns; attisdropped
  // skips logically-removed columns that pg keeps as zombies. The
  // information_schema.columns join adds character_maximum_length so we
  // can size the per-row placeholder to fit (e.g. VARCHAR(64)). Output is
  // pipe-separated quadruples: <schema.table>|<column>|<not_null t/f>|<max_length or empty>.
  const discoverySql = `
SELECT n.nspname || '.' || c.relname,
       a.attname,
       a.attnotnull,
       COALESCE(ic.character_maximum_length::text, '')
  FROM pg_attribute a
  JOIN pg_class    c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN information_schema.columns ic
    ON ic.table_schema = n.nspname
   AND ic.table_name = c.relname
   AND ic.column_name = a.attname
 WHERE col_description(a.attrelid, a.attnum) = 'staging:private'
   AND c.relkind = 'r'
   AND a.attnum > 0
   AND NOT a.attisdropped
   AND n.nspname NOT IN ('pg_catalog', 'information_schema')
 ORDER BY 1, 2`.trim();

  let stdout;
  try {
    stdout = await execInTarget(targetDb, discoverySql, { tuplesOnly: true });
  } catch (err) {
    log.error('db-manager', 'staging:private column discovery failed', {
      targetDb, err: err.message,
    });
    throw new Error(
      `Failed to discover staging:private columns in ${targetDb}: ${err.message}`
    );
  }

  const targets = (stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      // psql -At with the default field separator '|'. Four fields;
      // the third is exactly 't' or 'f' from a bool column, the fourth
      // is a character_maximum_length integer or '' when unbounded
      // (e.g. TEXT).
      const [qualified, column, notNullRaw, maxLengthRaw] = line.split('|');
      const maxLength = maxLengthRaw ? Number(maxLengthRaw) : null;
      return { qualified, column, notNull: notNullRaw === 't', maxLength };
    });

  if (targets.length === 0) {
    log.info('db-manager', 'No staging:private columns to scrub', { targetDb });
    return { scrubbed: [] };
  }

  log.info('db-manager', 'Scrubbing staging:private columns', {
    targetDb,
    count: targets.length,
    columns: targets.map((t) => `${t.qualified}.${t.column}`),
  });

  const failures = [];
  const scrubbed = [];
  for (const { qualified, column, notNull, maxLength } of targets) {
    if (!SAFE_QUALIFIED_IDENT.test(qualified) || !SAFE_IDENT.test(column)) {
      log.warn('db-manager', 'Refusing to UPDATE non-standard identifier', {
        targetDb, qualified, column,
      });
      failures.push({ target: `${qualified}.${column}`, error: 'unsafe identifier' });
      continue;
    }
    let value;
    if (!notNull) {
      value = 'NULL';
    } else if (maxLength != null && (!Number.isInteger(maxLength) || maxLength < 1)) {
      // Unexpected metadata shape — fail closed rather than guess at a
      // placeholder that might not fit the column.
      log.error('db-manager', 'staging:private column has unusable max length', {
        targetDb, qualified, column, maxLength,
      });
      failures.push({ target: `${qualified}.${column}`, error: `unusable max length ${maxLength}` });
      continue;
    } else {
      // NOT NULL columns can't accept NULL, and a single literal
      // sentinel breaks any UNIQUE constraint on the column (the
      // production incident: onchain_accounts.registration_code is
      // NOT NULL UNIQUE, so writing '__staging_redacted__' into every
      // row failed the whole clone). Derive a per-row-unique value from
      // ctid — unique within the table for the life of this single
      // UPDATE — sized to the column's max length when it has one (e.g.
      // VARCHAR(64)) so it never overflows. Auth code should never
      // accept this literal in any code path — bcrypt.compare against
      // it returns false for every plaintext, which is the only place
      // today that meaningfully reads users.password.
      const base = `'${STAGING_REDACTED_SENTINEL}' || ctid::text`;
      value = maxLength != null ? `left(${base}, ${maxLength})` : base;
    }
    try {
      await execInTarget(targetDb, `UPDATE ${qualified} SET ${column} = ${value}`);
      scrubbed.push(`${qualified}.${column}`);
    } catch (err) {
      log.error('db-manager', 'staging:private column UPDATE failed', {
        targetDb, qualified, column, err: err.message,
      });
      failures.push({ target: `${qualified}.${column}`, error: err.message });
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Failed to scrub ${failures.length} staging:private column(s) in ${targetDb}: ` +
      failures.map((f) => `${f.target} (${f.error})`).join('; ')
    );
  }

  return { scrubbed };
}

module.exports = {
  appDbName,
  stagingDbName,
  ownerRoleName,
  createDatabase,
  dropDatabase,
  cloneDatabase,
  connectionUrl,
  adoptExistingDatabase,
  ensureRoleExists,
  databaseExists,
  roleExists,
  truncatePrivateTables,
  scrubPrivateColumns,
  privateDataExclusions,
  pgRestoreArgs,
};
