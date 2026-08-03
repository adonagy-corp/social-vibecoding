'use strict';

/**
 * Bulk container rollover — recreate every running child-app container
 * with a freshly assembled environment.
 *
 * WHY THIS EXISTS
 *
 * Docker has no "set env on a live container" primitive, and neither does
 * the platform: an env change (a newly injected variable, a rotated key)
 * only reaches an app when its container is stop+rm+run with env built by
 * the CURRENT platform process. `docker restart` / `docker start` preserve
 * the original env, so a host reboot or an app-heal fast-path start leaves
 * a container looking perfectly healthy while still holding stale env.
 *
 * Before this module the only on-demand env-correct path was
 * `POST /api/apps/:slug/redeploy` → `staging.rebuildProduction`, which does
 * a full clone + `docker build` (p50 ~28s per app) one app at a time. The
 * cheap path — `appRespawn.runExistingImage`, which re-runs the image that
 * is already on the host with a freshly assembled env (~3-6s per app) —
 * was reachable only from the one-time boot migration and the watchdog.
 * This module exposes it as one admin-triggered sweep.
 *
 * DELIBERATELY ENV-ONLY. The respawn path reuses each app's existing
 * image, so a rollover never ships undeployed code and never applies
 * pending manifest reconciliation (name / visibility / governance /
 * admins / icon). That is the whole point: it is the safer tool than
 * /redeploy for "the environment changed, nothing else did". The full
 * rebuild is used only as a fallback when the image is missing.
 *
 * SHAPE
 *
 *   - One job at a time (module-level singleton). A second start() while a
 *     job is live returns the in-flight job instead of beginning a second
 *     sweep; the route turns that into a 409.
 *   - In-memory, not persisted — same rationale as app-deploy-status.js: if
 *     the platform restarts mid-job the work dies with it, and a fresh
 *     process showing no in-flight job is exactly right. A stale guard
 *     (30 min, mirroring DEPLOY_STALE_AFTER_MS) keeps a job that never
 *     unwound from blocking the next one forever.
 *   - Per-app failure isolation: every unit is individually caught, the
 *     drain continues, and the failure lands in `apps.last_failure` so the
 *     existing "View build log" panel covers it.
 *   - Progress rides existing WS machinery: per-app
 *     `app_redeploy_status` (via app-deploy-status markStart/markEnd, which
 *     is what flips the version pills) plus one aggregate
 *     `admin_rollover_status` sent only to admin sockets.
 */

const log = require('./logger');
const docker = require('./docker');
const appRespawn = require('./app-respawn');
const appDeployStatus = require('./app-deploy-status');
const deployFailure = require('./deploy-failure');
const events = require('./events');
const { getPool } = require('../db/pool');

// Mirrors app-heal.js's MAX_HEALS_PER_TICK: the existing precedent for
// "how much docker churn is polite on this host". At 3, at most three apps
// are briefly unavailable at once.
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 10;

// Same TTL as app-deploy-status: anything claiming to be in flight for
// >30min is an orphaned record (a caller died without unwinding), not a
// genuinely slow sweep — every unit is seconds.
const JOB_STALE_AFTER_MS = 30 * 60 * 1000;

// The apps this sweep owns. `self_hosted IS NOT TRUE` is the primary
// self-app exclusion — the platform's own row is status='running' too, so
// omitting it would try to stop the container serving the request. Same
// predicate app-heal.poll uses.
const ELIGIBLE_WHERE = "status = 'running' AND self_hosted IS NOT TRUE";

// slug -> row shape runExistingImage needs (db_password, manifest_snapshot)
// plus what the fallback and the UI need.
const SELECT_ELIGIBLE = `
  SELECT id, slug, name, db_password, manifest_snapshot, repo_url,
         self_hosted, main_sha
    FROM apps
   WHERE ${ELIGIBLE_WHERE}
   ORDER BY id`;

// Per-app outcomes, in the spirit of app-heal.checkAndHealOne's documented
// status enum:
//   rolled                  — image re-run with fresh env, healthy
//   rebuilt                 — image was missing; full rebuildProduction ran
//   skipped_deploying       — another rebuild owns this slug right now
//   skipped_missing_secrets — required secrets unset; image can't run
//   skipped_no_db_password  — per-role migration hasn't populated it
//   skipped_deleted         — app row vanished mid-job
//   failed                  — docker run / health check threw
const FAILED = 'failed';

