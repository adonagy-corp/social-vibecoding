/**
 * Production app-container watchdog (issue #426).
 *
 * The Caddyfile's wildcard site routes `<slug>.<domain>` to the container
 * named `usernode-app-<slug>` — when that container is stopped or missing,
 * every visit 502s and NOTHING repaired it: the drift poller only redeploys
 * on a main-SHA change, and the server.js heal sweep covers staging
 * previews only. This service closes the gap for production apps:
 *
 *   - Periodic sweep (default every 60s): for every status='running',
 *     non-self-hosted app, check the container's docker state. A stopped
 *     container gets a fast `docker start` (image + env + container all
 *     still exist); a missing one gets a full `staging.rebuildProduction`
 *     (repo-backed apps) or a re-run of the already-built image via
 *     app-respawn's runExistingImage (repo-less apps).
 *
 *   - On-demand heal (requestHeal): fired by the /__app_unavailable error
 *     page (src/routes/app-error.js) the moment a user actually hits a
 *     down app, so recovery starts immediately instead of waiting for the
 *     next tick. This path additionally HTTP-probes a 'running' container
 *     and `docker restart`s it when it's up-but-wedged — the state-only
 *     sweep can't see that failure mode, and probing every app every tick
 *     would be needless load.
 *
 * Churn control mirrors the staging heal sweep: a per-app cooldown
 * (default 10 min) is stamped BEFORE each attempt so a persistently
 * failing app (crash-loop on bad code, missing required secret) doesn't
 * thrash docker builds every tick; at most a few heals run per sweep.
 * A container observed 'restarting' gets one tick of grace — Docker's own
 * `--restart unless-stopped` policy is usually mid-backoff and recovers on
 * its own; we only step in when it's still not running next tick.
 *
 * Like the drift poller, apps.status deliberately stays 'running'
 * throughout a heal (flipping it would drop the app's URL from the home
 * tile — see main-drift-poller.js for the full rationale), and rebuilds
 * go through rebuildProduction so they get the same per-slug
 * serialization + version-pill deploy status as every other deploy path.
 */

const log = require('./logger');
const docker = require('./docker');
const applicationRuntime = require('./application-runtime');
const { getPool } = require('../db/pool');

const FIRST_PASS_DELAY_MS = 30_000;
const MAX_HEALS_PER_TICK = 3;
// requestHeal debounce: one error-page hit kicks a check; the retry
// storm from the page's 5s polling (and every other visitor) must not.
const REQUEST_HEAL_DEBOUNCE_MS = 30_000;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

// In-memory state, all keyed by slug (one process owns all heals).
const inFlight = new Set();          // heal currently running
const healAttempts = new Map();      // slug -> ts of last heal attempt (cooldown)
const restartingStreak = new Map();  // slug -> consecutive 'restarting' sightings
const requestDebounce = new Map();   // slug -> ts of last requestHeal

let _config = null; // captured by start() for requestHeal callers without one

function intervalMs(config) {
  const v = config && Number.isFinite(config.appHealIntervalMs)
    ? config.appHealIntervalMs
    : parseInt(process.env.APP_HEAL_INTERVAL_MS || String(DEFAULT_INTERVAL_MS), 10);
  return Number.isFinite(v) ? v : DEFAULT_INTERVAL_MS;
}

function cooldownMs(config) {
  const v = config && Number.isFinite(config.appHealCooldownMs)
    ? config.appHealCooldownMs
    : parseInt(process.env.APP_HEAL_COOLDOWN_MS || String(DEFAULT_COOLDOWN_MS), 10);
  return Number.isFinite(v) ? v : DEFAULT_COOLDOWN_MS;
}

function containerName(slug) {
  return `usernode-app-${slug}`;
}

