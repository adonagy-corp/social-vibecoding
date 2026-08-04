const { Router } = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getPool } = require('../db/pool');
const { adminMiddleware, requireAdminWrite } = require('../middleware/admin');
const { dbExportLimiter, mailTestLimiter } = require('../middleware/rate-limits');
const { clientIp } = require('../services/client-ip');
const { drainGuard } = require('../services/lifecycle');
const log = require('../services/logger');
const limits = require('../services/limits');
const anthropicCredits = require('../services/anthropic-credits');
const dbExport = require('../services/db-export');
const events = require('../services/events');
const llmTelemetry = require('../services/llm-telemetry');
const appRollover = require('../services/app-rollover');
const stagingReap = require('../services/staging-reap');
const stagingEnv = require('../services/staging-env');
const mail = require('../services/mail');
const mobilePushDiagnostics = require('../services/mobile-push-diagnostics');
const {
  accountRecovery,
  withTransaction,
} = require('../services/cli-auth');

// Fixed app-wide key for pg_advisory_xact_lock, dedicated to admin-status
// mutations (revoke-admin and delete-user). Any code path that could drop
// the admin count must take this lock inside its transaction so the
// "at least one admin must remain" invariant is checked and committed
// atomically — two concurrent revokes/deletes can't both observe >1 admin
// and race to zero. Now shared with the platform-variable writes in
// routes/apps.js, which is why the number lives in one module.
const { ADMIN_MUTATION_LOCK } = require('../services/advisory-locks');

// Staging mock data (#555): ANTHROPIC_ADMIN_KEY is unset in staging and
// the credit balance is a platform_settings row nobody will have recorded
// there, so the "Anthropic credits" row would read "Not set up" in every
// preview. See the ?demo=1 branch on GET /api/admin/anthropic-credits.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

function adminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.use('/api/admin', adminMiddleware);

  // #717: content-free usage baseline across Mayor/helper calls and coding
  // agents. Read-only and aggregate-only; view-only admins may inspect it.
  router.get('/api/admin/llm-telemetry', async (req, res) => {
    const rawDays = req.query.days == null ? '14' : String(req.query.days);
    if (!/^\d+$/.test(rawDays)) {
      return res.status(400).json({
        error: `days must be an integer between 1 and ${llmTelemetry.MAX_REPORT_DAYS}`,
      });
    }
    const days = Number(rawDays);
    if (days < 1 || days > llmTelemetry.MAX_REPORT_DAYS) {
      return res.status(400).json({
        error: `days must be an integer between 1 and ${llmTelemetry.MAX_REPORT_DAYS}`,
      });
    }
    try {
      return res.json(await llmTelemetry.aggregateReport(pool, { days }));
    } catch (err) {
      log.warn('admin', 'LLM telemetry aggregate failed', {
        code: err && err.code ? String(err.code).slice(0, 64) : 'query_failed',
      });
      return res.status(500).json({ error: 'Could not load LLM telemetry' });
    }
  });

  // ── Operations Overview ────────────────────────────────────
  //
  // A lightweight summary for the admin dashboard. The full tree lives on
  // `/status` (admin-gated sections there); this just surfaces the numbers
  // that warrant "something's wrong, go look" follow-up.
  router.get('/api/admin/overview', async (_req, res) => {
    try {
      const status = require('../services/status');
      const data = await status.gather(config, { isAdmin: true });

      const stuckApps = (data.apps || [])
        .filter((a) => a.dbStatus === 'creating' || a.dbStatus === 'error')
        .map((a) => ({
          id: a.id,
          name: a.name,
          slug: a.slug,
          dbStatus: a.dbStatus,
          createdBy: a.createdBy,
          createdAt: a.createdAt,
        }));

      const orphanWorkers = (data.workers || [])
        .filter((w) => w.orphan)
        .map((w) => ({
          name: w.name,
          sessionId: w.sessionId,
          appSlug: w.appSlug,
          uptimeSeconds: w.uptimeSeconds,
          sessionArchived: w.sessionArchived,
        }));

      const llmUsage = data.llmUsage || [];
      const totalSpendCents = llmUsage.reduce((sum, u) => sum + (u.costCents || 0), 0);

      res.json({
        stuckApps,
        orphanWorkers,
        llmToday: {
          totalSpendCents,
          users: llmUsage,
        },
      });
    } catch (err) {
      log.error('admin', 'Overview failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Mobile push diagnostics ────────────────────────────────
  //
  // Read-only operational visibility over the private push tables. The
  // response deliberately excludes encrypted registrations, token hashes,
  // service-account material and APNs credentials. View-only admins may use
  // it: diagnosing a device is observation, not a provider mutation.
  router.get('/api/admin/mobile-push/diagnostics', async (req, res) => {
    try {
      const data = await mobilePushDiagnostics.gather(pool, req.query.user);
      res.json({
        runtime: {
          enabled: config.mobilePushEnabled === true,
          environment: config.mobilePushEnvironment || null,
          firebaseProjectId: config.firebaseProjectId || null,
        },
        ...data,
      });
    } catch (err) {
      if (err instanceof mobilePushDiagnostics.MobilePushDiagnosticsInputError) {
        return res.status(400).json({ error: err.message });
      }
      log.error('admin', 'Mobile push diagnostics failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Container rollover ─────────────────────────────────────
  //
  // Recreate every running child-app container with freshly assembled env
  // (see services/app-rollover.js for why an env change needs a container
  // recreate at all). Fire-and-forget with a progress feed: POST answers
  // 202 with the job record and the docker work runs on a detached
  // promise, exactly like POST /api/apps/:slug/redeploy.

  router.post('/api/admin/rollover', requireAdminWrite, drainGuard, async (req, res) => {
    try {
      // A staging preview has no production containers to roll over (and
      // no docker socket to reach them with). An explicit refusal beats a
      // sweep that fails 35 times.
      if (appRollover.isStagingEnv()) {
        return res.status(400).json({
          error: 'Container rollover is unavailable in staging previews.',
        });
      }
      const { started, job } = appRollover.start(config, {
        userId: req.user.id,
        username: req.user.username,
      });
      if (!started) {
        return res.status(409).json({ error: 'Rollover already in progress', job });
      }
      // warn-level: a fleet-wide container recreate is worth finding in
      // the logs later, same stance as the db-export audit lines.
      log.warn('admin', 'Container rollover started', {
        by: req.user.username, jobId: job.id, total: job.total,
      });
      res.status(202).json({ job });
    } catch (err) {
      log.error('admin', 'Rollover kickoff failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Read-only, so it stays on the plain adminMiddleware gate — view-only
  // admins can watch a rollover, they just can't start one. This is the
  // page-load + WS-reconnect source of truth (the job lives in memory,
  // exactly like app-deploy-status).
  router.get('/api/admin/rollover', async (req, res) => {
    try {
      // Staging mock data (request-time demo injection): a preview has no
      // real job to show, so the console section would screenshot empty.
      // Never persisted, strictly a no-op outside staging.
      if (appRollover.isStagingEnv() && req.query.demo === '1') {
        return res.json({ job: appRollover.demoJob(), eligible: 5, demo: true });
      }
      const eligible = await appRollover.eligibleCount(config).catch(() => null);
      res.json({
        job: appRollover.read(),
        eligible,
        concurrency: appRollover.concurrency(),
      });
    } catch (err) {
      log.error('admin', 'Rollover status failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Stale staging previews ─────────────────────────────────
  //
  // The preview half of the rollover above. A preview's env is assembled by
  // the platform build that was deployed when it was BUILT, and previews
  // live for weeks — so a platform env change leaves them running happily
  // with stale env. This tears them down; the next Preview click rebuilds any
  // that someone actually wants, with current env, through the existing
  // ensure-staging path. See services/staging-reap.js for the full rationale.
  //
  // #851: staleness is now detected automatically (an env-fingerprint label,
  // services/staging-env.js) and swept on a background pass, so this button
  // is no longer the only remedy — it is the BIGGER HAMMER: it tears down
  // every preview it can enumerate, stale or not, without waiting out the
  // pass's interval. The GET reports the automatic pass's last run so an
  // admin can tell whether pressing it is even necessary.

  router.post('/api/admin/staging-reap', requireAdminWrite, drainGuard, async (req, res) => {
    try {
      // This fleet-wide inventory sweep is Docker-specific. Kubernetes
      // previews are managed through their runtime records instead of a
      // Docker socket, so do not report a misleading successful no-op.
      if (stagingReap.isStagingEnv() || (config.appRuntime && config.appRuntime !== 'docker')) {
        return res.status(400).json({
          error: 'The Docker stale-preview sweep is unavailable in this runtime.',
        });
      }
      const { started, job } = stagingReap.start(config, {
        userId: req.user.id,
        username: req.user.username,
      });
      if (!started) {
        return res.status(409).json({ error: 'Sweep already in progress', job });
      }
      // warn-level: a fleet-wide preview teardown is worth finding in the
      // logs later, same stance as the rollover above.
      log.warn('admin', 'Stale preview sweep started', {
        by: req.user.username, jobId: job.id, total: job.total,
      });
      res.status(202).json({ job });
    } catch (err) {
      log.error('admin', 'Stale preview sweep kickoff failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Read-only, so it stays on the plain adminMiddleware gate — view-only
  // admins can watch a sweep, they just can't start one.
  router.get('/api/admin/staging-reap', async (req, res) => {
    try {
      // Staging mock data (request-time demo injection): a preview has no
      // docker socket, so this section would screenshot empty. Never
      // persisted, strictly a no-op outside staging.
      // `staging` is reported independently of `demo`: the POST is refused in
      // a preview whether or not the reviewer arrived with ?demo=1, so the
      // button must be able to say so either way.
      const staging = stagingReap.isStagingEnv();
      if (staging && req.query.demo === '1') {
        return res.json({
          job: stagingReap.demoJob(),
          ...stagingReap.demoCounts(),
          demo: true,
          staging,
          concurrency: stagingReap.concurrency(),
        });
      }
      // `open` is every preview the manual button would shut down; `stale` is
      // the subset the automatic pass (#851) considers out of date. Both come
      // from one docker call. `stale` is kept as the legacy field name the
      // console's confirm dialog already reads — see the note below.
      const counts = await stagingReap.previewCounts(config).catch(() => ({ open: null, stale: null }));
      res.json({
        job: stagingReap.read(),
        open: counts.open,
        stale: counts.stale,
        expectedFingerprint: stagingEnv.expectedStagingFingerprint(config),
        automatic: stagingReap.readAutomatic(),
        staging,
        concurrency: stagingReap.concurrency(),
      });
    } catch (err) {
      log.error('admin', 'Stale preview status failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Users ──────────────────────────────────────────────────

  router.get('/api/admin/users', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT u.id, u.username, u.is_admin, u.admin_readonly, u.app_quota, u.created_at,
                u.daily_limit_cents, u.usernode_pubkey,
                (u.id = $1) AS is_self,
                ac.code as activation_code,
                COALESCE(lu.total_cost_cents, 0) as cost_today_cents,
                COALESCE(ac2.n, 0) AS apps_created
         FROM users u
         LEFT JOIN activation_codes ac ON ac.used_by = u.id
         LEFT JOIN llm_usage lu ON lu.user_id = u.id AND lu.date = CURRENT_DATE
         LEFT JOIN (
           SELECT created_by, COUNT(*) FILTER (WHERE status <> 'error') AS n
           FROM apps
           GROUP BY created_by
         ) ac2 ON ac2.created_by = u.id
         ORDER BY u.created_at ASC`,
        [req.user.id]
      );
      res.json(rows);
    } catch (err) {
      log.error('admin', 'List users failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Bulk set every user's app-creation quota (see users.app_quota in
  // schema.sql). Body `{ quota }` — a non-negative integer applied to ALL
  // users. Admins are included; since they bypass enforcement this is
  // harmless and keeps the operation simple ("set all to 0", "set all to
  // 3"). Declared BEFORE the per-user `:id` route below: Express matches
  // this distinctly (different segment count), but ordering keeps intent
  // obvious.
  router.put('/api/admin/users/app-quota', requireAdminWrite, async (req, res) => {
    const { quota } = req.body || {};
    const n = Number(quota);
    if (!Number.isInteger(n) || n < 0) {
      return res.status(400).json({ error: 'quota must be a non-negative integer' });
    }
    try {
      await pool.query('UPDATE users SET app_quota = $1', [n]);
      log.info('admin', 'App quota set for all users', { quota: n, by: req.user.username });
      res.json({ ok: true, quota: n });
    } catch (err) {
      log.error('admin', 'Bulk app-quota update failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Set one user's app-creation quota (see users.app_quota in schema.sql).
  // Body `{ quota }` — a non-negative integer. Modeled on the per-user
  // daily-limit handler below. Quota 0 means the user cannot create apps;
  // admins bypass enforcement regardless (their quota is cosmetic).
  router.put('/api/admin/users/:id/app-quota', requireAdminWrite, async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const { quota } = req.body || {};
    const n = Number(quota);
    if (!Number.isInteger(n) || n < 0) {
      return res.status(400).json({ error: 'quota must be a non-negative integer' });
    }
    try {
      const { rows } = await pool.query(
        `UPDATE users SET app_quota = $1 WHERE id = $2
         RETURNING id, username, app_quota`,
        [n, userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      log.info('admin', 'App quota updated', {
        id: rows[0].id, username: rows[0].username,
        appQuota: rows[0].app_quota, by: req.user.username,
      });
      res.json({ ok: true, app_quota: rows[0].app_quota });
    } catch (err) {
      log.error('admin', 'App quota update failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Set a user's role (issue #311). The three-way role selector in
  // public/admin.html posts here. Role is read live on every request
  // (src/middleware/auth.js), so a change takes effect on the target's
  // next request — no session invalidation needed.
  //
  //   user       → is_admin = FALSE, admin_readonly = FALSE
  //   view_admin → is_admin = TRUE,  admin_readonly = TRUE   (see-only)
  //   admin      → is_admin = TRUE,  admin_readonly = FALSE  (full)
  //
  // Back-compat: an older client posting `{ isAdmin: boolean }` is mapped
  // (true → 'admin', false → 'user').
  //
  // Two server-authoritative guardrails (mirrored in the UI for UX only),
  // both counting FULL admins only — a view-only admin can't promote anyone
  // back, so they don't satisfy the "at least one admin" requirement:
  //   - A full admin can't lower their OWN role (self-lockout).
  //   - The platform must always retain at least one full admin. Enforced
  //     inside a transaction that takes the ADMIN_MUTATION_LOCK advisory
  //     lock, then counts full admins and performs the UPDATE atomically —
  //     two concurrent demotions can't both observe >1 and race to zero.
  //   Setting the last full admin to `view_admin` is blocked the same way
  //   as demoting them to `user`.
  router.post('/api/admin/users/:id/is-admin', requireAdminWrite, async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    let role = req.body?.role;
    if (role === undefined && typeof req.body?.isAdmin === 'boolean') {
      role = req.body.isAdmin ? 'admin' : 'user';
    }
    const ROLE_COLUMNS = {
      user:       { is_admin: false, admin_readonly: false },
      view_admin: { is_admin: true,  admin_readonly: true },
      admin:      { is_admin: true,  admin_readonly: false },
    };
    const target = ROLE_COLUMNS[role];
    if (!target) {
      return res.status(400).json({ error: "role must be one of 'user', 'view_admin', 'admin'" });
    }

    const endsFullAdmin = target.is_admin && !target.admin_readonly;

    // Self-protection: a full admin can't set their own role to anything
    // that isn't full admin (re-affirming 'admin' on yourself is a no-op).
    if (userId === req.user.id && !endsFullAdmin) {
      return res.status(400).json({ error: "You can't lower your own admin role." });
    }

    // A change that ENDS in full admin never reduces the full-admin count,
    // so it needs no lock.
    if (endsFullAdmin) {
      try {
        const { rows } = await pool.query(
          `UPDATE users SET is_admin = $1, admin_readonly = $2 WHERE id = $3
           RETURNING id, username, is_admin, admin_readonly`,
          [target.is_admin, target.admin_readonly, userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        log.info('admin', 'Role set', {
          id: rows[0].id, username: rows[0].username, role, by: req.user.username,
        });
        return res.json({
          ok: true, role,
          isAdmin: rows[0].is_admin, adminReadonly: rows[0].admin_readonly,
        });
      } catch (err) {
        log.error('admin', 'Role set failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    // Demotion path (→ user or → view_admin): serialize on the advisory
    // lock, re-count FULL admins, and update inside one transaction so the
    // last-full-admin invariant holds under concurrency.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_MUTATION_LOCK]);

      const { rows: existing } = await client.query(
        'SELECT id, is_admin, admin_readonly FROM users WHERE id = $1',
        [userId]
      );
      if (!existing.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }

      const wasFullAdmin = existing[0].is_admin && !existing[0].admin_readonly;
      if (wasFullAdmin) {
        const { rows: countRows } = await client.query(
          'SELECT COUNT(*)::int AS n FROM users WHERE is_admin = TRUE AND admin_readonly = FALSE'
        );
        if (countRows[0].n <= 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: "Can't drop the last full admin." });
        }
      }

      const { rows } = await client.query(
        `UPDATE users SET is_admin = $1, admin_readonly = $2 WHERE id = $3
         RETURNING id, username, is_admin, admin_readonly`,
        [target.is_admin, target.admin_readonly, userId]
      );
      await client.query('COMMIT');
      log.info('admin', 'Role set', {
        id: rows[0].id, username: rows[0].username, role, by: req.user.username,
      });
      res.json({
        ok: true, role,
        isAdmin: rows[0].is_admin, adminReadonly: rows[0].admin_readonly,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error('admin', 'Role set failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  router.delete('/api/admin/users/:id', requireAdminWrite, async (req, res) => {
    const userId = parseInt(req.params.id);

    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    // Deleting drops the admin count just like a revoke, so it takes the
    // same advisory lock / transaction and enforces the last-admin
    // invariant server-side — even though the UI hides Delete for admins,
    // a direct API call must not be able to zero out the admins.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_MUTATION_LOCK]);

      const { rows: existing } = await client.query(
        'SELECT id, is_admin, admin_readonly FROM users WHERE id = $1',
        [userId]
      );
      if (!existing.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }
      // Only a FULL admin counts toward the "at least one admin" invariant
      // (issue #311) — deleting a view-only admin never threatens it.
      if (existing[0].is_admin && !existing[0].admin_readonly) {
        const { rows: countRows } = await client.query(
          'SELECT COUNT(*)::int AS n FROM users WHERE is_admin = TRUE AND admin_readonly = FALSE'
        );
        if (countRows[0].n <= 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: "Can't delete the last full admin." });
        }
      }

      await client.query('DELETE FROM users WHERE id = $1', [userId]);
      await client.query('COMMIT');
      log.info('admin', 'User deleted', { id: userId, by: req.user.username });
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error('admin', 'Delete user failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  // Admin-issued temporary password (issue #282). The universal recovery
  // path for accounts that can't self-reset with a wallet (no wallet
  // linked, or on plain desktop web). Gated by the same router-level
  // adminMiddleware as every other user route — any admin may issue one,
  // consistent with the rest of admin user-management.
  //
  // We generate a one-time temporary password, store only its bcrypt hash,
  // and return the plaintext exactly ONCE in the response for the admin to
  // relay out-of-band. The plaintext is never logged. Resetting deletes all
  // of the target's sessions so a leaked/old session can't outlive it. No
  // last-admin concern — this doesn't touch is_admin — and an admin may
  // reset their own password too.
  router.post('/api/admin/users/:id/reset-password', requireAdminWrite, async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    try {
      // URL-safe, ~12-char temporary password. base64url avoids +/=
      // so it's painless to relay over chat or read aloud.
      const tempPassword = crypto.randomBytes(9).toString('base64url');
      const hash = await bcrypt.hash(tempPassword, 12);

      const recovery = await withTransaction(pool, (client) => accountRecovery(client, {
        userId,
        actorUserId: req.user.id,
        updatePassword: (tx) => tx.query(
          `UPDATE users SET password = $1 WHERE id = $2
           RETURNING id, username, is_admin, admin_readonly`,
          [hash, userId]
        ),
      }));
      if (!recovery.found) return res.status(404).json({ error: 'User not found' });

      log.info('admin', 'Password reset issued', {
        id: recovery.user.id, username: recovery.user.username, by: req.user.username,
      });
      res.json({ ok: true, username: recovery.user.username, tempPassword });
    } catch (err) {
      log.error('admin', 'Password reset failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Activation Codes ───────────────────────────────────────

  router.get('/api/admin/codes', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT ac.id, ac.code, ac.created_at, ac.used_at,
                u.username as used_by_username
         FROM activation_codes ac
         LEFT JOIN users u ON u.id = ac.used_by
         ORDER BY ac.created_at DESC`
      );
      res.json(rows);
    } catch (err) {
      log.error('admin', 'List codes failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/admin/codes', requireAdminWrite, async (req, res) => {
    try {
      const code = crypto.randomBytes(6).toString('hex');
      const { rows } = await pool.query(
        'INSERT INTO activation_codes (code) VALUES ($1) RETURNING id, code, created_at',
        [code]
      );
      log.info('admin', 'Activation code created', { code, by: req.user.username });
      res.json(rows[0]);
    } catch (err) {
      log.error('admin', 'Create code failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/admin/codes/:id', requireAdminWrite, async (req, res) => {
    const codeId = parseInt(req.params.id);
    try {
      const result = await pool.query('DELETE FROM activation_codes WHERE id = $1 AND used_by IS NULL', [codeId]);
      if (result.rowCount === 0) {
        return res.status(400).json({ error: 'Code not found or already used' });
      }
      log.info('admin', 'Activation code deleted', { id: codeId, by: req.user.username });
      res.json({ ok: true });
    } catch (err) {
      log.error('admin', 'Delete code failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── LLM Spend Limits ───────────────────────────────────────
  //
  // Admin-tunable daily caps on LLM spend. Backed by the
  // `platform_settings` table (default per-user + global) plus the
  // `users.daily_limit_cents` per-user override. Reads are cached for
  // 10s in src/services/limits.js; PUTs invalidate that cache so the
  // new value takes effect on the next request from any worker.

  router.get('/api/admin/limits', async (_req, res) => {
    try {
      const userCents = await limits.getDefaultUserLimitCents(pool);
      const globalCents = await limits.getGlobalLimitCents(pool);
      const systemCents = await limits.getSystemTokensLimitCents(pool);
      res.json({
        user_daily_limit_cents: userCents,
        global_daily_limit_cents: globalCents,
        system_tokens_daily_limit_cents: systemCents,
      });
    } catch (err) {
      log.error('admin', 'Read limits failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/admin/limits', requireAdminWrite, async (req, res) => {
    const { user, global, system } = req.body || {};
    const updates = [];
    const validate = (label, v) => {
      if (v === undefined) return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) {
        return `${label} must be a non-negative integer (cents)`;
      }
      return n;
    };
    const userN = validate('user', user);
    if (typeof userN === 'string') return res.status(400).json({ error: userN });
    const globalN = validate('global', global);
    if (typeof globalN === 'string') return res.status(400).json({ error: globalN });
    const systemN = validate('system', system);
    if (typeof systemN === 'string') return res.status(400).json({ error: systemN });
    if (userN === null && globalN === null && systemN === null) {
      return res.status(400).json({ error: 'Provide at least one of: user, global, system' });
    }
    if (userN !== null) updates.push([limits.KEY_USER, String(userN)]);
    if (globalN !== null) updates.push([limits.KEY_GLOBAL, String(globalN)]);
    if (systemN !== null) updates.push([limits.KEY_SYSTEM, String(systemN)]);

    try {
      for (const [key, value] of updates) {
        await pool.query(
          `INSERT INTO platform_settings (key, value, updated_at, updated_by)
           VALUES ($1, $2, NOW(), $3)
           ON CONFLICT (key) DO UPDATE
             SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
          [key, value, req.user.id]
        );
      }
      // Hot-flip the cache so new limits apply on the very next request
      // instead of waiting up to 10s for the TTL to expire.
      limits.invalidate(...updates.map(([k]) => k));
      log.info('admin', 'Platform limits updated', {
        by: req.user.username,
        user: userN, global: globalN, system: systemN,
      });
      const userCents = await limits.getDefaultUserLimitCents(pool);
      const globalCents = await limits.getGlobalLimitCents(pool);
      const systemCents = await limits.getSystemTokensLimitCents(pool);
      res.json({
        user_daily_limit_cents: userCents,
        global_daily_limit_cents: globalCents,
        system_tokens_daily_limit_cents: systemCents,
      });
    } catch (err) {
      log.error('admin', 'Update limits failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Featured apps ──────────────────────────────────────────
  //
  // The admin-curated row under "Find more apps" on every user's home
  // screen. One global ordered list (no per-user targeting); the
  // `featured_apps` table is read by the LEFT JOIN in GET /api/apps, so
  // per-viewer visibility filtering is inherited for free — featuring a
  // view-private app shows it only to people who could already see it.
  //
  // The self-hosted platform row is excluded on both sides: it is hidden
  // from non-admin listings anyway (see GET /api/apps), so featuring it
  // would be a no-op for everyone the row is meant for.
  const FEATURED_MAX = 12;

  // Pure read — router-level adminMiddleware only, NO requireAdminWrite,
  // so view-only admins can inspect the list (same stance as /limits and
  // /overview above). Returns the current list in display order plus
  // every app still available to add, so the section renders from one
  // round trip.
  router.get('/api/admin/featured-apps', async (_req, res) => {
    try {
      const { rows: featured } = await pool.query(
        `SELECT a.slug, a.name, a.status, a.icon_emoji, a.icon_image_id, fa.sort_order
           FROM featured_apps fa
           JOIN apps a ON a.id = fa.app_id
          WHERE NOT a.self_hosted
          ORDER BY fa.sort_order ASC, a.name ASC`
      );
      const { rows: available } = await pool.query(
        `SELECT a.slug, a.name, a.status, a.icon_emoji, a.icon_image_id
           FROM apps a
          WHERE NOT a.self_hosted
            AND NOT EXISTS (SELECT 1 FROM featured_apps f WHERE f.app_id = a.id)
          ORDER BY LOWER(a.name) ASC`
      );
      // Server-built icon URL so the client never assembles ids into
      // paths (same rule as the /api/apps serializer).
      const shape = (r) => ({
        slug: r.slug,
        name: r.name,
        status: r.status,
        icon_emoji: r.icon_emoji || null,
        icon_url: r.icon_image_id ? `/app-icons/${r.icon_image_id}` : null,
        sort_order: r.sort_order ?? null,
      });
      res.json({ featured: featured.map(shape), available: available.map(shape) });
    } catch (err) {
      log.error('admin', 'Read featured apps failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Full rewrite of the list from an ordered slug array — the same idiom
  // as PUT /api/favorites/order in routes/apps.js. A full rewrite (rather
  // than add/remove deltas) is what makes the client's reorder controls
  // trivially correct: the array IS the display order.
  router.put('/api/admin/featured-apps', requireAdminWrite, async (req, res) => {
    const { slugs } = req.body || {};
    if (!Array.isArray(slugs)) {
      return res.status(400).json({ error: 'slugs must be an array' });
    }
    if (slugs.length > FEATURED_MAX) {
      return res.status(400).json({ error: `At most ${FEATURED_MAX} featured apps` });
    }
    if (slugs.some((s) => typeof s !== 'string' || !s.trim())) {
      return res.status(400).json({ error: 'slugs must be non-empty strings' });
    }
    const seen = new Set();
    for (const s of slugs) {
      if (seen.has(s)) return res.status(400).json({ error: `Duplicate slug: ${s}` });
      seen.add(s);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Resolve every slug up front so an unknown / self-hosted one is a
      // 400 naming the offender rather than a silently shorter list.
      const ids = [];
      for (const slug of slugs) {
        const { rows } = await client.query(
          'SELECT id, self_hosted FROM apps WHERE slug = $1',
          [slug]
        );
        if (!rows.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Unknown app: ${slug}` });
        }
        if (rows[0].self_hosted) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `The platform app cannot be featured: ${slug}` });
        }
        ids.push(rows[0].id);
      }
      await client.query('DELETE FROM featured_apps');
      for (let i = 0; i < ids.length; i += 1) {
        await client.query(
          `INSERT INTO featured_apps (app_id, sort_order, created_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (app_id) DO UPDATE
             SET sort_order = EXCLUDED.sort_order, created_by = EXCLUDED.created_by`,
          [ids[i], i, req.user.id]
        );
      }
      await client.query('COMMIT');
      log.info('admin', 'Featured apps updated', {
        by: req.user.username,
        count: slugs.length,
      });
      res.json({ ok: true, slugs });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
      log.error('admin', 'Update featured apps failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  // ── Anthropic credits (#555) ───────────────────────────────
  //
  // The organisation's remaining Anthropic credit, for the drawer's
  // status pane. Anthropic publishes billed spend, never a balance, so
  // the figure is derived from a balance an admin records here minus
  // cost_report spend since that date — see services/anthropic-credits.js
  // for the whole story. The two settings keys are intentionally absent
  // until someone records them; absence is the "not configured" state.

  // Router-level adminMiddleware only — NO requireAdminWrite. This is a
  // pure read, and view-only admins are squarely part of its audience
  // (same reasoning as /overview, /users, /codes, /limits above).
  router.get('/api/admin/anthropic-credits', async (req, res) => {
    // Staging mock data: read-only, obviously fake, no writes, strict
    // no-op in production. Admin-gated already by the router.
    if (IS_STAGING && req.query.demo === '1') {
      return res.json({
        configured: true,
        balanceCents: 500000,
        asOf: '2026-07-01',
        spentCents: 371550,
        remainingCents: 128450,
        source: 'anthropic',
        fetchedAt: new Date().toISOString(),
        partial: false,
        demo: true,
      });
    }
    try {
      res.json(await anthropicCredits.getCredits(pool, config));
    } catch (err) {
      // getCredits swallows its own failures, so reaching here means
      // something unexpected — still don't 500 a status-pane read.
      log.error('admin', 'Read anthropic credits failed', { message: err.message });
      res.json({ configured: true, error: 'Internal server error' });
    }
  });

  // Record the balance + the date it was correct. Full admins only —
  // this is a mutation, so it chains requireAdminWrite like PUT /limits.
  router.put('/api/admin/anthropic-credits', requireAdminWrite, async (req, res) => {
    const { balanceCents, balanceDollars, asOf } = req.body || {};

    let cents;
    if (balanceCents !== undefined) {
      cents = Number(balanceCents);
    } else if (balanceDollars !== undefined) {
      const d = Number(balanceDollars);
      cents = Number.isFinite(d) ? Math.round(d * 100) : NaN;
    } else {
      return res.status(400).json({ error: 'balanceCents or balanceDollars is required' });
    }
    if (!Number.isFinite(cents) || cents < 0) {
      return res.status(400).json({ error: 'Credit balance must be a non-negative amount' });
    }
    cents = Math.round(cents);

    const day = String(asOf || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return res.status(400).json({ error: 'asOf must be a date in YYYY-MM-DD form' });
    }
    const parsed = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
      return res.status(400).json({ error: 'asOf is not a real calendar date' });
    }
    // A future as-of date would subtract spend from a window that hasn't
    // happened yet and read as "full balance" forever.
    if (parsed.getTime() > Date.now()) {
      return res.status(400).json({ error: 'asOf cannot be in the future' });
    }

    try {
      for (const [key, value] of [
        [anthropicCredits.KEY_BALANCE, String(cents)],
        [anthropicCredits.KEY_AS_OF, day],
      ]) {
        await pool.query(
          `INSERT INTO platform_settings (key, value, updated_at, updated_by)
           VALUES ($1, $2, NOW(), $3)
           ON CONFLICT (key) DO UPDATE
             SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
          [key, value, req.user.id]
        );
      }
      // Drop the cached arithmetic so the recomputed figure below (and
      // every drawer that opens next) reflects the new balance at once.
      anthropicCredits.invalidate();
      log.info('admin', 'Anthropic credit balance recorded', {
        by: req.user.username, balanceCents: cents, asOf: day,
      });
      res.json(await anthropicCredits.getCredits(pool, config));
    } catch (err) {
      log.error('admin', 'Update anthropic credits failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Per-user override. Body `{ cents }` sets a cap for this user only;
  // `{ cents: null }` clears the override and falls them back to the
  // platform default. Cache invalidation isn't needed because the per-
  // user limit is read fresh from the users table on every checkBudget
  // call (only the platform_settings rows are cached).
  router.put('/api/admin/users/:id/daily-limit', requireAdminWrite, async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const { cents } = req.body || {};
    let value;
    if (cents === null) {
      value = null;
    } else {
      const n = Number(cents);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({ error: 'cents must be a non-negative integer or null' });
      }
      value = n;
    }
    try {
      const { rows } = await pool.query(
        `UPDATE users SET daily_limit_cents = $1 WHERE id = $2
         RETURNING id, username, daily_limit_cents`,
        [value, userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      log.info('admin', 'Per-user daily limit updated', {
        id: rows[0].id, username: rows[0].username,
        dailyLimitCents: rows[0].daily_limit_cents,
        by: req.user.username,
      });
      res.json({ ok: true, daily_limit_cents: rows[0].daily_limit_cents });
    } catch (err) {
      log.error('admin', 'Per-user limit update failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Linked wallet (issue #422) ─────────────────────────────
  //
  // Set / change / clear a user's linked Usernode wallet
  // (users.usernode_pubkey). Mirrors the per-user daily-limit handler.
  // Body `{ pubkey }`:
  //   - null or '' → CLEAR: usernode_pubkey = NULL, and the link-flow
  //     columns (token/expiry) are nulled too, matching the user-facing
  //     DELETE /api/me/wallet-link unlink.
  //   - non-empty  → SET, after a wallet-shape check.
  //
  // There is NO unique constraint on usernode_pubkey (only username is
  // unique), and wallet login resolves the account by pubkey alone — so
  // two rows sharing a pubkey is the "accounts mixed up" failure mode this
  // route exists to fix. We therefore enforce single-ownership here: if
  // another user already holds the target pubkey we return 409 unless the
  // caller explicitly opts into reassigning it. Reassign clears the other
  // user and sets this one inside one transaction so there's never a
  // transient duplicate. We intentionally do NOT gate on
  // genesisAccounts.isGenesisAddress — that's for user-initiated linking
  // and returns true when the genesis set is unloaded; an admin correcting
  // an association must not be blocked by it.
  router.put('/api/admin/users/:id/wallet', requireAdminWrite, async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const raw = req.body?.pubkey;
    const reassign = req.body?.reassign === true;

    // Normalize to either a clean string to set, or null to clear.
    let pubkey = null;
    if (raw !== null && raw !== undefined && raw !== '') {
      if (typeof raw !== 'string') {
        return res.status(400).json({ error: 'pubkey must be a string, null, or empty' });
      }
      const trimmed = raw.trim();
      if (trimmed === '') {
        pubkey = null;
      } else if (/\s/.test(trimmed)) {
        return res.status(400).json({ error: 'Wallet address must not contain whitespace' });
      } else if (!trimmed.startsWith('ut1')) {
        return res.status(400).json({ error: 'Wallet address must start with "ut1"' });
      } else if (trimmed.length < 8 || trimmed.length > 255) {
        return res.status(400).json({ error: 'Wallet address has an invalid length' });
      } else {
        pubkey = trimmed;
      }
    }

    try {
      // Clear is unconditional — no conflict possible when setting NULL.
      if (pubkey === null) {
        const { rows } = await pool.query(
          `UPDATE users
             SET usernode_pubkey = NULL,
                 wallet_link_token = NULL,
                 wallet_link_expires_at = NULL
           WHERE id = $1
           RETURNING id, username, usernode_pubkey`,
          [userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        log.info('admin', 'Wallet updated', {
          id: rows[0].id, username: rows[0].username,
          to: null, by: req.user.username,
        });
        return res.json({ ok: true, usernode_pubkey: null });
      }

      // Does another user already hold this pubkey?
      const { rows: holders } = await pool.query(
        'SELECT id, username FROM users WHERE usernode_pubkey = $1 AND id <> $2',
        [pubkey, userId]
      );
      if (holders.length && !reassign) {
        return res.status(409).json({
          error: `This wallet is already linked to "${holders[0].username}". Reassign it to move the wallet.`,
          conflictUser: { id: holders[0].id, username: holders[0].username },
        });
      }

      if (holders.length) {
        // Reassign: clear every other holder, then set the target — one
        // transaction so there's never a transient duplicate.
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `UPDATE users
               SET usernode_pubkey = NULL,
                   wallet_link_token = NULL,
                   wallet_link_expires_at = NULL
             WHERE usernode_pubkey = $1 AND id <> $2`,
            [pubkey, userId]
          );
          const { rows } = await client.query(
            `UPDATE users
               SET usernode_pubkey = $1,
                   wallet_link_token = NULL,
                   wallet_link_expires_at = NULL
             WHERE id = $2
             RETURNING id, username, usernode_pubkey`,
            [pubkey, userId]
          );
          if (!rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
          }
          await client.query('COMMIT');
          log.info('admin', 'Wallet updated', {
            id: rows[0].id, username: rows[0].username,
            to: pubkey.slice(0, 12) + '…',
            reassignedFrom: holders.map((h) => h.username),
            by: req.user.username,
          });
          return res.json({ ok: true, usernode_pubkey: rows[0].usernode_pubkey });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }

      // No conflict — straight set.
      const { rows } = await pool.query(
        `UPDATE users
           SET usernode_pubkey = $1,
               wallet_link_token = NULL,
               wallet_link_expires_at = NULL
         WHERE id = $2
         RETURNING id, username, usernode_pubkey`,
        [pubkey, userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      log.info('admin', 'Wallet updated', {
        id: rows[0].id, username: rows[0].username,
        to: pubkey.slice(0, 12) + '…', by: req.user.username,
      });
      res.json({ ok: true, usernode_pubkey: rows[0].usernode_pubkey });
    } catch (err) {
      log.error('admin', 'Wallet update failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Submitted features across all apps (#562) ─────────────────
  //
  // A platform-wide, admin-only view of member-submitted feature
  // requests, ranked by up-votes. "Submitted features" are the
  // user-submittable, GitHub-mirrored `issues` rows with kind='general'
  // (see src/routes/issues.js VALID_KINDS); the structured governance
  // kinds ('secret_change', 'close_issue') are deliberately excluded.
  // This is the first CROSS-APP issues query — every other issue read is
  // scoped to a single app_id or a single user. Gated only by the
  // router-level adminMiddleware (any admin, full OR view-only): it is a
  // pure read, so it must NOT chain requireAdminWrite, matching the other
  // /api/admin GET reads (/overview, /users, /codes, /limits).
  //
  // Ordering is by up-vote count DESC (matching the per-app list at
  // GET /api/apps/:slug/issues), with created_at then id as deterministic
  // tie-breaks so offset paging is stable. Offset paging (rather than the
  // keyset cursors used on high-churn feeds like votes.js) is used on
  // purpose: the sort key is a computed aggregate with heavy ties, which a
  // (created_at, id) cursor cannot page correctly, and this admin analytics
  // list is low-churn so any offset drift is acceptable.
  router.get('/api/admin/submitted-features', async (req, res) => {
    // status: 'open' (default) | 'closed' | 'all'. Anything else falls
    // back to the default rather than 400-ing an admin analytics read.
    const statusParam = String(req.query.status || 'open').toLowerCase();
    const status = ['open', 'closed', 'completed', 'all'].includes(statusParam) ? statusParam : 'open';

    // limit: default 50, clamped to [1, 200]; offset: non-negative int.
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
    const rawOffset = parseInt(req.query.offset, 10);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

    // Shared WHERE: only member-submitted features, optionally status-scoped.
    // $1 carries the status filter ('all' → no status predicate).
    const statusClause = status === 'all' ? '' : ' AND i.status = $1';
    const filterParams = status === 'all' ? [] : [status];

    try {
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS total
           FROM issues i
          WHERE i.kind = 'general'${statusClause}`,
        filterParams
      );
      const total = countRows[0] ? countRows[0].total : 0;

      const { rows } = await pool.query(
        `SELECT i.id, i.app_id, i.github_issue_number, i.title, i.description,
                i.kind, i.status, i.created_at, i.created_by,
                u.username AS created_by_username,
                a.slug AS app_slug, a.name AS app_name,
                (SELECT COUNT(*)::int FROM issue_votes
                   WHERE issue_id = i.id AND vote = 'up')   AS up_count,
                (SELECT COUNT(*)::int FROM issue_votes
                   WHERE issue_id = i.id AND vote = 'down') AS down_count
           FROM issues i
           JOIN apps a ON a.id = i.app_id
           LEFT JOIN users u ON u.id = i.created_by
          WHERE i.kind = 'general'${statusClause}
          ORDER BY (SELECT COUNT(*) FROM issue_votes
                      WHERE issue_id = i.id AND vote = 'up') DESC,
                   i.created_at DESC, i.id DESC
          LIMIT ${limit} OFFSET ${offset}`,
        filterParams
      );

      res.json({ features: rows, total, limit, offset });
    } catch (err) {
      log.error('admin', 'Submitted-features list failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Database export ────────────────────────────────────────
  //
  // A full, unredacted pg_dump of the platform database — plain SQL, gzip
  // compressed on the way out (`<db>-<stamp>.sql.gz`) — streamed straight
  // to a full admin's browser as a file download. The dumped file contains
  // every bcrypt hash in `users`, every live row of `sessions`, every
  // activation code, every app's db_password / llm_proxy_token /
  // storage_api_token, and the AES-GCM ciphertext of every BYOK key and
  // app secret. It deliberately bypasses BOTH containment mechanisms the
  // platform otherwise relies on — the `staging:private` scrub in
  // db-manager.js and the grant-level deny lists in debug-access.js.
  //
  // So the gate is: full platform admins only (requireAdminWrite — never
  // adminMiddleware alone, which admits view-only admins, and never any
  // per-app admin notion), password re-entry on every single export, an
  // explicit typed confirmation, 3 per admin per day, one at a time
  // platform-wide, blocked outright in staging, and an append-only
  // `db_exports` row for every attempt — written BEFORE anything runs.
  //
  // Mechanics live in src/services/db-export.js (spawn + docker exec +
  // in-process gzip + ticket store + single-flight guard); this file owns
  // auth and audit. NOTE: the audited/reported byte count is the COMPRESSED
  // size — what actually left the server — so history rows are comparable
  // with the file on the admin's disk, not with pg_database_size().

  const DB_EXPORT_HISTORY_MAX = 200;

  function auditClientIp(req) {
    return String(clientIp(req)).slice(0, 64) || null;
  }

  // Insert the audit row. Deliberately NOT fire-and-forget: callers await
  // this before doing the thing it records, so a dump can never run
  // without a row already committed for it. Returns the row id, or null
  // if the insert itself failed (in which case the caller logs and, for
  // the export path, refuses to proceed).
  async function recordExportAudit(req, { status, deniedReason = null, dbName = null }) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO db_exports (user_id, username, db_name, status, denied_reason, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          req.user?.id ?? null,
          req.user?.username || 'unknown',
          dbName || '(unresolved)',
          status,
          deniedReason,
          auditClientIp(req),
          String(req.get('user-agent') || '').slice(0, 512) || null,
        ]
      );
      return rows[0] ? rows[0].id : null;
    } catch (err) {
      log.error('admin', 'db-export audit insert failed', { message: err.message, status, deniedReason });
      return null;
    }
  }

  async function finishExportAudit(id, { status, bytesSent = 0, error = null, started = false }) {
    if (!id) return;
    try {
      await pool.query(
        `UPDATE db_exports
            SET status = $2,
                bytes_sent = $3,
                error = $4,
                started_at = COALESCE(started_at, CASE WHEN $5 THEN NOW() ELSE NULL END),
                finished_at = NOW()
          WHERE id = $1`,
        [id, status, bytesSent, error ? log.redactString(String(error)).slice(0, 4000) : null, started]
      );
    } catch (err) {
      log.error('admin', 'db-export audit update failed', { message: err.message, id });
    }
  }

  // Capability probe for the console. Readable by ANY admin (view-only
  // included) — it exposes no data, only whether the button should work
  // and, when it shouldn't, a machine-readable reason the client renders.
  // That indirection is what keeps public/js/admin-console.js free of any
  // USERNODE_ENV literal (pinned by tests/admin-console-page.test.js)
  // while the staging block itself stays server-side and absolute.
  router.get('/api/admin/db-export/status', async (req, res) => {
    try {
      const target = dbExport.resolveTargetDb(config);
      const inProgress = dbExport.isExportInProgress();

      let dbSizeBytes = null;
      try {
        const { rows } = await pool.query('SELECT pg_database_size(current_database())::bigint AS size');
        if (rows[0]) dbSizeBytes = Number(rows[0].size);
      } catch (err) {
        log.warn('admin', 'db-export size probe failed', { message: err.message });
      }

      // Advisory only — the enforced budget is the rolling in-memory
      // window in dbExportLimiter. This is the DB's view of the same
      // thing, for display; the two can disagree across a restart.
      let remainingToday = dbExport.MAX_PER_DAY;
      try {
        const { rows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM db_exports
            WHERE user_id = $1
              AND status <> 'denied'
              AND requested_at > NOW() - INTERVAL '24 hours'`,
          [req.user.id]
        );
        remainingToday = Math.max(0, dbExport.MAX_PER_DAY - (rows[0] ? rows[0].n : 0));
      } catch { /* display-only */ }

      let available = true;
      let reason = 'ok';
      if (dbExport.isStaging()) { available = false; reason = 'staging'; }
      else if (!target.dbName) { available = false; reason = 'unavailable'; }
      else if (inProgress) { available = false; reason = 'in_progress'; }
      else if (remainingToday <= 0) { available = false; reason = 'rate_limited'; }

      res.json({
        available,
        reason,
        dbName: target.dbName,
        dbSizeBytes,
        inProgress,
        remainingToday,
        maxPerDay: dbExport.MAX_PER_DAY,
        canWrite: !!req.user?.canAdminWrite,
      });
    } catch (err) {
      log.error('admin', 'db-export status failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Append-only history, readable by any admin. There is no delete or
  // edit counterpart, by design.
  router.get('/api/admin/db-export/history', async (req, res) => {
    try {
      const limit = Math.min(DB_EXPORT_HISTORY_MAX, Math.max(1, parseInt(req.query.limit, 10) || 25));
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const { rows: countRows } = await pool.query('SELECT COUNT(*)::int AS total FROM db_exports');
      const { rows } = await pool.query(
        `SELECT id, user_id, username, db_name, status, denied_reason, ip,
                bytes_sent, requested_at, started_at, finished_at, error
           FROM db_exports
          ORDER BY requested_at DESC, id DESC
          LIMIT ${limit} OFFSET ${offset}`
      );
      res.json({ exports: rows, total: countRows[0] ? countRows[0].total : 0, limit, offset });
    } catch (err) {
      log.error('admin', 'db-export history failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Audit the two denials that never reach the ticket handler: a view-only
  // admin bounced by requireAdminWrite, and a full admin bounced by the
  // rate limiter. Both are attempts on a credential-dump endpoint, so both
  // belong on the record.
  async function noteDbExportPreDenials(req, res, next) {
    res.on('finish', () => {
      if (res.statusCode === 429) {
        recordExportAudit(req, { status: 'denied', deniedReason: 'rate_limited' }).catch(() => {});
      }
    });
    if (!req.user?.canAdminWrite) {
      log.warn('admin', 'db-export refused: view-only admin', {
        by: req.user?.username, ip: clientIp(req),
      });
      await recordExportAudit(req, { status: 'denied', deniedReason: 'view_only' });
    }
    next();
  }

  // Step 1 of 2. Verifies the typed confirmation and the admin's own
  // password, then hands back a single-use 60s ticket. The browser
  // navigates to the ticket URL, which is what makes this a real
  // streamed file download rather than a Blob held in page memory.
  router.post('/api/admin/db-export/ticket',
    noteDbExportPreDenials, requireAdminWrite, dbExportLimiter,
    async (req, res) => {
      try {
        // Layer 2 of the staging block (layer 1 is structural: staging
        // containers never receive /var/run/docker.sock, so docker exec
        // cannot work there at all; layer 3 is the disabled button).
        if (dbExport.isStaging()) {
          await recordExportAudit(req, { status: 'denied', deniedReason: 'staging' });
          return res.status(403).json({
            error: 'Database export is disabled in staging previews.',
            code: 'staging',
          });
        }

        const { password, confirm } = req.body || {};
        if (confirm !== 'EXPORT') {
          return res.status(400).json({ error: 'Type EXPORT to confirm.', code: 'confirm_required' });
        }
        if (!password || typeof password !== 'string') {
          return res.status(400).json({ error: 'Your password is required.', code: 'password_required' });
        }

        const { rows } = await pool.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
        const hash = rows[0] ? rows[0].password : null;
        const ok = hash ? await bcrypt.compare(password, hash) : false;
        if (!ok) {
          await recordExportAudit(req, { status: 'denied', deniedReason: 'bad_password' });
          log.warn('admin', 'db-export refused: password verification failed', {
            by: req.user.username, ip: clientIp(req),
          });
          // Deliberately undifferentiated from any other verification
          // failure in the client-visible message.
          return res.status(401).json({ error: 'Password verification failed.', code: 'bad_password' });
        }

        const target = dbExport.resolveTargetDb(config);
        if (!target.dbName) {
          await recordExportAudit(req, { status: 'denied', deniedReason: 'unavailable' });
          return res.status(503).json({
            error: 'Database export is unavailable on this deployment.',
            code: 'unavailable',
          });
        }
        if (dbExport.isExportInProgress()) {
          await recordExportAudit(req, { status: 'denied', deniedReason: 'in_progress', dbName: target.dbName });
          return res.status(409).json({
            error: 'An export is already in progress — try again shortly.',
            code: 'in_progress',
          });
        }

        // AUDIT BEFORE ANYTHING RUNS. Mirrors the prod-debug idiom in
        // routes/internal.js: the record is committed first, so even an
        // export that dies before producing a byte is on the books.
        const auditId = await recordExportAudit(req, { status: 'requested', dbName: target.dbName });
        if (!auditId) {
          return res.status(500).json({ error: 'Could not record the export — refusing to run it.' });
        }

        const { token, expiresInSeconds } = dbExport.issueTicket({
          userId: req.user.id, ip: clientIp(req), auditId, dbName: target.dbName,
        });
        log.warn('admin', 'Database export authorized', {
          by: req.user.username, id: req.user.id, dbName: target.dbName,
          auditId, ip: clientIp(req), ticket: `${token.slice(0, 8)}…`,
        });

        res.json({
          token,
          url: `/api/admin/db-export?t=${encodeURIComponent(token)}`,
          filename: dbExport.exportFilename(target.dbName),
          expiresInSeconds,
        });
      } catch (err) {
        log.error('admin', 'db-export ticket failed', { message: err.message });
        res.status(500).json({ error: 'Internal server error' });
      }
    });

  // Step 2 of 2. Browser-navigated GET: consumes the ticket and streams
  // the gzipped SQL dump with Content-Disposition: attachment. requireAdminWrite is
  // re-applied here rather than trusted from step 1 — the ticket narrows
  // who may use this URL, it is not the authorization.
  router.get('/api/admin/db-export', requireAdminWrite, async (req, res) => {
    let auditId = null;
    let started = false;
    try {
      if (dbExport.isStaging()) {
        return res.status(403).json({
          error: 'Database export is disabled in staging previews.',
          code: 'staging',
        });
      }

      const ticket = dbExport.consumeTicket(String(req.query.t || ''), req.user.id);
      if (!ticket) {
        log.warn('admin', 'db-export refused: invalid or expired ticket', {
          by: req.user.username, ip: clientIp(req),
        });
        return res.status(403).json({
          error: 'This export link has expired — start the export again.',
          code: 'ticket_invalid',
        });
      }
      auditId = ticket.auditId;

      // A mobile client can legitimately change IP between the POST and
      // the navigation, so this is a warning, not a block.
      const ip = clientIp(req);
      if (ticket.ip && ip && ticket.ip !== ip) {
        log.warn('admin', 'db-export ticket redeemed from a different IP', {
          by: req.user.username, issuedTo: ticket.ip, redeemedFrom: ip, auditId,
        });
      }

      const target = dbExport.resolveTargetDb(config);
      if (!target.dbName) {
        await finishExportAudit(auditId, { status: 'failed', error: 'export target unavailable' });
        return res.status(503).json({
          error: 'Database export is unavailable on this deployment.',
          code: 'unavailable',
        });
      }

      if (!dbExport.beginExport({ userId: req.user.id, username: req.user.username })) {
        await finishExportAudit(auditId, { status: 'denied', error: 'another export was already running' });
        return res.status(409).json({
          error: 'An export is already in progress — try again shortly.',
          code: 'in_progress',
        });
      }

      const filename = dbExport.exportFilename(target.dbName);
      log.warn('admin', 'Database export started', {
        by: req.user.username, dbName: target.dbName, auditId, filename,
      });

      let result;
      try {
        result = await dbExport.runExport({
          dbName: target.dbName,
          res,
          filename,
          onStart: () => {
            started = true;
            pool.query(
              `UPDATE db_exports SET status = 'streaming', started_at = NOW() WHERE id = $1`,
              [auditId]
            ).catch((err) => log.error('admin', 'db-export streaming mark failed', { message: err.message }));
          },
        });
      } finally {
        dbExport.endExport();
      }

      await finishExportAudit(auditId, {
        status: result.status,
        bytesSent: result.bytesSent,
        error: result.error,
        started,
      });

      log[result.status === 'completed' ? 'warn' : 'error']('admin', 'Database export finished', {
        by: req.user.username, dbName: target.dbName, auditId,
        status: result.status, bytesSent: result.bytesSent, rawBytes: result.rawBytes,
      });

      if (result.status === 'completed') {
        events.record(pool, {
          type: events.EVENT_TYPES.DB_EXPORTED,
          userId: req.user.id,
          metadata: { dbName: target.dbName, bytesSent: result.bytesSent, auditId },
        });
      }
    } catch (err) {
      log.error('admin', 'db-export stream failed', { message: err.message });
      await finishExportAudit(auditId, { status: 'failed', error: err.message, started });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
      else try { res.destroy(); } catch { /* socket already gone */ }
    }
  });

  // ── Email delivery ─────────────────────────────────────────
  //
  // The operator's view of platform outbound mail. Three routes, and the
  // split between them is the whole point: reads are open to any admin
  // (including view-only), the one that actually puts a message on the
  // wire is full-admin-only.
  //
  // These live under /api/admin/mail and are ADDITIVE. The older
  // /api/v4/admin/settings/mail-status and /mail-activity pair that the
  // Topochain settings card reads is untouched — it is a different
  // console section with a different audience, and quietly repointing it
  // would be a second change riding on this one.

  // Conservative single-address check. Deliberately stricter than RFC
  // 5322: this is an operator typing their own inbox into a console, not
  // a signup form, so rejecting an exotic-but-legal address costs an
  // admin one retry while accepting a header-injecting one costs
  // everybody. No CR/LF anywhere, no comma or semicolon (one recipient,
  // not a list), and a length the ledger column can hold.
  const TEST_RECIPIENT_RE = /^[^\s@,;<>"'\\]+@[^\s@,;<>"'\\]+\.[A-Za-z]{2,}$/;

  function validateTestRecipient(raw) {
    if (typeof raw !== 'string') return { error: 'An email address is required.' };
    const to = raw.trim();
    if (!to) return { error: 'An email address is required.' };
    if (to.length > 255) return { error: 'That address is too long.' };
    if (/[\r\n]/.test(to)) return { error: 'That address is not a valid email address.' };
    if (!TEST_RECIPIENT_RE.test(to)) return { error: 'That address is not a valid email address.' };
    return { to };
  }

  // Configuration presence only — which provider is active, which keys
  // are absent, which flows break while it stays that way. describe()
  // returns no values by construction, so this response can never carry a
  // credential even though the page that renders it is admin-only.
  router.get('/api/admin/mail/status', async (req, res) => {
    try {
      const status = mail.describe(process.env);

      // Pre-fill the test form with the admin's own address when we have
      // one. The client session payload doesn't carry an email, so it
      // comes from here rather than from App.user.
      let suggestedRecipient = null;
      try {
        const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
        suggestedRecipient = (rows[0] && rows[0].email) || null;
      } catch (err) {
        // A missing suggestion is cosmetic; the card still works.
        log.warn('admin', 'Could not read the admin email for the mail card',
          { message: err.message });
      }

      res.json({ ...status, suggestedRecipient, canSendTest: !!req.user?.canAdminWrite });
    } catch (err) {
      log.error('admin', 'mail status failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The delivery ledger, newest first, with the 24-hour tally the card
  // shows above the table. `kind` filters to one message type (the
  // console uses it for the "Test emails only" toggle).
  router.get('/api/admin/mail/activity', async (req, res) => {
    try {
      const requested = Number(req.query.limit);
      const limit = Number.isFinite(requested)
        ? Math.min(100, Math.max(1, Math.floor(requested)))
        : 20;
      const kind = typeof req.query.kind === 'string' && req.query.kind.trim()
        ? req.query.kind.trim().slice(0, 64)
        : null;

      const [recent, totals] = await Promise.all([
        pool.query(
          `SELECT id, kind, recipient, provider, status, error, created_at
             FROM mail_deliveries
            WHERE ($1::text IS NULL OR kind = $1)
            ORDER BY created_at DESC
            LIMIT ${limit}`,
          [kind]
        ),
        pool.query(
          `SELECT status, COUNT(*)::int AS n
             FROM mail_deliveries
            WHERE created_at > NOW() - INTERVAL '24 hours'
              AND ($1::text IS NULL OR kind = $1)
            GROUP BY status`,
          [kind]
        ),
      ]);

      const last24h = {};
      for (const row of totals.rows) last24h[row.status] = row.n;

      res.json({ deliveries: recent.rows, last24h, kind, limit });
    } catch (err) {
      log.error('admin', 'mail activity failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Send one diagnostic email.
  //
  // Full admins only (it spends provider quota and puts a real message in
  // somebody's inbox) and rate-limited on top of that. The response is
  // 200 for every outcome the mail service can REPORT — including
  // `failed` and `no_transport` — because those are answers to the
  // question the operator asked, not errors in asking it. Only a
  // malformed request gets a 4xx, and that path never writes a ledger
  // row: nothing was attempted.
  router.post('/api/admin/mail/test', requireAdminWrite, mailTestLimiter,
    async (req, res) => {
      try {
        const { to, error } = validateTestRecipient((req.body || {}).to);
        if (error) return res.status(400).json({ error });

        const outcome = await mail.sendTest(config, { to });

        events.record(pool, {
          type: events.EVENT_TYPES.MAIL_TEST_SENT,
          userId: req.user.id,
          metadata: { status: outcome.status, provider: outcome.provider, recipient: to },
        });

        log.warn('admin', 'Admin sent a test email', {
          by: req.user.username,
          status: outcome.status,
          provider: outcome.provider,
          reference: outcome.reference,
        });

        res.json({ outcome });
      } catch (err) {
        log.error('admin', 'mail test failed', { message: err.message });
        res.status(500).json({ error: 'Internal server error' });
      }
    });

  return router;
}

module.exports = { adminRoutes };
