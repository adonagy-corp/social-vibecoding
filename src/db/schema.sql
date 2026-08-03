-- Users & auth
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  username        VARCHAR(255) UNIQUE NOT NULL,
  password        VARCHAR(255) NOT NULL,
  is_admin        BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
-- #30: optional user-provided Anthropic API key. `anthropic_key_enc`
-- holds the encrypted payload (v1:<iv>:<tag>:<ct>, base64). We also
-- keep the last 4 chars unencrypted purely so the UI can show
-- "sk-ant-…abcd" without a decrypt round-trip.
ALTER TABLE users ADD COLUMN IF NOT EXISTS anthropic_key_enc    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS anthropic_key_last4  VARCHAR(8);

-- Per-user app-creation permission, toggled by admins from /admin.
-- Default FALSE; existing admins are backfilled to TRUE on boot.
-- Enforced server-side on POST /api/apps in src/routes/apps.js;
-- the home-screen "Create new app" affordance is hidden client-side
-- for users who fail the check (see Home.canCreate in
-- frontend/src/features/home/home.js).
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_create_apps BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE users SET can_create_apps = TRUE WHERE is_admin = TRUE AND can_create_apps = FALSE;

-- Per-user app-creation quota: the maximum number of live (non-errored)
-- apps a user may have created. This is the actual app-creation gate (see
-- src/routes/apps.js) — a non-admin may create iff their live app count is
-- below this number, so deleting an app frees a slot (mirrors the server-
-- wide maxApps cap). Default 0 means "cannot create until an admin raises
-- it", matching the old can_create_apps default-off behaviour. Admins
-- bypass enforcement entirely — their quota is purely cosmetic. The client
-- still sees a derived `canCreateApps` boolean (computed in auth/me as
-- isAdmin || liveCount < app_quota) so the home screen needs no change; the
-- numeric quota is surfaced only through the admin API. `can_create_apps`
-- is KEPT for now purely as the one-shot backfill source below — dropping
-- it (and the derived canCreateApps plumbing) is deferred work.
ALTER TABLE users ADD COLUMN IF NOT EXISTS app_quota INTEGER NOT NULL DEFAULT 0;

-- is_admin is now mutable from the admin panel (grant/revoke toggle in
-- public/admin.html → POST /api/admin/users/:id/is-admin). The column is
-- nullable (DEFAULT FALSE, declared at the top of the table) so legacy
-- rows could hold NULL; normalize to FALSE so the last-admin guard's
-- `COUNT(*) WHERE is_admin = TRUE` and every `is_admin = TRUE` read treat
-- NULL and FALSE identically. Idempotent — safe to run every boot.
UPDATE users SET is_admin = FALSE WHERE is_admin IS NULL;

