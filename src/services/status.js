const { getPool } = require('../db/pool');
const log = require('./logger');
const workerProgress = require('./worker-progress');
const deployStatus = require('./deploy-status');
const nodeStatus = require('./node-status');
// Aliased to avoid colliding with the per-session `worker` local later
// in this file (where `worker = workers.find(...)` rebinds the name).
const workerSvc = require('./worker');
const applicationRuntime = require('./application-runtime');
const runtimeStatus = require('./runtime-status');

const WORKER_PREFIX = 'usernode-worker-';
const APP_PREFIX = 'usernode-app-';
const STAGING_PREFIX = 'usernode-staging-';

// Fallbacks only — the live caps come from config (MAX_GLOBAL_SESSIONS /
// MAX_USER_SESSIONS). Native coding sessions are 1:1 with workers. Imported
// PRs are produced externally and are excluded from this worker budget even
// though Usernode may build them a staging preview. These constants are kept
// so the dashboard still renders if config is absent.
const MAX_STAGING_GLOBAL = 25;
const MAX_STAGING_PER_USER = 3;
const WORKER_ORPHAN_THRESHOLD_MS = 20 * 60 * 1000;
const STUCK_SESSION_THRESHOLD_MS = 2 * 60 * 1000;

// Match sessions.js LLM caps so the dashboard shows the same numbers.
const USER_DAILY_LIMIT_CENTS = 2500;
const GLOBAL_DAILY_LIMIT_CENTS = 20000;

async function listContainers(config) {
  return runtimeStatus.listDockerContainers(config);
}

async function getStats(config) {
  return runtimeStatus.getDockerStats(config);
}