let _job = null;
let _seq = 0;

function isStagingEnv() {
  return process.env.USERNODE_ENV === 'staging';
}

function concurrency() {
  const raw = parseInt(process.env.ROLLOVER_CONCURRENCY || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CONCURRENCY;
  return Math.min(raw, MAX_CONCURRENCY);
}

function isActive(job) {
  if (!job || job.finishedAt) return false;
  const age = Date.now() - new Date(job.startedAt).getTime();
  return age <= JOB_STALE_AFTER_MS;
}

function snapshot(job) {
  if (!job) return null;
  return {
    id: job.id,
    startedAt: job.startedAt,
    startedBy: job.startedBy || null,
    finishedAt: job.finishedAt || null,
    concurrency: job.concurrency,
    total: job.total,
    done: job.done,
    failed: job.failed,
    stale: !job.finishedAt && !isActive(job),
    apps: job.apps.map((a) => ({
      appId: a.appId,
      slug: a.slug,
      state: a.state,
      ms: a.ms,
      error: a.error,
    })),
  };
}

// Lazily required so the module graph stays acyclic (ws.js does not import
// this module, but routes that load ws also load this) — same dodge
// app-deploy-status.js documents.
function broadcast(job) {
  try {
    const { broadcastToAdmins } = require('./ws');
    broadcastToAdmins({ type: 'admin_rollover_status', job: snapshot(job) });
  } catch (err) {
    log.warn('app-rollover', 'broadcast failed', { err: err.message });
  }
}

function read() {
  return snapshot(_job);
}

async function eligibleCount(config) {
  const pool = getPool(config);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM apps WHERE ${ELIGIBLE_WHERE}`
  );
  return rows[0] ? rows[0].n : 0;
}

/**
 * Staging demo job — request-time injection per the "Staging mock data"
 * convention, so the console section renders reviewable rows in a preview
 * (which has no production containers to roll over at all). Never
 * persisted; the route only serves it behind IS_STAGING && ?demo=1, and
 * POST stays refused in staging regardless.
 */
function demoJob() {
  return {
    id: 1,
    startedAt: '2026-01-01T12:00:00.000Z',
    startedBy: 'staging-demo-admin',
    finishedAt: '2026-01-01T12:00:47.000Z',
    concurrency: DEFAULT_CONCURRENCY,
    total: 5,
    done: 5,
    failed: 1,
    stale: false,
    demo: true,
    apps: [
      { appId: 900001, slug: 'staging-demo-app-one', state: 'rolled', ms: 4100, error: null },
      { appId: 900002, slug: 'staging-demo-app-two', state: 'rolled', ms: 3700, error: null },
      { appId: 900003, slug: 'staging-demo-app-three', state: 'rebuilt', ms: 31200, error: null },
      {
        appId: 900004,
        slug: 'staging-demo-app-four',
        state: 'skipped_missing_secrets',
        ms: 120,
        error: null,
      },
      {
        appId: 900005,
        slug: 'staging-demo-app-five',
        state: FAILED,
        ms: 22400,
        error: 'Container did not become healthy after respawn',
      },
    ],
  };
}

/**
 * Kick off a sweep. Synchronous by design: it creates and returns the job
 * record, then runs the docker work on a detached promise so the route can
 * answer 202 immediately (same fire-and-forget shape as /redeploy).
 *
 * Returns { started, job }. `started: false` means a job was already in
 * flight and `job` is that one.
 */
function start(config, { userId = null, username = null } = {}) {
  if (isActive(_job)) return { started: false, job: snapshot(_job) };

  const job = {
    id: ++_seq,
    startedAt: new Date().toISOString(),
    startedBy: username,
    startedByUserId: userId,
    finishedAt: null,
    concurrency: concurrency(),
    total: 0,
    done: 0,
    failed: 0,
    apps: [],
  };
  _job = job;

  // Detached: errors are contained here so an unhandled rejection can
  // never escape into the request that started the sweep.
  run(config, job).catch((err) => {
    log.error('app-rollover', 'Rollover job crashed', { jobId: job.id, err: err.message });
    if (!job.finishedAt) {
      job.finishedAt = new Date().toISOString();
      broadcast(job);
    }
  });

  return { started: true, job: snapshot(job) };
}

async function run(config, job) {
  const pool = getPool(config);
  const startedMs = Date.now();

  const { rows } = await pool.query(SELECT_ELIGIBLE);
  job.total = rows.length;
  job.apps = rows.map((app) => ({
    appId: app.id,
    slug: app.slug,
    state: 'pending',
    ms: null,
    error: null,
  }));
  log.info('app-rollover', 'Container rollover started', {
    jobId: job.id, total: job.total, concurrency: job.concurrency,
    by: job.startedBy || null,
  });
  broadcast(job);

  await drain(rows, job.concurrency, async (app, idx) => {
    const entry = job.apps[idx];
    entry.state = 'running';
    broadcast(job);
    const unitStarted = Date.now();
    let outcome = FAILED;
    let error = null;
    try {
      const result = await rollOne(config, pool, app);
      outcome = result.outcome;
      error = result.error || null;
    } catch (err) {
      // Belt-and-braces: rollOne already catches, so reaching here means a
      // bug rather than a docker failure. Still isolated per app.
      outcome = FAILED;
      error = err && err.message ? err.message : 'rollover failed';
      log.error('app-rollover', 'Unit threw outside its own guard', {
        slug: app.slug, err: error,
      });
    }
    entry.state = outcome;
    entry.error = error;
    entry.ms = Date.now() - unitStarted;
    job.done += 1;
    if (outcome === FAILED) job.failed += 1;
    broadcast(job);
  });

  job.finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startedMs;
  const tally = job.apps.reduce((acc, a) => {
    acc[a.state] = (acc[a.state] || 0) + 1;
    return acc;
  }, {});
  const failedSlugs = job.apps.filter((a) => a.state === FAILED).map((a) => a.slug);
  log.info('app-rollover', 'Container rollover finished', {
    jobId: job.id, total: job.total, failed: job.failed, durationMs, tally,
  });
  broadcast(job);

  // The only durable trace of the job — the job object itself is
  // in-memory, so an interrupted sweep leaves no row (apps.last_deploy_at
  // is the reconstruction path). Best-effort, like every events.record.
  events.record(pool, {
    type: events.EVENT_TYPES.CONTAINERS_ROLLED_OVER,
    userId: job.startedByUserId || null,
    metadata: {
      jobId: job.id,
      total: job.total,
      rolled: tally.rolled || 0,
      rebuilt: tally.rebuilt || 0,
      skipped: Object.keys(tally)
        .filter((k) => k.startsWith('skipped_'))
        .reduce((n, k) => n + tally[k], 0),
      failed: job.failed,
      failedSlugs,
      durationMs,
    },
  });
}

/**
 * One app's unit of work. Never throws — every path resolves to an
 * outcome string so a single bad app can't take the sweep down.
 */
async function rollOne(config, pool, app) {
  const containerName = `usernode-app-${app.slug}`;
  const imageName = `usernode-app-${app.slug}:latest`;

  // Something else (merge, drift poller, heal) owns this slug right now.
  // Stepping on it would interleave two stopAndRemove/runContainer pairs.
  const deploy = appDeployStatus.read(app.slug);
  if (deploy && deploy.deploying) return { outcome: 'skipped_deploying' };

  const kubernetesMode = config.appRuntime === 'kubernetes';
  const hasImage = kubernetesMode
    ? !!app.image_ref
    : await docker.imageExists(imageName).catch(() => false);

  if (!hasImage) {
    // Fallback: the cheap path needs an image on the host. Deliberately
    // NOT wrapped in serializeRebuild — rebuildProduction takes that lock
    // itself, and nesting would deadlock the slug's chain.
    if (!app.repo_url) {
      const err = new Error(
        `no image ${imageName} on the host and no repo_url — nothing to run`
      );
      await persistFailure(pool, app, err, 'start');
      log.warn('app-rollover', 'Cannot roll over app', { slug: app.slug, err: err.message });
      return { outcome: FAILED, error: err.message };
    }
    try {
      const staging = require('./staging');
      const { containerId, sha } = await staging.rebuildProduction(config, app);
      const { rowCount } = await pool.query(
        `UPDATE apps SET container_id = $1, main_sha = $2, last_deploy_at = NOW()
          WHERE id = $3`,
        [containerId, sha || app.main_sha || null, app.id]
      );
      if (!rowCount) return { outcome: 'skipped_deleted' };
      return { outcome: 'rebuilt' };
    } catch (err) {
      // rebuildProduction persists its own last_failure record.
      log.warn('app-rollover', 'Rebuild fallback failed', {
        slug: app.slug, err: err.message,
      });
      return { outcome: FAILED, error: err.message };
    }
  }

  // Per-slug serialization: bulk rollover, dev-chat merges, the drift
  // poller and heals all queue behind one another for the same app. This
  // is the race staging.js's serializeRebuild comment documents —
  // runExistingImage does not take the lock on its own.
  const staging = require('./staging');
  return staging.serializeRebuild(app.slug, async () => {
    // markStart/markEnd are the only emitters of app_redeploy_status, so
    // this is what makes the version pills spin during a rollover.
    appDeployStatus.markStart(app.slug, { fromSha: app.main_sha || null });
    let failedForPill = false;
    try {
      let containerId;
      try {
        containerId = await appRespawn.runExistingImage(config, app);
      } catch (err) {
        if (/db_password/.test(err.message || '')) {
          log.warn('app-rollover', 'App has no db_password — skipping', { slug: app.slug });
          return { outcome: 'skipped_no_db_password' };
        }
        failedForPill = true;
        await persistFailure(pool, app, err, 'start');
        log.warn('app-rollover', 'Respawn failed', { slug: app.slug, err: err.message });
        return { outcome: FAILED, error: err.message };
      }

      // null means required secrets are unset. Do NOT fall back to
      // rebuildProduction — it would raise MissingSecretsError for the
      // same reason, after a pointless clone + build.
      if (!containerId) return { outcome: 'skipped_missing_secrets' };

      try {
        if (kubernetesMode) {
          const { rowCount } = await pool.query(
            `UPDATE apps SET container_id = NULL, runtime_kind = 'kubernetes',
               runtime_name = $1, last_deploy_at = NOW() WHERE id = $2`,
            [containerId, app.id]
          );
          if (!rowCount) return { outcome: 'skipped_deleted' };
          return { outcome: 'rolled' };
        }
        await docker.waitForHealthy(containerName, 3000, '/health', 10);
      } catch (err) {
        failedForPill = true;
        await persistFailure(pool, app, err, 'healthcheck');
        log.warn('app-rollover', 'Container did not become healthy after respawn', {
          slug: app.slug, err: err.message,
        });
        return { outcome: FAILED, error: err.message };
      }

      // container_id AND last_deploy_at, mirroring app-heal's
      // recoverFromScratch. Deliberately NOT apps.status (flipping it
      // drops the app's URL from the home tile — see app-deploy-status.js)
      // and NOT main_sha (nothing was rebuilt).
      const { rowCount } = await pool.query(
        'UPDATE apps SET container_id = $1, last_deploy_at = NOW() WHERE id = $2',
        [containerId, app.id]
      );
      if (!rowCount) return { outcome: 'skipped_deleted' };
      return { outcome: 'rolled' };
    } finally {
      appDeployStatus.markEnd(app.slug, { failed: failedForPill });
    }
  });
}

// apps.last_failure so the existing "View build log" panel covers rollover
// failures too. classify() honors an explicit stage, so a failed docker run
// reads 'start' and a failed health wait reads 'healthcheck'. sha is null —
// nothing was built.
async function persistFailure(pool, app, err, stage) {
  try {
    await pool.query(
      'UPDATE apps SET last_failure = $1 WHERE id = $2',
      [JSON.stringify(deployFailure.record(err, { stage, sha: null })), app.id]
    );
  } catch (e) {
    log.warn('app-rollover', 'Failed to persist last_failure', {
      slug: app.slug, err: e.message,
    });
  }
}

// Fixed-width worker drain. No barrier between items: a slow app never
// holds up the next one, and at most `limit` docker operations are in
// flight. The worker is expected never to reject (callers guard).
async function drain(items, limit, worker) {
  if (!items.length) return;
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = [];
  for (let i = 0; i < width; i++) {
    runners.push((async () => {
      for (;;) {
        const idx = next++;
        if (idx >= items.length) return;
        await worker(items[idx], idx);
      }
    })());
  }
  await Promise.all(runners);
}

// Test seam only: drop the singleton so each case starts clean.
function _reset() {
  _job = null;
  _seq = 0;
}

module.exports = {
  start,
  read,
  demoJob,
  eligibleCount,
  isStagingEnv,
  concurrency,
  DEFAULT_CONCURRENCY,
  JOB_STALE_AFTER_MS,
  SELECT_ELIGIBLE,
  _reset,
};