-- View-only admin role (issue #311). `is_admin` remains the visibility
-- tier ("can see every admin surface"); `admin_readonly` marks an admin
-- whose access is read-only — they see everything a full admin sees but
-- cannot perform any mutating/privileged action. The canonical role is
-- derived, no enum needed:
--   is_admin = FALSE                          → normal user (this column ignored)
--   is_admin = TRUE  AND admin_readonly = FALSE → full admin
--   is_admin = TRUE  AND admin_readonly = TRUE  → view-only admin
-- Auth derives `canAdminWrite = is_admin AND NOT admin_readonly` (the single
-- write gate) in src/middleware/auth.js; every read/visibility gate keeps
-- keying off is_admin unchanged. Backfill is automatic — existing admin rows
-- default to FALSE (stay full admins). NOT tagged staging:private below
-- (non-sensitive, like is_admin) so staging shows correct roles. Idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_readonly BOOLEAN NOT NULL DEFAULT FALSE;

-- Usernode wallet linking: pubkey is the on-chain identity once linked;
-- token + expiry gate the QR-based linking flow.
ALTER TABLE users ADD COLUMN IF NOT EXISTS usernode_pubkey          VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_link_token        VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_link_expires_at   TIMESTAMPTZ;

-- Per-user override of the platform-wide daily LLM spend cap. NULL means
-- "use the global default" stored in platform_settings.user_daily_limit_cents
-- (see below). Set by admins from /admin to grant trusted users a higher
-- cap without raising it for everyone. Read by checkBudget() in
-- src/routes/sessions.js via src/services/limits.js.
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_limit_cents INTEGER;

-- Experimental: opt-in AI progress estimate for coding runs. When TRUE,
-- the platform periodically asks Haiku to skim the in-flight Claude Code
-- progress log and emits a vague "AI guess" line in dev-chat (see
-- runClaudeCodeTool in src/routes/sessions.js). Default OFF for everyone
-- while the experiment runs; toggled from Settings → Experimental via
-- POST /api/me/ai-progress-estimate.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_progress_estimate BOOLEAN NOT NULL DEFAULT FALSE;

-- Home-screen panels the viewer has dismissed (issue #911) — the keys of
-- the cards that sit on the home screen next to the app grid ('challenges'
-- today; see PANEL_REGISTRY in src/routes/home-panels.js, the only reader
-- and writer of this column). ABSENCE MEANS VISIBLE: an empty array — the
-- default for every existing and future row — means every panel in the
-- registry shows, which is what makes the challenges card default-on for
-- everyone with no backfill. Written only through
-- POST /api/home-panels/:key/visibility, which validates the key against
-- the registry, so the array can never accumulate unknown values. Called
-- "panels" and not "widgets" deliberately: the client half,
-- frontend/src/features/home/home.js, already uses "widget" for the iOS
-- home-screen widget's pinned app grid.
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_panels_hidden TEXT[] NOT NULL DEFAULT '{}';

-- RETIRED — superseded by the `user_home_layout` table (free-form home-grid
-- placement). It used to hold an iOS-homescreen-style drag position per
-- panel key ({ "challenges": 4 } = four app cards above the block), which
-- only ever expressed "which flow slot" — the home grid now stores real
-- (column, row) cells per breakpoint instead, and holes are a first-class
-- concept a card-count can't represent.
--
-- The column is LEFT IN PLACE, unread and unwritten: this file is
-- append-only (it has no DROP COLUMN anywhere) and a dead JSONB default of
-- '{}' costs nothing. Nothing may read it — see user_home_layout below.
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_panel_positions JSONB NOT NULL DEFAULT '{}';

-- Platform-level user language preference (issue #757). A BCP-47 language
-- tag ("id", "pt-BR", …) or NULL for "unset/auto — use device language".
-- Set from Settings → Language via POST /api/me/locale; exposed to apps as
-- the `locale` claim in the iframe JWT (server.js /api/iframe-token) and
-- through /api/auth/me → the shell → the bridge's usernode.getUserLocale().
-- 35 chars is the RFC 5646 recommended buffer for BCP-47 tags.
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale VARCHAR(35);

-- Preferred development flow (issue #1049). NULL = "ask me every time", the
-- default: the dev-chat picker renders and the user chooses per proposal.
-- A non-NULL value is the "remember my option" checkbox — 'platform' builds
-- here with the platform's own agent, 'claude-code' / 'codex' hand the work
-- order to the user's own Claude Code / Codex web UI (the external-agent
-- flow in services/external-agent-tasks.js).
--
-- Written by POST /api/me/dev-flow, echoed by GET /api/auth/me as
-- `devFlowPreference`, and clearable back to NULL from Settings →
-- Connections. The CHECK is the same allowlist the route enforces, so a
-- direct DB write can never park an unrenderable value here.
ALTER TABLE users ADD COLUMN IF NOT EXISTS dev_flow_preference TEXT;
DO $$
BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_dev_flow_preference_chk;
  ALTER TABLE users ADD CONSTRAINT users_dev_flow_preference_chk
    CHECK (dev_flow_preference IS NULL
           OR dev_flow_preference IN ('platform', 'claude-code', 'codex'));
END $$;

CREATE TABLE IF NOT EXISTS sessions (
  token      VARCHAR(64) PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

-- Global CLI device authorization and opaque access tokens. These are
-- deliberately independent from browser sessions and iframe/app identity.
CREATE TABLE IF NOT EXISTS cli_device_authorizations (
  id BIGSERIAL PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE
    CHECK (device_code_hash ~ '^[0-9a-f]{64}$'),
  user_code TEXT NOT NULL UNIQUE
    CHECK (
      user_code = UPPER(user_code)
      AND user_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$'
    ),
  client_id TEXT NOT NULL DEFAULT 'social-vibecoding-cli'
    CHECK (client_id = 'social-vibecoding-cli'),
  scopes TEXT[] NOT NULL
    CONSTRAINT cli_device_authorizations_scopes_check
    CHECK (
      scopes = ARRAY['rpc:identity:read']::TEXT[]
      OR scopes = ARRAY['rpc:identity:read', 'api:access']::TEXT[]
      OR scopes = ARRAY['rpc:identity:read', 'api:access', 'agent:local']::TEXT[]
    ),
  request_ip INET NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'consumed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
    CHECK (expires_at = created_at + INTERVAL '10 minutes'),
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  last_polled_at TIMESTAMPTZ,
  poll_count INTEGER NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
  CHECK (
    (status = 'pending' AND user_id IS NULL
      AND approved_at IS NULL AND rejected_at IS NULL
      AND cancelled_at IS NULL AND consumed_at IS NULL)
    OR
    (status = 'approved' AND user_id IS NOT NULL
      AND approved_at IS NOT NULL AND rejected_at IS NULL
      AND cancelled_at IS NULL AND consumed_at IS NULL)
    OR
    (status = 'rejected' AND user_id IS NOT NULL
      AND approved_at IS NULL AND rejected_at IS NOT NULL
      AND cancelled_at IS NULL AND consumed_at IS NULL)
    OR
    (status = 'cancelled' AND user_id IS NOT NULL
      AND approved_at IS NOT NULL AND rejected_at IS NULL
      AND cancelled_at IS NOT NULL AND consumed_at IS NULL)
    OR
    (status = 'consumed' AND user_id IS NOT NULL
      AND approved_at IS NOT NULL AND rejected_at IS NULL
      AND cancelled_at IS NULL AND consumed_at IS NOT NULL)
  ),
  CHECK (approved_at IS NULL OR approved_at >= created_at),
  CHECK (rejected_at IS NULL OR rejected_at >= created_at),
  CHECK (cancelled_at IS NULL OR cancelled_at >= approved_at),
  CHECK (consumed_at IS NULL OR consumed_at >= approved_at),
  CHECK (approved_at IS NULL OR approved_at < expires_at),
  CHECK (rejected_at IS NULL OR rejected_at < expires_at),
  CHECK (cancelled_at IS NULL OR cancelled_at < expires_at),
  CHECK (consumed_at IS NULL OR consumed_at < expires_at),
  CHECK (
    (last_polled_at IS NULL AND poll_count = 0)
    OR
    (last_polled_at IS NOT NULL
      AND last_polled_at >= created_at
      AND poll_count > 0)
  )
);

CREATE TABLE IF NOT EXISTS cli_access_tokens (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint TEXT NOT NULL
    CHECK (token_hint ~ '^svcli_…[A-Za-z0-9_-]{4}$'),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL DEFAULT 'social-vibecoding-cli'
    CHECK (client_id = 'social-vibecoding-cli'),
  scopes TEXT[] NOT NULL
    CONSTRAINT cli_access_tokens_scopes_check
    CHECK (
      cardinality(scopes) <= 3
      AND scopes <@ ARRAY['rpc:identity:read', 'api:access', 'agent:local']::TEXT[]
    ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at = created_at + INTERVAL '30 days'),
  CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE TABLE IF NOT EXISTS cli_auth_audit_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'authorization_started', 'authorization_approved',
      'authorization_rejected', 'authorization_cancelled',
      'token_issued', 'token_used', 'token_revoked'
    )),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  device_authorization_id BIGINT,
  access_token_id BIGINT,
  client_id TEXT NOT NULL DEFAULT 'social-vibecoding-cli'
    CHECK (client_id = 'social-vibecoding-cli'),
  scopes TEXT[] NOT NULL
    CONSTRAINT cli_auth_audit_events_scopes_check
    CHECK (
      (event_type IN ('token_used', 'token_revoked')
       AND cardinality(scopes) <= 3
       AND scopes <@ ARRAY['rpc:identity:read', 'api:access', 'agent:local']::TEXT[])
      OR
      (event_type NOT IN ('token_used', 'token_revoked')
       AND (
         scopes = ARRAY['rpc:identity:read']::TEXT[]
         OR scopes = ARRAY['rpc:identity:read', 'api:access']::TEXT[]
         OR scopes = ARRAY['rpc:identity:read', 'api:access', 'agent:local']::TEXT[]
       ))
    ),
  outcome TEXT NOT NULL DEFAULT 'success'
    CHECK (
      (event_type = 'token_used'
       AND outcome IN ('scope_authorized', 'insufficient_scope'))
      OR (event_type <> 'token_used' AND outcome = 'success')
    ),
  metadata JSONB NOT NULL DEFAULT '{}'
    CONSTRAINT cli_auth_audit_events_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT cli_auth_audit_events_metadata_allowlist_check
    CHECK (
      (
        event_type = 'token_used'
        AND metadata ? 'method'
        AND metadata ? 'route'
        AND metadata - ARRAY['method', 'route']::TEXT[] = '{}'::JSONB
        AND jsonb_typeof(metadata->'method') = 'string'
        AND metadata->>'method' IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')
        AND jsonb_typeof(metadata->'route') = 'string'
        AND char_length(metadata->>'route') BETWEEN 1 AND 2048
        AND metadata->>'route' LIKE '/api/%'
      )
      OR (
        event_type = 'authorization_cancelled'
        AND metadata = '{"reason":"account_recovery"}'::JSONB
      )
      OR (
        event_type = 'token_revoked'
        AND metadata ? 'reason'
        AND jsonb_typeof(metadata->'reason') = 'string'
        AND metadata->>'reason' IN ('self', 'settings', 'account_recovery')
        AND metadata - 'reason' = '{}'::JSONB
      )
      OR (
        event_type NOT IN (
          'token_used', 'authorization_cancelled', 'token_revoked'
        )
        AND metadata = '{}'::JSONB
      )
    ),
  CHECK (
    (event_type IN (
      'authorization_started', 'authorization_approved',
      'authorization_rejected', 'authorization_cancelled'
    ) AND device_authorization_id IS NOT NULL)
    OR
    (event_type = 'token_issued'
      AND device_authorization_id IS NOT NULL
      AND access_token_id IS NOT NULL)
    OR
    (event_type IN ('token_used', 'token_revoked')
      AND access_token_id IS NOT NULL)
  )
);

-- Expand the CLI grant from identity-only to the authenticated user-facing
-- JSON API.
-- Existing identity-only rows remain valid until they expire or are revoked;
-- all newly-created device grants request the exact two-scope set.
DO $$
DECLARE
  constraint_name TEXT;
  constraint_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO constraint_def
    FROM pg_constraint
   WHERE conrelid = 'cli_device_authorizations'::regclass
     AND conname = 'cli_device_authorizations_scopes_check';
  IF constraint_def IS NOT NULL
      AND position('agent:local' IN constraint_def) = 0 THEN
    ALTER TABLE cli_device_authorizations
      DROP CONSTRAINT cli_device_authorizations_scopes_check;
    ALTER TABLE cli_device_authorizations
      ADD CONSTRAINT cli_device_authorizations_scopes_check CHECK (
        scopes = ARRAY['rpc:identity:read']::TEXT[]
        OR scopes = ARRAY['rpc:identity:read', 'api:access']::TEXT[]
        OR scopes = ARRAY['rpc:identity:read', 'api:access', 'agent:local']::TEXT[]
      );
  END IF;

  SELECT pg_get_constraintdef(oid) INTO constraint_def
    FROM pg_constraint
   WHERE conrelid = 'cli_access_tokens'::regclass
     AND conname = 'cli_access_tokens_scopes_check';
  IF constraint_def IS NOT NULL
      AND position('agent:local' IN constraint_def) = 0 THEN
    ALTER TABLE cli_access_tokens
      DROP CONSTRAINT cli_access_tokens_scopes_check;
    ALTER TABLE cli_access_tokens
      ADD CONSTRAINT cli_access_tokens_scopes_check CHECK (
        cardinality(scopes) <= 3
        AND scopes <@ ARRAY['rpc:identity:read', 'api:access', 'agent:local']::TEXT[]
      );
  END IF;

  -- This table's original multi-column inline CHECK was auto-named
  -- cli_auth_audit_events_check rather than ..._scopes_check. Discover it
  -- by the protected column so deployed databases migrate regardless of
  -- PostgreSQL's generated name; new databases use the explicit name above.
  SELECT conname, pg_get_constraintdef(oid)
    INTO constraint_name, constraint_def
    FROM pg_constraint
   WHERE conrelid = 'cli_auth_audit_events'::regclass
     AND contype = 'c'
     AND position('scopes' IN pg_get_constraintdef(oid)) > 0
   ORDER BY oid
   LIMIT 1;
  IF constraint_def IS NOT NULL
      AND position('agent:local' IN constraint_def) = 0 THEN
    EXECUTE format(
      'ALTER TABLE cli_auth_audit_events DROP CONSTRAINT %I',
      constraint_name
    );
    ALTER TABLE cli_auth_audit_events
      ADD CONSTRAINT cli_auth_audit_events_scopes_check CHECK (
        (event_type IN ('token_used', 'token_revoked')
         AND cardinality(scopes) <= 3
         AND scopes <@ ARRAY['rpc:identity:read', 'api:access', 'agent:local']::TEXT[])
        OR
        (event_type NOT IN ('token_used', 'token_revoked')
         AND (
           scopes = ARRAY['rpc:identity:read']::TEXT[]
           OR scopes = ARRAY['rpc:identity:read', 'api:access']::TEXT[]
           OR scopes = ARRAY['rpc:identity:read', 'api:access', 'agent:local']::TEXT[]
         ))
      );
  END IF;
END $$;

-- CREATE TABLE does not add new constraints to an existing deployment.
-- Install the exact audit-metadata allowlist when upgrading an older schema.
DO $$
DECLARE
  constraint_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO constraint_def
      FROM pg_constraint
     WHERE conrelid = 'cli_auth_audit_events'::regclass
       AND conname = 'cli_auth_audit_events_metadata_allowlist_check';
  IF constraint_def IS NOT NULL
      AND (
        position('metadata ? ''reason''' IN constraint_def) = 0
        OR position('''POST''' IN constraint_def) = 0
        OR position('''PUT''' IN constraint_def) = 0
        OR position('''PATCH''' IN constraint_def) = 0
        OR position('''DELETE''' IN constraint_def) = 0
        OR position('''/api/%''' IN constraint_def) = 0
      ) THEN
    ALTER TABLE cli_auth_audit_events
      DROP CONSTRAINT cli_auth_audit_events_metadata_allowlist_check;
    constraint_def := NULL;
  END IF;
  IF constraint_def IS NULL THEN
    ALTER TABLE cli_auth_audit_events
      ADD CONSTRAINT cli_auth_audit_events_metadata_allowlist_check
      CHECK (
        (
          event_type = 'token_used'
          AND metadata ? 'method'
          AND metadata ? 'route'
          AND metadata - ARRAY['method', 'route']::TEXT[] = '{}'::JSONB
          AND jsonb_typeof(metadata->'method') = 'string'
          AND metadata->>'method' IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')
          AND jsonb_typeof(metadata->'route') = 'string'
          AND char_length(metadata->>'route') BETWEEN 1 AND 2048
          AND metadata->>'route' LIKE '/api/%'
        )
        OR (
          event_type = 'authorization_cancelled'
          AND metadata = '{"reason":"account_recovery"}'::JSONB
        )
        OR (
          event_type = 'token_revoked'
          AND metadata ? 'reason'
          AND jsonb_typeof(metadata->'reason') = 'string'
          AND metadata->>'reason' IN ('self', 'settings', 'account_recovery')
          AND metadata - 'reason' = '{}'::JSONB
        )
        OR (
          event_type NOT IN (
            'token_used', 'authorization_cancelled', 'token_revoked'
          )
          AND metadata = '{}'::JSONB
        )
      );
  END IF;
END $$;

-- Shared token-bucket state. Keys are fixed SHA-256 digests of a
-- namespace and subject, never raw credentials or addresses.
CREATE TABLE IF NOT EXISTS cli_auth_rate_limits (
  bucket_key TEXT PRIMARY KEY CHECK (bucket_key ~ '^[0-9a-f]{64}$'),
  tokens DOUBLE PRECISION NOT NULL CHECK (tokens >= 0),
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS cli_device_authorizations_expiry_idx
  ON cli_device_authorizations (expires_at);
CREATE INDEX IF NOT EXISTS cli_device_authorizations_ip_state_idx
  ON cli_device_authorizations (request_ip, status, expires_at);
CREATE INDEX IF NOT EXISTS cli_device_authorizations_state_expiry_idx
  ON cli_device_authorizations (status, expires_at);
CREATE INDEX IF NOT EXISTS cli_access_tokens_user_idx
  ON cli_access_tokens (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS cli_access_tokens_expiry_idx
  ON cli_access_tokens (expires_at);
CREATE INDEX IF NOT EXISTS cli_access_tokens_revoked_idx
  ON cli_access_tokens (revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS cli_auth_audit_events_time_idx
  ON cli_auth_audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS cli_auth_audit_events_user_idx
  ON cli_auth_audit_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS cli_auth_audit_events_actor_idx
  ON cli_auth_audit_events (actor_user_id, occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS cli_auth_audit_device_transition_uidx
  ON cli_auth_audit_events (event_type, device_authorization_id)
  WHERE event_type IN (
    'authorization_started', 'authorization_approved',
    'authorization_rejected', 'authorization_cancelled'
  );
CREATE UNIQUE INDEX IF NOT EXISTS cli_auth_audit_token_transition_uidx
  ON cli_auth_audit_events (event_type, access_token_id)
  WHERE event_type IN ('token_issued', 'token_revoked');
CREATE INDEX IF NOT EXISTS cli_auth_rate_limits_expiry_idx
  ON cli_auth_rate_limits (expires_at);

COMMENT ON TABLE cli_device_authorizations IS 'staging:private';
COMMENT ON TABLE cli_access_tokens IS 'staging:private';
COMMENT ON TABLE cli_auth_audit_events IS 'staging:private';
COMMENT ON TABLE cli_auth_rate_limits IS 'staging:private';

CREATE TABLE IF NOT EXISTS activation_codes (
  id         SERIAL PRIMARY KEY,
  code       VARCHAR(32) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at    TIMESTAMPTZ
);

-- Apps. `retry_count` tracks how many times creation has been retried
-- after a failure (see src/routes/apps.js retry endpoint).
CREATE TABLE IF NOT EXISTS apps (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(255) NOT NULL,
  slug           VARCHAR(255) UNIQUE NOT NULL,
  repo_url       VARCHAR(512),
  container_id   VARCHAR(128),
  status         VARCHAR(32) NOT NULL DEFAULT 'creating',
  retry_count    INTEGER NOT NULL DEFAULT 0,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
-- #21: surface the currently deployed commit. `main_sha` is the SHA the
-- prod container was built from; `main_pr_number` is the PR that
-- produced it (null for the initial pre-merge build). Backfilled on
-- server boot for apps created before this migration.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS main_sha VARCHAR(40);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS main_pr_number INTEGER;
-- Surface "when the app was last code-updated" on the home cards
-- alongside created_at. Bumped to NOW() at every successful prod-
-- container rebuild — the four sites in app-creator.js (initial
-- deploy), routes/apps.js (/redeploy), routes/votes.js (vote-merge),
-- and routes/issues.js (secret-change driven rebuild). Backfilled to
-- created_at for existing rows on first boot so the home tile reads
-- "updated <created_at>" instead of "never" for pre-migration apps;
-- the IS NULL guard makes the backfill a one-shot.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS last_deploy_at TIMESTAMPTZ;
UPDATE apps SET last_deploy_at = created_at WHERE last_deploy_at IS NULL;
-- Snapshot of `dapp.json` from the last successful clone (createApp +
-- rebuildProduction both write it). The Secrets UI reads this so it
-- can render the manifest-declared keys without re-cloning, and the
-- deploy block-on-missing-required check uses it as the source of
-- truth for "what does this dapp create".
ALTER TABLE apps ADD COLUMN IF NOT EXISTS manifest_snapshot JSONB;

-- #416: detail of the last build/deploy failure so the UI can show a
-- build log instead of a bare "Error" status. Shape:
--   { stage, reason, log, at, sha }
--   stage  : 'repo'|'clone'|'build'|'start'|'healthcheck'|'timeout'|'other'
--   reason : concise human line (<= 280 chars)
--   log    : ANSI-stripped tail of the docker build / boot output (<= 16 kB)
-- Written by the deploy catch paths (services/app-creator.js,
-- services/staging.js rebuildProduction, routes/apps.js watchdog);
-- cleared (NULL) on every successful deploy. Exposed API-side only to
-- the app's creator / collaborators / admins — see routes/apps.js.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS last_failure JSONB;

-- Admin-gated change lock. When TRUE, applying any group-voted change to
-- this app (PR merge in routes/votes.js, rename proposal + secret-change
-- proposal in routes/issues.js) additionally requires at least one admin
-- "yes"/"up" vote on top of the existing active-user majority. Toggled by
-- admins via POST /api/apps/:slug/lock; the home-card lock icon (admin-
-- only) is the canonical UI affordance. Default FALSE so every existing
-- app starts unlocked and behaves exactly as before.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE;

-- Per-app postgres role password. Every app's database has a dedicated
-- postgres role `<dbName>_owner` with this random password; the app's
-- container connects with that role's URL instead of the shared
-- superuser. Compromise of one app's DATABASE_URL no longer authorizes
-- access to other apps' DBs in the cluster. NULL means the app
-- predates the per-role migration; src/db/migrate.js's
-- migrateAppDbsToPerRole adopts such DBs at boot and persists the
-- password here. See src/services/db-manager.js for the role-creation
-- and reassignment logic. Tagged `staging:private` so the existing
-- column-scrub mechanism in cloneDatabase blanks it in any clone — a
-- staging container reading this from its cloned `apps` table would
-- get NULL for every row, which is correct (the staging container
-- has no business connecting to other prod app DBs).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS db_password TEXT;
-- Runtime-neutral deployment references. Docker's historical container_id
-- stays populated in Docker mode; Kubernetes mode records the image digest,
-- immutable kpack Build and namespaced workload separately.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS image_ref TEXT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS build_ref VARCHAR(253);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS runtime_kind VARCHAR(32) NOT NULL DEFAULT 'docker';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS runtime_name VARCHAR(253);

-- Activity tracking (for home screen sort)
CREATE TABLE IF NOT EXISTS app_activity (
  id             SERIAL PRIMARY KEY,
  app_id         INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
  seconds_spent  INTEGER NOT NULL DEFAULT 0,
  date           DATE NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE(app_id, user_id, date)
);

-- Per-check history: which of an app's declared dapp.json checks have ever
-- been OBSERVED PASSING, and are therefore allowed to block a merge.
--
-- Background: the manifest reader used to keep only the first 12 declared
-- checks, so this repo's own ~229 tail checks had never executed once. The
-- capture container now runs every declared check on every build, and this
-- table is what stops that from blocking the next proposal on hundreds of
-- pre-existing failures it did not cause. A check is BLOCKING iff
-- `first_passed_at IS NOT NULL` (derived, never stored as a flag); one that
-- has never passed is ADVISORY — it runs and reports, but does not gate.
-- There is no demotion: a graduated check that starts failing stays
-- blocking, which is the whole point of graduating it.
--
-- `check_key` is sha256(name || '\n' || path) — the same (name+path) pair
-- app-manifest.readTests de-duplicates on, so renaming a check mints a new
-- key and drops it back to advisory (an edited check re-earns its status).
--
-- PUBLIC (no `staging:private` tag) and deliberately so: it holds check
-- names and pass/fail timestamps for app code, which every viewer of a
-- proposal's checks card can already see. No credentials, no user content.
CREATE TABLE IF NOT EXISTS app_check_history (
  id              BIGSERIAL PRIMARY KEY,
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  check_key       VARCHAR(64) NOT NULL,
  check_name      TEXT,
  check_path      TEXT,
  first_passed_at TIMESTAMPTZ,
  last_passed_at  TIMESTAMPTZ,
  last_failed_at  TIMESTAMPTZ,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pass_count      INTEGER NOT NULL DEFAULT 0,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (app_id, check_key)
);
CREATE INDEX IF NOT EXISTS idx_app_check_history_app ON app_check_history(app_id);
-- The graduated-set load is the hot read (once per checks run).
CREATE INDEX IF NOT EXISTS idx_app_check_history_graduated
  ON app_check_history(app_id) WHERE first_passed_at IS NOT NULL;

-- Group chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id         SERIAL PRIMARY KEY,
  app_id     INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  content    TEXT NOT NULL,
  msg_type   VARCHAR(32) NOT NULL DEFAULT 'message',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Individual chat sessions (one per branch/PR)
CREATE TABLE IF NOT EXISTS chat_sessions (
  id                   SERIAL PRIMARY KEY,
  app_id               INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  user_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  branch_name          VARCHAR(255),
  pr_number            INTEGER,
  pr_url               VARCHAR(512),
  pr_title             VARCHAR(256),
  staging_container_id VARCHAR(128),
  staging_url          VARCHAR(512),
  -- Lifecycle:
  --   'active'    = open, has (or can lazily spawn) a warm worker container.
  --                 The only status counting against the per-user
  --                 active-session cap (MAX_USER_SESSIONS, raised for full
  --                 platform admins by MAX_ADMIN_USER_SESSIONS — resolved
  --                 per-requester in src/services/session-caps.js).
  --   'promoted'  = PR is up for a merge vote and the chat is still alive.
  --                 Un-pausable while the vote runs, so it is EXEMPT from
  --                 the active-session cap (#193) and bounded instead by
  --                 the promoted cap (MAX_USER_PROMOTED_SESSIONS /
  --                 MAX_ADMIN_USER_PROMOTED_SESSIONS) at promote time.
  --   'paused'    = open but worker container has been torn down to free
  --                 the slot. CC volume + branch + PR are all preserved
  --                 so /resume restores it cleanly. Unlimited — does NOT
  --                 count against either cap (no warm container).
  --   'archived'  = abandoned: worker container destroyed, CC volume
  --                 destroyed, PR closed. One-way (no /unarchive route).
  status               VARCHAR(32) NOT NULL DEFAULT 'active',
  -- Claude Code session id captured from the `init` stream-json event on the
  -- first turn of this chat. Subsequent turns pass `--resume <id>` to reuse
  -- CC's on-disk conversation memory (stored in a named Docker volume).
  cc_session_id        VARCHAR(64),
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Individual chat session messages (user <-> LLM)
CREATE TABLE IF NOT EXISTS chat_session_messages (
  id           SERIAL PRIMARY KEY,
  session_id   INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role         VARCHAR(20) NOT NULL,
  content      TEXT NOT NULL,
  model        VARCHAR(100),
  token_count  INTEGER DEFAULT 0,
  cost_cents   NUMERIC(10,4) DEFAULT 0,
  metadata     JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- #800: until this landed, the pkey was this table's ONLY index — while
-- every session open reads it by session_id (routes/sessions.js history
-- loads), i.e. a sequential scan over the whole message table each time.
-- The leading column serves those lookups; `model` rides along so a
-- future per-model cost aggregate can read it index-only.
CREATE INDEX IF NOT EXISTS idx_csm_session_model
  ON chat_session_messages(session_id, model);

-- Migrations (idempotent)
ALTER TABLE chat_session_messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS cc_session_id VARCHAR(64);
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS staging_image_ref TEXT;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS staging_build_ref VARCHAR(253);
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS staging_runtime_kind VARCHAR(32);
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS staging_runtime_name VARCHAR(253);
-- LLM-generated PR title shown alongside the PR number across the UI
-- (dev chat, vote panel, status page). Nullable so old rows predate the
-- auto-title feature and just fall back to showing "by <user>".
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS pr_title VARCHAR(256);
-- #8: how many commits the session branch is behind origin/main, as of
-- the most recent worker turn. Updated by run-cc.sh on every turn
-- (MODE=build and MODE=sync) via the BEHIND= field of the
-- __USERNODE_RESULT__ line. Drives the "Sync with main" banner in the
-- dev-chat session view and the merge-time block in votes.tryMerge.
-- Defaults to 0 for fresh rows; existing rows backfill on their next
-- turn (no separate migration backfill — pre-#8 sessions just show no
-- banner until they next run).
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS behind_main INTEGER NOT NULL DEFAULT 0;
-- Opt-in session visibility: NULL = private to the owner (every
-- pre-existing row), non-NULL = "visible to everyone" — the session
-- renders at the bottom of other users' In progress area on the Dev
-- board, with its discussion thread (chat_messages thread_type
-- 'session') open to comments. Doubles as the sort key there
-- (oldest-shared first so newly shared rows append at the bottom).
-- Set/cleared by POST /api/sessions/:id/share|unshare (owner-scoped);
-- naming mirrors chat_session_specs.shared_to_group_at ("private until
-- explicitly shared").
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ;
-- Opt-in TRANSCRIPT visibility — a second, strictly NARROWER opt-in that
-- sits on top of shared_at: NULL = the conversation with the AI stays
-- private to the owner (every pre-existing row), non-NULL = anyone with
-- view access to the app may READ the dev-chat transcript (and fork it
-- into their own session via POST /api/sessions/:id/fork).
--
-- Readability requires BOTH stamps to be non-NULL, deliberately
-- redundant: /share-transcript sets shared_at too (publishing the chat
-- implies board visibility) and /unshare clears BOTH, so there is no
-- state where a hidden session is still readable. Reads are served by
-- GET /api/sessions/:id/transcript, which sanitises every row through a
-- deny-by-default allowlist (services/transcript-share.js) — costs,
-- token counts, raw agent stderr (metadata.ccLog), owner-only action
-- cards and attachment BYTES never leave the owner's session.
--
-- Posting into someone else's chat stays structurally impossible: POST
-- /api/sessions/:id/chat is owner-scoped (cs.user_id = caller), so
-- "read-only" is enforced by authorization, not by missing UI.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS transcript_shared_at TIMESTAMPTZ;
-- #361: persisted merge-conflict snapshot so proposal cards can render a
-- rich merge-status badge (clean | behind | conflict | resolving |
-- failed) without a live GitHub call per render. Derived/written by
-- services/sync-main.js (persistConflictState) and
-- services/conflict-resolver.js; `behind` is derived when behind_main>0
-- and the branch still merges cleanly. conflict_files holds the file
-- paths that contained conflict markers on the last detection, and
-- conflict_checked_at is when the snapshot was last computed.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS merge_conflict_state TEXT;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS conflict_files JSONB NOT NULL DEFAULT '[]';
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS conflict_checked_at TIMESTAMPTZ;
-- #381: console-error "may break the app" check. After each staging build
-- the capture pipeline's headless browser records console errors / uncaught
-- exceptions / failed loads on the staging "after" target(s). Written by
-- services/visuals.js (captureForSession → storeConsoleCheck), latest run
-- only. console_check_state is 'clean' | 'errors' | 'unknown' (NULL until
-- the first check); console_errors is the captured {kind,message,source}
-- list; console_checked_at is when it last ran. Advisory only — never gates
-- voting or merge.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS console_check_state TEXT;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS console_errors JSONB NOT NULL DEFAULT '[]';
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS console_checked_at TIMESTAMPTZ;
-- #47: "CI for proposals". The console-error check above is now the
-- built-in baseline of a general "tests run against staging" framework: a
-- proposal carries automated headless-browser tests (declared in the app's
-- dapp.json `tests` array, accumulating across proposals like CI in a
-- GitHub repo), each navigating one staging route and asserting the page
-- loads, throws no console errors, and (optionally) shows an expected
-- selector/text. After every staging build services/visuals.js runs them
-- (captureForSession → storeChecks) and records the outcome here, latest
-- run only.
--   check_state       : 'passing' | 'failing' | 'pending' | 'error' |
--                       'skipped' | 'unknown' (NULL until the first run).
--                       'pending' is set the moment a (re)build starts so a
--                       stale pass can't slip through; 'error'/'unknown' mean
--                       the staging build or capture run itself broke.
--   test_results      : array of { name, path, status:'pass'|'fail',
--                       consoleErrors:[{kind,message,source}], failureReason }
--   checks_commit_sha : the commit the results describe (staleness signal).
--   checks_checked_at : when the suite last ran.
-- Unlike the advisory console columns above, check_state GATES merge:
-- routes/votes.js checkAndMerge blocks a non-'passing' proposal (admin
-- force-merge still bypasses). The console_* columns are kept written in
-- parallel for one release so a rolling deploy's old readers still work.
-- #447: 'pending' is only ever advanced out by the same captureForSession
-- run that set it, so a restart mid-capture (or a staging rebuild that
-- predated the capture wiring) could leave a promoted PR 'pending'/NULL and
-- permanently merge-blocked. A 'pending' row whose checks_checked_at is
-- older than CHECKS_STALE_MS (default 10m) is now treated as STUCK and
-- re-run: by server.js reconcileStuckChecks (boot + session-sweeper Pass 4),
-- by a vote that reaches threshold (checkAndMerge stale-pending kick), by any
-- staging rebuild (staging-recovery.rebuildSessionStaging now re-runs checks),
-- and by the manual POST /api/sessions/:id/recheck ("Re-run checks" button).
-- #461: 'skipped' is a TERMINAL, GATE-PASSING verdict recorded when the
-- checks genuinely cannot / need not run — the branch carries no commits
-- beyond main, or GitHub isn't configured so no checks infrastructure
-- exists. Written by visuals.storeChecksSkipped (via
-- staging-recovery.recordChecksSkipped) with the human-readable reason in
-- check_error_detail (same column the badge tooltip already surfaces); the
-- merge gate treats it exactly like 'passing', and the next pushed commit
-- returns the row to 'pending' via setChecksPending as usual. Before #461
-- these paths returned silently, leaving check_state NULL — merge-blocked
-- as "still running its tests" forever while the stuck-checks sweeper
-- re-skipped the same row every pass.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS check_state TEXT;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS test_results JSONB NOT NULL DEFAULT '[]';
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS checks_commit_sha VARCHAR(40);
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS checks_checked_at TIMESTAMPTZ;
-- Capture-outcome snapshot (screenshot-reliability spec). Before these,
-- "this proposal has no screenshots" was unattributable: an intentional
-- console-only run (no frontend files in the commit range) and a genuinely
-- failed capture looked identical, and per-artifact failure reasons (a
-- dropped over-cap webm, a screencast/ffmpeg error) lived only in
-- short-lived container logs. Written by services/visuals.js
-- (captureForSession → storeCaptureOutcome), latest run only.
--   capture_state  : 'captured'     — media run, everything usable stored
--                    'partial'      — media run stored, but some artifact
--                                     failed or was dropped over-cap
--                    'console_only' — non-UI-affecting commit range; media
--                                     intentionally skipped (NOT a failure)
--                    'failed'       — media run produced no usable "after",
--                                     or the capture run itself broke
--                    (NULL until the first outcome-aware run)
--   capture_detail : jsonb diagnostics — { media, pathDefaulted (the agent
--                    emitted no testing path so capture defaulted to '/'),
--                    prodRunning, paths, failures:[{kind,media,index,
--                    reason}], droppedOverCap:[{kind,media,index,bytes}],
--                    beforeFellBack:[capture indexes], reason? }
--   captured_at    : when the outcome was recorded.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS capture_state VARCHAR(16);
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS capture_detail JSONB;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ;
-- Deadlock-diagnosis columns. Before these, a staging build that crashed on
-- boot threw before any verdict was written, leaving check_state NULL — the
-- merge gate fail-closes on NULL with no signal, and the stuck-checks sweeper
-- retried the identical failing build every ~2 min forever (an "unclear
-- deadlock": votes pass, nothing merges, nobody is told why). Now a build/boot
-- failure is recorded as a terminal 'error' verdict carrying:
--   check_error_detail       : a concise, human-readable reason for the LAST
--                              failure (e.g. the Postgres error / crash line
--                              pulled from the container's boot logs). Surfaced
--                              in the merge-gate message, the proposal thread,
--                              and the proposal's checks badge tooltip.
--   consecutive_check_failures : count of back-to-back failed check runs for
--                              the current commit. Reset to 0 on any passing/
--                              failing verdict and when a NEW commit starts a
--                              check run (see visuals.setChecksPending). Drives
--                              the sweeper's exponential backoff + the
--                              crash-loop short-circuit (stop auto-retrying a
--                              deterministically-failing build after N tries).
--   first_check_failure_at / last_check_failure_at : streak bounds, for "stuck
--                              for X hours" escalation + diagnostics.
--   check_next_retry_at      : earliest time the sweeper may re-attempt this
--                              errored check. Set to NOW()+backoff on each
--                              failure; the sweeper only re-picks an 'error'
--                              row once this has elapsed, replacing the old
--                              fixed ~2 min retry with 2m → 4m → 8m → … → 30m.
--   check_error_notified_at  : stamped when the proposal owner is notified of
--                              the failure, so they're nudged once per streak
--                              (cleared when a new commit resets the streak).
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS check_error_detail TEXT;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS consecutive_check_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS first_check_failure_at TIMESTAMPTZ;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS last_check_failure_at TIMESTAMPTZ;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS check_next_retry_at TIMESTAMPTZ;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS check_error_notified_at TIMESTAMPTZ;
-- Which STAGE a 'pending' check run is in, so the proposal card can say
-- "Preparing the staging preview…" vs "Running the automated tests…"
-- instead of one opaque "Checks are still running…" for the whole run.
-- A run has two very differently-sized halves and both used to look
-- identical, which made a mid-flight build indistinguishable from a wedged
-- one. Values:
--   'building' — the branch is being built and the preview's database
--                clone is being made (set by the callers that stamp
--                'pending' BEFORE buildAndDeployStaging).
--   'testing'  — the preview is healthy and the headless suite is running
--                against it (set by visuals.captureForSession's own
--                setChecksPending at capture start).
-- NULL on legacy rows and after any terminal verdict; the card falls back
-- to its previous wording for NULL, so nothing regresses on old proposals.
-- Advisory/display only — the merge gate reads check_state, never this.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS check_phase VARCHAR(24);
-- WHY this check run started, alongside check_phase's "which half is it in".
-- The merge-gate trace recorded trigger='capture' for every run — literally
-- the name of the function that opened it — so a measurement of "1.81 checks
-- runs per proposal, 91 of 204 are re-runs" could count the re-runs but could
-- not say which were a human pressing Re-run, which were a new commit, and
-- which were the recovery sweeper re-driving a run that had gone quiet. Those
-- want completely different fixes. Values are visuals.CHECK_TRIGGERS
-- ('proposal-open', 'commit-push', 'sync-main', 'pr-import',
-- 'manual-recheck', 'promote-kick', 'boot-reconcile', 'stuck-sweep',
-- 'fleet-maintenance'); anything else is stored as NULL.
-- NULL on legacy rows and whenever the writer did not name one — the card
-- simply shows no trigger caption then. Advisory/display only, exactly like
-- check_phase: the merge gate reads check_state and nothing else.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS check_trigger VARCHAR(32);
-- #11: vote-to-undo a merged PR. When the undo majority is reached we
-- open a `git revert <merge_commit_sha>` PR and insert a new
-- chat_sessions row pointing back here via revert_of_session_id.
-- The new row goes through the regular promoted → merging → merged
-- flow (a second checkpoint instead of single-voter rollback), so
-- this is just bookkeeping for the original.
--   merge_commit_sha is captured from github.mergePR's response in
--   votes.tryMerge so the revert helper has a SHA to revert.
--   revert_of_session_id, when NOT NULL, marks this row as itself a
--   revert PR — the UI hides chat input + the undo button on
--   reverts so we can't vote-to-undo-an-undo from the merged list.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS merge_commit_sha    VARCHAR(40);
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS revert_of_session_id INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS chat_sessions_revert_of_idx ON chat_sessions(revert_of_session_id);

-- #11/#16: DEPRECATED. Originally held undo votes on merged PRs (a
-- separate majority gate before a revert PR could be opened). As of #16
-- undo is a single direct action — clicking Undo opens a revert PR
-- immediately and the revert's own merge vote is the only checkpoint —
-- so nothing reads or writes this table anymore. Kept (not dropped) to
-- avoid a destructive migration on existing deployments.
CREATE TABLE IF NOT EXISTS pr_undo_votes (
  id         SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  vote       VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, user_id)
);
CREATE INDEX IF NOT EXISTS pr_undo_votes_session_idx ON pr_undo_votes(session_id);

-- Spec-stage: per-session markdown spec doc + version history.
-- spec_md is the working buffer (written by the Mayor's scout dispatch
-- — user hand-edits via PUT /spec were dropped, and the Mayor's
-- in-process write_spec/edit_spec tools were removed in #111).
-- chat_session_specs holds the immutable numbered versions (v1…vN) that
-- are the single spec surface the dev-chat viewer presents (#69). Rows
-- are inserted automatically by snapshotSessionSpec() on every spec
-- mutation (#27), so spec_md is always byte-identical to the latest
-- version. The manual "Save version" route (POST /api/sessions/:id/specs)
-- was retired in #69 — it only ever re-snapped that same content.
-- Old sessions also have rows from the now-removed /build-spec route —
-- those carry commit_sha and pr_number; auto-snapshotted rows leave both
-- NULL and the UI degrades gracefully (no PR link rendered).
-- shared_to_group_at is set when the user posts a version into the
-- app's group chat.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS spec_md TEXT NOT NULL DEFAULT '';

-- Session auto-pause: persisted "last interacted with" timestamp. Bumped
-- on every chat turn, on session open/view, and on resume. The DB-driven
-- auto-pause sweeper (server.js) flips long-idle 'active' sessions to
-- 'paused' so they stop counting against the per-user / global session
-- caps; the in-memory worker idle-eviction (which only reclaims the
-- container) is a separate, shorter-timer concern. DEFAULT NOW() is
-- deliberate: it backfills existing rows to "active now" so the first
-- sweep after this migration doesn't mass-pause every open session.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
-- Supports the sweeper's "active + idle past threshold" scan.
CREATE INDEX IF NOT EXISTS chat_sessions_activity_idx ON chat_sessions(status, last_activity_at);

-- #155: headless "auto sessions" started from an issue's Auto-solve button.
-- A headless session is NOT connected to any user's dev chat: it runs one
-- unattended Mayor turn (scout / build / question) against the issue, may
-- push a branch, but never opens a PR or builds staging. It is billed to
-- the user who clicked the button (user_id), and any collaborator can later
-- clone its state (messages + spec + branch + CC memory) into their own
-- dev-chat session via POST /api/sessions/:id/clone-headless.
--   is_headless            = marks the row as an auto session; excluded from
--                            per-user session lists, the 3-slot cap, and chat.
--   headless_status        = 'generating' (run in flight) | 'ready' | 'failed'.
--                            NULL on ordinary sessions.
--   headless_issue_number  = the GitHub issue the auto session was started for.
--   headless_outcome       = what the run arrived at: 'spec' | 'code' |
--                            'spec_code' (#170 — scout drafted a spec AND the
--                            decision turn implemented it) | 'question'. Drives
--                            the cloned session's follow-up message. NULL until
--                            the run finishes.
--   cloned_from_session_id = on ORDINARY sessions: the session this dev chat
--                            was seeded from (many clones/forks per source).
--                            Two producers, told apart by the SOURCE row's
--                            is_headless: the headless auto session this was
--                            cloned from (POST /clone-headless), or — since
--                            transcript sharing — another user's HUMAN dev
--                            chat this was forked from (POST /fork, source
--                            is_headless = FALSE). Either way the copied
--                            history rows carry metadata.inheritedFrom, which
--                            is what DevChat._markInheritedMessages keys the
--                            collapsed-agent-block rendering off.
--   created_from_issue_number = #287: on ORDINARY sessions, the GitHub issue
--                            this dev chat was started for via the issue row's
--                            start-work button. Recorded at creation time (not
--                            the async, Mayor-declared `linked_issues`) so the
--                            row can deterministically swap "Create proposal" →
--                            "Create new proposal" for the owning viewer. NULL on
--                            the generic "+ New chat" path and on headless rows.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS is_headless BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS headless_status VARCHAR(20);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS headless_issue_number INTEGER;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS headless_outcome VARCHAR(20);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS cloned_from_session_id INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS created_from_issue_number INTEGER;
-- Supports the per-issue "latest auto session" lookup on the issues panel.
CREATE INDEX IF NOT EXISTS chat_sessions_headless_idx
  ON chat_sessions(app_id, headless_issue_number, created_at DESC)
  WHERE is_headless;
-- #287: supports the per-viewer "latest Create-PR session for this issue"
-- lookup on the issues panel (GET /github-issues → myPrSessionId).
CREATE INDEX IF NOT EXISTS chat_sessions_created_from_issue_idx
  ON chat_sessions(app_id, created_from_issue_number, user_id, created_at DESC)
  WHERE created_from_issue_number IS NOT NULL;

-- #687 (PR-import, Slice 1): provenance columns for proposals whose code
-- was authored OUTSIDE the platform — an existing GitHub PR imported into
-- the vote flow rather than opened by the group's AI dev-chat. Append-only:
-- existing rows read as native (source NULL/'native').
--   source               = 'native' (implicit for every existing row; a
--                          NULL value is treated as native), 'imported', or
--                          one of the native workflow provenance markers
--                          documented below (`cli_handoff`, `maintenance`).
--                          Drives the "Imported PR" source badge + GitHub
--                          link and the read-only dev surface for imported
--                          proposals.
--   imported_pr_head_sha = the PR head commit the current checks/votes
--                          describe. A later push moves the PR head; the
--                          Slice 3 sync poller compares against this to
--                          reset the tally, and Slice 4 pins the merge to
--                          exactly this SHA. NULL for native rows.
--   imported_pr_author   = display handle of the external PR author, shown
--                          beside the badge. NULL for native rows.
--   imported_pr_head_repo= 'owner/repo' of the repository the PR's HEAD
--                          branch lives in, as GitHub reported it at import
--                          time (#1196). NOT the same question as `source`:
--                          the connector's mirror rung copies an agent's
--                          verified fork branch into the APP repository and
--                          opens a same-repo pull request, which is then
--                          imported here — so an 'imported' row's head is
--                          sometimes a branch only the platform bot can
--                          write. Recorded because it decides which update
--                          path a revision takes (services/proposal-update.js
--                          `branchHomeOf`) and what get_proposal tells an
--                          agent to push to. NULL for native rows and for
--                          rows imported before this column existed; that
--                          fallback is documented at `branchHomeOf`.
-- NOTE: a partial UNIQUE index on (app_id, pr_number) WHERE source='imported'
-- is intentionally DEFERRED (see spec Considerations) — Slice 1 relies on
-- the read-only boot audit in db/migrate.js instead of a hard constraint,
-- to keep this migration strictly append-only.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS source               TEXT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS imported_pr_head_sha VARCHAR(40);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS imported_pr_author   VARCHAR(255);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS imported_pr_head_repo TEXT;
-- Exact revision approved for a native proposal. Imported proposals keep
-- imported_pr_head_sha as their existing source of truth; native votes,
-- checks, and merges are bound to this live GitHub PR head instead.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS reviewed_head_sha     VARCHAR(40);
-- Native CLI handoff sessions. A local Codex/Claude agent can author the
-- spec and code in the user's checkout, then attach that durable context and
-- an exact-tree bot-owned commit to an ordinary platform-owned dev session. The row
-- remains a native session (not an imported PR), so the same chat can be
-- opened and continued from the web Dev page and uses the normal
-- staging/checks/promotion pipeline.
--
-- handoff_request_id is a caller-generated idempotency key scoped to the
-- owner. base is the immutable audit anchor, uploaded is the latest bot-owned
-- commit reconstructed from a local tree, and head is the latest uploaded
-- revision explicitly submitted to staging/checks. A web Dev turn may advance
-- the shared branch/checks_commit_sha without overwriting those local audit
-- values. local_commit is the corresponding commit identity in the user's
-- checkout; it may differ from uploaded while their trees are identical.
-- Later local uploads must still continue from the current branch tree.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS handoff_request_id VARCHAR(64);
-- Immutable digest of proposal_start's normalized app/base/title/spec/history/
-- issue payload. Live session fields legitimately change after local or web
-- continuation, so they cannot serve as the idempotency comparison.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS handoff_request_fingerprint VARCHAR(64);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS handoff_base_sha   VARCHAR(40);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS handoff_head_sha   VARCHAR(40);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS handoff_uploaded_sha VARCHAR(40);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS handoff_local_commit_sha VARCHAR(40);
-- Snapshot of checks_commit_sha immediately before handoff_uploaded_sha was
-- written. Equality means the upload is still awaiting submission; a later
-- web turn naturally changes checks_commit_sha and supersedes that upload
-- without needing to know about CLI-specific state.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS handoff_upload_checked_sha VARCHAR(40);
-- Deliberately scoped independently of source: a delayed proposal_start retry
-- must always resolve to the same cross-surface session.
CREATE UNIQUE INDEX IF NOT EXISTS chat_sessions_handoff_request_idx
  ON chat_sessions(user_id, handoff_request_id)
  WHERE handoff_request_id IS NOT NULL;

-- ===================================================================
-- #907: local coding agents.
--
-- A user can attach a coding agent running on their own machine to one of
-- their dev sessions and have the Mayor dispatch that session's coding turns
-- to it instead of to a platform worker container. Everything after the agent
-- finishes — commit upload, staging, checks, visuals, PR metadata — is the
-- SAME pipeline the platform worker and the MCP proposal handoff already use,
-- so a local turn produces an ordinary proposal that anyone can review.
--
-- The platform never receives, stores, or proxies the user's own model
-- credentials: the local runtime authenticates to Anthropic itself, out of
-- band, exactly as it does when the user runs `claude` by hand.
-- ===================================================================

-- One machine's claim on one session. The unique partial index is the whole
-- exclusivity story: at most one unreleased lease per session, so a second
-- laptop attaching to the same chat is refused rather than racing.
--
-- `expires_at` is a hard TTL refreshed by heartbeat. A laptop that closes its
-- lid, loses Wi-Fi, or is killed simply stops heartbeating; the lease lapses
-- and the session falls back to the platform worker on its next turn without
-- anyone having to click anything.
CREATE TABLE IF NOT EXISTS session_agent_leases (
  id BIGSERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Which credential this machine attached with. ON DELETE SET NULL rather
  -- than CASCADE: revocation is a soft `revoked_at` (and detaches the lease
  -- explicitly, in the same transaction), while the row itself is only ever
  -- hard-deleted by the expiry prune long afterwards — which must not
  -- retroactively erase the record of where a session's turns ran.
  access_token_id BIGINT REFERENCES cli_access_tokens(id) ON DELETE SET NULL,
  -- User-chosen, display-only ("Evan's laptop"). Never a hostname the
  -- platform discovered by itself.
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 64),
  -- Which local runtime is driving. Only 'claude-code' exists in phase 1;
  -- the column is here so a second adapter does not need a migration.
  runtime TEXT NOT NULL DEFAULT 'claude-code'
    CHECK (runtime IN ('claude-code')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  -- 'detached' = the CLI left cleanly; 'revoked' = the owner clicked
  -- "Hand back to Usernode" in the browser or Settings; 'expired' = the
  -- heartbeat lapsed and a sweeper reaped it.
  release_reason TEXT
    CHECK (release_reason IN ('detached', 'revoked', 'expired')),
  CHECK (released_at IS NULL OR released_at >= created_at),
  CHECK ((released_at IS NULL) = (release_reason IS NULL)),
  CHECK (last_seen_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS session_agent_leases_active_uidx
  ON session_agent_leases (session_id)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS session_agent_leases_user_idx
  ON session_agent_leases (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS session_agent_leases_expiry_idx
  ON session_agent_leases (expires_at) WHERE released_at IS NULL;

-- One dispatched coding turn, offered to the lease that owns the session.
--
-- The lifecycle is deliberately explicit rather than a boolean pair: the
-- platform must be able to tell "the laptop never picked this up" (queued →
-- abandoned) apart from "the laptop picked it up and the run failed"
-- (accepted → running → failed), because only the first is safe to silently
-- re-route to a platform worker.
CREATE TABLE IF NOT EXISTS local_agent_turns (
  id BIGSERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  lease_id BIGINT NOT NULL REFERENCES session_agent_leases(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued', 'offered', 'accepted', 'declined',
      'running', 'completed', 'failed', 'stopped', 'abandoned'
    )),
  -- Which KIND of turn this is. 'build' writes code and produces a commit;
  -- 'scout' is read-only and produces the session's spec document instead.
  -- The distinction is load-bearing rather than cosmetic: it drives the
  -- read-only invariant below, the runtime's permission mode on the user's
  -- machine, and whether the platform runs the staging/checks tail at all.
  mode VARCHAR(16) NOT NULL DEFAULT 'build'
    CHECK (mode IN ('build', 'scout')),
  -- The Mayor's dispatch prompt plus the platform context blocks. Bounded so
  -- a runaway spec cannot turn this table into a document store.
  prompt TEXT NOT NULL CHECK (char_length(prompt) <= 262144),
  -- The base the local checkout must be sitting on for this turn to be safe
  -- to accept. The CLI refuses a turn whose base it cannot reproduce.
  base_sha VARCHAR(40) CHECK (base_sha IS NULL OR base_sha ~ '^[0-9a-f]{40}$'),
  branch_name TEXT,
  -- Free-text progress the local runtime streams back, rendered in dev chat
  -- exactly like worker progress lines. Capped by the route, not the column.
  progress JSONB NOT NULL DEFAULT '[]'::JSONB
    CHECK (jsonb_typeof(progress) = 'array'),
  -- What the run produced: the local commit the CLI then uploads through the
  -- existing exact-tree commit-upload endpoint, and the agent's own summary.
  head_sha VARCHAR(40) CHECK (head_sha IS NULL OR head_sha ~ '^[0-9a-f]{40}$'),
  summary TEXT CHECK (summary IS NULL OR char_length(summary) <= 32768),
  -- A scout turn's actual product: the markdown spec document the local agent
  -- drafted, which the platform writes to chat_sessions.spec_md exactly as it
  -- does for a worker-container scout. Separate from `summary` because it is
  -- the deliverable, not a description of one, and it is bounded like `prompt`
  -- rather than like a summary.
  spec_md TEXT CHECK (spec_md IS NULL OR char_length(spec_md) <= 262144),
  error_detail TEXT CHECK (error_detail IS NULL OR char_length(error_detail) <= 4096),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  offered_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (offered_at IS NULL OR offered_at >= created_at),
  CHECK (accepted_at IS NULL OR accepted_at >= created_at),
  CHECK (finished_at IS NULL OR finished_at >= created_at),
  -- A terminal row must say when it ended; a live one must not claim to have.
  CHECK (
    (status IN ('declined', 'completed', 'failed', 'stopped', 'abandoned')
     AND finished_at IS NOT NULL)
    OR (status IN ('queued', 'offered', 'accepted', 'running')
     AND finished_at IS NULL)
  ),
  -- THE read-only invariant, in the schema rather than only in the route: a
  -- scout turn can never carry a commit, and a build turn can never carry a
  -- spec. The protocol validates both too, but a scout turn that smuggled a
  -- head SHA would reach the staging/checks tail and put unreviewed code on
  -- the managed branch — so the database refuses it as well.
  CHECK (mode = 'build' OR head_sha IS NULL),
  CHECK (mode = 'scout' OR spec_md IS NULL)
);

-- At most one live turn per session. Same reasoning as the lease index: the
-- Mayor dispatching twice (a retry, a double-submit) must collide loudly
-- here rather than have two laptops commit onto the same branch.
CREATE UNIQUE INDEX IF NOT EXISTS local_agent_turns_live_uidx
  ON local_agent_turns (session_id)
  WHERE status IN ('queued', 'offered', 'accepted', 'running');
CREATE INDEX IF NOT EXISTS local_agent_turns_lease_idx
  ON local_agent_turns (lease_id, created_at DESC);
CREATE INDEX IF NOT EXISTS local_agent_turns_session_idx
  ON local_agent_turns (session_id, created_at DESC);

-- Scout support, added after the table already existed on some databases.
-- CREATE TABLE IF NOT EXISTS skips the whole definition above once the table
-- is there, so the two columns and their invariants need explicit migrations.
ALTER TABLE local_agent_turns
  ADD COLUMN IF NOT EXISTS mode VARCHAR(16) NOT NULL DEFAULT 'build';
ALTER TABLE local_agent_turns ADD COLUMN IF NOT EXISTS spec_md TEXT;
DO $$
BEGIN
  ALTER TABLE local_agent_turns DROP CONSTRAINT IF EXISTS local_agent_turns_mode_check;
  ALTER TABLE local_agent_turns ADD CONSTRAINT local_agent_turns_mode_check
    CHECK (mode IN ('build', 'scout'));
  ALTER TABLE local_agent_turns DROP CONSTRAINT IF EXISTS local_agent_turns_spec_len_check;
  ALTER TABLE local_agent_turns ADD CONSTRAINT local_agent_turns_spec_len_check
    CHECK (spec_md IS NULL OR char_length(spec_md) <= 262144);
  -- The read-only invariant again, for databases that predate it. Named so a
  -- re-run replaces rather than duplicates it (an unnamed CHECK added by the
  -- CREATE TABLE above gets a generated name and is left alone, which is
  -- fine — the two express the same rule).
  ALTER TABLE local_agent_turns DROP CONSTRAINT IF EXISTS local_agent_turns_readonly_check;
  ALTER TABLE local_agent_turns ADD CONSTRAINT local_agent_turns_readonly_check
    CHECK ((mode = 'build' OR head_sha IS NULL) AND (mode = 'scout' OR spec_md IS NULL));
END $$;

-- Both tables describe a specific person's machine and the prompts sent to
-- it, so a staging clone must never carry them. See tools/clone-db.
COMMENT ON TABLE session_agent_leases IS 'staging:private';
COMMENT ON TABLE local_agent_turns IS 'staging:private';

-- Where this session's LAST coding turn actually ran ('platform' | 'local'),
-- and the label of the machine that ran it. Both are display state: the
-- authoritative "can this session run locally right now" answer is always a
-- live row in session_agent_leases. They exist so a reloaded dev chat can
-- paint the "Ran on Evan's laptop" chip without waiting for a lease lookup,
-- and so the chip survives the laptop detaching afterwards.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS last_turn_runner  VARCHAR(16);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS local_agent_label TEXT;

-- Each local transcript item carries a stable handoffEventId in metadata.
-- This partial expression index makes append/retry idempotent without
-- constraining ordinary web-chat rows, whose metadata has no such key.
CREATE UNIQUE INDEX IF NOT EXISTS chat_session_messages_handoff_event_idx
  ON chat_session_messages(session_id, (metadata->>'handoffEventId'))
  WHERE metadata ? 'handoffEventId';
-- source = 'maintenance' marks proposals opened by a fleet maintenance
-- campaign (services/fleet-maintenance.js): platform-authored PRs fanned
-- out to child apps after a maintenance_campaign governance vote passes.
-- Same column as the 'imported' discriminator above; NULL stays native.
-- The campaign tables themselves live below the issues table (they FK
-- to it).

-- Restart-proof turns + resumable headless runs.
--   active_turn   = durable record of an in-flight detached CC turn:
--                   { turnId, phase, mode, journal, model, startedAt }. Set by
--                   worker.execInWorker before the detached `docker exec`
--                   dispatch and cleared after post-turn processing. On boot,
--                   server.js's adoption path uses it to replay the turn's
--                   journal file (in the CC volume) instead of killing the
--                   still-running in-container claude. NULL = no turn in
--                   flight.
--
--                   Two further keys cover the POST-AGENT TAIL — the
--                   minutes-long platform-side stretch after the agent
--                   exits (push heal → PR → staging build → cards →
--                   Mayor wrap-up). A `holdTurnRecord` caller keeps the
--                   record alive across it instead of clearing it at exec
--                   end, so a restart mid-tail is resumable rather than
--                   silently dropped (the incident: a turn's chat froze on
--                   "Building staging preview..." forever because a
--                   self-app deploy replaced the process mid-build):
--                     phase — 'tail_pending' once the exec is over and the tail
--                             owns the record. New rows otherwise use
--                             'dispatch_pending' / 'executing' and finish via
--                             'cleanup_pending'; an absent phase is interpreted
--                             as executing only for rolling-deploy compatibility.
--                     tail  — milestone map of what the tail ALREADY did,
--                             so a resumed tail repeats none of the steps
--                             that aren't idempotent:
--                             { sha, pushOk, prNumber,
--                               prOpenedEventRecorded, stagingUrl,
--                               votesResetFor, completionRowPosted,
--                               stagingPublished, stagingFailed,
--                               wrapUpPosted }.
--                             finalizeRecoveredTurn takes it as
--                             `alreadyDone`. Written with jsonb_set
--                             merges guarded on `active_turn IS NOT NULL`,
--                             so a late stamp can never resurrect a
--                             released record.
--   headless_step = where the headless auto-session loop last checkpointed:
--                   'planning' (Mayor phase-1) | 'cc_running' (CC turn
--                   dispatched) | 'wrapping' (Mayor phase-2). Lets
--                   resumeHeadlessRuns continue a 'generating' row after a
--                   restart instead of blanket-failing it. NULL on ordinary
--                   sessions and on headless rows finished before this column
--                   existed.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS active_turn   JSONB;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS headless_step VARCHAR(20);
-- Stable identity for the current post-agent headless Mayor phase. A single
-- auto-session may scout and then build (two coding turns), so wrap-up
-- receipts cannot safely borrow whichever active_turn happens to exist.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS headless_turn_id UUID;

-- #161: "owner left while a turn was in flight; notify on completion".
-- Armed/disarmed by the client via POST /api/sessions/:id/notify-on-done
-- the moment the owner stops watching a running turn; checked + cleared
-- at every turn-completion point (the chat handler's done hook and
-- server.js resumeDetachedTurn). Persisted rather than in-memory so
-- restart-recovered turns honor it.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS notify_on_done BOOLEAN NOT NULL DEFAULT FALSE;

-- GitHub issue linkage (#75): the open issues this session's work addresses,
-- declared by the Mayor via dispatch_claude_code / dispatch_scout's
-- `addresses_issues` arg. Accumulates (union) across turns, and shrinks via
-- the tools' `removes_issues` counterpart (#733) when scope is cut
-- mid-session — removal wins over an addition of the same number in the
-- same call. pr-metadata.js appends a `Closes #N` line per number to the PR
-- body so merging the PR auto-closes the issue. `pr_linked_issues_applied`
-- snapshots what was last written to the live PR body so the existing-PR
-- update path can detect a changed linkage even when the title is unchanged.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS linked_issues             INTEGER[] NOT NULL DEFAULT '{}';
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_linked_issues_applied  INTEGER[] NOT NULL DEFAULT '{}';
-- One-shot marker for the migrate-time backfill that recovers linked_issues
-- from historical PR bodies (closing keywords) predating the #75 plumbing.
-- Set true once a session's PR has been fetched + parsed so PRs without
-- closing keywords aren't re-fetched from GitHub on every boot.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS linked_issues_backfilled  BOOLEAN NOT NULL DEFAULT false;

-- Bot-generated testing guidance for PR previews (#127). The coding agent
-- may end a build turn with a "==== TESTING ====" block (parsed by
-- src/services/testing-notes.js):
--   testing_md         : latest "how to test" markdown (NULL = none).
--   testing_path       : validated relative deep-link path into the app that
--                        lands the tester on the changed feature.
--   pr_testing_applied : snapshot of the rendered "How to test" section last
--                        written into the live PR body (the
--                        pr_linked_issues_applied analog) so the existing-PR
--                        update path detects changed guidance even when the
--                        title is unchanged.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS testing_md         TEXT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS testing_path       VARCHAR(512);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_testing_applied TEXT;
--   testing_paths      : ordered list of validated deep-link routes the
--                        before/after capture pipeline shoots a pair at
--                        (#270). Since #768 elements are objects —
--                        { path, viewport: 'desktop'|'mobile' } (`@mobile`
--                        path annotation → phone-sized capture frame);
--                        older rows hold plain path strings and readers
--                        normalize via testing-notes.normalizeStoredPath.
--                        NULL/absent falls back to [testing_path || '/'],
--                        so legacy single-path rows are unchanged.
--                        testing_path stays the PRIMARY path (= the first
--                        of this list) for the "Test this change" button.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS testing_paths      JSONB;

-- Stale-promoted-PR policy + reversible archive.
--   promoted_at       : when the session was proposed to the group. With
--                       the latest pr_votes timestamp this gives the
--                       "interest" recency the stale sweeper measures.
--   stale_notified_at : set when the author was warned the PR is going
--                       stale; cleared when a new vote revives it. The
--                       grace-then-archive step keys off this.
--   archived_at       : when the session was archived. Archive is now
--                       REVERSIBLE within a retention window — the CC
--                       volume + branch are kept so /unarchive restores
--                       it; a hard GC purges the volume only after
--                       archived_at passes ARCHIVED_RETENTION_MS.
--   cc_purged         : TRUE once the hard GC has destroyed the CC volume
--                       (memory gone). /unarchive still works but starts
--                       a fresh Claude session.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS promoted_at        TIMESTAMPTZ;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS stale_notified_at  TIMESTAMPTZ;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS archived_at        TIMESTAMPTZ;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS cc_purged          BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS chat_sessions_archived_idx ON chat_sessions(status, archived_at);

-- Exact merge timestamp. Historically chat_sessions only recorded the
-- terminal `status = 'merged'` with no time, so "merges over time" could
-- not be charted (see the note in routes/kudos.js leaderboard query).
-- Set in routes/votes.js checkAndMerge() at the moment the PR lands (both
-- vote-driven and admin force-merge paths). NULL for rows merged before
-- this column existed; the events backfill approximates those with
-- promoted_at. Covered by the table-level staging:private comment, so it
-- is scrubbed from staging clones with the rest of the row.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS chat_sessions_merged_at_idx ON chat_sessions(merged_at);

-- #800: per-change CODING-AGENT spend, in cents at Anthropic list price.
-- The platform's first per-change cost figure.
--
-- Why it has to exist: chat_session_messages.cost_cents already records
-- every MAYOR turn's cost, but Claude Code in the worker bills through
-- routes/anthropic-proxy.js, which only ever folded its spend into the
-- per-user *daily* llm_usage ledger — so the agent's share (the large
-- majority: measured at ~4.3x the Mayor's on single-session user-days)
-- was never attributable to the change it was building. Total cost of a
-- change is therefore SUM(chat_session_messages.cost_cents) for the
-- session PLUS this column.
--
-- Written by the anthropic-proxy settle path as a best-effort
-- accumulating increment (one narrow single-row UPDATE per agent call;
-- a session's agent calls are serial so there is no contention).
-- Deliberately EXCLUDES platform-driven sync/merge-conflict turns —
-- those bill system_token_usage, run on a fixed model, and are not a
-- consequence of the user's model choice.
--
-- READING IT LATER — IMPORTANT: every session that predates this column
-- has 0 here despite really having spent money, and the history cannot
-- be backfilled (llm_usage has no session or model dimension). So any
-- aggregate MUST filter `agent_cost_cents > 0`, which is exactly the set
-- of sessions whose agent ran after the ledger existed and self-heals as
-- history accumulates. Without that filter the low end of any cost
-- distribution collapses toward zero.
--
-- This is a list-price cost record, NOT a billing record: it is written
-- identically for BYOK and platform-key turns (llm_usage remains the
-- source of truth for spend against allowances). Covered by the
-- table-level staging:private comment.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_cost_cents NUMERIC(12,4) NOT NULL DEFAULT 0;

-- #58: snapshot the vote threshold that was in effect at the moment a PR
-- merged. The "majority" needed to merge is computed live from the active-
-- user set (services/active-users.js getActiveUserStats) and is never
-- otherwise persisted, so the merged-PR vote pill used to be rendered
-- against the *current* majority — its denominator drifted as the app's
-- active-user count changed ("3 / 3" at merge could later read "3 / 5").
-- These two columns freeze the at-merge numbers so the pill (and a
-- tooltip) can show the true historical threshold:
--   votes_required        = the majority threshold needed to merge
--   active_users_at_merge = the active-user count the threshold was
--                           derived from (the "/ M" denominator context)
-- Both set in routes/votes.js checkAndMerge() at the moment the PR lands
-- (vote-driven, admin force-merge, and revert-PR paths all flow through
-- there). NULL for rows merged before these columns existed; the boot-time
-- backfill in db/migrate.js reconstructs them from the merge announcement
-- message's "(yes/active votes)" figure where possible, and the frontend
-- falls back to the live majority for any that remain NULL. Covered by the
-- table-level staging:private comment, so they are scrubbed from staging
-- clones with the rest of the row.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS votes_required        INTEGER;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS active_users_at_merge INTEGER;

-- #788: "explicit approval" flag — this proposal's diff changes a
-- privilege-granting block in dapp.json (today only the top-level
-- `admins` list), so the TIME-BASED merge paths are switched off for it:
-- no minimum visibility window, no lazy-consensus "silence is consent"
-- auto-merge. The app's NORMAL approval rules are otherwise untouched
-- (same threshold, same electorate, same at-least-N / invited-approver
-- configuration, same contested handling) — the proposal merges the
-- moment its normal threshold is met by votes actually cast. The
-- rejection countdown and the stale-PR sweep behave exactly as they do
-- for any other proposal on that app. Implemented as the pure
-- applyNoTimerMerge modifier in services/governance.js.
--   requires_explicit_approval : NULL = not computed yet (the stale-PR
--     sweeper backfills), FALSE = ordinary proposal, TRUE = flagged.
--   explicit_approval_reason   : which rule flagged it; only 'admins'
--     today, a string so a second source can be added later without a
--     schema change.
-- Stamped at promote, at manifest-PR creation, and on every head change
-- (native new-commit vote reset + imported-PR head sync);
-- re-verified authoritatively in checkAndMerge just before the gate.
-- Covered by the table-level staging:private comment.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS requires_explicit_approval BOOLEAN;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS explicit_approval_reason   VARCHAR(32);

CREATE TABLE IF NOT EXISTS chat_session_specs (
  id                  SERIAL PRIMARY KEY,
  session_id          INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  content             TEXT    NOT NULL,
  built_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  commit_sha          VARCHAR(40),
  pr_number           INTEGER,
  shared_to_group_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, version)
);
CREATE INDEX IF NOT EXISTS idx_chat_session_specs_session
  ON chat_session_specs (session_id, version DESC);

-- #86: private spec shares. Each row grants ONE user read access to ONE
-- frozen spec version (the "Share to user" button on the dev-session
-- spec viewer). This table is the authorization source of truth for the
-- widened read gate on GET /api/sessions/:id/specs/:version — the
-- matching 'spec_shared' notification row is just UI. The unique
-- constraint makes re-shares idempotent (and is what keeps a recipient
-- from being re-notified per spec version). Independent of
-- chat_session_specs.shared_to_group_at: a later group share simply
-- makes these rows redundant, never conflicting.
CREATE TABLE IF NOT EXISTS chat_session_spec_user_shares (
  id            SERIAL PRIMARY KEY,
  session_id    INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  recipient_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, version, recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_spec_user_shares_recipient
  ON chat_session_spec_user_shares (recipient_id, created_at DESC);

-- Allow group-chat messages to carry structured payloads (spec_share
-- card metadata today; future: PR previews, system-link metadata, etc.)
-- without overloading the free-form `content` field.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- #194: thread scoping for chat_messages. NULL thread_type = general
-- chat (all pre-existing rows; no backfill needed). thread_type is one
-- of 'issue' | 'session' | 'governance'; thread_ref is, respectively,
-- the GitHub issue number (consistent with
-- issue_bounties.github_issue_number keying), chat_sessions.id (PR
-- proposals), or the internal issues.id (governance proposals). No FK
-- on thread_ref — GitHub issue numbers aren't a local table; session /
-- governance refs are validated server-side at post time (ws.js).
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS thread_type VARCHAR(16);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS thread_ref INTEGER;

-- Message editing: NULL = never edited; a timestamp = the most recent edit
-- time (rendered as the "edited" marker's tooltip). No backfill needed —
-- all pre-existing rows are unedited (matches the metadata/thread_type
-- precedent). Only the original author may set it (enforced in the WS
-- 'edit' handler, src/services/ws.js).
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread
  ON chat_messages (app_id, thread_type, thread_ref, id)
  WHERE thread_type IS NOT NULL;

-- #25: emoji reactions on group-chat messages (WhatsApp-style, but
-- Slack-model: a user may add multiple distinct emoji to one message,
-- hence UNIQUE(message_id, user_id, emoji) rather than per-user). Toggled
-- via the per-app chat WebSocket ('react' message in src/services/ws.js).
CREATE TABLE IF NOT EXISTS message_reactions (
  id         SERIAL PRIMARY KEY,
  message_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  emoji      VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS message_reactions_message_idx ON message_reactions(message_id);

-- Issues (mirrored to GitHub Issues). `kind` discriminates general issues from
-- structured proposals like 'rename' (see src/routes/issues.js). `payload`
-- carries the proposal-specific data (e.g. { newName }).
CREATE TABLE IF NOT EXISTS issues (
  id                  SERIAL PRIMARY KEY,
  app_id              INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  github_issue_number INTEGER,
  title               VARCHAR(512) NOT NULL,
  description         TEXT,
  kind                VARCHAR(32) NOT NULL DEFAULT 'general',
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status              VARCHAR(32) NOT NULL DEFAULT 'open',
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS kind VARCHAR(32) NOT NULL DEFAULT 'general';
ALTER TABLE issues ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Applied close-issue proposals surface in the Completed stream
-- (GET /api/apps/:slug/merged interleaves them with merged PRs); this
-- partial index keeps that keyset scan cheap without widening the table's
-- general indexing.
CREATE INDEX IF NOT EXISTS idx_issues_close_completed
  ON issues (app_id, created_at DESC, id DESC)
  WHERE kind = 'close_issue' AND status = 'closed';

CREATE TABLE IF NOT EXISTS issue_votes (
  id         SERIAL PRIMARY KEY,
  issue_id   INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  vote       VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(issue_id, user_id)
);
-- User-first scan for the "My history" view (GET /api/me/history).
CREATE INDEX IF NOT EXISTS idx_issue_votes_user ON issue_votes (user_id, created_at DESC);

-- Fleet maintenance campaigns (#853's generalization): a platform-level
-- governance proposal (issues.kind='maintenance_campaign' on the
-- self-hosted app) that, once its vote passes, runs a sequential AI loop
-- over every child app repo, opening one maintenance PR per app
-- (chat_sessions.source='maintenance'). The campaign row is created by
-- the apply path (issues.maybeApplyMaintenanceCampaignProposal); per-app
-- execution state lives in maintenance_campaign_apps so a platform
-- restart resumes from the first pending row instead of losing track
-- (fleet-maintenance.resumeRunningCampaigns).
--   status: 'running'   = fan-out in progress (the boot resume picks
--                         these up);
--           'done'      = every target reached a terminal engine state
--                         (pr_open / skipped / failed) — merging is
--                         tracked per-app, not here;
--           'cancelled' = an admin stopped it.
CREATE TABLE IF NOT EXISTS maintenance_campaigns (
  id            SERIAL PRIMARY KEY,
  issue_id      INTEGER REFERENCES issues(id) ON DELETE SET NULL,
  title         VARCHAR(300) NOT NULL,
  instructions  TEXT NOT NULL,
  target_filter JSONB,
  status        VARCHAR(32) NOT NULL DEFAULT 'running',
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

-- One row per (campaign, target app). State machine, engine-owned:
--   pending -> running -> pr_open | skipped | failed
--   pr_open -> merged   (written by the merge-green drain; the status
--                        endpoint also derives live merge state from the
--                        joined session so a normal community-vote merge
--                        shows correctly without this write)
-- 'skipped' = the AI concluded the app doesn't need the change;
-- 'failed'  = LLM/GitHub error, `error` carries the reason; the dashboard
--             retry route resets the row to 'pending' and re-runs it.
CREATE TABLE IF NOT EXISTS maintenance_campaign_apps (
  id          SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES maintenance_campaigns(id) ON DELETE CASCADE,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id  INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  state       VARCHAR(32) NOT NULL DEFAULT 'pending',
  error       TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(campaign_id, app_id)
);

-- PR votes
CREATE TABLE IF NOT EXISTS pr_votes (
  id         SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  vote       VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, user_id)
);
-- User-first scan for the "My history" view (GET /api/me/history).
CREATE INDEX IF NOT EXISTS idx_pr_votes_user ON pr_votes (user_id, created_at DESC);

-- Revision-scoped approvals for every GitHub PR proposal. Imported proposals
-- use imported_pr_head_sha; native proposals use reviewed_head_sha. A later
-- push re-opens approval and the merge gate counts only votes cast against
-- the current reviewed revision. NULL remains valid for historical rows until
-- their next promote, vote, or merge reconciliation. Append-only; safe on boot.
ALTER TABLE pr_votes ADD COLUMN IF NOT EXISTS head_sha VARCHAR(40);

-- #955: provenance for commits the PLATFORM itself pushed onto a proposal
-- branch (today only the MODE=sync "merge origin/main" turn — clean or
-- Claude-resolved). A proposal's votes are pinned to the exact reviewed
-- commit, so without this record the platform's own conflict-resolution
-- commit is indistinguishable from an author push and wipes the tally.
--
-- Authenticity comes from "we pushed this SHA", never from commit message,
-- author identity, or merge-commit shape — all of which an author can
-- reproduce locally, which would turn vote preservation into a governance
-- bypass. first_parent_sha lets the reconciler walk a chain of stacked
-- platform commits back to the reviewed head without re-reading GitHub;
-- prior_reviewed_head_sha records what the review was pinned to at push
-- time (audit only). Append-only; rows cascade with the session.
--
-- Deliberately NOT tagged 'staging:private': it holds no user content and no
-- credential — just commit ids the platform authored. It still arrives empty
-- in a staging clone, as a transitive FK child of the private chat_sessions
-- (db-manager.js truncates those CASCADE and its recursive discovery finds
-- this table automatically), exactly like its sibling pr_votes.
CREATE TABLE IF NOT EXISTS session_platform_pushes (
  id                      SERIAL PRIMARY KEY,
  session_id              INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  sha                     VARCHAR(40) NOT NULL,
  first_parent_sha        VARCHAR(40),
  prior_reviewed_head_sha VARCHAR(40),
  kind                    VARCHAR(24) NOT NULL DEFAULT 'sync_main',
  sync_result             VARCHAR(16),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, sha)
);
CREATE INDEX IF NOT EXISTS idx_session_platform_pushes_session
  ON session_platform_pushes (session_id, sha);

-- Community-voted "priority" + "assigned person" on issues and PR
-- proposals. ONE unified table because both fields share identical
-- voting mechanics (one movable vote per user per field per card; the
-- top-voted value is what the card shows). target_ref points at the
-- GitHub issue NUMBER when target_type='issue' (mirroring issue_bounties,
-- which is keyed by (app_id, github_issue_number) because the Dev feed
-- lists repo GitHub issues that may have no internal `issues` row) and at
-- the chat_sessions.id (session id) when target_type='proposal'.
-- value holds 'low'|'medium'|'high' for priority, one of a fixed category
-- slug set (feature|bug|improvement|design|docs|chore) for category, or the
-- typed display name (raw casing) for assignee — assignee dedupe is
-- case-insensitive at read time, never restricted to registered users.
-- NOT staging:private:
-- the tally is a public governance-style signal (closer to issue_votes
-- than to the privacy-flavoured bounty/kudos ledgers), so leaving it
-- copyable lets staging previews show real seeded data.
CREATE TABLE IF NOT EXISTS topic_attribute_votes (
  id          SERIAL PRIMARY KEY,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  target_type VARCHAR(16) NOT NULL,   -- 'issue' | 'proposal'
  target_ref  INTEGER NOT NULL,       -- github_issue_number | chat_sessions.id
  field       VARCHAR(16) NOT NULL,   -- 'priority' | 'assignee' | 'category'
  value       TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id, target_type, target_ref, field, user_id)
);
-- Per-card tally read (group by value within one target+field).
CREATE INDEX IF NOT EXISTS idx_topic_attribute_votes_target
  ON topic_attribute_votes (app_id, target_type, target_ref, field);

-- #780: per-app registry of CUSTOM category options, listed under the six
-- built-in slugs (feature|bug|improvement|design|docs|chore) in the category
-- chip's dropdown and in the kanban / PM filter bar. Typing a new category
-- in that dropdown registers a row here (scoped to ONE app) and casts the
-- typer's vote for it in the same request — "suggesting" and "voting" stay
-- the same operation, mirroring the free-text assignee field.
--   slug  — lowercased dedupe key; ALSO the literal string written into
--           topic_attribute_votes.value, so a custom category tallies
--           byte-for-byte like a built-in one and needs no vote migration.
--   label — the display casing as FIRST typed ("iOS", "UX"), so a later
--           "ios" votes for the same option without rewriting the label.
-- NOT staging:private — like topic_attribute_votes this is a shared,
-- governance-style signal everyone in the app sees, so it must copy into
-- staging clones.
CREATE TABLE IF NOT EXISTS app_topic_categories (
  id          SERIAL PRIMARY KEY,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,           -- lowercase dedupe key + vote value
  label       TEXT NOT NULL,           -- display casing as first typed
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id, slug)
);

-- #613: manual drag-and-drop ordering of cards WITHIN a Dev-board kanban
-- column. The board's default order is derived (recency / merge-priority);
-- this table is an OVERLAY: cards whose identity appears here sort first,
-- by `position` asc, and everything else keeps the derived order. Keyed the
-- same way as topic_attribute_votes (heterogeneous cards addressed by a
-- (type, ref) pair) because a column mixes GitHub issues (ref = issue
-- NUMBER) with promoted PR proposals (ref = chat_sessions.id) and governance
-- proposals (ref = issues.id). column_key ∈ 'issues' | 'review' (the two
-- shared columns this feature covers; In progress is per-viewer and Done is
-- paginated, so both are out of scope). One movable order per app+column;
-- writes REPLACE the whole (app_id, column_key) set with a dense 0..N-1
-- sequence (last-write-wins). NOT staging:private — like topic_attribute_votes
-- this is a shared, governance-style signal that everyone sees, so it must
-- copy into staging clones.
CREATE TABLE IF NOT EXISTS dev_board_card_order (
  id          SERIAL PRIMARY KEY,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  column_key  VARCHAR(16) NOT NULL,   -- 'issues' | 'review'
  card_type   VARCHAR(16) NOT NULL,   -- 'issue' | 'proposal' | 'gov'
  card_ref    INTEGER NOT NULL,       -- github_issue_number | chat_sessions.id | issues.id
  position    INTEGER NOT NULL,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id, column_key, card_type, card_ref)
);
-- Per-column ordered read (position asc within one app+column).
CREATE INDEX IF NOT EXISTS idx_dev_board_card_order_col
  ON dev_board_card_order (app_id, column_key, position);

-- Manual drag-and-drop ordering of cards WITHIN one person's section of the
-- Dev board's PM view ("tasks by assignee"). Sibling of dev_board_card_order,
-- but keyed by the case-folded ASSIGNEE instead of a kanban column: the PM
-- view groups cards by their top-voted assignee (see topic-attribute votes),
-- so a manual order is scoped to a person, not a column. Same OVERLAY model —
-- cards whose identity appears here sort first by `position` asc, everything
-- else keeps the client's derived recency order (see _applyManualOrder in
-- public/js/app-view.js). assignee_key = lower(display name), matching
-- topic-attributes.groupKey so it lines up with the rendered section. A PM
-- section only ever holds GitHub issues (card_ref = issue NUMBER) and promoted
-- PR proposals (card_ref = chat_sessions.id) — never governance cards, which
-- carry no assignee. One movable order per (app_id, assignee_key); writes
-- REPLACE the whole set with a dense 0..N-1 sequence (last-write-wins). NOT
-- staging:private — like dev_board_card_order it's a shared, governance-style
-- signal everyone sees, so it must copy into staging clones.
CREATE TABLE IF NOT EXISTS dev_pm_card_order (
  id           SERIAL PRIMARY KEY,
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  assignee_key VARCHAR(64) NOT NULL,   -- lower(assignee display name)
  card_type    VARCHAR(16) NOT NULL,   -- 'issue' | 'proposal'
  card_ref     INTEGER NOT NULL,       -- github_issue_number | chat_sessions.id
  position     INTEGER NOT NULL,
  updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id, assignee_key, card_type, card_ref)
);
-- Per-person ordered read (position asc within one app+assignee).
CREATE INDEX IF NOT EXISTS idx_dev_pm_card_order_key
  ON dev_pm_card_order (app_id, assignee_key, position);

-- LLM usage tracking
CREATE TABLE IF NOT EXISTS llm_usage (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  total_cost_cents NUMERIC(10,4) NOT NULL DEFAULT 0,
  UNIQUE(user_id, date)
);

-- #361: dedicated "system tokens" daily ledger for platform-driven
-- merge-conflict / sync-with-main resolution turns. One row per day (not
-- per user — this spend isn't attributable to a person). Mirrors the
-- llm_usage upsert shape. Kept separate from llm_usage so this
-- housekeeping spend never pollutes per-user analytics or the global
-- cap aggregation. Written via limits.recordSystemSpend, gated via
-- limits.checkSystemBudget against system_tokens_daily_limit_cents.
CREATE TABLE IF NOT EXISTS system_token_usage (
  date       DATE PRIMARY KEY DEFAULT CURRENT_DATE,
  cost_cents NUMERIC(10,4) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- #119: split daily spend by who paid Anthropic.
--   total_cost_cents = platform-key spend (drives the daily caps)
--   byok_cost_cents  = spend billed to the user's own Anthropic key
--                      (display only — never considered by any cap)
ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS byok_cost_cents NUMERIC(10,4) NOT NULL DEFAULT 0;

-- #1088: stamped the first time — for this UTC day — the owner is TOLD
-- that their own Anthropic key took over once the free daily allowance
-- ran out. The proxy's per-turn registry flag only made the notice
-- once-per-turn, so it re-fired on every chat after credits ran out.
-- Claimed race-free by limits.claimByokSwitchNotice (a conditional
-- upsert); NULL means "not yet told today". Rides on the row's `date`,
-- so it expires exactly when the credits themselves reset — no sweeper.
ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS byok_notice_at TIMESTAMPTZ;

-- Platform-level admin-tunable settings. Currently only used for the
-- daily LLM spend caps; designed as a generic key/value store so future
-- admin knobs can land here without another migration. Values are
-- TEXT so callers can interpret per-key (parseInt for cents, etc.).
-- Read via src/services/limits.js with a 10s in-process cache;
-- writes from /api/admin/limits invalidate the cache.
CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
-- Seed defaults that match the legacy hardcoded values in
-- src/routes/sessions.js (USER_DAILY_LIMIT_CENTS=2500, GLOBAL=20000)
-- so a fresh deploy preserves the prior behavior. ON CONFLICT DO
-- NOTHING means existing operator-set values survive every boot.
INSERT INTO platform_settings (key, value) VALUES
  ('user_daily_limit_cents',   '2500'),
  ('global_daily_limit_cents', '20000'),
  -- #361: separate "system tokens" budget that funds platform-driven
  -- merge-conflict / sync-with-main resolution turns. Defaults to $25/day.
  ('system_tokens_daily_limit_cents', '2500')
ON CONFLICT (key) DO NOTHING;

-- One-shot backfill of users.app_quota from the legacy can_create_apps
-- boolean. Guarded by a marker row in platform_settings so it runs EXACTLY
-- ONCE: a re-run-safe UPDATE keyed only on can_create_apps = TRUE would
-- re-clobber any quota an admin later resets to 0 for a still-enabled user.
-- Placed after both `apps` and `platform_settings` exist (this whole file
-- runs as one ordered statement). Mapping for existing enabled users:
--   can_create_apps = TRUE  → app_quota = GREATEST(5, <live app count>),
--     where live count = COUNT(*) of their non-errored apps. The floor of
--     5 guarantees no regression — nobody who could already create ends up
--     below the apps they already have. Admins are included (their quota is
--     cosmetic since they bypass enforcement) so the admin UI shows a
--     sensible number.
--   can_create_apps = FALSE → quota stays 0 (the column default).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_settings WHERE key = 'app_quota_migrated') THEN
    UPDATE users u
       SET app_quota = GREATEST(5, (
             SELECT COUNT(*)::int FROM apps
              WHERE created_by = u.id AND status <> 'error'
           ))
     WHERE u.can_create_apps = TRUE;
    INSERT INTO platform_settings (key, value)
      VALUES ('app_quota_migrated', 'true')
      ON CONFLICT (key) DO NOTHING;
  END IF;
END $$;

-- Notifications. Generic row format so we can add more `kind`s later
-- (PR approvals, etc). Currently 'mention' (group-chat @mention parser
-- in src/services/ws.js), 'kudos' (PR kudos give in src/routes/kudos.js),
-- 'reply' (#15 — someone quoted your message/PR in group chat;
-- chat_message_id points to the reply, set in src/services/ws.js),
-- 'reaction' (#25 — someone reacted to your message; chat_message_id is
-- the reacted message, `detail` holds the emoji), 'stale_pr' (a promoted
-- PR is going quiet, addressed to its author), 'pr_proposed' (a PR
-- was promoted for voting — session_id points to it; fanned out to the
-- app's active users + creator + favoriters in src/routes/votes.js),
-- 'session_done' (#161 — a dev-session turn finished after its owner
-- left; session_id points to the session), 'auto_solve_done' (#161 —
-- a headless auto-solve run finished; `detail` holds the outcome:
-- spec | code | spec_code | question | failed) and 'spec_shared' (#86 —
-- someone privately shared a spec version with you; session_id points
-- to the dev session, `detail` holds the version number as a string).
CREATE TABLE IF NOT EXISTS notifications (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id          INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  chat_message_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
  source_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind            VARCHAR(32) NOT NULL DEFAULT 'mention',
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user_recent
  ON notifications (user_id, created_at DESC);

-- Kudos notifications carry a chat_sessions reference so the notification
-- dropdown can navigate back to the PR (group-chat tab) and render the
-- PR's title in the preview. Added later than the rest of the column
-- set, so wrapped in IF NOT EXISTS for idempotent re-runs.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS session_id
  INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE;

-- #25: free-form detail for a notification kind that needs a small extra
-- string. Today only 'reaction' uses it (the emoji someone reacted with);
-- kept generic + nullable so future kinds can reuse it.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS detail VARCHAR(32);

-- Per-app environment secrets. Values are AES-256-GCM encrypted via
-- src/services/secrets.js (keyed off DATA_ENCRYPTION_KEY), serialized as
-- "v1:<iv>:<tag>:<ct>" — same scheme used for users.anthropic_key_enc.
--
-- A dapp declares which keys it needs in `dapp.json` at its repo root
-- (see src/services/app-manifest.js). Stored values for any `required`
-- key listed there must be present at deploy time, otherwise the
-- deploy is blocked (createApp flips status to 'awaiting_secrets';
-- rebuildProduction throws with `missingSecrets`).
--
-- value_last4 is a redacted preview the UI can show without a decrypt
-- round-trip (e.g. "ut1…abcd"). Sensitive values store NULL here so the
-- UI never shows even a fragment.
CREATE TABLE IF NOT EXISTS app_secrets (
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key         VARCHAR(128) NOT NULL,
  value_enc   TEXT NOT NULL,
  value_last4 VARCHAR(8),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (app_id, key)
);

-- Self-hosting: the platform itself appears as one row in `apps` with
-- self_hosted=TRUE. The seed at boot inserts/refreshes this row; two
-- guards in app-creator and votes (Phase 2g) skip container-management
-- side effects for it. See SELF-HOSTING.md.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS self_hosted BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_apps_self_hosted
  ON apps (self_hosted) WHERE self_hosted = TRUE;

-- Staging privacy convention. Tables tagged `staging:private` are
-- TRUNCATEd by db-manager.js's cloneDatabase when spawning a staging
-- clone; columns tagged `staging:private` are UPDATE'd to NULL (or a
-- sentinel for NOT NULL columns) so the surrounding row survives.
-- See src/prompts/app-conventions.md for the convention doc.
--
-- RELATED (#616): the prod-debug read-only role (usernode_debug_ro,
-- src/services/debug-access.js) carries its OWN deny lists
-- (DENIED_TABLES / DENIED_COLUMNS). When you add a NEW credential-
-- bearing table or column here (anything you'd tag staging:private
-- because it stores a password, key, or token — not merely private
-- user content), add it to those deny lists too so admin debugging
-- sessions can never SELECT it. tests/prod-debug-access.test.js
-- cross-checks the credential-tagged columns below against the lists.
--
-- RELATED (#1130): there is a SECOND read-only role, the admin SQL
-- console's (topochain_console_ro,
-- src/services/topochain/db-console-scope.js). It denies credential
-- COLUMNS, never whole tables, because a platform admin who cannot read
-- a table here just reads it somewhere less redacted. It IMPORTS
-- DENIED_COLUMNS above (so a new credential column added there covers
-- both roles) and adds CONSOLE_CREDENTIAL_COLUMNS for the columns inside
-- the tables debug-access.js denies wholesale. So a new credential
-- column needs a DENIED_COLUMNS entry; a new credential column on a
-- table that is denied WHOLESALE for prod-debug needs a
-- CONSOLE_CREDENTIAL_COLUMNS entry as well.
-- tests/topochain-db-tools.test.js cross-checks the credential-tagged
-- columns below, and sweeps this file for credential-shaped column
-- names, against the console lists.
--
-- Table-level: every row is sensitive in its entirety.
COMMENT ON TABLE sessions               IS 'staging:private';
COMMENT ON TABLE activation_codes       IS 'staging:private';
COMMENT ON TABLE chat_sessions          IS 'staging:private';
COMMENT ON TABLE chat_session_messages  IS 'staging:private';
COMMENT ON TABLE chat_session_specs     IS 'staging:private';
COMMENT ON TABLE chat_session_spec_user_shares IS 'staging:private';
COMMENT ON TABLE llm_usage              IS 'staging:private';
COMMENT ON TABLE notifications          IS 'staging:private';
COMMENT ON TABLE app_secrets            IS 'staging:private';
-- `mail_deliveries` is tagged too, but its COMMENT lives beside its
-- CREATE TABLE further down this file — the table doesn't exist yet at
-- this point, and a COMMENT ON a missing table aborts the whole re-apply.

-- Column-level on `users`: rows survive cloning so FK-targeted
-- attribution (chat_messages.user_id, apps.created_by, …) keeps
-- working in staging. Only the auth-sensitive columns get scrubbed.
-- usernode_pubkey is intentionally NOT scrubbed: it's an on-chain
-- public identity, no different from username for privacy purposes,
-- and a self-app dev wants to see it to test wallet-link flows.
COMMENT ON COLUMN users.password               IS 'staging:private';
COMMENT ON COLUMN users.anthropic_key_enc      IS 'staging:private';
COMMENT ON COLUMN users.anthropic_key_last4    IS 'staging:private';
COMMENT ON COLUMN users.wallet_link_token      IS 'staging:private';
COMMENT ON COLUMN users.wallet_link_expires_at IS 'staging:private';

-- Per-app postgres role passwords. A staging clone has no legitimate
-- need for the prod credentials of any app (including its own — the
-- clone has its own dedicated role with its own ephemeral password),
-- so blank every row's value. Without this scrub, a self-app staging
-- container could SELECT db_password FROM apps and recover every
-- prod app's credential.
COMMENT ON COLUMN apps.db_password IS 'staging:private';

-- Public by omission (no comment): apps, app_activity, issues, the
-- users table itself, chat_messages, issue_votes, pr_votes. These
-- carry no per-row secrets and the aggregates are already visible
-- to anyone the staging clone would be spun up for.

-- PR kudos. A platform-wide appreciation signal that's orthogonal to
-- `pr_votes` (which is a yes/no merge gate). Every user gets a weekly
-- allowance (WEEKLY_KUDOS_LIMIT in src/services/bounties.js, currently
-- 20, shared with issue bounties), can give at most 1 per PR, can't give
-- to their own PR, and can't take a kudos back.
-- Eligibility lives in src/routes/kudos.js:
-- only chat_sessions in status ('promoted','merging','merged') can
-- receive kudos.
--
-- `week_start` is the Monday-00:00-UTC bucket containing `created_at`,
-- stored explicitly so (giver_user_id, week_start) is an indexable
-- equality lookup for the per-week quota check. Postgres
-- `date_trunc('week', x AT TIME ZONE 'UTC')::DATE` returns the Monday
-- of that ISO week, which matches the boundary exactly. See
-- src/routes/kudos.js for both the JS-side (`weekStartUtc`) and SQL
-- usages — keep them aligned if the boundary is ever changed.
--
-- Tagged staging:private so kudos history doesn't leak into staging
-- clones; per-user counts are derivable from production but the
-- row-level (giver, PR) attribution is privacy-flavored social data.
CREATE TABLE IF NOT EXISTS pr_kudos (
  id             SERIAL PRIMARY KEY,
  session_id     INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  giver_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start     DATE NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, giver_user_id)
);
CREATE INDEX IF NOT EXISTS idx_pr_kudos_session     ON pr_kudos (session_id);
CREATE INDEX IF NOT EXISTS idx_pr_kudos_giver_week  ON pr_kudos (giver_user_id, week_start);
CREATE INDEX IF NOT EXISTS idx_pr_kudos_created     ON pr_kudos (created_at DESC);
COMMENT ON TABLE pr_kudos IS 'staging:private';

-- Issue bounties — a "Give kudos" pledge placed on a GitHub issue from the
-- Open Issues activity-panel section. A bounty is a SYMBOLIC off-chain
-- ledger entry (no tokens, no on-chain transfer): pledging it debits the
-- giver's shared weekly kudos allowance (the same 5/week cap pr_kudos
-- enforces, counted across BOTH tables — see src/routes/kudos.js). When a
-- merged PR closes the issue (via its chat_sessions.linked_issues link),
-- the open bounty flips to 'awarded' and is credited to that PR's author —
-- see the payout block in routes/votes.js checkAndMerge.
--
-- Keyed by (app_id, github_issue_number) — NOT the internal `issues` table —
-- because the Open Issues section lists the repo's GitHub issues, which may
-- have no internal proposal row. staging:private for the same reason as
-- pr_kudos: row-level (giver, issue) attribution is privacy-flavored social
-- data. (A private table may FK public tables; only the reverse is barred.)
CREATE TABLE IF NOT EXISTS issue_bounties (
  id                   SERIAL PRIMARY KEY,
  app_id               INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  github_issue_number  INTEGER NOT NULL,
  giver_user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  week_start           DATE NOT NULL,
  status               VARCHAR(16) NOT NULL DEFAULT 'open',
  awarded_session_id   INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  awarded_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  awarded_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One OPEN bounty per (app, issue, giver). A partial unique index keeps the
-- constraint scoped to status='open' so a giver can re-pledge after a prior
-- bounty of theirs has already been awarded/voided.
CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_bounties_open_uniq
  ON issue_bounties (app_id, github_issue_number, giver_user_id)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_issue_bounties_issue
  ON issue_bounties (app_id, github_issue_number, status);
CREATE INDEX IF NOT EXISTS idx_issue_bounties_giver_week
  ON issue_bounties (giver_user_id, week_start);
COMMENT ON TABLE issue_bounties IS 'staging:private';

-- Manual "In progress" claims on GitHub issues (the hand-set half of the
-- issue in-progress status; the automatic half derives from
-- chat_sessions.linked_issues at read time — see GET /github-issues in
-- src/routes/issues.js). One row per (app, issue, user): several people
-- can claim the same issue concurrently, each owning exactly one claim.
-- Claims carry no status column and are never swept — expiry is a
-- read-time filter: a claim is live while GREATEST(claimed_at, the
-- issue's discussion-thread last activity) is within ISSUE_CLAIM_TTL_DAYS
-- (7). Renewal (re-POST by the owner) just refreshes claimed_at; clearing
-- deletes the row (claimer or write-admin only). Keyed by GitHub issue
-- number for the same reason as issue_bounties. NOT staging:private —
-- claims are group-visible coordination data (the chip names claimers to
-- everyone), so cloned rows are as public in staging as in prod.
CREATE TABLE IF NOT EXISTS issue_claims (
  id                   SERIAL PRIMARY KEY,
  app_id               INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  github_issue_number  INTEGER NOT NULL,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claimed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, github_issue_number, user_id)
);

-- Per-user app favorites. Personal shortcut — starred apps appear in a
-- dedicated section above the main grid on the home screen. No effect
-- on visibility or permissions for other users. Not staging:private
-- because favorites are non-sensitive and useful in staging previews.
CREATE TABLE IF NOT EXISTS app_favorites (
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_favorites_user ON app_favorites(user_id);
-- Per-user manual ordering of starred apps (issue #128). NULL = no
-- explicit position: such rows sort after all explicitly ordered ones,
-- falling back to the activity-based list order. Lower = earlier.
-- Uniqueness is deliberately not enforced — gaps/ties are tolerated and
-- resolved by the fallback, and PUT /api/favorites/order rewrites the
-- caller's full set contiguously on every save anyway.
ALTER TABLE app_favorites ADD COLUMN IF NOT EXISTS sort_order INTEGER;
-- #618: per-user "Your apps" opt-out for member apps. Membership
-- (app_collaborators) pins an app into the home screen's "Your apps"
-- section; a hidden=TRUE row here suppresses that pin for this user
-- only — display preference, zero effect on access or permissions.
-- Row semantics: hidden=FALSE (the default, and every pre-migration
-- row) = a manual add (the classic favorite); hidden=TRUE = an
-- explicit opt-out. The favorite toggle endpoint decides which to
-- write: members get the hidden upsert, non-members get the old
-- insert/delete (see POST /api/apps/:slug/favorite in
-- src/routes/apps.js).
ALTER TABLE app_favorites ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;

-- Free-form per-user home-screen layout: where every app tile and widget
-- sits on the launcher grid, as a real (column, row) CELL rather than a
-- position in a flow. This is what makes holes possible — an arrangement
-- with an empty row and one app alone in the bottom-right corner is
-- expressible here and is not expressible as an ordering.
--
-- ONE LAYOUT PER COLUMN COUNT. `cols` is the breakpoint discriminator: the
-- home grid is 4 columns on a phone and 5 above 640px, and a layout with
-- intentional holes has no round-trip between the two widths. Storing one
-- arrangement per width is what lets a phone drag be remembered without
-- silently rewriting the desktop arrangement (and vice versa). A width with
-- NO rows means "never dragged at this width" — the client derives that
-- view by reflowing the other one (or from app_favorites.sort_order flow
-- order) and only persists once the user actually drags there. That is why
-- this table needs no backfill: every existing account keeps today's
-- arrangement as a derivation.
--
-- A table rather than a JSONB column on `users` (the retired
-- home_panel_positions above was the latter) precisely for the app FK:
-- ON DELETE CASCADE means a deleted app vacates its cell for free, where a
-- blob would accumulate dead ids that every home paint would have to filter.
--
-- Cells only, never sizes: a widget's footprint (w x h, per column count)
-- comes from PANEL_REGISTRY in src/routes/home-panels.js, so a widget can
-- be resized in code without migrating anyone's stored layout. The client's
-- HomeLayout.repair() resolves any overlap that a size change introduces.
--
-- Widget rows are NEVER conditional on the viewer's permissions — notably
-- the 'create' widget is stored for every account regardless of app quota;
-- whether it is tappable is a render-time read of the derived canCreateApps
-- boolean. Nothing about quota reaches this table, so gaining or losing it
-- can never move or drop anyone's tiles.
--
-- Not staging:private: a home-screen arrangement is a display preference
-- with no sensitive content, and staging previews are far more useful with
-- real layouts in them.
CREATE TABLE IF NOT EXISTS user_home_layout (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 4 (phone) or 5 (>= 640px). Kept in step with HomeLayout.columnsForWidth
  -- in frontend/src/features/home/home-layout.js and the grid classes on #app-list.
  cols        SMALLINT NOT NULL,
  item_type   TEXT NOT NULL,
  app_id      INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  widget_key  TEXT,
  grid_col    SMALLINT NOT NULL,
  grid_row    SMALLINT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_home_layout_kind CHECK (
    (item_type = 'app' AND app_id IS NOT NULL AND widget_key IS NULL)
    OR (item_type = 'widget' AND widget_key IS NOT NULL AND app_id IS NULL)
  ),
  CONSTRAINT user_home_layout_cols CHECK (cols IN (4, 5)),
  CONSTRAINT user_home_layout_col CHECK (grid_col >= 0 AND grid_col < cols),
  -- 8 rows is the free-PLACEMENT canvas, not a capacity cap: items that
  -- don't fit render as dense overflow rows below it (client-side) and are
  -- simply not stored until they're dragged back onto the canvas.
  CONSTRAINT user_home_layout_row CHECK (grid_row >= 0 AND grid_row < 8)
);
-- One cell per item per width. Partial indexes rather than a composite PK
-- because exactly one of app_id / widget_key is set on any row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_home_layout_app
  ON user_home_layout(user_id, cols, app_id) WHERE app_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_home_layout_widget
  ON user_home_layout(user_id, cols, widget_key) WHERE widget_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_home_layout_read
  ON user_home_layout(user_id, cols);

-- Admin-curated "Find more apps" row on the home screen. Global (one
-- ordered list for everyone — no per-user targeting), display-only, and
-- zero effect on access: the row is derived client-side from the
-- `featured` / `featured_order` flags GET /api/apps already serializes
-- per viewer, so a featured VIEW-PRIVATE app is simply absent for
-- someone who can't see it — the visibility filter in that query is the
-- only gate needed.
--
-- A table rather than a platform_settings blob so app deletion cascades
-- and the admin console can join names/icons directly.
-- Deliberately NOT staging:private: curation is public information (the
-- row is on every user's home screen). Rows don't exist in prod yet, so
-- a staging clone starts empty — src/db/migrate.js seeds a few under
-- IS_STAGING so PR previews can review the row at all.
-- Written only by PUT /api/admin/featured-apps (full-rewrite, admin
-- only); read by the LEFT JOIN in GET /api/apps.
CREATE TABLE IF NOT EXISTS featured_apps (
  app_id      INTEGER PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_featured_apps_order ON featured_apps(sort_order);

-- Append-only product-analytics event log. The long-term source of truth
-- behind the admin /dashboard (growth, retention, and the dapp-usage /
-- PR-promotion funnels). Rows are written fire-and-forget at action sites
-- via src/services/events.js (never blocking or failing the originating
-- request). On first boot the events table is backfilled from the existing
-- domain tables (users, apps, app_activity, chat_messages, pr_votes,
-- pr_kudos, app_favorites, chat_sessions) so the funnels and retention
-- curves are continuous across the cutover — see backfillEvents() in
-- src/db/migrate.js.
--
-- `event_type` is a free-form verb (e.g. 'user_signed_up', 'dapp_opened',
-- 'pr_promoted', 'pr_merged'); see EVENT_TYPES in src/services/events.js
-- for the canonical list. The nullable user/app/session FKs use ON DELETE
-- SET NULL so analytics history survives the deletion of the referenced
-- row (the aggregate counts stay correct even after a user is removed).
CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  app_id      INTEGER REFERENCES apps(id) ON DELETE SET NULL,
  session_id  INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  event_type  VARCHAR(64) NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_events_user_created ON events(user_id, created_at);

-- #717: restart/recovery-safe receipt for provider-neutral invocation rows.
-- Ordinary product analytics events do not carry invocation_key and are
-- unaffected. The key is an opaque platform id, never provider/user content.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_llm_invocation_key
  ON events ((metadata->>'invocation_key'))
  WHERE event_type = 'llm_invocation' AND metadata ? 'invocation_key';

-- Tagged staging:private so the analytics log (which is derived from
-- chat_sessions / pr_kudos, both already private) is TRUNCATEd in staging
-- clones rather than leaking social history into previews.
COMMENT ON TABLE events IS 'staging:private';

-- Per-app visibility (collaborator & viewer privacy).
--   collab_visibility: who may participate in building the app (group
--     chat, dev sessions, voting, issues, kudos). 'public' = everyone.
--   view_visibility:   who may see the app exists and use it (home list,
--     App tab). 'public' = everyone.
-- Invariants (enforced by the CHECK below + API validation in
-- routes/apps.js): collab-public implies view-public, and view-private
-- means the viewer list IS the collaborator list (viewers are never
-- separately enumerated). Admins always see everything — enforced in
-- src/services/app-access.js, the shared gate every route goes through.
-- Post-creation changes go through dapp.json's top-level `visibility`
-- block (issue #124): a vote-gated PR edits the block and the merge's
-- production rebuild reconciles these columns to it
-- (services/app-manifest.js reconcileAppVisibility).
-- Defaults make every pre-migration app public/public (no behavior change).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS collab_visibility VARCHAR(10) NOT NULL DEFAULT 'public';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS view_visibility   VARCHAR(10) NOT NULL DEFAULT 'public';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'apps_visibility_combo_check' AND conrelid = 'apps'::regclass
  ) THEN
    ALTER TABLE apps ADD CONSTRAINT apps_visibility_combo_check
      CHECK (NOT (collab_visibility = 'public' AND view_visibility = 'private'));
  END IF;
END $$;

-- Anonymous-shell probe result (landing-page app directory).
--   anon_shell: whether the app's own HTML shell serves without a
--     platform session. 'public' = anonymous GET / returns 2xx (echo /
--     lastwin style), 'gated' = it 401s or bounces to the platform (the
--     scaffold default), 'unknown' = never probed or unclassifiable.
--     Written ONLY by services/shell-probe.js; consumed by
--     GET /api/public/apps as `requires_login` (anything not 'public').
--     'unknown' renders as account-required — the safe default, matching
--     the scaffold's gated-by-default behavior.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS anon_shell VARCHAR(10) NOT NULL DEFAULT 'unknown';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS anon_shell_checked_at TIMESTAMPTZ;

-- Per-app proposal-approval governance (issue #646).
--   approver_policy:    who can approve proposals. 'anyone' = every
--     eligible voter's vote counts toward the merge gate (today's
--     behavior); 'invited' = only votes from app_approvers members
--     count — everyone else's votes are advisory.
--   approvals_required: how many approvals are needed. NULL = the
--     default time-&-majority strategy (services/active-users.js
--     mergeGate); >= 1 = "at least N" mode — a proposal merges as soon
--     as it has N qualifying yes votes, with no visibility window,
--     lazy-consensus clock, contested state, or auto-rejection.
-- Source of truth is dapp.json's top-level `governance` block,
-- reconciled on every production deploy (services/app-manifest.js
-- reconcileAppGovernance) and — unlike visibility — also at boot for
-- the self-hosted platform app (db/migrate.js seedSelfApp). Defaults
-- make every pre-migration app behave exactly as before.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS approver_policy VARCHAR(10) NOT NULL DEFAULT 'anyone';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS approvals_required SMALLINT;

-- Per-app admins (#788), display side. The last reconciled *declared*
-- username list from dapp.json's top-level `admins` block — INCLUDING
-- names that resolved to no registered user, which is exactly why this
-- exists alongside the resolved-id table `app_admins` below: the
-- Members panel can say "@carol — declared, not a registered user"
-- without a second source. Never consulted for permission checks (the
-- `app_admins` rows are the authority); purely for display and to keep
-- the settings endpoint a single query. Defaults to the empty array so
-- every pre-migration app reads as "no declared admins".
ALTER TABLE apps ADD COLUMN IF NOT EXISTS admin_usernames TEXT[] NOT NULL DEFAULT '{}';

-- Pixel density the platform captures this app's before/after preview
-- screenshots at (issue #360). 2 = HiDPI/retina (the default, matching
-- real laptops/phones — surfaces "only broken on retina" bugs as a
-- visible before/after diff); 1 = standard density, opted into by apps
-- that genuinely need it (pixel art). Source of truth is dapp.json's
-- top-level `screenshot.deviceScaleFactor`, reconciled here on every
-- deploy (services/app-manifest.js reconcileAppScreenshot) and read by
-- the capture orchestrator (services/visuals.js captureForSession).
-- DEFAULT 2 means every pre-migration app captures at 2× with no
-- manifest edit.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS screenshot_device_scale SMALLINT NOT NULL DEFAULT 2;

-- Homescreen icon, source of truth: dapp.json's optional top-level
-- `icon` block ({"emoji": "🎮"} or {"image": "public/icon.png"}),
-- reconciled on every deploy (services/app-manifest.js
-- reconcileAppIcon). Both NULL = the letter-tile fallback the home
-- card always rendered. icon_image_id points at an app_icons row and
-- deliberately carries no FK: the reconcile owns both sides' lifecycle
-- and rotates the id only when the committed bytes change (the
-- /app-icons/:id cache header is immutable, so a new id doubles as
-- the cache-buster).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS icon_emoji VARCHAR(32);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS icon_image_id VARCHAR(32);

-- Fork lineage. NULL for normally-created apps; for a fork it stores a
-- REFERENCE ONLY to the source app: {"appId": <id>, "slug": "<slug>"}.
-- The source's display name is deliberately NOT persisted here — it is
-- resolved LIVE at serialize time (routes/apps.js) by looking the source
-- up by appId, so a rename on the original is reflected immediately and
-- a deleted source resolves to the literal "<deleted>" (link inert).
-- A plain JSONB reference (not an FK) is used on purpose: an FK with
-- ON DELETE would blank the reference exactly when we still want to show
-- "forked from <deleted>". NOT staging:private — lineage renders on the
-- public home feed and must survive into staging clones.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS forked_from JSONB;

-- Icon image bytes, one row per app, keyed by an unguessable random id
-- (same access stance as session_visuals: /app-icons/:id is served
-- unauthenticated so home tiles load it with a plain <img>, and the
-- 32-hex id is the only access control — an icon discloses only
-- itself). Bytes live OFF the apps row on purpose: GET /api/apps
-- spreads SELECT a.* into JSON, and a BYTEA column there would
-- serialize into every list response. NOT staging:private — icons
-- render on the public home feed and should survive into staging
-- clones.
CREATE TABLE IF NOT EXISTS app_icons (
  id           VARCHAR(32) PRIMARY KEY,
  app_id       INTEGER UNIQUE NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  content_type VARCHAR(32) NOT NULL,
  data         BYTEA       NOT NULL,
  sha256       VARCHAR(64) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- App membership + invites in one table. A row with status='invited' is
-- a pending invite (grants NO access — every check requires 'member');
-- declining deletes the row so re-invites work. The creator gets a
-- member row at creation time (and via the backfill below for existing
-- apps), so "creator is always a collaborator" holds uniformly.
-- Deliberately NOT staging:private (like app_favorites): membership must
-- survive into staging clones so a cloned platform's own access checks
-- keep working, and rows carry no secrets.
CREATE TABLE IF NOT EXISTS app_collaborators (
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      VARCHAR(16) NOT NULL DEFAULT 'member',
  invited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_collaborators_user ON app_collaborators(user_id, status);

-- Backfill: every existing app's creator becomes a member. Idempotent.
INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
  SELECT id, created_by, 'member', NOW() FROM apps WHERE created_by IS NOT NULL
ON CONFLICT (app_id, user_id) DO NOTHING;

-- Proposal approvers + invites (issue #646), a structural clone of
-- app_collaborators: one table holds both approver members
-- (status='member') and pending invites (status='invited'). A pending
-- invite grants NOTHING — the merge-gate math counts only 'member'
-- rows; declining/revoking deletes the row so re-invites work. Only
-- consulted when apps.approver_policy = 'invited'; rows are kept
-- dormant when the policy flips back to 'anyone'. Deliberately NOT
-- staging:private (like app_collaborators): the roster carries no
-- secrets and must survive into staging clones so the governed-gate
-- math stays testable there. No creator backfill — approvers are
-- opt-in (the reconcile auto-seeds the creator only at the moment an
-- app first switches to 'invited' with an empty roster).
CREATE TABLE IF NOT EXISTS app_approvers (
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      VARCHAR(16) NOT NULL DEFAULT 'member',
  invited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_approvers_user ON app_approvers(user_id, status);

-- Per-app admins (#788), authority side. A structurally slimmer
-- app_approvers: deliberately NO status/invite columns, because the
-- manifest PR IS the consent mechanism — an admins change is voted in
-- and merged before it ever reaches this table, so there is nothing
-- left to accept. Source of truth is dapp.json's top-level `admins`
-- block, reconciled on every production deploy
-- (services/app-manifest.js reconcileAppAdmins), which makes these rows
-- match the declared list exactly (an explicit empty array clears the
-- roster; an ABSENT block is a no-op). Self-hosted apps are skipped —
-- the platform repo can never mint app admins.
-- An app admin is treated as a second app creator for that ONE app
-- (see services/app-admins.js canManageApp) and may force-merge that
-- app's proposals — except ones flagged requires_explicit_approval,
-- which would be self-escalation.
-- Deliberately NOT staging:private (like app_collaborators /
-- app_approvers): the roster carries no secrets and must survive into
-- staging clones so the access checks keep behaving there.
CREATE TABLE IF NOT EXISTS app_admins (
  app_id     INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_admins_user ON app_admins(user_id);

-- Before/after visuals on UI-affecting proposals (issue #195). Each row is
-- one capture artifact produced by the one-shot usernode-capture container
-- after a staging preview comes up healthy: kind = before (production) /
-- after (staging), media = png (still) / webm (in-app <video> clip) /
-- gif (PR-body inline embed). Retention is latest-set-per-session only —
-- src/services/visuals.js deletes the session's prior rows before
-- inserting a fresh capture, so growth is bounded per session (<= 8
-- artifacts per captured path — a full-media desktop group plus a
-- PNG-only mobile group — times CAPTURE_MAX_PATHS routes).
-- The id is a random 32-hex token generated in Node: GET /visuals/:id is
-- a public (pre-auth) route so GitHub's camo proxy can fetch embeds
-- anonymously, and unguessable ids are the only privacy layer.
-- Artifacts are bytea-in-Postgres because the platform container has no
-- persistent file volume; the serving route isolates that storage choice.
CREATE TABLE IF NOT EXISTS session_visuals (
  id            VARCHAR(32) PRIMARY KEY,
  session_id    INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  commit_hash   VARCHAR(64),
  kind          VARCHAR(8)  NOT NULL,
  media         VARCHAR(8)  NOT NULL,
  content_type  VARCHAR(32) NOT NULL,
  data          BYTEA       NOT NULL,
  captured_path VARCHAR(512),
  -- #270: capture order within a session. A proposal can now point its
  -- screenshots at a short ordered list of routes; each route is a
  -- "capture group" sharing one capture_index, and the renderers emit one
  -- labelled before/after row per group. Defaults to 0 so pre-#270 rows
  -- form a single legacy group with no migration backfill needed.
  capture_index SMALLINT NOT NULL DEFAULT 0,
  -- #768: viewport label the group was shot at ('mobile' for a testing
  -- path annotated `@mobile`; NULL = the default desktop frame). Renderers
  -- suffix labelled groups with "(mobile)" so reviewers know what frame
  -- they're looking at. NULL on pre-#768 rows — desktop by definition.
  captured_viewport VARCHAR(16),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE session_visuals ADD COLUMN IF NOT EXISTS capture_index SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE session_visuals ADD COLUMN IF NOT EXISTS captured_viewport VARCHAR(16);
-- Capture-outcome columns (screenshot-reliability spec):
--   shot_status      : HTTP status the shot's navigation answered with
--                      (NULL on pre-outcome rows).
--   before_fell_back : TRUE when this "before" artifact was actually shot
--                      at '/' because the deep testing path 404'd / failed
--                      on production (the page didn't exist there yet).
--                      Renderers caption the pair so reviewers aren't
--                      confused by a mismatched comparison.
ALTER TABLE session_visuals ADD COLUMN IF NOT EXISTS shot_status SMALLINT;
ALTER TABLE session_visuals ADD COLUMN IF NOT EXISTS before_fell_back BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_session_visuals_session ON session_visuals(session_id);

-- Private like its parent chat_sessions (public-FK-to-private is the
-- combination the migration linter forbids); the artifacts also embed
-- screenshots of other users' staging previews.
COMMENT ON TABLE session_visuals IS 'staging:private';

-- Snapshot of the rendered "Before / after" PR-body block last written to
-- GitHub, mirroring pr_testing_applied: applyPrMetadata compares the fresh
-- block against this to decide whether a title-unchanged turn still needs
-- a PR body update, and src/services/visuals.js stamps it after its
-- targeted post-capture body patch so the next turn doesn't rewrite an
-- unchanged body.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_visuals_applied TEXT;

-- Plain-language, user-facing summary of a proposed change (1-3 sentences,
-- no jargon/file names/code). Generated alongside pr_title by the Haiku
-- PR-metadata call, prepended as the first paragraph of the GitHub PR body,
-- and rendered at the top of the in-app proposal view (the column is this
-- surface's single source of truth). NULL = none generated yet (legacy /
-- pre-feature proposals, or an LLM-unavailable fallback); the view simply
-- omits the summary paragraph in that case.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_summary_md TEXT;

-- App access to user LLM budgets (issue #34). One row per (app, user)
-- consent: the user explicitly allowed this app to spend from their
-- daily AI budget through the platform proxy (/api/app-llm), up to
-- daily_cap_cents per day. Revocation keeps the row (usage history,
-- easy re-grant) and just flips status; the proxy requires
-- status='active'. allow_byok extends the grant onto the user's own
-- stored Anthropic key once the platform allowance is exhausted —
-- strictly opt-in per app, still bounded by the cap.
CREATE TABLE IF NOT EXISTS app_llm_grants (
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          VARCHAR(16) NOT NULL DEFAULT 'active',
  daily_cap_cents INTEGER NOT NULL DEFAULT 100,
  allow_byok      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ,
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_llm_grants_user ON app_llm_grants(user_id);
-- Consent/financial-adjacent rows must not leak into staging clones.
-- (A private table may FK public tables; only the reverse is barred.)
COMMENT ON TABLE app_llm_grants IS 'staging:private';

-- Per-app daily spend ledger, mirroring llm_usage's split: total goes
-- against the platform daily caps, byok is the display-only bucket for
-- spend billed to the user's own key. The proxy writes BOTH this table
-- and llm_usage (via limits.recordSpend) so platform-wide caps and the
-- existing /api/budget display stay correct.
CREATE TABLE IF NOT EXISTS app_llm_usage (
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  total_cost_cents NUMERIC(10,4) NOT NULL DEFAULT 0,
  byok_cost_cents  NUMERIC(10,4) NOT NULL DEFAULT 0,
  UNIQUE(app_id, user_id, date)
);
-- Sibling of llm_usage, which is already staging:private.
COMMENT ON TABLE app_llm_usage IS 'staging:private';

-- Per-app credential identifying the calling app to the LLM proxy.
-- Random 64-hex, generated lazily at production deploy when NULL (same
-- adoption shape as db_password). Deliberately NOT a JWT: every dapp
-- container holds the shared JWT_SECRET, so a JWT-based app identity
-- would be forgeable by any other app; a random opaque token is not.
-- staging:private so the column-scrub in cloneDatabase blanks it —
-- staging containers never receive the token and therefore can't
-- spend grants (unreviewed PR code).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS llm_proxy_token TEXT;
COMMENT ON COLUMN apps.llm_proxy_token IS 'staging:private';

-- #249: meaningful default session names. session_title is the
-- display-name layer for dev sessions: set from the first interactive
-- message (Haiku), refreshed at pre-PR turn ends, mirrored from
-- pr_title once a PR exists, and derived deterministically
-- ("#N · issue title") for headless auto sessions. NULL falls back to
-- pr_title then branch_name at every display site. Branch names stay
-- machine-generated and immutable — this column never affects git.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS session_title VARCHAR(256);

-- Experimental AI progress estimate accuracy dataset (#50 follow-up).
-- Each row records one estimator tick: what the small model predicted
-- (remaining-time number + hedged phrase) and how far into the run it
-- was. When the turn ends, the actual outcome is backfilled (whole-turn
-- wall clock, per-tick ground-truth remaining, and how the turn ended)
-- so estimator accuracy can be evaluated later. Anchored on the per-turn
-- progress-log message (progress_message_id) — the codebase has no
-- first-class "turn" row, and a fresh progress message is created per
-- build turn, which uniquely identifies it. Invisible in the product for
-- now; reviewing accuracy is deferred follow-up work.
CREATE TABLE IF NOT EXISTS progress_estimates (
  id                          BIGSERIAL PRIMARY KEY,
  session_id                  INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  progress_message_id         INTEGER REFERENCES chat_session_messages(id) ON DELETE CASCADE,
  user_id                     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  model                       VARCHAR(64),
  -- Inputs at estimate time.
  elapsed_ms                  INTEGER NOT NULL,
  step_count                  INTEGER NOT NULL DEFAULT 0,
  progress_lines              INTEGER NOT NULL DEFAULT 0,
  -- Prediction.
  estimate_text               VARCHAR(120),
  predicted_remaining_seconds INTEGER,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Later-filled actuals (NULL until the turn reaches a terminal point).
  actual_total_ms             INTEGER,
  actual_remaining_ms         INTEGER,
  outcome                     VARCHAR(16),
  resolved_at                 TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_progress_estimates_message ON progress_estimates(progress_message_id);
CREATE INDEX IF NOT EXISTS idx_progress_estimates_session ON progress_estimates(session_id, created_at);
-- staging:private — forced, not a preference: this table FKs both
-- chat_sessions and chat_session_messages, which are already
-- staging:private, and the migration linter forbids a public table
-- FK-ing a private one. The rows are also per-user run-timing data with
-- no value in a staging clone, so it ships schema-only + empty there.
COMMENT ON TABLE progress_estimates IS 'staging:private';

-- #892 recalibration columns. The v1 estimator's numeric guess failed every
-- graduation bar (median error 181s vs a 90s bar, 31% within half-to-double
-- vs 60%, -110s bias vs +/-60s), but the failure was a SCALE error inherited
-- from its own prompt, not an absence of signal — within an elapsed bucket
-- its ranking correlated 0.40-0.56 with the truth. v2 feeds the measured
-- run-length distribution in as prompt INPUT (llm.js RUN_LENGTH_PRIORS) and
-- adds a display-side monotonicity guard. These columns are what make the
-- before/after judgeable and the guard auditable.
--
-- `prompt_version` is the important one: without it v1 and v2 pool into a
-- single average that hides whether the change worked. Existing rows are v1
-- by definition, hence the DEFAULT 1.
--
-- `predicted_remaining_seconds` remains the RAW model output in every path
-- (clamped, floored and suppressed alike) — the accuracy metrics score the
-- model, never the guard. `displayed_remaining_seconds` is the post-guard,
-- post-floor value the user actually saw; on v2 rows it is always positive
-- (a fixed 30s floor, so the countdown can never stick at zero). The share
-- of ticks where that floor bound is derived as
-- `displayed_remaining_seconds <= 30` rather than stored separately.
ALTER TABLE progress_estimates ADD COLUMN IF NOT EXISTS prompt_version SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE progress_estimates ADD COLUMN IF NOT EXISTS displayed_remaining_seconds INTEGER;
-- Guard telemetry. `clamped` = the guard held the previous projection
-- because an extension had no cause. `slip_reason` names the cause when one
-- WAS accepted: 'expired' (the projection ran out and the run continues),
-- 'new_phase' (a new stage marker landed), 'revision' (the model at least
-- doubled its own previous guess). NULL when no extension happened.
ALTER TABLE progress_estimates ADD COLUMN IF NOT EXISTS clamped BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE progress_estimates ADD COLUMN IF NOT EXISTS slip_reason VARCHAR(24);
-- Completion-claim suppression telemetry. `estimate_text` keeps the
-- UNMODIFIED model phrase (so the dataset still measures the model);
-- `estimate_text_shown` is what was actually rendered, and `suppressed`
-- marks the ticks where a "nearly done" claim was replaced because the run
-- had not yet reached a commit/push/done marker.
ALTER TABLE progress_estimates ADD COLUMN IF NOT EXISTS estimate_text_shown VARCHAR(120);
ALTER TABLE progress_estimates ADD COLUMN IF NOT EXISTS suppressed BOOLEAN NOT NULL DEFAULT FALSE;
-- The two new prompt inputs, recorded so a future offline analysis has them
-- without re-deriving from chat_session_messages.metadata->'progressLog'.
ALTER TABLE progress_estimates ADD COLUMN IF NOT EXISTS last_phase VARCHAR(24);
ALTER TABLE progress_estimates ADD COLUMN IF NOT EXISTS distinct_files INTEGER;
-- Outcome vocabulary: 'committed' | 'noop' | 'stopped' | 'error' set by the
-- live backfill at the turn's choke point, plus 'unknown' set by the
-- estimate-backfill sweeper for rows orphaned by a server restart mid-run
-- (services/estimate-backfill.js).

-- #297: per-user, read-only "Ask AI" advisor conversations scoped to a
-- single proposal — the "Mayor in advisor mode" surface. Each row is one
-- turn the conversation OWNER (user_id) sent or the advisor replied with,
-- keyed to either a promoted/merging/merged PR (proposal_kind='pr',
-- proposal_ref=chat_sessions.id) or a governance issue
-- (proposal_kind='gov', proposal_ref=issues.id). proposal_ref is a
-- polymorphic reference with no FK — same precedent as chat_messages
-- thread_ref (a PR session id and a governance issue id can't share one
-- FK target). The conversation is private scratch data: never posted into
-- the shared group thread, and never copied into staging clones
-- (staging:private), so a prod-cloned staging DB ships this table empty
-- and seeds its own "Staging demo …" rows. A private table may FK public
-- tables (apps, users); only the reverse is barred by the linter.
-- RETIRED by #827: the "Ask AI" advisor panel was replaced by the
-- "Explore in dev chat" flow, so nothing reads or writes this table any
-- more. The DDL stays (migrations are append-only; dropping is a separate,
-- deliberate data-retirement change) and existing rows are left in place.
CREATE TABLE IF NOT EXISTS proposal_ai_messages (
  id            SERIAL PRIMARY KEY,
  app_id        INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  proposal_kind VARCHAR(8) NOT NULL,
  proposal_ref  INTEGER NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          VARCHAR(16) NOT NULL,
  content       TEXT NOT NULL,
  model         VARCHAR(64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Per-conversation, per-user history load: WHERE app_id + kind + ref +
-- user_id, ORDER BY id. The composite index makes that an index range scan.
CREATE INDEX IF NOT EXISTS idx_proposal_ai_messages_convo
  ON proposal_ai_messages (app_id, proposal_kind, proposal_ref, user_id, id);
COMMENT ON TABLE proposal_ai_messages IS 'staging:private';

-- Admin /debug merge & conflict-resolution logs. Each merge attempt (or
-- automatic conflict-resolution attempt) is a "run"; every step inside it
-- (gate check, GitHub merge call, worker sync phase, outcome) is a child
-- row ordered by `seq`. Written fire-and-forget by services/merge-debug.js
-- and read only by the admin-gated /api/debug/* endpoints.
CREATE TABLE IF NOT EXISTS merge_debug_runs (
  id          BIGSERIAL PRIMARY KEY,
  app_id      INTEGER REFERENCES apps(id) ON DELETE SET NULL,
  session_id  INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  pr_number   INTEGER,
  -- 'merge' | 'conflict_resolution' | 'checks'
  --
  -- 'checks' reuses this tracer for the proposal-checks pipeline
  -- (services/visuals.js captureForSession) rather than a merge attempt: one
  -- run per checks run, with a step per phase (image_build, clone,
  -- staging_health, capture, tests) carrying detail.durationMs. Added because
  -- nothing persisted how long a checks run took, so a ~8x slowdown in it
  -- could only be diagnosed from a container log tail before rotation.
  kind        VARCHAR(32) NOT NULL DEFAULT 'merge',
  -- 'vote' | 'force' | 'post_merge_sweep' | 'drift' | 'behind_main' | 'merge_conflict'
  --   | 'capture' (kind='checks')
  trigger     VARCHAR(48),
  -- running | merged | blocked | conflict_resolving | conflict_failed
  --   | awaiting_github | noop | error | pr_closed
  -- A kind='checks' run instead ends on its suite's verdict — passing |
  -- failing | skipped | error — mirroring chat_sessions.check_state.
  status      VARCHAR(32) NOT NULL DEFAULT 'running',
  summary     TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_merge_debug_runs_app     ON merge_debug_runs (app_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_merge_debug_runs_session ON merge_debug_runs (session_id);
CREATE INDEX IF NOT EXISTS idx_merge_debug_runs_started ON merge_debug_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS merge_debug_steps (
  id         BIGSERIAL PRIMARY KEY,
  run_id     BIGINT NOT NULL REFERENCES merge_debug_runs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  phase      VARCHAR(48),
  -- info | warn | error
  level      VARCHAR(8) NOT NULL DEFAULT 'info',
  message    TEXT,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_merge_debug_steps_run ON merge_debug_steps (run_id, seq);

-- staging:private — these rows carry internal session ids, conflict file
-- paths, error text and resolution details that mirror private build
-- history; they're TRUNCATEd in staging clones rather than leaking into
-- previews (same policy as the events / proposal_ai_messages tables). The
-- /debug view seeds its own mock runs under IS_STAGING + ?demo=1.
COMMENT ON TABLE merge_debug_runs  IS 'staging:private';
COMMENT ON TABLE merge_debug_steps IS 'staging:private';

-- #460: per-user global agent instruction & skill files. Uploaded in the
-- account Settings modal ("Agent instructions & skills") and materialized
-- into the per-session CC volume (~/.claude/CLAUDE.md + ~/.claude/skills/)
-- at every build/scout dispatch the user owns — see
-- services/user-agent-files.js + worker.syncUserAgentFiles. Contents are
-- plain user-authored text (NOT secrets — no encryption), but they are
-- personal scratch config with no value in a staging clone, so the table
-- ships schema-only + empty there (staging:private); the Settings section
-- uses ?demo=1 fabricated rows for staging previews instead.
CREATE TABLE IF NOT EXISTS user_agent_files (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'instruction' | 'skill'
  kind        VARCHAR(16) NOT NULL CHECK (kind IN ('instruction', 'skill')),
  -- normalized slug: ^[a-z0-9][a-z0-9-]{0,63}$
  name        VARCHAR(64) NOT NULL,
  description VARCHAR(200) NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, kind, name)
);
CREATE INDEX IF NOT EXISTS idx_user_agent_files_user ON user_agent_files (user_id, kind, name);
COMMENT ON TABLE user_agent_files IS 'staging:private';

-- Dev-chat file attachments (#450). Users attach files to dev-chat
-- messages as extra context for the Mayor, scout, and coding agent.
-- Bytea-in-Postgres like session_visuals (the platform container
-- has no persistent file volume); ids are random 32-hex tokens generated
-- in Node. message_id is NULL between upload and send — the chat handler
-- links it when the message posts, and server.js's session sweeper GCs
-- orphans older than 24h. Retention otherwise follows the parent session
-- (ON DELETE CASCADE), bounded by a 50 MB per-session cap at upload time.
CREATE TABLE IF NOT EXISTS chat_session_attachments (
  id           VARCHAR(32) PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  message_id   INTEGER REFERENCES chat_session_messages(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- 'image' (png/jpeg/gif/webp, magic-byte verified) | 'text' (UTF-8,
  -- inlined into prompts) | 'zip' (central-directory-validated archive)
  -- | 'binary' (opaque pass-through for the coding agent)
  kind         VARCHAR(8)   NOT NULL,
  filename     VARCHAR(256) NOT NULL,
  content_type VARCHAR(64)  NOT NULL,
  size_bytes   INTEGER      NOT NULL,
  -- Kind-specific metadata captured at upload; for 'zip' the manifest
  -- { entryCount, uncompressedBytes, topLevel } from validateZip.
  meta         JSONB,
  data         BYTEA        NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
ALTER TABLE chat_session_attachments ADD COLUMN IF NOT EXISTS meta JSONB;
CREATE INDEX IF NOT EXISTS idx_chat_session_attachments_session ON chat_session_attachments(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_session_attachments_message ON chat_session_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_session_attachments_orphan
  ON chat_session_attachments(created_at) WHERE message_id IS NULL;

-- Private like its parent chat_sessions (public-FK-to-private is the
-- combination the migration linter forbids), and the bytes are private
-- chat content in their own right — screenshots and files a user shared
-- with their own dev session only. Schema-only in staging clones;
-- migrate.js seeds a demo fixture so the UI is exercisable there.
COMMENT ON TABLE chat_session_attachments IS 'staging:private';

-- Saved dev-chat drafts (#940). The composer's save icon parks typed text
-- as a DRAFT while a turn runs (#798, #810); until this table existed those
-- drafts lived only in the localStorage of the browser that typed them, so
-- a thought parked on a laptop was invisible on a phone and clearing site
-- data lost it silently. Now they belong to the ACCOUNT: the client keeps
-- localStorage as an instant-paint mirror + offline buffer and reconciles
-- against these rows on every session open.
--
-- draft_id is CLIENT-generated (DevChat._newDraftId, `d<base36><rand>`) and
-- validated against ^[A-Za-z0-9_-]{1,32}$ in the route. That is what makes
-- an upload idempotent (ON CONFLICT DO NOTHING) and lets two devices
-- recognise the same draft without a round trip; it is only ever a bound
-- parameter, never interpolated, and is always paired with session_id in
-- the primary key.
--
-- saved_at is the ordering key ("newest last", matching the render order),
-- with draft_id as the tiebreak because two devices can stamp the same
-- second. A client-supplied saved_at is clamped to [NOW() - 30 days, NOW()]
-- in the route so a device with a wrong clock can't pin a draft to the top
-- or to the far future.
--
-- Retention follows the parent session (ON DELETE CASCADE), bounded by a
-- 20-drafts-per-session cap enforced at insert time.
CREATE TABLE IF NOT EXISTS chat_session_drafts (
  session_id INTEGER     NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  -- Always the session owner. Stored so the ownership check and any
  -- per-user query is a single predicate on this table.
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_id   VARCHAR(32) NOT NULL,
  content    TEXT        NOT NULL CHECK (length(content) BETWEEN 1 AND 10000),
  saved_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, draft_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_session_drafts_session
  ON chat_session_drafts(session_id, saved_at, draft_id);
CREATE INDEX IF NOT EXISTS idx_chat_session_drafts_user
  ON chat_session_drafts(user_id);

-- Private like its parent chat_sessions — forced, not a preference: this
-- table FKs chat_sessions (public-FK-to-private is the combination the
-- clone's FK-closure discovery forbids), and the rows are unsent private
-- chat content in their own right. Schema-only in staging clones;
-- migrate.js seeds a demo fixture (session 990402) so the DB-backed path
-- is exercisable there.
COMMENT ON TABLE chat_session_drafts IS 'staging:private';

-- Fallback-title marker for the title auto-heal sweeper (services/
-- title-heal.js). TRUE when the PR's title came from the LLM-unavailable
-- fallback template ("<user>'s changes") — e.g. Anthropic credits ran out
-- or the API errored — instead of the generated one. The sweeper retries
-- generation while this is set and clears it on success; the vote panel
-- renders an "Auto-title pending" chip off the same flag so voters know
-- the placeholder isn't the real description of the change.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_title_fallback BOOLEAN NOT NULL DEFAULT FALSE;

-- Feedback issues filed with the fallback title ("Feedback from Usernode")
-- because the Haiku title call failed (routes/feedback.js). The issue is
-- filed immediately regardless — never block feedback on LLM availability —
-- and a row lands here so the title-heal sweeper can regenerate the title
-- from the stored description and PATCH the GitHub issue later. Rows are
-- deleted on success or abandoned after MAX_ATTEMPTS (title-heal.js);
-- next_attempt_at implements per-row exponential backoff.
CREATE TABLE IF NOT EXISTS title_heal_queue (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  owner           TEXT NOT NULL,
  repo            TEXT NOT NULL,
  issue_number    INTEGER NOT NULL,
  description     TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner, repo, issue_number)
);
ALTER TABLE title_heal_queue
  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_title_heal_queue_due ON title_heal_queue(next_attempt_at);

-- #683: drag-selected screenshots attached to filed GitHub issues from
-- the feedback modal. Bytea-in-Postgres like session_visuals (the
-- platform container has no persistent file volume); rows are served on
-- the public pre-auth GET /issue-images/:id route, so the unguessable
-- 32-hex id is the only privacy layer — same stance as visuals, and the
-- user explicitly published the image into a GitHub issue body.
-- issue_owner/repo/number are stamped when the issue is filed; rows
-- never linked (upload abandoned / modal cancelled) are GC'd by the
-- server.js orphan sweeper after 24h.
CREATE TABLE IF NOT EXISTS issue_screenshots (
  id            VARCHAR(32) PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type  VARCHAR(32) NOT NULL,
  size_bytes    INTEGER NOT NULL,
  data          BYTEA NOT NULL,
  issue_owner   TEXT,
  issue_repo    TEXT,
  issue_number  INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_issue_screenshots_orphan
  ON issue_screenshots(created_at) WHERE issue_number IS NULL;
-- Private: the bytea can contain anything visible on the reporter's
-- screen; staging gets the schema only.
COMMENT ON TABLE issue_screenshots IS 'staging:private';

-- Group-chat file attachments (#694). Users attach files to group-chat
-- messages (images, markdown, standalone HTML, anything else as a
-- download). Same bytea-in-Postgres shape as chat_session_attachments
-- (#450): ids are random 32-hex tokens generated in Node; message_id is
-- NULL between upload and send — the WS 'chat' handler links it when the
-- message posts, and server.js's sweeper GCs orphans older than 24h.
-- Retention otherwise follows the parent message (ON DELETE CASCADE),
-- bounded by a 200 MB per-app cap at upload time.
CREATE TABLE IF NOT EXISTS chat_message_attachments (
  id           VARCHAR(32) PRIMARY KEY,
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  message_id   INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- 'image' (png/jpeg/gif/webp, magic-byte verified) | 'markdown'
  -- (.md/.markdown UTF-8, rendered in the chat's side panel) | 'html'
  -- (.html/.htm UTF-8, previewable only via the sandboxed /view route)
  -- | 'text' (other UTF-8, download-only) | 'binary' (opaque download)
  kind         VARCHAR(8)   NOT NULL,
  filename     VARCHAR(256) NOT NULL,
  content_type VARCHAR(64)  NOT NULL,
  size_bytes   INTEGER      NOT NULL,
  meta         JSONB,
  data         BYTEA        NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_message_attachments_app ON chat_message_attachments(app_id);
CREATE INDEX IF NOT EXISTS idx_chat_message_attachments_message ON chat_message_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_message_attachments_orphan
  ON chat_message_attachments(created_at) WHERE message_id IS NULL;

-- staging:private: chat_messages itself is staging-copied (group chat is
-- shared content), but copying every app's attachment BLOBS into every
-- staging clone would balloon clone size for no testing value — the
-- migrate.js fixture seeds a demo message with attachments instead.
-- Private-FK-to-public is the allowed direction for the migration linter
-- (the forbidden combination is a public table FK'ing a private one).
COMMENT ON TABLE chat_message_attachments IS 'staging:private';

-- App file storage (#752): user-uploaded images apps store through the
-- platform (usernode.uploadFile() / POST /api/app-storage/files). This
-- table holds METADATA ONLY — the bytes live in the MinIO object-store
-- sidecar under key `app/<app_id>/<id>` (see services/app-files.js), so
-- the platform DB, its pg_dump backups, and self-app staging clones
-- never carry image payloads. Ids are random 16-byte hex, served on the
-- public pre-auth GET /app-files/:id route — the unguessable id is the
-- access control for visibility='public' rows (same stance as
-- app_icons); visibility='private' rows additionally require a valid
-- platform user JWT at serve time. `staging` marks uploads made from a
-- staging preview (bridge relay path); the server.js sweeper GCs those
-- after 7 days. Quota sums (per app / per app+user) read size_bytes.
CREATE TABLE IF NOT EXISTS app_files (
  id           VARCHAR(32) PRIMARY KEY,
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  filename     VARCHAR(256) NOT NULL,
  content_type VARCHAR(64)  NOT NULL,
  size_bytes   INTEGER      NOT NULL,
  visibility   VARCHAR(7)   NOT NULL DEFAULT 'public',
  staging      BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_files_app ON app_files(app_id);
CREATE INDEX IF NOT EXISTS idx_app_files_app_user ON app_files(app_id, user_id);
CREATE INDEX IF NOT EXISTS idx_app_files_staging
  ON app_files(created_at) WHERE staging = TRUE;
-- Private: upload ownership is user content a staging clone has no
-- business seeing (same stance as issue_screenshots). Rows are metadata
-- only, so this is about privacy, not clone size. Private-FK-to-public
-- is the allowed linter direction.
COMMENT ON TABLE app_files IS 'staging:private';

-- Per-app credential for the app-storage API (#752), the exact
-- llm_proxy_token pattern: random 64-hex generated lazily at first
-- production deploy (services/app-storage-env.js), injected as
-- USERNODE_STORAGE_TOKEN into production containers only. Staging
-- deploys never receive it. Credential-bearing: tagged staging:private
-- AND listed in debug-access.js's DENIED_COLUMNS (the
-- prod-debug-access test cross-checks the two).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS storage_api_token VARCHAR(64);
COMMENT ON COLUMN apps.storage_api_token IS 'staging:private';

-- ── Database-export audit log ────────────────────────────────────────
--
-- Append-only record of every attempt to download a full pg_dump of this
-- platform database from the admin console (/api/admin/db-export, see
-- src/services/db-export.js). Written BEFORE the dump is spawned, so an
-- export killed mid-stream — a deploy cutover, a crash — still leaves a
-- record; a boot sweep in migrate.js flips any row left `requested` /
-- `streaming` by a dead process to `interrupted`.
--
-- Nothing in the product ever UPDATEs a terminal row or DELETEs from this
-- table, and no admin UI exposes a way to clear it. That is the point:
-- the export hands out every credential in the platform, so the fact that
-- it happened must not be erasable from inside the app.
--
--   status        requested | streaming | completed | failed
--                 | cancelled | interrupted | denied
--   denied_reason bad_password | rate_limited | staging | view_only
--                 | in_progress | unavailable   (NULL unless denied)
--
-- user_id is ON DELETE SET NULL (mirroring `events`) so deleting a user
-- can never erase the history of what they exported; `username` is a
-- snapshot kept for exactly that case.
CREATE TABLE IF NOT EXISTS db_exports (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username      VARCHAR(255) NOT NULL,
  db_name       VARCHAR(255) NOT NULL,
  status        VARCHAR(32)  NOT NULL,
  denied_reason VARCHAR(64),
  ip            VARCHAR(64),
  user_agent    TEXT,
  bytes_sent    BIGINT       NOT NULL DEFAULT 0,
  requested_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_db_exports_requested ON db_exports (requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_db_exports_user ON db_exports (user_id, requested_at DESC);

-- Private for the same reason `events` is: an activity log carrying admin
-- usernames, source IPs and user agents that a staging preview has no
-- business carrying. NOT added to debug-access.js's DENIED_TABLES, and
-- that asymmetry is intentional — the deny lists exist for CREDENTIAL-
-- bearing data, and this table holds none (it records that an export
-- happened, never any exported content). A prod-debug session should be
-- able to read the export log; that's an audit trail, not a secret.
COMMENT ON TABLE db_exports IS 'staging:private';

-- ── Platform environment variables ───────────────────────────────────
--
-- In-platform management of the *platform's own* env vars — the ones
-- .github/workflows/deploy.yml writes into /opt/usernode/.env. Before
-- this, adding a tunable meant editing deploy.yml (a guardrailed file)
-- and adding a GitHub repo variable by hand, out of band from the
-- proposal that needed it, so a merged proposal could deploy straight
-- into a crash-loop on a variable nobody had set.
--
-- THE SURFACE is the platform app's own secrets panel, labelled "Platform
-- variables" (the "+" menu on its dev tab) — served by the self-hosted
-- branch of /api/apps/:slug/secrets* in routes/apps.js, with the vote path
-- riding kind='secret_change' like any other app's secrets. There is no
-- separate admin-console section: it existed briefly and was folded in,
-- because two screens describing one process's environment is how you get
-- an inert list of credentials with buttons that don't work.
--
-- Two tables, deliberately separate:
--
--   platform_env_declarations — a CACHE of the `platform_env` block in
--     the platform repo's committed dapp.json, refreshed on every boot
--     by app-manifest.reconcilePlatformEnv() from seedSelfApp(). The
--     manifest is the source of truth; this table exists so the panel
--     and the pre-merge check can query declarations in SQL instead of
--     re-reading the working tree, and so a value with no declaration
--     ("orphan") is detectable. NOT staging:private: it is a verbatim
--     copy of a public committed file.
--
--   platform_env_values — the SET VALUES (by an admin directly, or by an
--     applied secret_change vote), AES-256-GCM encrypted at rest by
--     services/secrets.js exactly as app_secrets is (same `v1:iv:tag:ct`
--     format, same JWT_SECRET-derived key). Resolved at deploy time,
--     never read by the running platform process — see the "Resolve
--     platform env" step in deploy.yml. Both write paths go through
--     services/platform-env.js so the unwritable-key and
--     private-from-declaration rules hold for either.
--
-- The value table is credential-bearing: tagged staging:private (so a
-- staging clone starts empty and the IS_STAGING seed fills it with
-- obvious fixtures) AND listed in debug-access.js's DENIED_TABLES, the
-- same treatment app_secrets gets.
--
-- A declaration is never required for a value to exist and vice versa:
-- removing a variable from dapp.json drops the declaration but KEEPS the
-- value, because the merge that removes it and the deploy that stops
-- using it are separate events and a rollback needs the value intact.
--
-- `unwritable` is derived by the manifest reader from
-- app-manifest.PLATFORM_ENV_UNWRITABLE, not declared: it marks a
-- variable that may be documented here but whose value comes straight
-- from a GitHub secret at deploy time and can never be written through
-- the admin UI (JWT_SECRET, DATABASE_URL, the GitHub App credentials…).
CREATE TABLE IF NOT EXISTS platform_env_declarations (
  app_id        INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key           VARCHAR(128) NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  required      BOOLEAN NOT NULL DEFAULT FALSE,
  private       BOOLEAN NOT NULL DEFAULT FALSE,
  grouping      VARCHAR(64) NOT NULL DEFAULT 'General',
  default_value TEXT,
  unwritable    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, key)
);

CREATE TABLE IF NOT EXISTS platform_env_values (
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key         VARCHAR(128) NOT NULL,
  value_enc   TEXT NOT NULL,
  value_last4 VARCHAR(8),
  private     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (app_id, key)
);
COMMENT ON TABLE platform_env_values IS 'staging:private';

-- Display-only mirror of the platform-env pre-merge check for a proposal
-- (see src/services/platform-env-check.js). Deliberately NOT folded into
-- chat_sessions.check_state: that column is owned by the staging-capture
-- pipeline and rewritten wholesale on every storeChecks() run, which
-- would clobber a verdict computed from a different input (the diff
-- against main, not a browser run). These columns feed the Checks card;
-- the merge gate in routes/votes.js re-evaluates LIVE rather than
-- trusting them, so a variable set between the last check run and the
-- final vote unblocks the merge without a re-check.
--
--   platform_env_state  : 'passing' | 'failing' | 'skipped' | 'error'
--                         (NULL until the first evaluation)
--   platform_env_detail : { missing:[{key,required,description}],
--                           added:[key], removed:[key], reason }
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS platform_env_state TEXT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS platform_env_detail JSONB;

-- ══════════════════════════════════════════════════════════════════
-- Declaring a BRAND-NEW secret / platform variable from the panel.
--
-- The App secrets panel can set values for keys `dapp.json` already
-- declares. Adding a key needs TWO things to land: the manifest
-- DECLARATION (only ever changeable by a merged PR — see
-- services/rename-pr.js, the single writer of dapp.json) and the
-- VALUE (app_secrets / platform_env_values). This table is where the
-- value waits while its declaration PR is up for vote, so ONE
-- proposal carries both halves.
--
-- One row per proposed key, bound to the declaration PR's
-- chat_sessions row:
--   status='pending'   the PR is open; the value (if any) is held here
--   status='applied'   the PR merged and the value was written to the
--                      real store by routes/votes.js finalizeMerge()
--   status='discarded' the PR was withdrawn / voted down
--
-- `value_enc` is NULL in two legitimate cases: no value was supplied
-- (a declaration-only proposal, e.g. one that only documents a
-- default), or the proposer was a full admin, who is already allowed
-- to write values directly — those go straight to the real store and
-- the row records `value_applied_at` so the panel can say
-- "value set, declaration up for vote".
--
-- Credential-bearing exactly like app_secrets: staging:private (a
-- clone starts empty; the IS_STAGING seed fills it with obvious
-- fixtures) AND in debug-access.js's DENIED_TABLES.
CREATE TABLE IF NOT EXISTS pending_secret_declarations (
  id              SERIAL PRIMARY KEY,
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id      INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL,
  key             VARCHAR(128) NOT NULL,
  declaration     JSONB NOT NULL,
  value_enc       TEXT,
  value_last4     VARCHAR(8),
  value_applied_at TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE pending_secret_declarations IS 'staging:private';
-- One live proposal per key per app. Partial index rather than a plain
-- UNIQUE so the applied/discarded history can hold many rows for the
-- same key (a variable declared, removed, and declared again).
CREATE UNIQUE INDEX IF NOT EXISTS pending_secret_decl_live_key
  ON pending_secret_declarations (app_id, key) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS pending_secret_decl_session
  ON pending_secret_declarations (session_id);

-- ══════════════════════════════════════════════════════════════════
-- Topochain (testnet competition) — SPEC §3.4 schema
--
-- Topochain becomes a native part of this platform: a testnet
-- competition organized as Season → Event → Challenge.
--   Season          the top-level competition period (`seasons`).
--   Season Event    a phase within a season (`season_events` — named
--                   with the full word "season_event" everywhere,
--                   never "event", because the platform already owns
--                   an unrelated analytics table called `events`).
--   Challenge       a task instance scoped to one season_event,
--                   itself an instantiation of a reusable
--                   `challenge_templates` row (`challenges`).
-- Users earn points by completing challenges and producing blocks;
-- `user_activities` is the append-only ledger of both, scored into
-- periodic `leaderboard_snapshots`.
--
-- Source: topochain's own Postgres database, migrated table-for-table
-- per docs/migration/usernode-migration.md §3.4 (line-referenced
-- below as "SPEC"). SPEC wins over convenience for every exact type,
-- default, and index. `users.id` here is the platform's SERIAL/
-- INTEGER primary key; every FK column below is BIGINT as specced —
-- Postgres allows a bigint column to reference an integer primary key
-- (int4/int8 share a btree operator family), so no type downgrade is
-- needed to keep the FK real.
--
-- Every CREATE is IF NOT EXISTS / guarded so this whole file can run
-- as one boot-time multi-statement query, every boot, forever.
-- ══════════════════════════════════════════════════════════════════

-- `seasons` — the top level of Season → Event → Challenge. One row
-- per competition period (e.g. "Season 1"). `pool_info` is a free-text
-- description of the token pool being distributed; `internal` flags a
-- season not meant for public display (staff dry-runs).
CREATE TABLE IF NOT EXISTS seasons (
  id             BIGSERIAL PRIMARY KEY,
  name           VARCHAR(255) NOT NULL,
  description    TEXT,
  starts_at      TIMESTAMPTZ NOT NULL,
  ends_at        TIMESTAMPTZ NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  internal       BOOLEAN NOT NULL DEFAULT FALSE,
  display_order  INTEGER NOT NULL DEFAULT 0,
  pool_info      VARCHAR(255),
  created_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_seasons_display_order ON seasons (display_order);
CREATE INDEX IF NOT EXISTS idx_seasons_is_active ON seasons (is_active);
CREATE INDEX IF NOT EXISTS idx_seasons_starts_ends ON seasons (starts_at, ends_at);

-- `season_events` — the Event level of Season → Event → Challenge, one
-- phase of a season. Named `season_events` (not `events`) because the
-- platform already has an unrelated `events` analytics table; every FK
-- to this table is named `season_event_id` in full, never `event_id`.
-- `account_source_season_event_id` is a self-referential FK used for
-- account inheritance between events (`account_inheritance_mode`
-- governs whether/how onchain_accounts carry over from a prior event).
-- `chain_id` deliberately stays TEXT with no FK — it is a free-form
-- match against `chains.chain_id` values, which are not unique per row
-- there either (chains is an append-only block log).
CREATE TABLE IF NOT EXISTS season_events (
  id                                BIGSERIAL PRIMARY KEY,
  name                              VARCHAR(255) NOT NULL,
  description                       TEXT,
  starts_at                         TIMESTAMPTZ NOT NULL,
  ends_at                           TIMESTAMPTZ NOT NULL,
  is_active                         BOOLEAN NOT NULL DEFAULT TRUE,
  scoring_formula                   JSONB NOT NULL,
  created_at                        TIMESTAMPTZ,
  updated_at                        TIMESTAMPTZ,
  start_epoch                       BIGINT,
  end_epoch                         BIGINT,
  internal                          BOOLEAN NOT NULL DEFAULT FALSE,
  disclaimer                        TEXT,
  display_leaderboard               BOOLEAN NOT NULL DEFAULT TRUE,
  score_start_time                  TIMESTAMPTZ,
  score_end_time                    TIMESTAMPTZ,
  display_disclaimer                BOOLEAN NOT NULL DEFAULT FALSE,
  chain_id                          TEXT,
  rank_based_on_bp_or_success_rate  VARCHAR(255) NOT NULL DEFAULT 'BP',
  display_activities                BOOLEAN NOT NULL DEFAULT FALSE,
  season_id                         BIGINT REFERENCES seasons(id) ON DELETE CASCADE,
  type                              VARCHAR(20) NOT NULL DEFAULT 'regular',
  account_inheritance_mode          VARCHAR(32) NOT NULL DEFAULT 'none',
  account_source_season_event_id    BIGINT REFERENCES season_events(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_season_events_epoch_range ON season_events (start_epoch, end_epoch);
CREATE INDEX IF NOT EXISTS idx_season_events_display_activities ON season_events (display_activities);
CREATE INDEX IF NOT EXISTS idx_season_events_is_active ON season_events (is_active);
CREATE INDEX IF NOT EXISTS idx_season_events_starts_ends ON season_events (starts_at, ends_at);

-- `user_enrollments` — a user enrolled either in an entire season
-- (`season_event_id` NULL) or in one specific event (`season_event_id`
-- set). `season_id` is always set (denormalized from the event when
-- event-scoped) so "everyone in season X" is a single-column filter.
-- Invariant (app/ETL-enforced, no cross-table CHECK): when
-- season_event_id is set, season_id must equal that event's season_id.
-- Two partial uniques — rather than one composite — let season-wide
-- and per-event enrollments coexist without NULL-uniqueness surprises.
CREATE TABLE IF NOT EXISTS user_enrollments (
  id               BIGSERIAL PRIMARY KEY,
  season_event_id  BIGINT REFERENCES season_events(id) ON DELETE CASCADE,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season_id        BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  registered_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at       TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS user_enrollments_user_season_event_unique
  ON user_enrollments (user_id, season_event_id) WHERE season_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS user_enrollments_user_season_unique
  ON user_enrollments (user_id, season_id) WHERE season_event_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_enrollments_season ON user_enrollments (season_id);
CREATE INDEX IF NOT EXISTS idx_user_enrollments_season_event ON user_enrollments (season_event_id);
CREATE INDEX IF NOT EXISTS idx_user_enrollments_user ON user_enrollments (user_id);

-- `challenge_kinds` — the taxonomy scanners key off (a flat slug list,
-- not hierarchical — the sibling `category` column on templates stays
-- free text with no table behind it). PK is a VARCHAR(100) slug such
-- as REPORT_BUG_CHALLENGE / SEND_TX_CHALLENGE.
CREATE TABLE IF NOT EXISTS challenge_kinds (
  id           VARCHAR(100) PRIMARY KEY,
  name         VARCHAR(255) NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ
);

-- `challenge_templates` — a reusable challenge definition; one or more
-- `challenges` rows instantiate it per event (referenced there as
-- `challenge_template_id`). `kind` carries a real FK to
-- `challenge_kinds(id)` (the source only validated this in app code).
CREATE TABLE IF NOT EXISTS challenge_templates (
  id                BIGSERIAL PRIMARY KEY,
  category          VARCHAR(50) NOT NULL,
  goal              VARCHAR(255) NOT NULL,
  task              TEXT NOT NULL,
  reward            VARCHAR(255) NOT NULL,
  description       TEXT,
  requirements      TEXT,
  schedule_start    TIMESTAMPTZ,
  schedule_end      TIMESTAMPTZ,
  reward_logic      TEXT,
  cta_button        VARCHAR(255),
  cta_label         VARCHAR(255),
  cta_link          TEXT,
  created_at        TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ,
  kind              VARCHAR(100) REFERENCES challenge_kinds(id) ON DELETE SET NULL,
  cta_type          VARCHAR(10),
  mobile_cta_type   VARCHAR(10),
  mobile_cta_label  VARCHAR(255),
  mobile_cta_link   TEXT,
  metric_type       VARCHAR(30),
  metric_target     NUMERIC(20,4),
  metric_label      VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS idx_challenge_templates_category ON challenge_templates (category);

-- `challenges` — the Challenge level of Season → Event → Challenge: an
-- instance of a `challenge_templates` row scoped to one season_event,
-- overriding whatever fields it needs. Challenge completions are NOT a
-- separate table (the source's completion tables are excluded) — every
-- completion is a `user_activities` row instead (see the two replay-
-- protection indexes on that table below).
-- `challenge_template_id` deliberately has NO ON DELETE action (defaults
-- to NO ACTION/RESTRICT): SPEC §D4 calls the source's cascading template
-- delete "destructive with no guard" (it silently wipes every challenge
-- using the type, and transitively their scored user_activities history)
-- and says v4 must REFUSE deletion while challenges still reference the
-- template. Unlike season_events → challenges (a real CASCADE further
-- up this table), this FK is the database backstop for that refusal —
-- the admin API's own guard (a later task) is the primary UX, but a
-- direct DB delete must still fail closed, not cascade.
CREATE TABLE IF NOT EXISTS challenges (
  id                     BIGSERIAL PRIMARY KEY,
  season_event_id        BIGINT NOT NULL REFERENCES season_events(id) ON DELETE CASCADE,
  challenge_template_id  BIGINT NOT NULL REFERENCES challenge_templates(id),
  goal                   VARCHAR(255),
  task                   TEXT,
  reward                 VARCHAR(255),
  description            TEXT,
  requirements           TEXT,
  schedule_start         TIMESTAMPTZ,
  schedule_end           TIMESTAMPTZ,
  reward_logic           TEXT,
  cta_button             VARCHAR(255),
  cta_label              VARCHAR(255),
  cta_link               TEXT,
  created_at             TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ,
  enabled                BOOLEAN NOT NULL DEFAULT TRUE,
  display_order          INTEGER NOT NULL DEFAULT 0,
  completed              BOOLEAN NOT NULL DEFAULT FALSE,
  kind                   VARCHAR(100) REFERENCES challenge_kinds(id) ON DELETE SET NULL,
  cta_type               VARCHAR(10),
  mobile_cta_type        VARCHAR(10),
  mobile_cta_label       VARCHAR(255),
  mobile_cta_link        TEXT,
  metric_type            VARCHAR(30),
  metric_target          NUMERIC(20,4),
  metric_label           VARCHAR(255),
  featured               BOOLEAN NOT NULL DEFAULT FALSE,
  featured_order         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_challenges_completed ON challenges (completed);
CREATE INDEX IF NOT EXISTS idx_challenges_display_order ON challenges (display_order);
CREATE INDEX IF NOT EXISTS idx_challenges_enabled ON challenges (enabled);
CREATE INDEX IF NOT EXISTS idx_challenges_featured ON challenges (featured);
CREATE INDEX IF NOT EXISTS idx_challenges_challenge_template ON challenges (challenge_template_id);
CREATE INDEX IF NOT EXISTS idx_challenges_season_event ON challenges (season_event_id);
CREATE INDEX IF NOT EXISTS idx_challenges_season_event_display_order ON challenges (season_event_id, display_order);

-- `user_activities` — the append-only points ledger: one row per
-- completed challenge OR per block-production credit. `added_by` is a
-- soft reference to a source admin user (admins are not migrated, so
-- it carries no FK and is simply left NULL for migrated rows).
-- `source` keeps the original enum verbatim ('admin_ui', scanner/agent
-- values); agent rows remain valid history even though agent tables
-- are excluded from this migration.
CREATE TABLE IF NOT EXISTS user_activities (
  id               BIGSERIAL PRIMARY KEY,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season_event_id  BIGINT NOT NULL REFERENCES season_events(id) ON DELETE CASCADE,
  activity_type    VARCHAR(100) NOT NULL,
  points           NUMERIC(10,2) NOT NULL DEFAULT 0,
  description      TEXT,
  metadata         JSONB,
  activity_at      TIMESTAMPTZ NOT NULL,
  added_by         BIGINT,
  source           VARCHAR(255) NOT NULL DEFAULT 'admin_ui',
  created_at       TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ,
  challenge_id     BIGINT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_activities_activity_type ON user_activities (activity_type);
CREATE INDEX IF NOT EXISTS idx_user_activities_user_season_event ON user_activities (user_id, season_event_id);

-- Anti-replay after dropping the source's completion tables (SPEC
-- §4.10): the source enforced "one completion per (user, challenge)"
-- and "one claim per (challenge, zkPassport nullifier)" at the
-- database level via those tables; recording completions as
-- `user_activities` rows keeps the points but drops the constraints
-- unless restored here. Restored as partial unique indexes over
-- expression values pulled from `metadata`, verbatim per spec.
CREATE UNIQUE INDEX IF NOT EXISTS user_activities_completion_unique
  ON user_activities (user_id, challenge_id)
  WHERE metadata->>'kind' = 'challenge_completion';

CREATE UNIQUE INDEX IF NOT EXISTS user_activities_nullifier_unique
  ON user_activities (challenge_id, (metadata->>'nullifier_hex'))
  WHERE metadata->>'nullifier_hex' IS NOT NULL;

-- `onchain_accounts` — a testnet account (address + keys) granted to a
-- user, scoped to a season or to a single event, mirroring
-- `user_enrollments`: `season_id` is always set, `season_event_id` is
-- nullable, and a NULL event means the account is granted for the
-- whole season. Invariant (app/ETL-enforced): when season_event_id is
-- set, season_id must equal that event's season_id. Two partial
-- uniques keep season-scoped and event-scoped accounts from colliding
-- on the same public key. `secret_key` is a real testnet credential —
-- handled like `apps.db_password` elsewhere in this schema: scrubbed
-- in staging and denied from prod-debug access (wired in Task 2).
-- `address` (ut1…) is the participant-facing account; `public_key`
-- (utpk1… hash source) is the VRF-side key.
CREATE TABLE IF NOT EXISTS onchain_accounts (
  id                 BIGSERIAL PRIMARY KEY,
  amount             BIGINT NOT NULL,
  identity_uid       VARCHAR(64) NOT NULL,
  address            VARCHAR(100) NOT NULL,
  public_key         VARCHAR(64) NOT NULL,
  secret_key         VARCHAR(64) NOT NULL,
  tier               VARCHAR(50) NOT NULL,
  description        TEXT,
  registration_code  VARCHAR(64) NOT NULL UNIQUE,
  season_event_id    BIGINT REFERENCES season_events(id) ON DELETE CASCADE,
  season_id          BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  user_id            BIGINT REFERENCES users(id) ON DELETE SET NULL,
  is_used            BOOLEAN NOT NULL DEFAULT FALSE,
  used_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS onchain_accounts_season_event_public_key_unique
  ON onchain_accounts (season_event_id, public_key) WHERE season_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS onchain_accounts_season_public_key_unique
  ON onchain_accounts (season_id, public_key) WHERE season_event_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_onchain_accounts_user ON onchain_accounts (user_id);
CREATE INDEX IF NOT EXISTS idx_onchain_accounts_season ON onchain_accounts (season_id);
CREATE INDEX IF NOT EXISTS idx_onchain_accounts_season_event_address ON onchain_accounts (season_event_id, address);
CREATE INDEX IF NOT EXISTS idx_onchain_accounts_address ON onchain_accounts (address);
CREATE INDEX IF NOT EXISTS idx_onchain_accounts_identity_uid ON onchain_accounts (identity_uid);
CREATE INDEX IF NOT EXISTS idx_onchain_accounts_public_key ON onchain_accounts (public_key);
CREATE INDEX IF NOT EXISTS idx_onchain_accounts_user_season_event_used ON onchain_accounts (user_id, season_event_id, is_used);
CREATE INDEX IF NOT EXISTS idx_onchain_accounts_season_event_used ON onchain_accounts (season_event_id, is_used);

-- `account_delegation_periods` — when a testnet account (`account`, a
-- ut1… address matching `onchain_accounts.address`) had its stake
-- delegated. Deliberately no FK: delegations can reference accounts
-- from any event/season, and the source table wasn't scoped that way.
CREATE TABLE IF NOT EXISTS account_delegation_periods (
  id          BIGSERIAL PRIMARY KEY,
  account     VARCHAR(255) NOT NULL UNIQUE,
  started_at  TIMESTAMPTZ NOT NULL,
  ended_at    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_account_delegation_periods_account_ended ON account_delegation_periods (account, ended_at);

-- `leaderboard_snapshots` — point-in-time leaderboard rows, one per
-- (season_event, user, snapshot_at). With the source's
-- `global_leaderboard` table excluded from this migration, this is
-- the ONLY persisted leaderboard; any all-time/global view is derived
-- from it at query time (see the standings service, Task 5).
-- `extra_points` holds points awarded outside block production (the
-- source called this `offchain_points`; API payloads use the new
-- name). `challenge_details` was already JSONB in the source.
CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id                                       BIGSERIAL PRIMARY KEY,
  season_event_id                          BIGINT NOT NULL REFERENCES season_events(id) ON DELETE CASCADE,
  user_id                                  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rank                                     INTEGER NOT NULL,
  total_points                             NUMERIC(15,2) NOT NULL DEFAULT 0,
  extra_points                             NUMERIC(15,2) NOT NULL DEFAULT 0,
  snapshot_at                              TIMESTAMPTZ NOT NULL,
  created_at                               TIMESTAMPTZ,
  updated_at                               TIMESTAMPTZ,
  last_epoch_total_produced_blocks         BIGINT NOT NULL DEFAULT 0,
  event_total_produced_blocks              BIGINT NOT NULL DEFAULT 0,
  event_success_rate                       NUMERIC(5,2),
  epoch_success_rate                       NUMERIC(5,2),
  first_block_points                       INTEGER NOT NULL DEFAULT 0,
  produced_half_blocks_points              INTEGER NOT NULL DEFAULT 0,
  top_3_points                             INTEGER NOT NULL DEFAULT 0,
  success_50_percent_points                INTEGER NOT NULL DEFAULT 0,
  bug_report_points                        INTEGER NOT NULL DEFAULT 0,
  inviting_new_participant_points          INTEGER NOT NULL DEFAULT 0,
  community_contribution_points            INTEGER NOT NULL DEFAULT 0,
  vrf_total_won_slots                      INTEGER NOT NULL DEFAULT 0,
  canonical_total_won_slots                INTEGER NOT NULL DEFAULT 0,
  canonical_total_produced_blocks          INTEGER NOT NULL DEFAULT 0,
  canonical_won_slots_up_to_current        INTEGER NOT NULL DEFAULT 0,
  canonical_produced_blocks_up_to_current  INTEGER NOT NULL DEFAULT 0,
  max_bp_success_rate_up_to_current        NUMERIC(5,2) NOT NULL DEFAULT 0,
  season_id                                BIGINT,
  challenge_details                        JSONB,
  UNIQUE (season_event_id, user_id, snapshot_at)
);
CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshots_season_event_rank ON leaderboard_snapshots (season_event_id, rank);
CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshots_season_event_snapshot ON leaderboard_snapshots (season_event_id, snapshot_at);

-- `token_allocation` — the financial record of tokens allocated to a
-- user for a season. `updated_by` referenced a source admin user;
-- admins are not migrated, so it is a soft (no-FK) column, left NULL.
CREATE TABLE IF NOT EXISTS token_allocation (
  id                   BIGSERIAL PRIMARY KEY,
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season_id            BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  total_points         NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_season_tokens  NUMERIC(18,2) NOT NULL DEFAULT 0,
  allocated_tokens     NUMERIC(30,8) NOT NULL DEFAULT 0,
  description          VARCHAR(255),
  created_at           TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ,
  updated_by           BIGINT,
  UNIQUE (user_id, season_id)
);
CREATE INDEX IF NOT EXISTS idx_token_allocation_updated_by ON token_allocation (updated_by);

-- `epoch_stats` — per-(chain, wallet, epoch) block-production tallies.
-- `wallet_address` is kept alongside the nullable `user_id` because
-- stats can exist for wallets never linked to a platform user; a
-- deleted user's history stays (SET NULL, not CASCADE).
CREATE TABLE IF NOT EXISTS epoch_stats (
  id                      BIGSERIAL PRIMARY KEY,
  chain_id                VARCHAR(64) NOT NULL,
  wallet_address          VARCHAR(255) NOT NULL,
  user_id                 BIGINT REFERENCES users(id) ON DELETE SET NULL,
  epoch                   INTEGER NOT NULL,
  epoch_won_slots         INTEGER NOT NULL DEFAULT 0,
  epoch_produced_blocks   INTEGER NOT NULL DEFAULT 0,
  epoch_canonical_blocks  INTEGER NOT NULL DEFAULT 0,
  epoch_orphaned_blocks   INTEGER NOT NULL DEFAULT 0,
  epoch_failed_blocks     INTEGER NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ,
  UNIQUE (chain_id, epoch, wallet_address)
);
CREATE INDEX IF NOT EXISTS idx_epoch_stats_chain_epoch ON epoch_stats (chain_id, epoch);

-- `chains` — append-only block log (public chain data). No FKs by
-- design: `chain_id` is a free-form value, not a foreign key to
-- anything, since this table itself never carries a unique
-- (chain_id) row. Currently 0 rows in the source; schema only.
CREATE TABLE IF NOT EXISTS chains (
  id            BIGSERIAL PRIMARY KEY,
  chain_id      VARCHAR(64) NOT NULL,
  global_slot   BIGINT NOT NULL,
  block_height  BIGINT NOT NULL,
  slot_time     TIMESTAMPTZ NOT NULL,
  canonical     BOOLEAN NOT NULL,
  block_hash    VARCHAR(255) NOT NULL,
  producer      VARCHAR(255) NOT NULL,
  predecessor   VARCHAR(255),
  epoch         INTEGER NOT NULL,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_chains_block_height ON chains (block_height);
CREATE INDEX IF NOT EXISTS idx_chains_canonical ON chains (canonical);
CREATE INDEX IF NOT EXISTS idx_chains_chain_id ON chains (chain_id);
CREATE INDEX IF NOT EXISTS idx_chains_epoch ON chains (epoch);
CREATE INDEX IF NOT EXISTS idx_chains_global_slot ON chains (global_slot);

-- `bytea_larger` / `max(bytea)` — the source database defines a custom
-- MAX() aggregate over bytea (its own migration 2026_05_18_000003) so
-- queries can take the largest `vrf_obligations.vrf_output_be_bytes`
-- value. Postgres ships no built-in bytea ordering aggregate, so it is
-- recreated here: an IMMUTABLE helper function picks the larger of two
-- (byte-wise) bytea values, NULL-safe, and a custom aggregate folds it
-- across rows. `CREATE AGGREGATE` has no IF NOT EXISTS / OR REPLACE
-- form, so it is guarded by checking pg_proc/pg_aggregate directly —
-- the same idempotency this whole file relies on everywhere else.
CREATE OR REPLACE FUNCTION bytea_larger(a BYTEA, b BYTEA) RETURNS BYTEA AS $$
  SELECT CASE
    WHEN a IS NULL THEN b
    WHEN b IS NULL THEN a
    WHEN a > b THEN a
    ELSE b
  END;
$$ LANGUAGE SQL IMMUTABLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_aggregate ag
      JOIN pg_proc p ON p.oid = ag.aggfnoid
      JOIN pg_type t ON t.oid = p.proargtypes[0]
     WHERE p.proname = 'max' AND t.typname = 'bytea'
  ) THEN
    CREATE AGGREGATE max(BYTEA) (
      SFUNC = bytea_larger,
      STYPE = BYTEA
    );
  END IF;
END $$;

-- `vrf_obligations` — the largest migrated table by far (source has
-- ~3.08M rows): one row per VRF slot obligation observed for a
-- (chain, sender). `raw` is the observed JSON payload (JSON→JSONB).
-- No FKs by design (chain_id is a free-form value, same as `chains`).
CREATE TABLE IF NOT EXISTS vrf_obligations (
  id                            BIGSERIAL PRIMARY KEY,
  chain_id                      VARCHAR(64) NOT NULL,
  global_slot                   BIGINT NOT NULL,
  sender_pk_hash                VARCHAR(255) NOT NULL,
  sender                        VARCHAR(255),
  active_participant            BOOLEAN NOT NULL DEFAULT FALSE,
  stake                         VARCHAR(255),
  tier                          VARCHAR(32),
  threshold                     DOUBLE PRECISION,
  status                        VARCHAR(32) NOT NULL,
  produced_count                SMALLINT NOT NULL DEFAULT 0,
  out_of_window_produced_count  SMALLINT NOT NULL DEFAULT 0,
  dropped_count                 SMALLINT NOT NULL DEFAULT 0,
  evidence_run_id               VARCHAR(255),
  evidence_event_id             BIGINT,
  evidence_timestamp_ms         BIGINT,
  observed_first_seen_ms        BIGINT,
  observed_last_seen_ms         BIGINT,
  epoch                         INTEGER NOT NULL,
  epoch_slot                    INTEGER,
  slot_time_ms                  BIGINT,
  raw                           JSONB,
  synced_at                     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at                    TIMESTAMPTZ,
  updated_at                    TIMESTAMPTZ,
  vrf_output_truncated          VARCHAR(80),
  vrf_output_be_bytes           BYTEA,
  UNIQUE (chain_id, global_slot, sender_pk_hash)
);
CREATE INDEX IF NOT EXISTS idx_vrf_obligations_chain_epoch ON vrf_obligations (chain_id, epoch);
CREATE INDEX IF NOT EXISTS idx_vrf_obligations_chain_global_slot ON vrf_obligations (chain_id, global_slot);
CREATE INDEX IF NOT EXISTS idx_vrf_obligations_chain_status ON vrf_obligations (chain_id, status);
CREATE INDEX IF NOT EXISTS idx_vrf_obligations_sender_pk_hash ON vrf_obligations (sender_pk_hash);

-- `vrf_obligations_sync_state` — one cursor row per chain tracking how
-- far the VRF obligations sync has progressed. PK is `chain_id`
-- itself (not a surrogate id) since there is exactly one row per chain.
CREATE TABLE IF NOT EXISTS vrf_obligations_sync_state (
  chain_id                  VARCHAR(64) PRIMARY KEY,
  last_synced_slot          BIGINT NOT NULL DEFAULT 0,
  partial_window_from_slot  BIGINT,
  partial_window_to_slot    BIGINT,
  last_synced_at            TIMESTAMPTZ,
  created_at                TIMESTAMPTZ,
  updated_at                TIMESTAMPTZ,
  descending_cursor_slot    BIGINT,
  last_known_tip_slot       BIGINT
);

-- `slot_outcome_reports` — mobile-client device telemetry: what
-- happened to a wallet's assigned slot, as observed on-device. There
-- is no `metric_id` column here — the source column referenced a
-- telemetry table outside this system's scope, so it was dropped.
-- `user_id` is a plain column (no FK) per spec — unlike `epoch_stats`,
-- the source never validated it against a users table either.
-- `report_uid` is the mobile client's dedup key; the unique index
-- below is the idempotency guard for re-sent reports.
CREATE TABLE IF NOT EXISTS slot_outcome_reports (
  id                          BIGSERIAL PRIMARY KEY,
  report_uid                  VARCHAR(64) NOT NULL,
  chain_id                    VARCHAR(64) NOT NULL,
  wallet_address              VARCHAR(255) NOT NULL,
  user_id                     BIGINT,
  captured_at_ms              BIGINT NOT NULL,
  global_slot                 BIGINT NOT NULL,
  epoch                       INTEGER,
  slot_in_epoch               INTEGER,
  slot_time_ms                BIGINT,
  outcome                     VARCHAR(32) NOT NULL,
  outcome_reason              VARCHAR(255),
  block_hash                  VARCHAR(255),
  block_height                BIGINT,
  canonical                   BOOLEAN,
  produced_at_ms              BIGINT,
  discarded_at_ms             BIGINT,
  node_slot_status            VARCHAR(16),
  flow_outcome                VARCHAR(64),
  flow_outcome_detail         TEXT,
  terminal_stage              VARCHAR(32),
  discard_reason              TEXT,
  empty_reason                TEXT,
  block_injected_at_ms        BIGINT,
  flow_summary_at_ms          BIGINT,
  build_ms                    INTEGER,
  db_diff_ms                  INTEGER,
  sign_ms                     INTEGER,
  inject_ms                   INTEGER,
  batch_fetch_ms              INTEGER,
  hydration_visible_ms        INTEGER,
  app_state                   VARCHAR(32),
  network_type                VARCHAR(32),
  network_connected           BOOLEAN,
  platform                    VARCHAR(32),
  platform_version            VARCHAR(255),
  app_version                 VARCHAR(255),
  app_build_number            VARCHAR(255),
  battery_level               SMALLINT,
  wakelock_held               BOOLEAN,
  foreground_service_running  BOOLEAN,
  alarm_scheduled_at_ms       BIGINT,
  alarm_fired_at_ms           BIGINT,
  monitoring_started_at_ms    BIGINT,
  created_at                  TIMESTAMPTZ,
  updated_at                  TIMESTAMPTZ,
  UNIQUE (chain_id, wallet_address, report_uid)
);
CREATE INDEX IF NOT EXISTS idx_slot_outcome_reports_captured_at_ms ON slot_outcome_reports (captured_at_ms);
CREATE INDEX IF NOT EXISTS idx_slot_outcome_reports_chain_epoch ON slot_outcome_reports (chain_id, epoch);
CREATE INDEX IF NOT EXISTS idx_slot_outcome_reports_user ON slot_outcome_reports (user_id);
CREATE INDEX IF NOT EXISTS idx_slot_outcome_reports_chain_wallet_global_slot ON slot_outcome_reports (chain_id, wallet_address, global_slot);
CREATE INDEX IF NOT EXISTS idx_slot_outcome_reports_chain_global_slot ON slot_outcome_reports (chain_id, global_slot);

-- `mobile_logs` — raw device log payloads uploaded from the mobile
-- app, keyed to the user who sent them. `payload` was JSON→JSONB.
CREATE TABLE IF NOT EXISTS mobile_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload     JSONB,
  created_at  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mobile_logs_user ON mobile_logs (user_id);

-- `mobile_otp_codes` — email login codes for the mobile app. Schema
-- only is migrated; ROWS ARE NOT (migrating live login codes would be
-- a security smell). Keyed by email; after identity merge, lookups go
-- through the platform's own `users.email`. No FK (rows here predate
-- any user match, by email string alone).
CREATE TABLE IF NOT EXISTS mobile_otp_codes (
  id           BIGSERIAL PRIMARY KEY,
  email        VARCHAR(255) NOT NULL,
  code_hash    VARCHAR(255) NOT NULL,
  attempts     SMALLINT NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mobile_otp_codes_email ON mobile_otp_codes (email);

-- `app_version_configs` — one row per mobile OS, gating minimum /
-- recommended client build numbers. Direct carry-over from the source.
CREATE TABLE IF NOT EXISTS app_version_configs (
  id                        BIGSERIAL PRIMARY KEY,
  os                        VARCHAR(255) NOT NULL UNIQUE,
  min_build_number          INTEGER NOT NULL,
  recommended_build_number  INTEGER,
  current_version           VARCHAR(50),
  must_update_message       TEXT,
  is_active                 BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                TIMESTAMPTZ,
  updated_at                TIMESTAMPTZ,
  should_update_message     TEXT,
  update_url                VARCHAR(500)
);
CREATE INDEX IF NOT EXISTS idx_app_version_configs_is_active ON app_version_configs (is_active);

-- `terms_versions` — one row per published terms-of-service revision.
CREATE TABLE IF NOT EXISTS terms_versions (
  id             BIGSERIAL PRIMARY KEY,
  version        VARCHAR(255) NOT NULL UNIQUE,
  title          VARCHAR(255) NOT NULL,
  body_markdown  TEXT NOT NULL,
  terms_link     VARCHAR(255),
  published_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_terms_versions_published_at ON terms_versions (published_at);

-- `user_terms_consents` — one row per user's response to a
-- `terms_versions` row. `ip` is PII (the consent IP), classified
-- staging:private in Task 2 alongside the rest of this batch.
CREATE TABLE IF NOT EXISTS user_terms_consents (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  terms_version_id  BIGINT NOT NULL REFERENCES terms_versions(id) ON DELETE CASCADE,
  status            VARCHAR(255) NOT NULL,
  responded_at      TIMESTAMPTZ NOT NULL,
  ip                VARCHAR(45),
  app_version       VARCHAR(255),
  created_at        TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ,
  UNIQUE (user_id, terms_version_id)
);

-- `mobile_auth_tokens` — bearer tokens for the topochain mobile
-- surface (plan Global Constraints #4; this table has no equivalent in
-- the source topochain database — it is new capability for the
-- platform-hosted mobile auth flow). `token_hash` stores the sha256
-- hex of the bearer token, never the token itself. `ability`
-- distinguishes a normal 90-day 'session' token from a single-use,
-- 10-minute 'set-password' token (issued right after OTP login for
-- users who still need to set a platform password). Never trust a
-- client-supplied user id on the mobile surface — the user always
-- comes from this table via the token (see topochain-auth
-- middleware, Task 3).
CREATE TABLE IF NOT EXISTS mobile_auth_tokens (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    VARCHAR(64) NOT NULL UNIQUE,
  ability       VARCHAR(20) NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mobile_auth_tokens_user ON mobile_auth_tokens (user_id);

-- Mobile push notifications — sender identity, registrations, deliveries (#844)
--
-- This header also bounds the topochain block above for
-- tests/topochain-schema.test.js: the six mobile_push_* tables below are
-- NOT part of the SPEC §3.4 topochain migration and must not count toward
-- its 22-table pin.

-- Database-owned sender identity and activation boundary. Same-identity sender
-- restarts retain this cutoff so queued work survives ordinary deployments.
-- Initial activation, re-enabling, and deployment identity changes establish
-- a fresh cutoff so incompatible or disabled-period work is not delivered.
CREATE TABLE IF NOT EXISTS mobile_push_deployment_state (
  environment         VARCHAR(32) PRIMARY KEY,
  firebase_project_id VARCHAR(128) NOT NULL CHECK (BTRIM(firebase_project_id) <> ''),
  send_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  send_not_before     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (BTRIM(environment) <> ''),
  CHECK (NOT send_enabled OR send_not_before IS NOT NULL)
);

-- Mobile push registrations belong to a platform user and app installation.
-- The bearer authorizes registration changes; only its expiry is copied as a
-- bounded lifetime. Provider registrations are encrypted with
-- DATA_ENCRYPTION_KEY; the hash is used only for uniqueness/rebinding and is
-- never returned or logged.
-- The installation mutation row deliberately survives logout/deletion so a
-- delayed request cannot resurrect an older registration state.
CREATE TABLE IF NOT EXISTS mobile_push_installation_mutations (
  environment              VARCHAR(32) NOT NULL,
  installation_id          UUID NOT NULL,
  latest_mutation_revision BIGINT NOT NULL CHECK (latest_mutation_revision > 0),
  latest_mutation_kind     VARCHAR(8) NOT NULL
                             CHECK (latest_mutation_kind IN ('put', 'delete')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (environment, installation_id),
  CHECK (BTRIM(environment) <> '')
);

CREATE TABLE IF NOT EXISTS mobile_push_registrations (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  environment        VARCHAR(32) NOT NULL,
  installation_id    UUID NOT NULL,
  provider           VARCHAR(16) NOT NULL DEFAULT 'fcm' CHECK (provider = 'fcm'),
  registration_hash  VARCHAR(64) NOT NULL CHECK (registration_hash ~ '^[0-9a-f]{64}$'),
  registration_enc   TEXT NOT NULL CHECK (BTRIM(registration_enc) <> ''),
  platform           VARCHAR(16) NOT NULL CHECK (platform IN ('android', 'ios')),
  permission_status  VARCHAR(24) NOT NULL CHECK (
                         permission_status IN (
                           'authorized', 'provisional', 'denied', 'not_determined'
                         )
                       ),
  session_expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (environment, installation_id),
  UNIQUE (environment, registration_hash),
  CHECK (BTRIM(environment) <> '')
);
CREATE INDEX IF NOT EXISTS idx_mobile_push_registrations_user
  ON mobile_push_registrations (user_id, environment);

-- Closed notification-kind policy. The notification INSERT trigger and the
-- sender both read this table, so a future inbox kind is push-disabled until
-- it is deliberately assigned to one reviewed category here. Keep this seed
-- in lockstep with services/mobile-push-preferences.js.
CREATE TABLE IF NOT EXISTS mobile_push_kind_categories (
  kind            VARCHAR(32) PRIMARY KEY,
  category        VARCHAR(32) NOT NULL CHECK (category IN (
                    'direct_interactions', 'invitations', 'shared_work',
                    'developer_sessions', 'proposal_alerts', 'lightweight_activity',
                    'messages'
                  )),
  default_enabled BOOLEAN NOT NULL
);
-- Existing databases already carry autogenerated category CHECK constraints;
-- CREATE TABLE IF NOT EXISTS cannot widen those. Replace the kind-category
-- constraint before inserting the new Messages rows below.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'mobile_push_kind_categories'::regclass
       AND conname = 'mobile_push_kind_categories_category_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%messages%'
  ) THEN
    ALTER TABLE mobile_push_kind_categories
      DROP CONSTRAINT mobile_push_kind_categories_category_check;
    ALTER TABLE mobile_push_kind_categories
      ADD CONSTRAINT mobile_push_kind_categories_category_check
      CHECK (category IN (
        'direct_interactions', 'invitations', 'shared_work',
        'developer_sessions', 'proposal_alerts', 'lightweight_activity',
        'messages'
      ));
  END IF;
END $$;
INSERT INTO mobile_push_kind_categories (kind, category, default_enabled) VALUES
  ('mention', 'direct_interactions', TRUE),
  ('reply', 'direct_interactions', TRUE),
  ('collab_invite', 'invitations', TRUE),
  ('collab_invite_accepted', 'invitations', TRUE),
  ('approver_invite', 'invitations', TRUE),
  ('approver_invite_accepted', 'invitations', TRUE),
  ('spec_shared', 'shared_work', TRUE),
  ('session_done', 'developer_sessions', TRUE),
  ('auto_solve_done', 'developer_sessions', TRUE),
  ('stale_pr', 'proposal_alerts', TRUE),
  ('check_failed', 'proposal_alerts', TRUE),
  ('pr_proposed', 'proposal_alerts', TRUE),
  ('reaction', 'lightweight_activity', FALSE),
  ('kudos', 'lightweight_activity', FALSE),
  ('conversation_invite', 'messages', TRUE),
  ('conversation_message', 'messages', TRUE),
  ('conversation_mention', 'messages', TRUE),
  ('conversation_reply', 'messages', TRUE),
  ('conversation_reaction', 'messages', TRUE)
ON CONFLICT (kind) DO UPDATE
  SET category = EXCLUDED.category,
      default_enabled = EXCLUDED.default_enabled;
DELETE FROM mobile_push_kind_categories
 WHERE kind NOT IN (
   'mention', 'reply', 'collab_invite', 'collab_invite_accepted',
   'approver_invite', 'approver_invite_accepted', 'spec_shared',
   'session_done', 'auto_solve_done', 'stale_pr', 'check_failed',
   'pr_proposed', 'reaction', 'kudos',
   'conversation_invite', 'conversation_message', 'conversation_mention',
   'conversation_reply', 'conversation_reaction'
 );

-- Sparse account overrides. The closed policy above supplies defaults, so
-- existing accounts need no backfill and a preference change never touches
-- per-device Firebase registrations.
CREATE TABLE IF NOT EXISTS mobile_push_preferences (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category   VARCHAR(32) NOT NULL CHECK (category IN (
               'direct_interactions', 'invitations', 'shared_work',
               'developer_sessions', 'proposal_alerts', 'lightweight_activity',
               'messages'
             )),
  enabled    BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, category)
);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'mobile_push_preferences'::regclass
       AND conname = 'mobile_push_preferences_category_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%messages%'
  ) THEN
    ALTER TABLE mobile_push_preferences
      DROP CONSTRAINT mobile_push_preferences_category_check;
    ALTER TABLE mobile_push_preferences
      ADD CONSTRAINT mobile_push_preferences_category_check
      CHECK (category IN (
        'direct_interactions', 'invitations', 'shared_work',
        'developer_sessions', 'proposal_alerts', 'lightweight_activity',
        'messages'
      ));
  END IF;
END $$;

-- Durable notification outbox. No provider token is copied here. `attempts`
-- tracks retry backoff within the single Social sender.
CREATE TABLE IF NOT EXISTS mobile_push_deliveries (
  id                BIGSERIAL PRIMARY KEY,
  notification_id   INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  registration_id   BIGINT REFERENCES mobile_push_registrations(id) ON DELETE SET NULL,
  environment       VARCHAR(32) NOT NULL CHECK (BTRIM(environment) <> ''),
  installation_id   UUID NOT NULL,
  -- Snapshot the destination platform so a provider-invalidated registration
  -- can be deleted without turning its durable diagnostic row into "unknown".
  platform          VARCHAR(16) CHECK (platform IN ('android', 'ios')),
  status            VARCHAR(16) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sending', 'sent', 'dead', 'cancelled')),
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  sent_at           TIMESTAMPTZ,
  last_error_code   VARCHAR(96),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (notification_id, environment, installation_id)
);
ALTER TABLE mobile_push_deliveries
  ADD COLUMN IF NOT EXISTS platform VARCHAR(16);
UPDATE mobile_push_deliveries delivery
   SET platform = registration.platform
  FROM mobile_push_registrations registration
 WHERE delivery.registration_id = registration.id
   AND delivery.platform IS NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mobile_push_deliveries_platform_check'
       AND conrelid = 'mobile_push_deliveries'::regclass
  ) THEN
    ALTER TABLE mobile_push_deliveries
      ADD CONSTRAINT mobile_push_deliveries_platform_check
      CHECK (platform IN ('android', 'ios')) NOT VALID;
  END IF;
END $$;
ALTER TABLE mobile_push_deliveries
  VALIDATE CONSTRAINT mobile_push_deliveries_platform_check;
CREATE INDEX IF NOT EXISTS idx_mobile_push_deliveries_claim
  ON mobile_push_deliveries (environment, available_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_mobile_push_deliveries_registration
  ON mobile_push_deliveries (registration_id) WHERE registration_id IS NOT NULL;

COMMENT ON TABLE mobile_push_deployment_state IS 'staging:private';
COMMENT ON TABLE mobile_push_installation_mutations IS 'staging:private';
COMMENT ON TABLE mobile_push_registrations IS 'staging:private';
COMMENT ON TABLE mobile_push_deliveries IS 'staging:private';

-- Capture the push outbox in the same transaction as the canonical
-- notification. The kind/category registry is intentionally closed: adding a
-- new inbox kind does not automatically make it a lock-screen event.
CREATE OR REPLACE FUNCTION enqueue_mobile_push_deliveries()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.read_at IS NOT NULL
     OR NOT COALESCE((
       SELECT COALESCE(preference.enabled, policy.default_enabled)
         FROM mobile_push_kind_categories policy
         LEFT JOIN mobile_push_preferences preference
           ON preference.user_id = NEW.user_id
          AND preference.category = policy.category
        WHERE policy.kind = NEW.kind
     ), FALSE) THEN
    RETURN NEW;
  END IF;

  -- Project changes lock deployment state before deleting registrations.
  -- Take the same lock order here so outbox capture cannot deadlock with that
  -- transition or commit an old-project registration behind it.
  PERFORM environment
    FROM mobile_push_deployment_state
   ORDER BY environment
   FOR KEY SHARE;

  WITH eligible AS MATERIALIZED (
    SELECT r.id, r.environment, r.installation_id, r.platform
      FROM mobile_push_registrations r
      JOIN mobile_push_deployment_state s ON s.environment = r.environment
     WHERE r.user_id = NEW.user_id
       AND r.session_expires_at > NOW()
       AND r.permission_status IN ('authorized', 'provisional')
       AND s.send_enabled
       AND s.send_not_before IS NOT NULL
       AND COALESCE(NEW.created_at, NOW()) >= s.send_not_before
     ORDER BY r.id
     FOR KEY SHARE OF r
  )
  INSERT INTO mobile_push_deliveries (
    notification_id, registration_id, environment, installation_id, platform, expires_at
  )
  SELECT NEW.id, id, environment, installation_id, platform,
         COALESCE(NEW.created_at, NOW()) + INTERVAL '24 hours'
    FROM eligible
  ON CONFLICT (notification_id, environment, installation_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'notifications_enqueue_mobile_push_deliveries'
       AND tgrelid = 'notifications'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER notifications_enqueue_mobile_push_deliveries
      AFTER INSERT ON notifications
      FOR EACH ROW EXECUTE FUNCTION enqueue_mobile_push_deliveries();
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- Topochain Task 2 — `users` columns, `platform_settings` seed, staging
-- privacy (plan Task 2; SPEC §8.5 users columns 3283-3294, §3.5 settings
-- 801-804, §6 staging privacy 3080-3088).
-- ═══════════════════════════════════════════════════════════════════════

-- Columns the topochain merge adds to the platform's existing `users`
-- table — SPEC §8.5 says plainly "the platform users table IS the users
-- table"; there is no separate topochain users table. Every new column
-- is nullable or safely defaulted so this whole block is a no-op for
-- every pre-existing platform account. `email` gets a PARTIAL unique
-- index below (WHERE email IS NOT NULL) because existing platform users
-- have none. `users.password` is already tagged staging:private near
-- schema.sql:1148 — not re-tagged here.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email                      VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_confirmed            BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_confirmation_token   VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_confirmation_sent_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_confirmed_at         TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name               VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram                   VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord                    VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS github                     VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS x                          VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_in_waitlist             BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS waitlist_submitted_at      TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS waitlist_ip                VARCHAR(45);
ALTER TABLE users ADD COLUMN IF NOT EXISTS waitlist_answers           JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referrer                   VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referrer_handle            VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS country                    VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS city                       VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_info                JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS exclude_podium             BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS accept_logs                BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at                 TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_is_in_waitlist ON users(is_in_waitlist);
CREATE INDEX IF NOT EXISTS idx_users_exclude_podium ON users(exclude_podium);
CREATE INDEX IF NOT EXISTS idx_users_email_confirmation_token ON users(email_confirmation_token);
CREATE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram);
CREATE INDEX IF NOT EXISTS idx_users_discord ON users(discord);
CREATE INDEX IF NOT EXISTS idx_users_country ON users(country);

-- The user directory's handle match (services/user-directory.js, #1213).
-- Every lookup runs `LOWER(username) = LOWER($1)` and every typeahead
-- keystroke runs `LOWER(username) LIKE '<prefix>%' ... ORDER BY
-- LOWER(username)`, across three surfaces (app-platform API, the shell's
-- bridge relay, the collaborator-invite typeahead) — without these both
-- were sequential scans. Two indexes because they serve different
-- operators: the default (btree/collation) opclass answers the equality
-- and the ORDER BY, but under a non-C collation it cannot serve LIKE
-- prefix ranges — that needs text_pattern_ops, which in turn cannot serve
-- the collation-ordered ORDER BY.
CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));
CREATE INDEX IF NOT EXISTS idx_users_username_lower_pattern ON users (LOWER(username) text_pattern_ops);

-- `platform_settings` gains a `description` column (SPEC §3.5) and the
-- topochain point-values as `topochain_`-prefixed keys, so the prefix can
-- never collide with a platform key. Seeded with ON CONFLICT (key) DO
-- NOTHING so an operator's later edit (admin settings screen) survives
-- every reboot.
--
-- NOTE on key count (task-2 brief resolution of a SPEC ambiguity): SPEC
-- §3.5's prose says "the seven topochain values", but the reset-defaults
-- table it points readers at (§4.9 POST /point-settings/reset, SPEC
-- 2825-2840) lists only SIX keys (first_block, produced_half_blocks,
-- top_1, top_2, top_3, success_50_percent). The task-2 brief resolves
-- the count by naming seven keys explicitly — those six plus
-- `inviting_new_participant_points` — and that concrete list is what's
-- seeded below verbatim. `bug_report_points` and
-- `community_contribution_points` are NOT settings keys: they are
-- per-row columns already on `leaderboard_snapshots` (Task 1), scored
-- per activity rather than configured as a flat point value.
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS description TEXT;
INSERT INTO platform_settings (key, value, description) VALUES
  ('topochain_first_block_points',              '250',
    'Points awarded for producing a season event''s first block.'),
  ('topochain_produced_half_blocks_points',     '0',
    'Points awarded for producing at least half of the expected blocks.'),
  ('topochain_top_1_points',                    '1500',
    'Points awarded for finishing rank 1 on the leaderboard.'),
  ('topochain_top_2_points',                    '1000',
    'Points awarded for finishing rank 2 on the leaderboard.'),
  ('topochain_top_3_points',                    '500',
    'Points awarded for finishing rank 3 on the leaderboard.'),
  ('topochain_success_50_percent_points',       '1000',
    'Points awarded for a block-production success rate of at least 50%.'),
  ('topochain_inviting_new_participant_points', '0',
    'Points awarded for inviting a new participant into the competition.')
ON CONFLICT (key) DO NOTHING;

-- Staging privacy (SPEC §6), table-level: every row of these tables is
-- sensitive in its entirety in a staging clone (truncated by
-- db-manager.js's truncatePrivateTables — discovered dynamically via
-- these COMMENTs, no code change needed there). `mobile_otp_codes` and
-- `mobile_auth_tokens` are additionally hidden from the prod-debug role
-- entirely (see DENIED_TABLES in src/services/debug-access.js).
COMMENT ON TABLE token_allocation     IS 'staging:private';
COMMENT ON TABLE chains               IS 'staging:private';
COMMENT ON TABLE vrf_obligations      IS 'staging:private';
COMMENT ON TABLE slot_outcome_reports IS 'staging:private';
COMMENT ON TABLE mobile_logs          IS 'staging:private';
COMMENT ON TABLE mobile_otp_codes     IS 'staging:private';
COMMENT ON TABLE mobile_auth_tokens   IS 'staging:private';
COMMENT ON TABLE user_terms_consents  IS 'staging:private'; -- contains consent IPs, SPEC 781-799

-- Staging privacy (SPEC §6), column-level: the row survives cloning (FK-
-- targeted attribution keeps working) but the credential/PII-bearing
-- value is scrubbed. All four are additionally hidden from the
-- prod-debug role by column (DENIED_COLUMNS in
-- src/services/debug-access.js) so a future secret column on either
-- table fails closed rather than leaking.
COMMENT ON COLUMN users.email_confirmation_token    IS 'staging:private';
COMMENT ON COLUMN users.waitlist_ip                 IS 'staging:private';
COMMENT ON COLUMN onchain_accounts.secret_key        IS 'staging:private';
COMMENT ON COLUMN onchain_accounts.registration_code IS 'staging:private';

-- ═══════════════════════════════════════════════════════════════════════
-- Topochain Task 8 — mobile auth: users.password_set (plan Task 8;
-- Global Constraints #4/#6, task-8 brief).
-- ═══════════════════════════════════════════════════════════════════════

-- Every platform `users` row already has a NOT NULL `password` (a real
-- bcrypt hash) — but the topochain mobile OTP flow
-- (POST /api/v4/mobile/auth/otp/verify) can create a user row with NO
-- caller-chosen password at all: it stores a random, unusable bcrypt hash
-- (of 32 random bytes nobody knows) just to satisfy the NOT NULL
-- constraint. `password_set` is how the mobile auth surface tells "a real,
-- caller-chosen password exists" apart from "some syntactically-valid
-- hash nobody can ever produce" — POST /auth/check-email's
-- `password_set` response field and POST /auth/login's guest/member/
-- operator level computation both branch on it directly (mobile-auth.js).
-- Existing platform users (registered the normal way, always with a real
-- chosen password) default TRUE via DEFAULT TRUE, so this column is a
-- no-op for every pre-existing account; only the OTP-created path (and,
-- until it completes set-password, that path alone) ever sets it FALSE.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set BOOLEAN NOT NULL DEFAULT TRUE;

-- ═══════════════════════════════════════════════════════════════════════
-- Onboarding flow alignment — email-only platform waitlist, enforced
-- platform-access gate, block-producer queue (user-onboarding-flows doc).
-- ═══════════════════════════════════════════════════════════════════════

-- Platform waitlist entries are keyed by EMAIL, not by user: joining
-- requires no account (`POST /api/public/waitlist`), and admins can
-- release an email before its owner ever registers. `released_at` is the
-- release marker; when a `users` row with a matching email is created
-- (OTP verify or classic register), the linkage step points
-- `linked_user_id` here and — if already released — grants
-- `has_platform_access` on the spot. Emails are stored lowercased.
CREATE TABLE IF NOT EXISTS waitlist_signups (
  id             BIGSERIAL PRIMARY KEY,
  email          VARCHAR(255) NOT NULL UNIQUE,
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip             VARCHAR(45),
  answers        JSONB,
  released_at    TIMESTAMPTZ,
  linked_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_waitlist_signups_released ON waitlist_signups (released_at);
CREATE INDEX IF NOT EXISTS idx_waitlist_signups_linked_user ON waitlist_signups (linked_user_id);
COMMENT ON COLUMN waitlist_signups.ip IS 'staging:private';

-- Two-stage waitlist survey (ported from the original topochain
-- waitlist). `more_token` is the capability for the optional stage-2
-- "Want in sooner?" form — shown once after joining and carried in the
-- join email, it lets the signer re-open and merge answers (and verify
-- GitHub / X handles via OAuth) without an account. NULL for rows that
-- predate the survey.
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS more_token VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_signups_more_token
  ON waitlist_signups (more_token) WHERE more_token IS NOT NULL;
COMMENT ON COLUMN waitlist_signups.more_token IS 'staging:private';

-- Email confirmation. Set the first time the signer follows the confirm
-- link in their join mail (GET /api/public/waitlist/confirm/:token, which
-- then lands them on the stage-2 survey). Idempotent — a second visit
-- keeps the original timestamp. A NULL here after a join means the
-- address never proved it can receive mail, which is exactly what an
-- admin wants to see before releasing a row.
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

-- Outbound mail log (src/services/mail/). Every send attempt lands here
-- with its outcome, and it is the ONLY place an operator can see what
-- happened: the endpoints that trigger mail are always-200 by contract
-- (SPEC 1667) so they cannot report a delivery failure to the user, and a
-- non-delivery was historically invisible for exactly that reason.
--
-- It is also the throttle's state: src/services/mail/rate-limit.js counts
-- the `sent` / `skipped_staging` rows for a recipient to cap how much mail
-- one address can be made to receive, and counts them globally to bound
-- the provider bill.
--
-- `status` is one of:
--   sent                  delivered to the provider
--   skipped_staging       rendered to the log by a staging preview
--   failed                the provider refused or timed out (`error` says)
--   suppressed_rate_limit the throttle declined it (`error` says why)
--   no_transport          nothing was configured to send it
-- `error` holds a bounded provider complaint. It NEVER holds the message
-- body, so a login code cannot end up in this table.
CREATE TABLE IF NOT EXISTS mail_deliveries (
  id         BIGSERIAL PRIMARY KEY,
  kind       VARCHAR(64) NOT NULL,
  recipient  VARCHAR(255) NOT NULL,
  provider   VARCHAR(32),
  status     VARCHAR(24) NOT NULL,
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- The throttle's read path: newest rows for one recipient and kind.
CREATE INDEX IF NOT EXISTS idx_mail_deliveries_recipient
  ON mail_deliveries (recipient, kind, created_at DESC);
-- The global hourly count, the admin card's "recent activity", and the
-- retention sweep all walk the table by time.
CREATE INDEX IF NOT EXISTS idx_mail_deliveries_created
  ON mail_deliveries (created_at DESC);
-- Staging privacy (see the convention block earlier in this file): a log
-- of who the platform emailed and when is private user content, so a
-- staging clone starts empty and gets obviously-fake seed rows instead
-- (seedStagingPlatformMail in src/db/migrate.js).
--
-- Deliberately NOT added to the prod-debug deny lists in
-- src/services/debug-access.js: this table holds no password, key or
-- token, and "did that user's login code actually go out" is precisely the
-- question an admin debugging session needs to be able to answer.
COMMENT ON TABLE mail_deliveries IS 'staging:private';

-- Access + block-production state on the user. `has_platform_access`
-- gates the SV platform surfaces (home/social/build) — NOT login-required
-- child apps, which any account may use (see src/middleware/auth.js).
-- `bp_requested_at`/`bp_released_at` are the block-producer queue: any
-- user with platform access may ask to produce blocks; an admin releases
-- them manually, which is what lets the mobile node enable its block
-- producer (surfaced via GET /api/v4/mobile/me).
ALTER TABLE users ADD COLUMN IF NOT EXISTS has_platform_access        BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_access_granted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bp_requested_at            TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bp_released_at             TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_has_platform_access ON users (has_platform_access);

-- One-time grandfather + legacy-waitlist backfill, guarded by a
-- platform_settings marker key because this whole file re-runs on every
-- boot. First boot after deploy: every pre-existing account keeps full
-- access (the gate only bites signups created after this ships), and the
-- migrated topochain waitlist columns on `users` are copied into
-- `waitlist_signups` (those legacy columns stay read-only thereafter).
-- Later boots: the marker exists, both statements are no-ops.
UPDATE users
  SET has_platform_access = TRUE, platform_access_granted_at = NOW()
  WHERE NOT EXISTS
    (SELECT 1 FROM platform_settings WHERE key = 'onboarding_gate_grandfathered');

INSERT INTO waitlist_signups (email, submitted_at, ip, answers, linked_user_id)
  SELECT LOWER(u.email), COALESCE(u.waitlist_submitted_at, NOW()),
         u.waitlist_ip, u.waitlist_answers, u.id
  FROM users u
  WHERE u.is_in_waitlist = TRUE AND u.email IS NOT NULL
    AND NOT EXISTS
      (SELECT 1 FROM platform_settings WHERE key = 'onboarding_gate_grandfathered')
ON CONFLICT (email) DO NOTHING;

INSERT INTO platform_settings (key, value, description) VALUES
  ('onboarding_gate_grandfathered', 'true',
    'Marker: the one-time platform-access grandfather + waitlist backfill has run. Do not delete — deleting re-grants access to every account on next boot.')
ON CONFLICT (key) DO NOTHING;

-- ── Hosted MCP connector: OAuth 2.1 authorization server ────────────────
--
-- Claude.ai and ChatGPT connect to the platform's remote MCP endpoint
-- (POST /mcp) as PUBLIC OAuth clients: dynamic client registration, the
-- authorization-code grant with mandatory PKCE S256, and rotating refresh
-- tokens. These are deliberately SEPARATE tables from the CLI's
-- cli_access_tokens / cli_auth_audit_events family, whose CHECK
-- constraints pin client_id to the single first-party CLI identity and
-- scopes to that flow's two values — a third-party connector fits neither.
--
-- All three are staging:private: they hold (hashed) credential material
-- and a staging clone must never carry a live grant. The Settings section
-- that lists them therefore renders from a ?demo=1 fixture in staging.

CREATE TABLE IF NOT EXISTS mcp_clients (
  id               BIGSERIAL PRIMARY KEY,
  client_id        TEXT NOT NULL UNIQUE,
  client_name      TEXT NOT NULL,
  -- Every entry is https (or loopback in explicit local-dev mode) and its
  -- host is on the deployment's connector allowlist; the registration
  -- route is the enforcement point.
  redirect_uris    TEXT[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at      TIMESTAMPTZ,
  CHECK (char_length(client_name) BETWEEN 1 AND 128)
);
COMMENT ON TABLE mcp_clients IS 'staging:private';

-- Authorization codes. Single-use, 60s TTL, bound to client + redirect +
-- PKCE challenge, stored hashed. The consumed_at/expires_at pairing is
-- expressed as constraints so an inconsistent row cannot be written.
CREATE TABLE IF NOT EXISTS mcp_authorization_codes (
  id             BIGSERIAL PRIMARY KEY,
  code_hash      TEXT NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  client_id      TEXT NOT NULL,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes         TEXT[] NOT NULL
    CHECK (
      cardinality(scopes) BETWEEN 1 AND 2
      AND scopes <@ ARRAY['usernode:apps:read', 'usernode:proposals:write']::TEXT[]
    ),
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  grant_id       TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
COMMENT ON TABLE mcp_authorization_codes IS 'staging:private';

-- Access + refresh tokens. grant_id groups everything minted from one
-- consent so Settings → Disconnect revokes the whole chain in one write;
-- rotated_from records refresh rotation so reuse of a consumed refresh
-- token can be detected and the chain killed.
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id           BIGSERIAL PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id    TEXT NOT NULL,
  grant_id     TEXT NOT NULL,
  scopes       TEXT[] NOT NULL
    CHECK (
      cardinality(scopes) BETWEEN 1 AND 2
      AND scopes <@ ARRAY['usernode:apps:read', 'usernode:proposals:write']::TEXT[]
    ),
  rotated_from BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
COMMENT ON TABLE mcp_tokens IS 'staging:private';

CREATE INDEX IF NOT EXISTS mcp_tokens_user_idx
  ON mcp_tokens (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS mcp_tokens_grant_idx
  ON mcp_tokens (grant_id);
CREATE INDEX IF NOT EXISTS mcp_tokens_expiry_idx
  ON mcp_tokens (expires_at);
CREATE INDEX IF NOT EXISTS mcp_authorization_codes_expiry_idx
  ON mcp_authorization_codes (expires_at);

-- Connector auth audit. Same event vocabulary and same
-- metadata-allowlist discipline as cli_auth_audit_events, but with a free
-- client_id (a third-party connector is not the first-party CLI) and the
-- connector scope set.
CREATE TABLE IF NOT EXISTS mcp_auth_audit_events (
  id              BIGSERIAL PRIMARY KEY,
  event_type      TEXT NOT NULL
    CHECK (event_type IN (
      'authorization_approved', 'authorization_rejected',
      'token_issued', 'token_used', 'token_revoked'
    )),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  access_token_id BIGINT,
  client_id       TEXT NOT NULL,
  scopes          TEXT[] NOT NULL
    CHECK (
      cardinality(scopes) <= 2
      AND scopes <@ ARRAY['usernode:apps:read', 'usernode:proposals:write']::TEXT[]
    ),
  outcome         TEXT NOT NULL DEFAULT 'success'
    CHECK (
      (event_type = 'token_used'
       AND outcome IN ('scope_authorized', 'insufficient_scope'))
      OR (event_type <> 'token_used' AND outcome = 'success')
    ),
  metadata        JSONB NOT NULL DEFAULT '{}'
    CHECK (jsonb_typeof(metadata) = 'object')
);
COMMENT ON TABLE mcp_auth_audit_events IS 'staging:private';

CREATE INDEX IF NOT EXISTS mcp_auth_audit_events_user_idx
  ON mcp_auth_audit_events (user_id, occurred_at DESC);

-- Throttle state for the in-band "you can stop these permission prompts"
-- hint that rides along on a read-only tool result.
--
-- Keyed on grant_id, not on an MCP session: /mcp is STATELESS
-- (sessionIdGenerator: undefined — a fresh McpServer per HTTP request), so
-- there is no session id to key on and "once per session" is not something
-- this server can express. A grant is the nearest durable thing that means
-- "this connection", and it survives the hourly access-token rotation, which
-- is what stops the hint reappearing every hour forever.
--
-- What decides "a new conversation" is armed_at, NOT the access token.
-- last_token_id used to be that gate — a claim was refused when the calling
-- token matched the last one — on the theory that an hourly token is roughly
-- a conversation. It is not: one token serves every conversation opened in
-- that hour, so the first eligible read consumed the only slot and every
-- conversation afterwards got nothing. In production that produced exactly
-- one row, ever. armed_at is written when the client sends `initialize`,
-- which is the protocol actually saying a session has started, and a claim is
-- granted when the row has been armed since it was last shown. The column
-- stays as a DIAGNOSTIC: written on every showing, read by nothing.
--
-- shown_count is a ROLLING budget, not a lifetime cap: at most 3 showings per
-- window_started_at + 7 days, with the window rolled forward inside the claim
-- statement. The lifetime cap it replaced had no reset path, so a connection
-- that spent it went quiet permanently.
--
-- Advisory state, never authoritative: a failed claim is logged and the read
-- returns without a hint. Nothing here gates access to anything.
CREATE TABLE IF NOT EXISTS mcp_connector_hints (
  grant_id      TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shown_count   INTEGER NOT NULL DEFAULT 0,
  last_token_id BIGINT,
  last_shown_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE mcp_connector_hints IS 'staging:private';

-- Added after the table shipped, so they arrive as idempotent ALTERs like
-- every other post-hoc column in this file.
--
-- armed_at is NULLABLE on purpose: NULL means "not armed", and a showing
-- clears it, so one initialize buys one showing rather than every read in the
-- session. It has no DEFAULT for the same reason — a row created by the claim
-- path (a client mid-session when this shipped) must not look armed.
--
-- window_started_at is NOT NULL DEFAULT NOW(), which back-fills every existing
-- row to "the window starts now". That is the deliberate choice: it gives the
-- one grant that spent its lifetime cap under the old rules a fresh weekly
-- budget rather than leaving it locked out.
ALTER TABLE mcp_connector_hints ADD COLUMN IF NOT EXISTS armed_at TIMESTAMPTZ;
ALTER TABLE mcp_connector_hints
  ADD COLUMN IF NOT EXISTS window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ── Verified GitHub account link (IDENTITY ONLY) ────────────────────────
-- Distinct from the self-declared `users.github` profile string above,
-- which is unverified display text and must NEVER be used for
-- authorization. These are written only by the OAuth round-trip in
-- src/services/github-link.js, which asks GitHub for NO SCOPE: the login
-- is the whole link, and the platform holds no credential for the user.
--
-- github_oauth_token_enc is LEGACY and always NULL. It once held a
-- `public_repo` token used to fork an app repo into the user's account on
-- their behalf; that fork is now made by the user's own coding agent.
-- saveLink writes NULL, and migrate.js's revokeLegacyGithubGrants hands
-- any pre-existing token back to GitHub and clears it. Kept (rather than
-- dropped) so a rollback to the previous release cannot hit a missing
-- column mid-deploy; drop it once every deployment has migrated.
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_login             VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_oauth_token_enc   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_linked_at         TIMESTAMPTZ;
COMMENT ON COLUMN users.github_oauth_token_enc IS 'staging:private';

-- Generic social-account ownership proofs used by the opt-in identity
-- credit policy. `provider_subject` is the provider's immutable numeric id;
-- the handle is presentation/attribution metadata and may change. One
-- provider account can belong to only one Usernode account, while linking
-- both providers never stacks the tier. No OAuth access or refresh token is
-- stored here (or anywhere else after the callback completes).
CREATE TABLE IF NOT EXISTS user_social_identities (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider            VARCHAR(16) NOT NULL CHECK (provider IN ('github', 'x')),
  provider_subject    VARCHAR(40) NOT NULL CHECK (provider_subject ~ '^[1-9][0-9]{0,39}$'),
  handle              VARCHAR(64) NOT NULL,
  linked_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider),
  UNIQUE (provider, provider_subject)
);
COMMENT ON TABLE user_social_identities IS 'staging:private';
CREATE INDEX IF NOT EXISTS user_social_identities_user_idx
  ON user_social_identities (user_id);

-- Single-use OAuth state. The browser receives the random state value while
-- this table stores only its SHA-256 hash plus the server-side PKCE verifier.
-- Starting a replacement flow invalidates the previous one for that
-- user/provider; callbacks atomically DELETE ... RETURNING before exchange.
CREATE TABLE IF NOT EXISTS social_identity_oauth_states (
  state_hash       CHAR(64) PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         VARCHAR(16) NOT NULL CHECK (provider IN ('github', 'x')),
  pkce_verifier    VARCHAR(128) NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, provider)
);
COMMENT ON TABLE social_identity_oauth_states IS 'staging:private';
CREATE INDEX IF NOT EXISTS social_identity_oauth_states_expiry_idx
  ON social_identity_oauth_states (expires_at);

-- Which external coding agent produced a proposal, for the "built with
-- Claude Code" / "built with Codex" badge. Deliberately a SEPARATE column
-- rather than a new `source` value: `source = 'imported'` is compared for
-- exact equality in ~10 places (sync-main, staging-recovery, pr-vote-
-- revision, the chat-turn guard, …) and every one of those behaviours is
-- wanted for an externally-authored branch.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS external_agent   TEXT;

-- ── External-agent work orders ──────────────────────────────────────────
--
-- One row per "the connector handed a task to the user's own coding agent
-- and is waiting for the branch to come back". It is the server's memory of
-- what prepare_work promised, so submit_work can check that the branch it
-- is asked to import is the branch it reserved, in the fork it reserved,
-- from the base commit it recorded — rather than trusting the three strings
-- the model hands back.
--
-- `staging:private`: rows tie a Usernode account to a personal GitHub
-- account and to in-flight, unpublished work. They carry no credential
-- (the OAuth token lives encrypted on `users`), so they are not in the
-- prod-debug deny list; they are simply not other people's business and
-- must not ride along into a staging clone. This table references public
-- tables, never the reverse.
CREATE TABLE IF NOT EXISTS external_agent_tasks (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id        INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  issue_number  INTEGER,
  fork_owner    TEXT NOT NULL,
  fork_repo     TEXT NOT NULL,
  branch_name   TEXT NOT NULL,
  base_sha      TEXT NOT NULL,
  brief         TEXT NOT NULL DEFAULT '',
  client_id     TEXT,
  status        TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'submitted', 'abandoned')),
  session_id    INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '14 days'
);
COMMENT ON TABLE external_agent_tasks IS 'staging:private';

-- At most one OPEN task per (user, app, branch): re-running prepare_work
-- for the same branch adopts the existing reservation instead of minting a
-- second one, and two connectors racing cannot both reserve it.
CREATE UNIQUE INDEX IF NOT EXISTS external_agent_tasks_open_branch_idx
  ON external_agent_tasks (user_id, app_id, branch_name)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS external_agent_tasks_user_idx
  ON external_agent_tasks (user_id, created_at DESC);

-- ── Idempotency and submission provenance ────────────────────────────
--
-- The branch index above DOCUMENTS "at most one open task per request" and
-- has never once delivered it: prepare_work invents a fresh random nonce for
-- every branch name, so the index can only ever catch a nonce collision.
-- Production proved it — three OPEN rows for one request (#50 on app 156),
-- minted 15:29 / 16:02 / 17:35 UTC on 2026-08-07, each holding a slot of the
-- caller's open-work-order bound and each with a different branch the agent felt
-- obliged to rewrite its finished commit to match.
--
-- request_key is the key the behaviour actually needs: `issue:<n>` when the
-- work implements a numbered request, else `brief:<sha256 prefix>` of the
-- brief. prepare_work now looks it up and RETURNS the existing task instead
-- of minting a second one.
ALTER TABLE external_agent_tasks ADD COLUMN IF NOT EXISTS request_key TEXT;

-- How the submission actually reached GitHub, recorded so the 2026-08-07
-- failure is answerable from SQL alone next time:
--   branch           — the plain cross-fork create worked
--   branch_head_repo — it only worked once head_repo disambiguated the fork
--   mirror           — the fork branch had to be copied into the app's repo
--   patch            — the agent could not push at all and sent a patch
--   pr               — the caller named an already-open pull request
-- `branch` vs `branch_head_repo` is precisely the question "was the missing
-- head_repo parameter the whole bug?".
ALTER TABLE external_agent_tasks ADD COLUMN IF NOT EXISTS submitted_branch TEXT;
ALTER TABLE external_agent_tasks ADD COLUMN IF NOT EXISTS submitted_via TEXT;
ALTER TABLE external_agent_tasks ADD COLUMN IF NOT EXISTS submitted_source TEXT;
ALTER TABLE external_agent_tasks ADD COLUMN IF NOT EXISTS submitted_client_id TEXT;

-- Which existing proposal this work order UPDATES, when prepare_work was
-- called with a proposalId (#1054). NULL is the original behaviour: the work
-- order opens a NEW proposal. ON DELETE SET NULL because the task row is the
-- audit trail of what an agent was asked to do, and it outlives the proposal.
ALTER TABLE external_agent_tasks ADD COLUMN IF NOT EXISTS target_session_id BIGINT
  REFERENCES chat_sessions(id) ON DELETE SET NULL;

DO $$
BEGIN
  -- The update path adds two more values (#1054):
  --   update_branch    — the fork branch was pushed onto the proposal's
  --                      bot-owned branch in the app repo
  --   update_fork_head — the proposal's head already lived in the author's
  --                      fork, so advancing the tracked head WAS the write
  -- Widening a CHECK means replacing it, so this one constraint is dropped
  -- and recreated rather than added-if-absent. Safe on every boot: the new
  -- list is a superset, so no stored value can be excluded by it.
  ALTER TABLE external_agent_tasks DROP CONSTRAINT IF EXISTS external_agent_tasks_submitted_via_chk;
  ALTER TABLE external_agent_tasks ADD CONSTRAINT external_agent_tasks_submitted_via_chk
    CHECK (submitted_via IS NULL OR submitted_via IN (
      'branch','branch_head_repo','mirror','patch','pr','update_branch','update_fork_head'));
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'external_agent_tasks_submitted_source_chk'
  ) THEN
    ALTER TABLE external_agent_tasks ADD CONSTRAINT external_agent_tasks_submitted_source_chk
      CHECK (submitted_source IS NULL OR submitted_source IN ('work_order','assistant'));
  END IF;
END $$;

-- Forward-only backfill, same shape as the chat_sessions one below.
--
-- DEDUPE BEFORE BACKFILL, not after. Filling the key first would make two
-- open rows collide the moment they got their keys, which fails outright on
-- any boot where the unique index already exists — and this file is applied
-- on EVERY boot, not once. So the duplicate check computes the key inline
-- (`COALESCE(request_key, <what it would be>)`) and closes the losers first;
-- by the time the backfill runs, no two open rows can share a key.
--
-- Newest kept, because that is the one whose branch the agent actually
-- pushed — production's three rows for request #50 differ only in their
-- branch nonce, and only the last one exists on GitHub.
UPDATE external_agent_tasks t
SET status = 'abandoned'
WHERE t.status = 'open'
  AND EXISTS (
    SELECT 1 FROM external_agent_tasks newer
     WHERE newer.status = 'open'
       AND newer.user_id = t.user_id
       AND newer.app_id = t.app_id
       AND newer.id > t.id
       AND COALESCE(
             newer.request_key,
             CASE WHEN newer.issue_number IS NOT NULL
                  THEN 'issue:' || newer.issue_number::text
                  ELSE 'brief:' || substr(encode(sha256(convert_to(coalesce(newer.brief, ''), 'UTF8')), 'hex'), 1, 32)
             END
           ) = COALESCE(
             t.request_key,
             CASE WHEN t.issue_number IS NOT NULL
                  THEN 'issue:' || t.issue_number::text
                  ELSE 'brief:' || substr(encode(sha256(convert_to(coalesce(t.brief, ''), 'UTF8')), 'hex'), 1, 32)
             END
           )
  );

-- sha256 over the stored (already-trimmed) brief, hex, first 32 chars —
-- byte-identical to what services/external-agent-tasks.js computes, so a row
-- backfilled here is FOUND by the next prepare_work rather than duplicated.
UPDATE external_agent_tasks
SET request_key = CASE
      WHEN issue_number IS NOT NULL THEN 'issue:' || issue_number::text
      ELSE 'brief:' || substr(encode(sha256(convert_to(coalesce(brief, ''), 'UTF8')), 'hex'), 1, 32)
    END
WHERE request_key IS NULL;

-- At most one OPEN task per (user, app, request). This is the constraint the
-- branch index above was always meant to be.
CREATE UNIQUE INDEX IF NOT EXISTS external_agent_tasks_open_request_idx
  ON external_agent_tasks (user_id, app_id, request_key)
  WHERE status = 'open';

-- ── Generic agent backend (Codex/OpenRouter BYOK; plan.md PR1) ───────
-- chat_sessions today pins Claude continuity via cc_session_id. To add a
-- second coding-agent backend (codex_openrouter) without breaking the
-- Claude path, we generalize the session's agent configuration into its
-- own columns. Each field is nullable / defaulted so legacy rows stay on
-- claude_code with zero migration work; cc_session_id remains the source
-- of truth for existing Claude threads until PR8's legacy cleanup.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_backend            VARCHAR(32) NOT NULL DEFAULT 'claude_code';
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_provider           VARCHAR(32);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_model              VARCHAR(255);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_reasoning_effort   VARCHAR(16);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_thread_id          VARCHAR(128);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_config_version     INTEGER NOT NULL DEFAULT 1;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_context_reset_at   TIMESTAMPTZ;

-- Backfill: every existing session is a Claude session. Carry the Claude
-- continuity id into the generic agent_thread_id so backend-neutral code
-- can read one field for both backends, while cc_session_id remains
-- readable during the migration window (plan.md §5.4).
--
-- Gated with `agent_thread_id IS DISTINCT FROM cc_session_id` instead of
-- the old `agent_thread_id IS NULL`: rows whose thread already equals the
-- cc_session_id are skipped entirely, so a NULL->NULL rewrite (locks, WAL,
-- dead tuples) no longer happens on every boot.
UPDATE chat_sessions
SET agent_backend = 'claude_code',
    agent_provider = 'anthropic',
    agent_thread_id = cc_session_id
WHERE agent_backend = 'claude_code'
  AND (
    agent_thread_id IS DISTINCT FROM cc_session_id
    OR agent_provider IS DISTINCT FROM 'anthropic'
  );

-- ── Generic user AI credentials (plan.md PR2) ────────────────────────
-- Generalization of users.anthropic_key_enc/_last4 so a second provider
-- (openrouter) can be stored without stacking another pair of columns.
--
-- provider:  anthropic | openrouter
-- purpose:   coding_agent | app_llm
-- For this feature we add provider='openrouter', purpose='coding_agent'.
-- The encryption envelope is unchanged (secrets.js AES-256-GCM), so
-- existing Anthropic ciphertext can be copied in without decrypting.
--
-- On deletion we keep a tombstone row (status='revoked', secret_enc
-- cleared, revision incremented, revoked_at set) so session/audit
-- references stay safe; we never physically delete the row.
-- Credentials live in a dedicated PRIVATE schema (not `public`). The
-- prod-debug role bootstrap (src/services/debug-access.js) only sweeps
-- `public` (REVOKE/GRANT ALL TABLES IN SCHEMA public), so rolled-back
-- (old) code cannot re-grant SELECT on this table — the schema boundary
-- is rollback-persistent DB state, independent of the JS deny-list.
CREATE SCHEMA IF NOT EXISTS credentials;
CREATE TABLE IF NOT EXISTS credentials.user_ai_credentials (
  id                   BIGSERIAL PRIMARY KEY,
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider             VARCHAR(32) NOT NULL,
  purpose              VARCHAR(32) NOT NULL,
  secret_enc           TEXT,
  secret_last4         VARCHAR(8),
  secret_fingerprint   VARCHAR(64),
  status               VARCHAR(16) NOT NULL DEFAULT 'unverified',
  revision             INTEGER NOT NULL DEFAULT 1,
  verified_at          TIMESTAMPTZ,
  last_used_at         TIMESTAMPTZ,
  last_error_code      VARCHAR(64),
  revoked_at           TIMESTAMPTZ,
  metadata             JSONB NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_ai_credentials_provider_check
    CHECK (provider IN ('anthropic', 'openrouter')),
  CONSTRAINT user_ai_credentials_purpose_check
    CHECK (purpose IN ('coding_agent', 'app_llm')),
  -- status/verified_at coupling: a usable ('valid') row must carry a
  -- verified_at timestamp; non-valid rows must not claim verification.
  CONSTRAINT user_ai_credentials_valid_verified_check
    CHECK (
      (status = 'valid' AND verified_at IS NOT NULL)
      OR (status <> 'valid' AND verified_at IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS user_ai_credentials_unique_provider_purpose
  ON credentials.user_ai_credentials (user_id, provider, purpose);

-- Backfill existing Anthropic BYOK keys into the generic store. Because
-- the encryption envelope is unchanged we copy the existing ciphertext
-- as-is (no decrypt/re-encrypt). Seeds verified status; a key stored
-- on-file was verified at save time.
--
-- Rollback reconciliation (plan.md review F2): during the migration
-- window the LEGACY users.anthropic_key_* columns remain the source of
-- truth for the Anthropic coding-agent credential, because rolled-back
-- (old) code can only ever write those columns. Re-deriving the generic
-- row from legacy on every schema run guarantees rollback survival:
--
--   1. Where legacy ciphertext exists, we OVERWRITE the generic row from
--      it — even if the existing generic row is 'valid'. This reconciles a
--      stale generic key that a legacy-only replace changed during a
--      rollback (a plain `ON CONFLICT DO NOTHING`, or a guard that skips
--      valid rows, would keep the obsolete key usable).
--   2. Where legacy is NULL but a generic row is 'valid', the legacy side
--      (a delete during rollback, or a first-save that was never mirrored)
--      is authoritative: we REVOKE the generic row so a deleted key can
--      never be resurrected. Non-valid generic rows without legacy
--      (e.g. an unverified key kept generic-only) are left as non-usable
--      pending rows.
INSERT INTO credentials.user_ai_credentials
  (user_id, provider, purpose, secret_enc, secret_last4, status, verified_at, revision)
SELECT id, 'anthropic', 'coding_agent', anthropic_key_enc, anthropic_key_last4,
       'valid', NOW(), 1
FROM users
WHERE anthropic_key_enc IS NOT NULL
ON CONFLICT (user_id, provider, purpose) DO UPDATE SET
  secret_enc = EXCLUDED.secret_enc,
  secret_last4 = EXCLUDED.secret_last4,
  secret_fingerprint = NULL,
  status = EXCLUDED.status,
  verified_at = EXCLUDED.verified_at,
  revoked_at = NULL,
  revision = credentials.user_ai_credentials.revision + 1,
  updated_at = NOW()
-- Only touch the generic row when the legacy value actually differs, so
-- we never reset fingerprint / verified_at / revision on an unchanged
-- credential every restart (review F2).
WHERE credentials.user_ai_credentials.secret_enc IS DISTINCT FROM EXCLUDED.secret_enc;

-- Legacy delete must win over a previously-valid generic row: revoke any
-- generic anthropic/coding_agent row that is 'valid' while the legacy
-- column is absent (rolled-back delete, or a key that was never mirrored
-- to legacy). Non-valid rows (unverified/invalid/revoked) are untouched.
UPDATE credentials.user_ai_credentials g
SET secret_enc = NULL,
    secret_last4 = NULL,
    secret_fingerprint = NULL,
    status = 'revoked',
    -- valid_verified requires non-valid rows to carry verified_at NULL,
    -- so the tombstone must clear it or the UPDATE fails (breaking
    -- roll-forward after a rollback deletion).
    verified_at = NULL,
    revoked_at = NOW(),
    revision = g.revision + 1,
    updated_at = NOW()
WHERE g.provider = 'anthropic'
  AND g.purpose = 'coding_agent'
  AND g.status = 'valid'
  AND NOT EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = g.user_id
      AND u.anthropic_key_enc IS NOT NULL
  );

-- Mark credential-bearing columns for the staging:private scrubber
-- (same treatment the legacy users.anthropic_key_enc already gets).
COMMENT ON TABLE  credentials.user_ai_credentials IS 'staging:private';

-- ═══════════════════════════════════════════════════════════════════════
-- Profile customization (issue #982) — the editable half of the #profile
-- screen: a short bio and a profile picture.
-- ═══════════════════════════════════════════════════════════════════════

-- User-authored public bio, shown on the viewer's own #profile screen and
-- (once the follow-up lands) on their public builder page. Plain text, NOT
-- markdown — nothing renders it through marked/DOMPurify, so it is always
-- inserted as a text node. The ≤280-char cap is enforced in
-- src/routes/profile.js rather than as a DB constraint, matching how every
-- other user-authored text column on this table is handled. Deliberately
-- not `staging:private`: it is content the user publishes to other users.
--
-- `display_name`, `github` and `x` — the other three fields the profile
-- editor writes — already exist on this table (topochain Task 2 block
-- above) and are reused as-is; only the bio is new.
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;

-- Profile pictures, modelled column-for-column on `app_icons` above and
-- served the same way: GET /avatars/:id is mounted BEFORE authMiddleware
-- (src/routes/avatars.js) so a plain <img> renders with no auth dance, and
-- the unguessable 32-hex id is the only access control — an avatar
-- discloses only itself, and it is published to other users by design.
--
-- ONE ROW PER USER (user_id UNIQUE) and the id ROTATES on every upload:
-- POST /api/me/avatar upserts with `ON CONFLICT (user_id) DO UPDATE SET
-- id = EXCLUDED.id, …`, so the content-addressed URL changes whenever the
-- bytes do and the year-long immutable cache header stays safe. That also
-- means there is never an orphan row to sweep (contrast issue_screenshots,
-- which needs the 24h GC) — the UNIQUE + ON DELETE CASCADE cover it.
--
-- NOT staging:private, for the same reason as app_icons: avatars render on
-- shared surfaces and should survive into staging clones.
CREATE TABLE IF NOT EXISTS user_avatars (
  id           VARCHAR(32) PRIMARY KEY,
  user_id      INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type VARCHAR(32) NOT NULL,
  size_bytes   INTEGER     NOT NULL,
  data         BYTEA       NOT NULL,
  sha256       VARCHAR(64) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Public profiles (#582) extend the existing profile customization storage
-- above instead of creating a second display-name/bio/avatar record. Platform
-- username remains the canonical, immutable route key; publishing only makes
-- the already-user-authored display_name, bio and user_avatars row readable
-- through the explicit public allowlist in src/routes/profiles.js.
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_published BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_disabled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_disabled_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_disabled_reason VARCHAR(240);
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMPTZ;

-- Reports are private moderation material. One open report per reporter and
-- profile makes retries idempotent while allowing a later report after the
-- earlier one is resolved or dismissed. Account deletion removes both sides
-- of the identity edge; resolved_by is audit attribution and may become NULL.
CREATE TABLE IF NOT EXISTS profile_reports (
  id               BIGSERIAL PRIMARY KEY,
  profile_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reporter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason           VARCHAR(32) NOT NULL CHECK (reason IN ('impersonation', 'harassment', 'spam', 'unsafe_avatar', 'other')),
  detail           VARCHAR(500),
  status           VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ,
  resolved_by      INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_reports_open_reporter
  ON profile_reports (profile_user_id, reporter_user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_profile_reports_status_created
  ON profile_reports (status, created_at DESC, id DESC);
COMMENT ON TABLE profile_reports IS 'staging:private';
COMMENT ON COLUMN users.profile_disabled_reason IS 'staging:private';

-- ═══════════════════════════════════════════════════════════════════════
-- Email-based password reset (magic link from the #login recovery screen).
-- ═══════════════════════════════════════════════════════════════════════

-- Single outstanding reset token per user, modelled on wallet_link_token
-- above: the column holds the sha256 hex of a 32-byte token that only ever
-- travels inside the emailed link (/#reset-password?token=…), so a DB read
-- alone can never redeem a reset. Minted by POST
-- /api/auth/password-reset/request only for non-admin accounts with a
-- CONFIRMED email (admins keep the admin-issued temporary-password path —
-- the same email-control-must-not-equal-admin-takeover stance as the
-- mobile OTP guard in src/routes/topochain/mobile-auth.js), consumed and
-- cleared by POST /api/auth/password-reset/confirm, which runs
-- accountRecovery() so every session and CLI authorization dies with the
-- old password.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_hash VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN users.password_reset_token_hash IS 'staging:private';
COMMENT ON COLUMN users.password_reset_expires_at IS 'staging:private';

-- ── OpenRouter BYOK with Codex — full feature (plan.md PR3+) ────────
-- All additions are idempotent and live alongside the merged foundation
-- (PR #943: chat_sessions.agent_* + credentials.user_ai_credentials).

-- Per-user per-backend agent preferences (model, reasoning effort, cost
-- ceiling, which backend is the default). One row per (user_id, backend).
CREATE TABLE IF NOT EXISTS user_agent_preferences (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  backend            VARCHAR(32) NOT NULL,
  model_id           VARCHAR(255),
  reasoning_effort   VARCHAR(16),
  max_turn_cost_usd  NUMERIC(18,8),
  is_default         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, backend),
  CONSTRAINT user_agent_preferences_backend_check
    CHECK (backend IN ('claude_code', 'codex_openrouter')),
  CONSTRAINT user_agent_preferences_reasoning_check
    CHECK (reasoning_effort IS NULL
           OR reasoning_effort IN ('minimal', 'low', 'medium', 'high', 'xhigh')),
  -- Cost ceiling (review #7): reject negatives at the DB so a buggy client
  -- cannot store a value that disables the cap. The cap is advisory (the
  -- platform does not mediate direct Codex requests), but it must still be
  -- a sane nonnegative number.
  CONSTRAINT user_agent_preferences_cost_check
    CHECK (max_turn_cost_usd IS NULL OR max_turn_cost_usd >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_agent_preferences_one_default
  ON user_agent_preferences (user_id) WHERE is_default = TRUE;

-- Durable per-turn ledger for multi-provider usage, retries, and proxy
-- settlement. Idempotent settlement keys on the turn id.
CREATE TABLE IF NOT EXISTS agent_turns (
  id                       UUID PRIMARY KEY,
  session_id               BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id                  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  backend                  VARCHAR(32) NOT NULL,
  provider                 VARCHAR(32),
  requested_model          VARCHAR(255),
  routed_model             VARCHAR(255),
  routed_provider          VARCHAR(128),
  reasoning_effort         VARCHAR(16),
  credential_id            BIGINT REFERENCES credentials.user_ai_credentials(id),
  credential_revision      INTEGER,
  agent_thread_id          VARCHAR(128),
  agent_config_version     INTEGER NOT NULL DEFAULT 1,
  status                   VARCHAR(24) NOT NULL,
  input_tokens             BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens      BIGINT NOT NULL DEFAULT 0,
  cache_write_input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens            BIGINT NOT NULL DEFAULT 0,
  reasoning_output_tokens  BIGINT NOT NULL DEFAULT 0,
  actual_cost_usd          NUMERIC(18,8) NOT NULL DEFAULT 0,
  estimated_cost_usd       NUMERIC(18,8),
  cost_source              VARCHAR(32),
  billed_by                VARCHAR(32),
  logical_turn_id          UUID,
  attempt_number           INTEGER NOT NULL DEFAULT 1,
  provider_input_tokens_total          BIGINT,
  provider_cached_input_tokens_total   BIGINT,
  provider_cache_write_input_tokens_total BIGINT,
  provider_output_tokens_total         BIGINT,
  provider_reasoning_output_tokens_total BIGINT,
  usage_reset_detected     BOOLEAN NOT NULL DEFAULT FALSE,
  error_code               VARCHAR(64),
  error_detail             TEXT,
  started_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at             TIMESTAMPTZ,
  metadata                 JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_agent_turns_session
  ON agent_turns (session_id, started_at);
-- Idempotent upgrade (review P7): an environment that already applied a
-- preceding PR revision has agent_turns without agent_config_version, and
-- CREATE TABLE IF NOT EXISTS is a no-op there. This ALTER covers that path.
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS agent_config_version INTEGER NOT NULL DEFAULT 1;
-- Commit 4 (plan §6): per-attempt + cumulative provider totals.
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS logical_turn_id UUID;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS attempt_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS cache_write_input_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS provider_input_tokens_total BIGINT;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS provider_cached_input_tokens_total BIGINT;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS provider_cache_write_input_tokens_total BIGINT;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS provider_output_tokens_total BIGINT;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS provider_reasoning_output_tokens_total BIGINT;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC(18,8);
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS usage_reset_detected BOOLEAN NOT NULL DEFAULT FALSE;
-- Backfill legacy single-turn rows: a lone row IS its own logical turn.
UPDATE agent_turns SET logical_turn_id = id WHERE logical_turn_id IS NULL AND attempt_number = 1;
-- One physical Codex invocation = one attempt under a logical turn.
CREATE UNIQUE INDEX IF NOT EXISTS agent_turns_logical_attempt_unique
  ON agent_turns (logical_turn_id, attempt_number)
  WHERE logical_turn_id IS NOT NULL;

-- Durable idempotency receipts for replayable post-agent work. A platform
-- restart may re-enter a turn tail, but a stable (turn_id, effect_key) means
-- database-local effects (spend settlement, cards, notifications, terminal
-- state) can be committed exactly once in the same transaction as the
-- receipt. External effects use pending/completed plus reconciliation.
CREATE TABLE IF NOT EXISTS turn_effects (
  turn_id       UUID NOT NULL,
  effect_key    VARCHAR(96) NOT NULL,
  session_id    BIGINT REFERENCES chat_sessions(id) ON DELETE CASCADE,
  state         VARCHAR(16) NOT NULL DEFAULT 'pending',
  result        JSONB,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (turn_id, effect_key),
  CONSTRAINT turn_effects_state_check
    CHECK (state IN ('pending', 'completed', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_turn_effects_session
  ON turn_effects (session_id, started_at);
-- Nonnegativity (idempotent DO blocks; an already-created table will not
-- pick up constraints from CREATE TABLE IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_turns_provider_totals_nonneg') THEN
    ALTER TABLE agent_turns ADD CONSTRAINT agent_turns_provider_totals_nonneg CHECK (
      provider_input_tokens_total IS NULL OR provider_input_tokens_total >= 0
    );
  END IF;
END$$;

-- Compatibility overlay: verified / experimental / blocked per model.
CREATE TABLE IF NOT EXISTS agent_model_compatibility (
  backend             VARCHAR(32) NOT NULL,
  model_id            VARCHAR(255) NOT NULL,
  status              VARCHAR(16) NOT NULL,
  minimum_cli_version VARCHAR(32),
  note                TEXT,
  checked_at          TIMESTAMPTZ,
  PRIMARY KEY (backend, model_id)
);

-- Seed a verified Codex model as the recommended first-run choice.
-- Compatibility is advisory: every model in the user's OpenRouter catalog
-- remains selectable, while operators can mark known-good models here.
INSERT INTO agent_model_compatibility (backend, model_id, status, note, checked_at)
VALUES ('codex_openrouter', 'openai/gpt-5.3-codex', 'verified', 'Default verified Codex model', NOW())
ON CONFLICT (backend, model_id) DO NOTHING;

-- AI-generated progress report cache (Reporting tab). One row per app —
-- the summary is shared by every viewer, which is why its input is built
-- exclusively from data every app member can see (no private sessions).
-- input_hash fingerprints the server-built input so an unchanged app
-- returns the cache without an LLM call and the client can show a
-- "data changed" staleness hint.
CREATE TABLE IF NOT EXISTS app_report_ai (
  app_id        INTEGER PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  input_hash    VARCHAR(64) NOT NULL,
  narrative     TEXT NOT NULL,
  risks_json    JSONB NOT NULL DEFAULT '[]'::jsonb,
  owners_json   JSONB NOT NULL DEFAULT '[]'::jsonb,
  model         VARCHAR(64),
  generated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bullet-point progress highlights for the AI report summary
-- (report-lock-share). Additive to the existing app_report_ai row; old
-- rows default to an empty list and render without the section.
ALTER TABLE app_report_ai ADD COLUMN IF NOT EXISTS highlights_json JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Report period start (reporting-period). The start date the cached
-- summary was generated for — NULL means "all history". The cache is one
-- shared row per app, so recording the period keeps the summary honest
-- about what it covers when members select different periods.
ALTER TABLE app_report_ai ADD COLUMN IF NOT EXISTS period_start TIMESTAMPTZ;

-- Locked report snapshots (report-lock-share). Locking freezes the
-- client's self-contained standalone report document as an immutable
-- dated row; the draft cache above keeps being overwritten. html is
-- untrusted user content and is only ever served under a sandbox CSP.
-- ai_json is the SERVER's own draft summary at lock time — it feeds the
-- next generation's "previousReport" input, so it must never come from
-- the client. share_token (32-hex, crypto-random) is the sole access
-- control on the public /reports/:token route; NULL means not shared,
-- and unsharing nulls it again so revoked links 404.
CREATE TABLE IF NOT EXISTS app_report_snapshots (
  id           SERIAL PRIMARY KEY,
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  html         TEXT NOT NULL,
  ai_json      JSONB,
  locked_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  locked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  share_token  VARCHAR(64) UNIQUE,
  shared_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_app_report_snapshots_app
  ON app_report_snapshots (app_id, locked_at DESC);

-- Platform-wide private messaging (#488). This domain is deliberately
-- separate from app-scoped `chat_messages`: membership, consent, blocks,
-- retention, and realtime audiences are all platform-user concerns.
CREATE TABLE IF NOT EXISTS conversations (
  id         SERIAL PRIMARY KEY,
  kind       VARCHAR(16) NOT NULL CHECK (kind IN ('direct', 'group')),
  title      VARCHAR(80),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status     VARCHAR(16) NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (kind = 'direct' AND title IS NULL)
    OR (kind = 'group' AND title IS NOT NULL AND BTRIM(title) <> '')
  )
);

-- Direct conversations have one canonical unordered user pair. The service
-- also takes a transaction-scoped advisory lock on the normalized pair;
-- this unique constraint is the final race-proof backstop.
CREATE TABLE IF NOT EXISTS conversation_direct_pairs (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  user_low_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  CHECK (user_low_id < user_high_id),
  UNIQUE (user_low_id, user_high_id)
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id     INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                VARCHAR(16) NOT NULL DEFAULT 'member'
                        CHECK (role IN ('owner', 'member')),
  status              VARCHAR(16) NOT NULL DEFAULT 'invited'
                        CHECK (status IN ('invited', 'member', 'declined', 'left', 'removed')),
  invited_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at        TIMESTAMPTZ,
  joined_at           TIMESTAMPTZ,
  left_at             TIMESTAMPTZ,
  last_read_message_id INTEGER,
  PRIMARY KEY (conversation_id, user_id),
  CHECK (role <> 'owner' OR status IN ('member', 'left', 'removed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_members_active_owner
  ON conversation_members (conversation_id)
  WHERE role = 'owner' AND status = 'member';
CREATE INDEX IF NOT EXISTS idx_conversation_members_user_active
  ON conversation_members (user_id, conversation_id)
  WHERE status IN ('member', 'invited');

CREATE TABLE IF NOT EXISTS conversation_messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  content         TEXT NOT NULL DEFAULT '',
  msg_type        VARCHAR(24) NOT NULL DEFAULT 'message'
                    CHECK (msg_type IN ('message', 'system')),
  reply_to_id     INTEGER REFERENCES conversation_messages(id) ON DELETE SET NULL,
  idempotency_key VARCHAR(64),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at       TIMESTAMPTZ,
  CHECK (char_length(content) <= 8000)
);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_page
  ON conversation_messages (conversation_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_reply
  ON conversation_messages (reply_to_id) WHERE reply_to_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_idempotency
  ON conversation_messages (conversation_id, sender_id, idempotency_key)
  WHERE sender_id IS NOT NULL AND idempotency_key IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'conversation_members'::regclass
       AND conname = 'conversation_members_last_read_message_id_fkey'
  ) THEN
    ALTER TABLE conversation_members
      ADD CONSTRAINT conversation_members_last_read_message_id_fkey
      FOREIGN KEY (last_read_message_id)
      REFERENCES conversation_messages(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS conversation_message_reactions (
  id         SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      VARCHAR(16) NOT NULL CHECK (BTRIM(emoji) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_conversation_reactions_message
  ON conversation_message_reactions (message_id);

-- Upload-before-send, like app group chat. Unlinked rows remain readable
-- only to their uploader and are eligible for orphan collection after 24h.
CREATE TABLE IF NOT EXISTS conversation_message_attachments (
  id              VARCHAR(32) PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      INTEGER REFERENCES conversation_messages(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind            VARCHAR(16) NOT NULL
                    CHECK (kind IN ('image', 'markdown', 'html', 'text', 'binary')),
  filename        VARCHAR(256) NOT NULL,
  content_type    VARCHAR(128) NOT NULL,
  size_bytes      INTEGER NOT NULL CHECK (size_bytes > 0),
  meta            JSONB,
  data            BYTEA NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversation_attachments_message
  ON conversation_message_attachments (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_attachments_orphan
  ON conversation_message_attachments (created_at) WHERE message_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_attachments_storage
  ON conversation_message_attachments (conversation_id, user_id);

-- Repair any database that applied an earlier draft where deleting the
-- uploader cascaded linked attachment evidence.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'conversation_message_attachments'::regclass
       AND attname = 'user_id' AND attnotnull
  ) THEN
    ALTER TABLE conversation_message_attachments ALTER COLUMN user_id DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'conversation_message_attachments'::regclass
       AND conname = 'conversation_message_attachments_user_id_fkey'
       AND confdeltype <> 'n'
  ) THEN
    ALTER TABLE conversation_message_attachments
      DROP CONSTRAINT conversation_message_attachments_user_id_fkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'conversation_message_attachments'::regclass
       AND conname = 'conversation_message_attachments_user_id_fkey'
  ) THEN
    ALTER TABLE conversation_message_attachments
      ADD CONSTRAINT conversation_message_attachments_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- One typed, canonical platform-object reference per message. Display fields
-- are never stored here: hydration derives them through the viewer's current
-- authorization and returns one generic unavailable shape on any denial.
CREATE TABLE IF NOT EXISTS conversation_message_objects (
  id             SERIAL PRIMARY KEY,
  message_id     INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  position       SMALLINT NOT NULL DEFAULT 0 CHECK (position >= 0 AND position < 8),
  object_type    VARCHAR(24) NOT NULL CHECK (object_type IN (
                   'app', 'github_issue', 'code_proposal',
                   'governance_proposal', 'spec'
                 )),
  app_id         INTEGER REFERENCES apps(id) ON DELETE SET NULL,
  object_ref     INTEGER NOT NULL CHECK (object_ref > 0),
  object_version INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (object_type = 'spec' AND object_version IS NOT NULL AND object_version > 0)
    OR (object_type <> 'spec' AND object_version IS NULL)
  ),
  CHECK (object_type <> 'app' OR app_id IS NULL OR object_ref = app_id),
  UNIQUE (message_id, position)
);
CREATE INDEX IF NOT EXISTS idx_conversation_objects_message
  ON conversation_message_objects (message_id, position);
CREATE INDEX IF NOT EXISTS idx_conversation_objects_app
  ON conversation_message_objects (app_id, object_type, object_ref);

-- Sharing an exact immutable spec version into a conversation grants it to
-- current members. Membership is checked at every read, so leaving/removal
-- immediately revokes both retained-history and full-spec access.
CREATE TABLE IF NOT EXISTS chat_session_spec_conversation_shares (
  session_id      INTEGER NOT NULL,
  version         INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  shared_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, version, conversation_id),
  FOREIGN KEY (session_id, version)
    REFERENCES chat_session_specs(session_id, version) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_spec_conversation_shares_conversation
  ON chat_session_spec_conversation_shares (conversation_id, created_at DESC);

-- Blocks are global and directional. Either direction prevents a new direct
-- request, direct acceptance/sending, and a new group invitation; an existing
-- shared group is intentionally not disrupted or used to reveal block state.
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_user_id),
  CHECK (blocker_id <> blocked_user_id)
);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked
  ON user_blocks (blocked_user_id, blocker_id);

-- Reports retain immutable evidence even when the author later edits the
-- live message. One pending report per reporter/message makes retries safe.
CREATE TABLE IF NOT EXISTS conversation_message_reports (
  id                BIGSERIAL PRIMARY KEY,
  conversation_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id        INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  reporter_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reported_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason            VARCHAR(32) NOT NULL CHECK (reason IN (
                      'harassment', 'spam', 'threats', 'hate', 'sexual_content', 'other'
                    )),
  detail            VARCHAR(500),
  content_snapshot  TEXT NOT NULL,
  evidence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  status            VARCHAR(16) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'resolved', 'dismissed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,
  resolved_by       INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_reports_pending
  ON conversation_message_reports (message_id, reporter_user_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_conversation_reports_queue
  ON conversation_message_reports (status, created_at DESC, id DESC);

-- Repair earlier drafts for immutable abuse evidence as well: account
-- deletion removes attribution, never the retained report snapshot.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'conversation_message_reports'::regclass
       AND attname IN ('reporter_user_id', 'reported_user_id') AND attnotnull
  ) THEN
    ALTER TABLE conversation_message_reports ALTER COLUMN reporter_user_id DROP NOT NULL;
    ALTER TABLE conversation_message_reports ALTER COLUMN reported_user_id DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'conversation_message_reports'::regclass
       AND conname = 'conversation_message_reports_reporter_user_id_fkey'
       AND confdeltype <> 'n'
  ) THEN
    ALTER TABLE conversation_message_reports
      DROP CONSTRAINT conversation_message_reports_reporter_user_id_fkey;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'conversation_message_reports'::regclass
       AND conname = 'conversation_message_reports_reported_user_id_fkey'
       AND confdeltype <> 'n'
  ) THEN
    ALTER TABLE conversation_message_reports
      DROP CONSTRAINT conversation_message_reports_reported_user_id_fkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'conversation_message_reports'::regclass
       AND conname = 'conversation_message_reports_reporter_user_id_fkey'
  ) THEN
    ALTER TABLE conversation_message_reports
      ADD CONSTRAINT conversation_message_reports_reporter_user_id_fkey
      FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'conversation_message_reports'::regclass
       AND conname = 'conversation_message_reports_reported_user_id_fkey'
  ) THEN
    ALTER TABLE conversation_message_reports
      ADD CONSTRAINT conversation_message_reports_reported_user_id_fkey
      FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Conversation notifications coexist with app-chat notifications. Dedicated
-- kinds avoid app routing/category collisions; both references remain nullable
-- for every pre-existing notification kind.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS conversation_id
  INTEGER REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS conversation_message_id
  INTEGER REFERENCES conversation_messages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_notifications_conversation
  ON notifications (conversation_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_conversation_message
  ON notifications (conversation_message_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_conversation_unread
  ON notifications (user_id, conversation_id, created_at DESC)
  WHERE read_at IS NULL AND conversation_id IS NOT NULL;

COMMENT ON TABLE conversations IS 'staging:private';
COMMENT ON TABLE conversation_direct_pairs IS 'staging:private';
COMMENT ON TABLE conversation_members IS 'staging:private';
COMMENT ON TABLE conversation_messages IS 'staging:private';
COMMENT ON TABLE conversation_message_reactions IS 'staging:private';
COMMENT ON TABLE conversation_message_attachments IS 'staging:private';
COMMENT ON TABLE conversation_message_objects IS 'staging:private';
COMMENT ON TABLE chat_session_spec_conversation_shares IS 'staging:private';
COMMENT ON TABLE user_blocks IS 'staging:private';
COMMENT ON TABLE conversation_message_reports IS 'staging:private';

-- Account deletion must not strand a group without an owner or erase retained
-- conversation history. This centralized BEFORE DELETE trigger covers every
-- admin/account-deletion path before participant FKs cascade: group ownership
-- moves deterministically to the oldest active member, empty groups and all
-- direct conversations are archived, and linked attachment/report evidence
-- keeps its content with nullable attribution.
CREATE OR REPLACE FUNCTION prepare_conversations_for_user_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  owned RECORD;
  successor_id INTEGER;
BEGIN
  -- Unsent uploads have no retained conversation evidence. Remove those
  -- immediately; linked bytes keep their row and lose only attribution via
  -- the nullable ON DELETE SET NULL foreign key below.
  DELETE FROM conversation_message_attachments
   WHERE user_id = OLD.id AND message_id IS NULL;

  FOR owned IN
    SELECT c.id
      FROM conversations c
      JOIN conversation_members cm ON cm.conversation_id = c.id
     WHERE c.kind = 'group' AND c.status = 'active'
       AND cm.user_id = OLD.id AND cm.status = 'member' AND cm.role = 'owner'
     FOR UPDATE OF c, cm
  LOOP
    SELECT cm.user_id INTO successor_id
      FROM conversation_members cm
     WHERE cm.conversation_id = owned.id
       AND cm.user_id <> OLD.id AND cm.status = 'member'
     ORDER BY cm.joined_at NULLS LAST, cm.created_at, cm.user_id
     LIMIT 1
     FOR UPDATE;

    UPDATE conversation_members
       SET role = 'member', status = 'removed', left_at = NOW()
     WHERE conversation_id = owned.id AND user_id = OLD.id;

    IF successor_id IS NULL THEN
      UPDATE conversation_members
         SET status = 'declined', responded_at = NOW()
       WHERE conversation_id = owned.id AND status = 'invited';
      DELETE FROM notifications WHERE conversation_id = owned.id;
      UPDATE conversations SET status = 'archived', updated_at = NOW()
       WHERE id = owned.id;
    ELSE
      UPDATE conversation_members SET role = 'owner'
       WHERE conversation_id = owned.id AND user_id = successor_id;
      UPDATE conversations SET updated_at = NOW() WHERE id = owned.id;
    END IF;
  END LOOP;

  UPDATE conversations c
     SET status = 'archived', updated_at = NOW()
   WHERE c.kind = 'direct' AND c.status = 'active'
     AND EXISTS (
       SELECT 1 FROM conversation_direct_pairs p
        WHERE p.conversation_id = c.id
          AND (p.user_low_id = OLD.id OR p.user_high_id = OLD.id)
     );
  DELETE FROM notifications n
   USING conversation_direct_pairs p
   WHERE n.conversation_id = p.conversation_id
     AND (p.user_low_id = OLD.id OR p.user_high_id = OLD.id);
  RETURN OLD;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'users_prepare_conversations_for_delete'
       AND tgrelid = 'users'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER users_prepare_conversations_for_delete
      BEFORE DELETE ON users
      FOR EACH ROW EXECUTE FUNCTION prepare_conversations_for_user_delete();
  END IF;
END $$;