function uptimeSeconds(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

// gatherFull: always builds the *admin* version of the payload (with all
// fields). Caching layer below stores this and the per-request `gather()`
// strips admin-only fields for non-admin viewers via `redact()`.
//
// This is the slow path — four DB queries plus the active runtime's
// inventory/capacity calls. Docker also collects one-shot stats and start
// timestamps; Kubernetes deliberately sticks to readiness and quota data.
// Don't call directly from a request handler; use `gather()`.
async function gatherFull(config) {
  const pool = getPool(config);
  const isAdmin = true; // Always build the full payload; redact at serve time.

  const [appsQ, sessionsQ, llmQ, sessionCountsQ, runtimeQ] = await Promise.all([
    pool.query(
      `SELECT a.id, a.name, a.slug, a.repo_url, a.container_id, a.status, a.created_at,
              a.image_ref, a.build_ref, a.runtime_kind, a.runtime_name,
              u.username AS created_by_username,
              (SELECT COUNT(*) FROM chat_sessions cs
                 WHERE cs.app_id = a.id AND cs.status = 'active') AS open_sessions,
              (SELECT COUNT(*) FROM issues i
                 WHERE i.app_id = a.id AND i.status = 'open') AS open_issues
       FROM apps a
       LEFT JOIN users u ON a.created_by = u.id
       ORDER BY a.created_at ASC`
    ),
    pool.query(
      `SELECT cs.id, cs.app_id, cs.branch_name, cs.pr_number, cs.pr_url, cs.pr_title,
              cs.session_title, cs.staging_container_id, cs.staging_url, cs.status, cs.created_at,
              cs.staging_image_ref, cs.staging_build_ref, cs.staging_runtime_kind, cs.staging_runtime_name,
              u.username, u.id AS user_id, a.slug AS app_slug
       FROM chat_sessions cs
       LEFT JOIN users u ON cs.user_id = u.id
       JOIN apps a ON cs.app_id = a.id
       WHERE cs.status = 'active'
       ORDER BY cs.created_at DESC`
    ),
    pool.query(
      `SELECT u.username, u.id AS user_id, lu.total_cost_cents
       FROM llm_usage lu JOIN users u ON u.id = lu.user_id
       WHERE lu.date = CURRENT_DATE
       ORDER BY lu.total_cost_cents DESC`
    ),
    // Session-status census for the capacity gauge. One indexed aggregate;
    // FILTERed so the whole ramp picture (cap usage, paused backlog, stale
    // PRs heading for archive, resumable archives) comes back in one row.
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('active','promoted')
                            AND source IS DISTINCT FROM 'imported')                   AS global_used,
         COUNT(*) FILTER (WHERE status = 'active')                                    AS active,
         COUNT(*) FILTER (WHERE status = 'promoted')                                  AS promoted,
         COUNT(*) FILTER (WHERE status = 'paused')                                    AS paused,
         COUNT(*) FILTER (WHERE status = 'archived')                                  AS archived,
         COUNT(*) FILTER (WHERE status = 'promoted' AND stale_notified_at IS NOT NULL) AS stale_notified,
         COUNT(*) FILTER (WHERE status = 'archived' AND cc_purged = FALSE)            AS archived_resumable
       FROM chat_sessions`
    ),
    runtimeStatus.snapshot(config),
  ]);

  const apps = appsQ.rows;
  const sessions = sessionsQ.rows;
  const llmUsage = llmQ.rows.map((r) => ({
    username: r.username,
    userId: r.user_id,
    costCents: parseFloat(r.total_cost_cents || 0),
  }));

  const containers = runtimeQ.resources || [];
  const stats = runtimeQ.stats || {};
  const runtimeKind = runtimeQ.runtimeKind || applicationRuntime.mode(config);

  const byName = Object.fromEntries(containers.map((c) => [c.name, c]));

  // Workers are now long-lived per session: warm-idle while waiting for
  // the next dispatch, in-flight while a docker exec is running. The
  // warm registry is the source of truth for which session each
  // container belongs to and whether it's currently executing; container
  // state on its own is "running" in both cases.
  const warmByName = new Map();
  for (const meta of workerSvc.warmRegistrySnapshot()) {
    warmByName.set(meta.containerName, meta);
  }

  const workerContainers = containers.filter((c) =>
    c.resourceType === 'worker' || c.name.startsWith(WORKER_PREFIX)
  );
  for (const meta of workerSvc.warmRegistrySnapshot()) {
    if (runtimeKind === 'docker'
        && !workerContainers.some((container) => container.name === meta.containerName)) {
      workerContainers.push({
        name: meta.containerName, id: null, state: 'running',
        status: 'Docker container', runtimeKind: 'docker',
      });
    }
  }
  const workers = await Promise.all(workerContainers.map(async (c) => {
    const startedAt = c.startedAt || null;
    const sessionId = c.sessionId
      || parseInt(c.name.match(/(?:usernode-worker-|sv-worker-s)(\d+)$/)?.[1], 10)
      || null;
    const sess = sessions.find((s) => s.id === sessionId);
    const prog = workerProgress.get(sessionId);
    const uptime = uptimeSeconds(startedAt);
    const warm = warmByName.get(c.name);
    // workerMode classifies what the worker is doing right now:
    //   - 'in-flight'  : a `docker exec` is running run-cc.sh
    //   - 'warm-idle'  : sleep wrapper is alive, waiting for the next
    //                    dispatch. Costs ~256MB until the idle sweeper
    //                    evicts it.
    //   - 'bootstrapping' : ensureWorker is racing through clone +
    //                       checkout + warm-ready
    //   - 'unregistered'  : container exists but isn't in the warm
    //                       registry. Likely an orphan from a prior
    //                       process; recovery should sweep it.
    let workerMode = 'unregistered';
    if (warm) {
      if (warm.bootstrapping) workerMode = 'bootstrapping';
      else if (warm.inFlight) workerMode = 'in-flight';
      else workerMode = 'warm-idle';
    }
    const idleMs = warm && !warm.inFlight ? Date.now() - warm.lastUsedMs : null;
    return {
      name: c.name,
      id: c.id,
      state: c.state,
      status: c.status,
      sessionId,
      appSlug: sess?.app_slug || null,
      username: sess?.username || null,
      sessionArchived: sessionId != null && !sess,
      startedAt,
      uptimeSeconds: uptime,
      // Long-lived workers can stay warm-idle indefinitely while a
      // session is open; uptime alone isn't an orphan signal anymore.
      // Only flag if the session is gone — the idle eviction sweeper
      // owns the time-based teardown.
      orphan: (sessionId != null && !sess) || workerMode === 'unregistered',
      lastProgress: prog?.text || null,
      lastProgressAt: prog?.at || null,
      model: prog?.model || null,
      stats: stats[c.name] || null,
      // Long-lived worker telemetry
      workerMode,
      idleMs,
      adopted: !!warm?.adopted,
    };
  }));

  // Apps — nest sessions, nest worker under each session.
  const appTree = await Promise.all(apps.map(async (app) => {
    const prodName = app.runtime_name || `${APP_PREFIX}${app.slug}`;
    const prod = byName[prodName];
    const prodRuntimeKind = app.runtime_kind || 'docker';
    const prodState = prod?.state || 'not_found';
    const prodStarted = prod?.startedAt || null;

    const appSessions = await Promise.all(sessions
      .filter((s) => s.app_id === app.id)
      .map(async (s) => {
        const stagingName = s.staging_runtime_name || `${STAGING_PREFIX}${app.slug}--${s.id}`;
        const staging = byName[stagingName];
        const stagingRuntimeKind = s.staging_runtime_kind || 'docker';
        const stagingState = staging?.state || 'not_found';
        const worker = workers.find((w) => w.sessionId === s.id) || null;
        return {
          id: s.id,
          branchName: s.branch_name,
          prNumber: s.pr_number,
          prUrl: s.pr_url,
          prTitle: s.pr_title,
          sessionTitle: s.session_title,
          stagingUrl: s.staging_url,
          username: s.username,
          userId: s.user_id,
          createdAt: s.created_at,
          ageSeconds: uptimeSeconds(s.created_at),
          status: s.status,
          stagingRuntimeName: stagingName,
          stagingRuntimeKind,
          staging: stagingState !== 'not_found' ? {
            name: stagingName,
            state: stagingState,
            status: staging?.status || stagingState,
            stats: stats[stagingName] || null,
          } : null,
          stagingDriftWarning: !!(s.staging_runtime_name || s.staging_container_id) && stagingState === 'not_found',
          worker: worker ? {
            name: worker.name,
            state: worker.state,
            uptimeSeconds: worker.uptimeSeconds,
            lastProgress: worker.lastProgress,
            lastProgressAt: worker.lastProgressAt,
            model: worker.model,
            orphan: worker.orphan,
            // Long-lived worker mode: in-flight / warm-idle /
            // bootstrapping / unregistered. Lets the dashboard show
            // why a container exists without needing to reconcile
            // activeWorkers + warm registry on the client.
            workerMode: worker.workerMode,
            idleMs: worker.idleMs,
          } : null,
        };
      }));

    return {
      id: app.id,
      name: app.name,
      slug: app.slug,
      repoUrl: app.repo_url,
      dbStatus: app.status,
      createdBy: app.created_by_username,
      createdAt: app.created_at,
      openSessions: parseInt(app.open_sessions, 10),
      openIssues: parseInt(app.open_issues, 10),
      prodRuntimeName: prodName,
      prodRuntimeKind,
      prod: prodState !== 'not_found' ? {
        name: prodName,
        state: prodState,
        status: prod?.status || prodState,
        image: app.image_ref || prod?.image,
        startedAt: prodStarted,
        uptimeSeconds: uptimeSeconds(prodStarted),
        stats: stats[prodName] || null,
      } : null,
      prodMissing: prodState === 'not_found' && app.status !== 'creating',
      sessions: appSessions,
    };
  }));

  // Counters.
  const stagingContainers = containers.filter((c) =>
    c.resourceType === 'staging' || c.name.startsWith(STAGING_PREFIX)
  );
  const stagingRunning = stagingContainers.filter((c) => c.state === 'running').length;
  const workerReady = workers.filter((w) => w.state === 'running').length;

  const stagingPerUser = {};
  for (const s of sessions) {
    if (s.staging_runtime_name || s.staging_container_id) {
      stagingPerUser[s.username] = (stagingPerUser[s.username] || 0) + 1;
    }
  }

  // Sessions that have a branch but no staging URL for > 2 min — the exact
  // drift state the server-side recoverSessions() scans for on startup.
  const stuckSessions = sessions
    .filter((s) =>
      s.branch_name &&
      !s.staging_url &&
      Date.now() - new Date(s.created_at).getTime() > STUCK_SESSION_THRESHOLD_MS
    )
    .map((s) => ({
      id: s.id,
      appSlug: s.app_slug,
      username: s.username,
      branchName: s.branch_name,
      ageSeconds: uptimeSeconds(s.created_at),
    }));

  const globalSpendCents = llmUsage.reduce((a, r) => a + r.costCents, 0);

  // Dead Caddy-ish references: container_id recorded in DB but missing from docker.
  const driftContainers = [];
  for (const a of appTree) {
    if (a.prodMissing) {
      driftContainers.push({ kind: 'app', slug: a.slug, expected: a.prodRuntimeName });
    }
    for (const s of a.sessions) {
      if (s.stagingDriftWarning) {
        driftContainers.push({ kind: 'staging', slug: a.slug, sessionId: s.id, expected: s.stagingRuntimeName });
      }
    }
  }

  // Build the FULL (admin) payload. `redact()` below strips admin-only
  // fields for non-admin viewers at serve time so the cache is shared
  // across both audiences.
  // Long-lived worker breakdown. Memory budget tuning lives downstream
  // of these numbers — operators dial WORKER_IDLE_EVICTION_MS based on
  // typical warmIdle counts vs. memory headroom.
  const workersInFlight = workers.filter((w) => w.workerMode === 'in-flight').length;
  const workersWarmIdle = workers.filter((w) => w.workerMode === 'warm-idle').length;
  const workersBootstrapping = workers.filter((w) => w.workerMode === 'bootstrapping').length;

  // ── Ramp telemetry ──────────────────────────────────────────────────
  // The numbers that actually answer "are we close to falling over?":
  //   capacity.activeTurns  — concurrent `docker exec` CC turns. This is
  //                           the real RAM/CPU pressure (warm/paused
  //                           sessions are cheap), so it's the headline.
  //   capacity.globalUsed   — active+promoted vs the global cap that
  //                           demand-eviction / 429s gate on.
  //   host                  — host RAM + load (os reads the host's
  //                           /proc, so freemem reflects the whole box,
  //                           not just the platform container).
  //   db                    — pg pool saturation; `waiting > 0` means
  //                           handlers are queuing on connections.
  const sc = sessionCountsQ.rows[0] || {};
  const num = (v) => parseInt(v, 10) || 0;
  const globalCap = config.maxGlobalSessions || MAX_STAGING_GLOBAL;
  const capacity = {
    globalUsed: num(sc.global_used),
    globalCap,
    userCap: config.maxUserSessions || MAX_STAGING_PER_USER,
    activeTurns: workersInFlight,
    warmIdleWorkers: workersWarmIdle,
    byStatus: {
      active: num(sc.active),
      promoted: num(sc.promoted),
      paused: num(sc.paused),
      archived: num(sc.archived),
    },
    staleNotified: num(sc.stale_notified),
    archivedResumable: num(sc.archived_resumable),
    namespaces: runtimeQ.namespaceCapacity || [],
  };
  const host = runtimeQ.host || null;

  let dbPool = null;
  try {
    dbPool = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      max: config.dbPoolMax || 10,
    };
  } catch { /* pg internals not present — leave null */ }

  const summary = {
    apps: apps.length,
    prodRunning: appTree.filter((a) => a.prod?.state === 'running').length,
    prodMissing: appTree.filter((a) => a.prodMissing).length,
    stagingRunning,
    stagingTotal: stagingContainers.length,
    stagingCap: globalCap,
    workersRunning: workerReady,
    workersReady: workerReady,
    workersTotal: workers.length,
    workersInFlight,
    workersWarmIdle,
    workersBootstrapping,
    workersOrphaned: workers.filter((w) => w.orphan).length,
    stuckSessions: stuckSessions.length,
    globalSpendCents,
    globalSpendCap: GLOBAL_DAILY_LIMIT_CENTS,
    // Ramp headlines, mirrored into the summary bar.
    sessionsGlobalUsed: capacity.globalUsed,
    sessionsGlobalCap: globalCap,
    activeTurns: capacity.activeTurns,
    hostMemUsedPct: host?.memUsedPct ?? null,
    hostLoadAvg1: host?.loadAvg1 ?? null,
    dbPoolWaiting: dbPool ? dbPool.waiting : null,
  };

  return {
    // `now` is replaced at serve time so cached payloads don't show stale
    // "as of" timestamps. Recorded here only so the un-replaced timestamp
    // is available for debugging the cache.
    now: new Date().toISOString(),
    version: process.env.GIT_SHA || 'dev',
    runtimeKind,
    isAdmin: true, // overridden in redact() based on requester
    deployProgress: deployStatus.read(),
    node: nodeStatus.get(),
    explorer: nodeStatus.getExplorer(),
    limits: {
      stagingGlobal: globalCap,
      stagingPerUser: config.maxUserSessions || MAX_STAGING_PER_USER,
      userDailyCents: USER_DAILY_LIMIT_CENTS,
      globalDailyCents: GLOBAL_DAILY_LIMIT_CENTS,
      workerOrphanThresholdMs: WORKER_ORPHAN_THRESHOLD_MS,
      // Tunable knob for how long warm-idle workers persist before
      // eviction. Surfaced so the dashboard can show the budget the
      // sweeper is operating against.
      workerIdleEvictionMs: parseInt(
        process.env.WORKER_IDLE_EVICTION_MS || (10 * 60 * 1000),
        10
      ),
    },
    summary,
    capacity,
    host,
    db: dbPool,
    apps: appTree,
    workers,
    stuckSessions,
    stagingPerUser,
    driftContainers,
    llmUsage,
    events: log.tail(50),
  };
}

// Strip admin-only fields from a cached full payload. Hot path — runs on
// every request — so it stays cheap (shallow clones, no deep copies of
// arrays we don't touch).
function redact(full, { isAdmin }) {
  if (isAdmin) {
    return {
      ...full,
      isAdmin: true,
      now: new Date().toISOString(),
      // node snapshot is read fresh per request so the "as of Xs ago"
      // line in the dashboard stays honest even when the rest of the
      // payload is served from cache.
      node: nodeStatus.get(),
      explorer: nodeStatus.getExplorer(),
    };
  }
  // Non-admin: strip live Claude Code progress text, model name, and
  // exact timestamps from worker objects; drop llmUsage + events; drop
  // the admin-only spend / dollar limits from summary.
  const stripWorker = (w) => {
    if (!w) return w;
    const { lastProgress, lastProgressAt, model, ...rest } = w;
    return rest;
  };
  // Drop host RAM/load + pg pool internals (operational signal we only
  // want admins to see) along with the existing admin-only blocks.
  const { llmUsage, events, summary, limits, apps, workers, host, db, capacity, ...rest } = full;
  const {
    globalSpendCents, globalSpendCap,
    hostMemUsedPct, hostLoadAvg1, dbPoolWaiting,
    ...publicSummary
  } = summary || {};
  const { userDailyCents, globalDailyCents, ...publicLimits } = limits || {};
  return {
    ...rest,
    isAdmin: false,
    now: new Date().toISOString(),
    node: nodeStatus.get(),
    explorer: nodeStatus.getExplorer(),
    summary: publicSummary,
    capacity: { ...(capacity || {}), namespaces: [] },
    limits: publicLimits,
    apps: (apps || []).map((a) => ({
      ...a,
      sessions: (a.sessions || []).map((s) => ({ ...s, worker: stripWorker(s.worker) })),
    })),
    workers: (workers || []).map(stripWorker),
  };
}

// ── Stale-while-revalidate cache ───────────────────────────────────────────
//
// The dashboard polls /api/status every 5s, and a single page load fires
// the first request before the JS has rendered anything. Without this
// cache, every Docker refresh waited 1-2s for `docker stats`; Kubernetes
// also benefits by coalescing its namespace inventory API calls.
//
// SWR semantics:
//   - cache age < FRESH (3s)  → serve cached, do nothing
//   - cache age < STALE (15s) → serve cached, kick background refresh
//   - cache age >= STALE      → block on a fresh gather (or first call ever)
//
// `start()` warms the cache at server boot so the very first user request
// also gets the instant path. Background refreshes never throw — failures
// just leave the cache as-is, so a transient runtime API hiccup keeps
// serving stale data instead of 500ing.
const CACHE_FRESH_MS = 3000;
const CACHE_STALE_MS = 15000;

let cachedFull = null;
let cachedAt = 0;
let inflightGather = null;

function refreshCache(config) {
  if (inflightGather) return inflightGather;
  inflightGather = gatherFull(config)
    .then((payload) => {
      cachedFull = payload;
      cachedAt = Date.now();
      return payload;
    })
    .finally(() => { inflightGather = null; });
  return inflightGather;
}

async function gather(config, { isAdmin = false } = {}) {
  const age = Date.now() - cachedAt;
  if (!cachedFull || age >= CACHE_STALE_MS) {
    // Cold start or cache is too old to trust — must wait.
    await refreshCache(config);
  } else if (age >= CACHE_FRESH_MS) {
    // Warm but not fresh: serve cached now, refresh asynchronously.
    refreshCache(config).catch((err) => {
      log.warn('status', 'background refresh failed', { err: err.message });
    });
  }
  return redact(cachedFull, { isAdmin });
}

// Warm the cache at server boot so the very first user request is instant.
// Failure here is non-fatal — the next request will retry (and block on
// the slow path that one time).
function start(config) {
  refreshCache(config).catch((err) => {
    log.warn('status', 'initial cache warm failed', { err: err.message });
  });
}

// listContainers/getStats are also consumed by the prod-debug internal
// API (#616 — src/routes/internal.js) for the usernode-debug CLI.
module.exports = { gather, start, listContainers, getStats };