// Rebuild-or-respawn for a container that is gone (or refused to start in
// place). Repo-backed apps go through rebuildProduction — the same flow
// every other deploy path uses (per-slug serialized, drives the version
// pill); repo-less apps re-run their already-built image with a freshly
// assembled env. Returns the result status string.
async function recoverFromScratch(config, pool, app) {
  const github = require('./github');
  const name = containerName(app.slug);

  if (app.repo_url && github.isEnabled()) {
    const staging = require('./staging');
    const { containerId, sha } = await staging.rebuildProduction(config, app);
    await pool.query(
      `UPDATE apps SET container_id = $1, main_sha = $2, last_deploy_at = NOW()
       WHERE id = $3`,
      [containerId, sha || app.main_sha || null, app.id]
    );
    try {
      const { broadcastGlobal } = require('./ws');
      broadcastGlobal({
        type: 'app_version_changed',
        appSlug: app.slug,
        sha: sha || null,
        prNumber: null,
      });
    } catch (_) { /* ws failures are non-fatal */ }
    log.info('app-heal', 'App rebuilt from repo', { slug: app.slug, sha: (sha || '').slice(0, 7) });
    return 'rebuilt';
  }

  // No repo (or no GitHub configured): the image built at create time is
  // still on the host — re-run it with a freshly assembled env.
  const appRespawn = require('./app-respawn');
  const containerId = await appRespawn.runExistingImage(config, app);
  if (!containerId) {
    // Missing required secrets — unrunnable until a human fixes them.
    throw new Error(`cannot respawn ${app.slug}: missing required secrets`);
  }
  await docker.waitForHealthy(name, 3000, '/health', 10);
  await pool.query(
    'UPDATE apps SET container_id = $1, last_deploy_at = NOW() WHERE id = $2',
    [containerId, app.id]
  );
  log.info('app-heal', 'App respawned from existing image', { slug: app.slug });
  return 'respawned';
}

// A 'running' app with repo_url NULL is permanently broken for the dev
// workflow: every chat turn bails ("No GitHub repo configured"), sessions
// can't be created, and NOTHING repaired it — /retry only accepts
// status='error' apps. This state comes from a pre-fix createApp that
// swallowed a GitHub repo-creation failure and fell back to a local build
// (the failure is fatal at create time now, but existing apps need
// healing). Provision the repo — create it under the bot account, push
// the template (getTemplateFiles never embeds dbUrl or any key in file
// contents, so nothing secret lands on GitHub), persist repo_url — then
// rebuildProduction so prod converges with the new repo. A repo-less app
// can never have merged any change (no repo → no PRs), so the current
// template is the best available source for its content.
async function provisionMissingRepo(config, pool, app) {
  const github = require('./github');
  const dbManager = require('./db-manager');
  const { getTemplateFiles } = require('./template');

  const botUsername = await github.getBotUsername();
  // adoptExisting: the create-time failure that produces a repo-less app
  // usually fired AFTER the GitHub create call succeeded (between it and
  // the repo_url persist), so the repo typically already exists on the
  // bot account — a plain create would 422 "name already exists" on
  // every sweep forever. Adopting it is safe: this app has never merged
  // anything (no repo_url → no PRs), and the template push below just
  // commits on top of whatever the orphan contains.
  const repo = await github.createRepo(botUsername, app.slug, {
    description: `${app.name} — built on Usernode Social Vibecoding`,
    adoptExisting: true,
  });
  const repoUrl = repo.html_url;

  const dbUrl = dbManager.connectionUrl(dbManager.appDbName(app.slug), app.db_password);
  const files = getTemplateFiles(app.name, app.slug, dbUrl);
  await github.pushFiles(botUsername, app.slug, files, {
    message: `Initialize ${app.name} from Usernode template (repo heal)`,
  });

  // Persist BEFORE the rebuild: if the rebuild fails the repo still
  // exists and the app is already un-broken for the dev workflow — the
  // container heal paths take over from here on the next tick.
  await pool.query('UPDATE apps SET repo_url = $1 WHERE id = $2', [repoUrl, app.id]);
  app.repo_url = repoUrl;
  log.info('app-heal', 'GitHub repo provisioned for repo-less app', {
    slug: app.slug, repoUrl,
  });

  const staging = require('./staging');
  const { containerId, sha } = await staging.rebuildProduction(config, app);
  await pool.query(
    `UPDATE apps SET container_id = $1, main_sha = $2, last_deploy_at = NOW()
     WHERE id = $3`,
    [containerId, sha || null, app.id]
  );
  try {
    const { broadcastGlobal } = require('./ws');
    broadcastGlobal({
      type: 'app_version_changed',
      appSlug: app.slug,
      sha: sha || null,
      prNumber: null,
    });
  } catch (_) { /* ws failures are non-fatal */ }
  log.info('app-heal', 'Production converged with provisioned repo', {
    slug: app.slug, sha: (sha || '').slice(0, 7),
  });
}

// Check one app's production container and heal it if needed. Returns a
// structured status so the sweep loop and tests can act on the outcome:
//   healthy         — container is running (and, when probed, answering)
//   skipped         — self-hosted / not eligible
//   in_flight       — a heal for this slug is already running
//   deploying       — a rebuild is mid-flight (app-deploy-status)
//   restart_grace   — 'restarting' seen once; give Docker's policy a tick
//   cooldown        — a recent attempt failed; not retrying yet
//   started         — stopped container brought back with `docker start`
//   rebuilt         — full rebuildProduction succeeded
//   respawned       — existing image re-run succeeded
//   restarted       — hung-but-running container docker-restarted (probe path)
//   repo_provisioned — missing GitHub repo created + prod converged
//   heal_failed     — the attempt threw; cooldown stamped
async function checkAndHealOne(config, pool, app, { probeRunning = false } = {}) {
  if (app.self_hosted) return { status: 'skipped', slug: app.slug };
  if (inFlight.has(app.slug)) return { status: 'in_flight', slug: app.slug };

  const appDeployStatus = require('./app-deploy-status');
  const deploy = appDeployStatus.read(app.slug);
  if (deploy && deploy.deploying) return { status: 'deploying', slug: app.slug };

  // Repo provisioning comes before the container-state logic: a repo-less
  // app usually has a perfectly healthy container, which would otherwise
  // return 'healthy' before we ever looked at repo_url. Same cooldown +
  // in-flight machinery as container heals, so a persistent GitHub outage
  // can't thrash the API every tick.
  {
    const github = require('./github');
    if (!app.repo_url && github.isEnabled()) {
      if (Date.now() - (healAttempts.get(app.slug) || 0) < cooldownMs(config)) {
        return { status: 'cooldown', slug: app.slug };
      }
      healAttempts.set(app.slug, Date.now());
      inFlight.add(app.slug);
      try {
        await provisionMissingRepo(config, pool, app);
        healAttempts.delete(app.slug);
        return { status: 'repo_provisioned', slug: app.slug };
      } catch (err) {
        // Cooldown stays stamped — retried next tick after it lapses.
        log.warn('app-heal', 'Repo provisioning failed (will retry after cooldown)', {
          slug: app.slug, err: err.message,
        });
        return { status: 'heal_failed', slug: app.slug, error: err.message };
      } finally {
        inFlight.delete(app.slug);
      }
    }
  }

  const name = app.runtime_name || containerName(app.slug);
  const runtimeRef = { runtimeKind: app.runtime_kind || 'docker', runtimeName: name };
  const state = await applicationRuntime.status(config, runtimeRef);

  if (runtimeRef.runtimeKind === 'kubernetes') {
    if (state === 'running') return { status: 'healthy', slug: app.slug };
    if (Date.now() - (healAttempts.get(app.slug) || 0) < cooldownMs(config)) {
      return { status: 'cooldown', slug: app.slug };
    }
    healAttempts.set(app.slug, Date.now());
    inFlight.add(app.slug);
    try {
      if (state !== 'not_found') {
        await applicationRuntime.restart(config, runtimeRef);
        healAttempts.delete(app.slug);
        return { status: 'restarted', slug: app.slug };
      }
      const recovered = await recoverFromScratch(config, pool, app);
      healAttempts.delete(app.slug);
      return { status: recovered, slug: app.slug };
    } catch (err) {
      log.error('app-heal', 'Kubernetes heal failed', { slug: app.slug, err: err.message });
      return { status: 'heal_failed', slug: app.slug, error: err.message };
    } finally {
      inFlight.delete(app.slug);
    }
  }

  if (state === 'running') {
    restartingStreak.delete(app.slug);
    if (!probeRunning) return { status: 'healthy', slug: app.slug };
    // On-demand path only: a user just hit the error page for this app,
    // yet the container claims to be running — probe it, and restart a
    // hung process. waitForHealthy's short form gives ~2 tries (~4s).
    try {
      await docker.waitForHealthy(name, 3000, '/health', 2);
      return { status: 'healthy', slug: app.slug };
    } catch (_) {
      if (Date.now() - (healAttempts.get(app.slug) || 0) < cooldownMs(config)) {
        return { status: 'cooldown', slug: app.slug };
      }
      healAttempts.set(app.slug, Date.now());
      inFlight.add(app.slug);
      try {
        log.warn('app-heal', 'Container running but not answering — restarting', { slug: app.slug });
        await docker.restartContainer(name);
        await docker.waitForHealthy(name, 3000, '/health', 10);
        healAttempts.delete(app.slug);
        return { status: 'restarted', slug: app.slug };
      } catch (err) {
        log.error('app-heal', 'Restart of hung container failed', { slug: app.slug, err: err.message });
        return { status: 'heal_failed', slug: app.slug, error: err.message };
      } finally {
        inFlight.delete(app.slug);
      }
    }
  }

  if (state === 'restarting') {
    // Docker's own restart policy is mid-backoff. Give it one tick of
    // grace — most crash-restarts recover on their own; only a container
    // STILL not running next time gets escalated to a heal.
    const seen = (restartingStreak.get(app.slug) || 0) + 1;
    restartingStreak.set(app.slug, seen);
    if (seen < 2) return { status: 'restart_grace', slug: app.slug };
  } else {
    restartingStreak.delete(app.slug);
  }

  // Non-running: exited / created / paused / dead / not_found (or a
  // persistent 'restarting'). Cooldown-gate the attempt, stamped BEFORE
  // the (possibly minutes-long) work so a concurrent tick can't double-heal.
  if (Date.now() - (healAttempts.get(app.slug) || 0) < cooldownMs(config)) {
    return { status: 'cooldown', slug: app.slug };
  }
  healAttempts.set(app.slug, Date.now());
  inFlight.add(app.slug);
  log.info('app-heal', 'Production container is down — healing', {
    slug: app.slug, containerState: state,
  });

  try {
    // Fast path: the container still exists — start it in place.
    if (state !== 'not_found') {
      try {
        await docker.startContainer(name);
        await docker.waitForHealthy(name, 3000, '/health', 10);
        healAttempts.delete(app.slug);
        restartingStreak.delete(app.slug);
        log.info('app-heal', 'Container started in place', { slug: app.slug });
        return { status: 'started', slug: app.slug };
      } catch (err) {
        log.warn('app-heal', 'In-place start failed; escalating to rebuild', {
          slug: app.slug, err: err.message,
        });
      }
    }
    const status = await recoverFromScratch(config, pool, app);
    healAttempts.delete(app.slug);
    restartingStreak.delete(app.slug);
    return { status, slug: app.slug };
  } catch (err) {
    // Cooldown stays stamped — a crash-loop on bad code or a missing
    // secret can't be fixed by retrying every tick.
    log.error('app-heal', 'Heal failed', { slug: app.slug, err: err.message });
    return { status: 'heal_failed', slug: app.slug, error: err.message };
  } finally {
    inFlight.delete(app.slug);
  }
}

async function poll(config) {
  const pool = getPool(config);
  const { rows } = await pool.query(
    `SELECT * FROM apps
      WHERE status = 'running' AND self_hosted IS NOT TRUE`
  );
  if (!rows.length) return;

  // Sequential, like the drift poller: heals can kick docker start /
  // build / health waits, and we don't want to saturate the host.
  // Bound the number of actual heal ATTEMPTS per tick; the rest are
  // picked up next tick.
  let attempts = 0;
  for (const app of rows) {
    if (attempts >= MAX_HEALS_PER_TICK) break;
    try {
      const result = await checkAndHealOne(config, pool, app);
      if (['started', 'rebuilt', 'respawned', 'repo_provisioned', 'heal_failed'].includes(result.status)) {
        attempts++;
      }
    } catch (err) {
      log.warn('app-heal', 'Per-app check threw (continuing)', { slug: app.slug, err: err.message });
    }
  }
}

// On-demand heal, fired by the /__app_unavailable error page when a user
// actually lands on a down app. Debounced per slug so the page's retry
// polling (and concurrent visitors) collapse into one check. Never
// throws; fire-and-forget.
function requestHeal(slug, config = _config) {
  if (!slug || !config) return;
  const now = Date.now();
  if (now - (requestDebounce.get(slug) || 0) < REQUEST_HEAL_DEBOUNCE_MS) return;
  requestDebounce.set(slug, now);

  (async () => {
    const pool = getPool(config);
    const { rows } = await pool.query(
      `SELECT * FROM apps
        WHERE slug = $1 AND status = 'running' AND self_hosted IS NOT TRUE`,
      [slug]
    );
    if (!rows.length) return;
    const result = await checkAndHealOne(config, pool, rows[0], { probeRunning: true });
    log.info('app-heal', 'On-demand heal finished', { slug, status: result.status });
  })().catch((err) => {
    log.warn('app-heal', 'On-demand heal failed', { slug, err: err.message });
  });
}

function start(config) {
  _config = config;
  const interval = intervalMs(config);
  if (!interval) {
    log.info('app-heal', 'Disabled (APP_HEAL_INTERVAL_MS=0)');
    return;
  }
  log.info('app-heal', 'Starting', { intervalMs: interval, cooldownMs: cooldownMs(config) });
  setTimeout(() => {
    poll(config).catch((err) => log.error('app-heal', 'Initial sweep failed', { err: err.message }));
  }, FIRST_PASS_DELAY_MS).unref?.();
  setInterval(() => {
    poll(config).catch((err) => log.error('app-heal', 'Sweep failed', { err: err.message }));
  }, interval).unref?.();
}

// Test hook: clear all in-memory bookkeeping between test cases.
function _resetForTests() {
  inFlight.clear();
  healAttempts.clear();
  restartingStreak.clear();
  requestDebounce.clear();
  _config = null;
}

module.exports = { start, poll, checkAndHealOne, requestHeal, _resetForTests };
