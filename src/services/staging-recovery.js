'use strict';

// Shared staging recovery helpers — the single source of truth for
// "does this session's staging preview need rebuilding?" and "rebuild
// it from the branch's latest commit". Extracted from server.js so the
// three callers never drift apart:
//   1. startup recovery        (server.js recoverSessions)
//   2. periodic heal sweep     (server.js sweeper Pass 3)
//   3. on-demand preview click (routes/sessions.js ensure-staging)
//
// Behaviour is identical to the former in-server implementations.

const log = require('./logger');

// Does a session need its staging preview (re)built?
//
// THREE failure shapes leave a card without a working preview:
//   1. staging_url IS NULL — GC reclaimed it (or it was GC'd before
//      promotion). The Preview button is hidden (gated on staging_url).
//   2. staging_url is set but the staging container is gone — the
//      Preview button renders but the hostname has no upstream, so the
//      iframe 502s / fails to connect. (Pre-wildcard-Caddy this also
//      surfaced as "secure connection failed" when the per-host route
//      was dropped; routing is now container-name based so the only
//      remaining cause is a missing/stopped container.)
//   3. #851: the container is running, but its ENVIRONMENT is out of date —
//      it was assembled by an older platform build. This shape is invisible
//      to a liveness check and is why #850 needed a manual sweep at all: a
//      pre-#848 preview boots fine and then cannot recognise the signed-in
//      user, so the on-demand route answered {status:'ready'} and opened the
//      app's login screen. Detected by comparing the `usernode.env.fp` label
//      stamped at build time (services/staging-env.js) against the digest the
//      platform would produce today.
// All three are healable by a rebuild. We deliberately do NOT rebuild on a
// merely-unhealthy-but-running container (that's a 502, an app bug, not
// a missing preview) to avoid churn.
//
// `config` is optional. Without it the staleness comparison is skipped and
// the verdict is liveness-only — the pre-#851 behaviour. Every real caller
// passes one; the fallback keeps the function usable from a context that has
// no config and makes the added parameter non-breaking.
async function stagingNeedsRebuild(session, { config = null } = {}) {
  if (!session.staging_url) return true;
  if (session.staging_runtime_kind === 'kubernetes') {
    if (!session.staging_runtime_name) return true;
    const applicationRuntime = require('./application-runtime');
    const config = {
      appRuntime: 'kubernetes',
      kubernetes: { appNamespace: process.env.APP_NAMESPACE || 'social-apps' },
    };
    return (await applicationRuntime.status(config, {
      runtimeKind: 'kubernetes', runtimeName: session.staging_runtime_name,
    })) !== 'running';
  }
  if (!session.staging_container_id) return true;
  const docker = require('./docker');
  const state = await docker.inspectContainer(session.staging_container_id);
  // The inspect could not be PERFORMED (unreachable daemon). Distinct from
  // 'not_found', which means the container is genuinely gone and is handled
  // below by the status check. Leave the preview strictly alone here: a docker
  // hiccup must never be read as evidence that a preview is broken or stale,
  // because the heal sweep and the reap pass both act on this verdict.
  if (!state) return false;
  // Covers 'not_found' (shape 2 — the container is gone) as well as
  // exited/dead/created.
  if (state.status !== 'running') return true;
  if (!config) return false;

  const stagingEnv = require('./staging-env');
  const expected = stagingEnv.expectedStagingFingerprint(config);
  const actual = state.labels[stagingEnv.LABEL_ENV_FP] || null;
  if (actual === expected) return false;

  log.info('staging-recovery', 'Preview env is stale — rebuild needed', {
    sessionId: session.id, expected, actual,
  });
  return true;
}

// Recovery's own `reason` strings name the CODE PATH; visuals.CHECK_TRIGGERS
// names why a checks run started, which is the vocabulary the merge-gate trace
// and the proposal card share. Map one to the other here rather than leaking a
// recovery-internal label into either. An unmapped reason reads as the sweeper,
// which is what every unnamed recovery path actually is.
const CHECK_TRIGGER_BY_REASON = {
  'manual-recheck': 'manual-recheck',
  'preview-click': 'manual-recheck',
  // #1199: a same-commit resubmit that corrected the proposal's capture
  // routes. It reads as a manual re-run because that is what it is — an
  // author asking for a fresh verdict on code that has not changed — and a
  // new trigger string would need a value in visuals.CHECK_TRIGGERS and
  // reviewer-facing copy in public/js/app-view.js to render as anything.
  'testing-update': 'manual-recheck',
  startup: 'boot-reconcile',
  'stuck-checks-boot': 'boot-reconcile',
  tail_worker_gone: 'boot-reconcile',
  dangling_tail: 'boot-reconcile',
  heal: 'stuck-sweep',
  'stuck-checks-sweep': 'stuck-sweep',
};
function checkTriggerForReason(reason) {
  return CHECK_TRIGGER_BY_REASON[reason] || 'stuck-sweep';
}

// The reasons that mean "produce a FRESH verdict", so captureForSession's
// redundant-run skip is bypassed. Keyed on the reason rather than on the
// trigger it maps to: 'preview-click' also reads as a manual re-run to a
// reviewer, but it is a page load rather than a request for new screenshots
// and must stay skippable.
const FORCED_RECHECK_REASONS = new Set(['manual-recheck', 'testing-update']);

// Rebuild the staging preview for a single session that has a branch +
// commits ahead of main but a NULL/dead staging_url. Shared by the
// startup recovery sweep (recoverSessions), the periodic sweeper's
// staging-heal pass (Pass 3), and the on-demand ensure-staging route so
// they never drift apart.
//
// Returns 'built' on success, 'skipped' when there's nothing to do (no
// owner/repo, no bot token, branch not ahead of main), or throws on a
// genuine build failure (caller logs + decides whether to retry).
//
// Creates a PR only when one is missing — the active-session recovery case
// where CC finished but post-processing died before opening the PR.
// 'promoted'/'merging' sessions always already have one, so that branch is
// a no-op for them. On success it pings BOTH the dev-chat tail
// (broadcastGlobal session_event) AND the group-chat vote panel
// (pushSessionUpdate) so the Preview button reappears on the PR card
// without anyone needing to reload.
async function rebuildSessionStaging({ config, pool, session, reason }) {
  const staging = require('./staging');
  const { broadcastGlobal, pushSessionUpdate } = require('./ws');

  const [, owner, repo] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  if (!owner || !repo) {
    // #461: every no-op below used to return silently, leaving check_state
    // NULL — the merge gate blocks NULL as "still running its tests" and the
    // stuck-checks sweeper re-picked the row every pass, re-skipped, forever.
    // Record an explicit terminal verdict instead: 'skipped' (gate-passing)
    // when checks genuinely cannot/need not run, 'error' (retryable with
    // backoff) when the cause is transient.
    await recordChecksSkipped({
      config, pool, session, commitSha: session.checks_commit_sha || null,
      reason: 'checks unavailable — GitHub is not configured',
    });
    return 'skipped';
  }

  const pat = process.env.GITHUB_BOT_TOKEN;
  if (!pat) {
    await recordChecksSkipped({
      config, pool, session, commitSha: session.checks_commit_sha || null,
      reason: 'checks unavailable — GitHub is not configured',
    });
    return 'skipped';
  }

  const { Octokit } = await import('@octokit/rest');
  const ok = new Octokit({ auth: pat });

  // #866: what identifies this session's code in the app's own repo.
  //
  // Native rows own their branch there, so `branch_name` compares and
  // clones fine. An imported PR's branch_name is the PR's HEAD REF, which
  // for a fork-headed PR doesn't exist in the base repo at all — the
  // compare below 404s and the whole heal turns into a permanent 'error'
  // verdict ("could not compare <branch> with main"), which is exactly the
  // dead end an imported proposal used to reach the first time its preview
  // was GC'd. The head SHA is always reachable (refs/pull/<N>/head), so
  // pin to it and let staging.js's PR-ref clone fetch it.
  const imported = session.source === 'imported';
  const importedHead = imported ? (session.imported_pr_head_sha || null) : null;
  if (imported && !importedHead) {
    await recordChecksSkipped({
      config, pool, session, commitSha: session.checks_commit_sha || null,
      reason: 'imported PR has no recorded head commit — nothing to preview',
    });
    return 'skipped';
  }
  const compareHead = importedHead || session.branch_name;

  // Only build when the head actually carries work — a head level with
  // (or behind) main has nothing to preview.
  let compare;
  try {
    const { data } = await ok.rest.repos.compareCommits({
      owner, repo, base: 'main', head: compareHead,
    });
    compare = data;
  } catch (err) {
    // Transient (API hiccup) or a deleted branch — record a retryable
    // 'error' verdict so the existing exponential backoff +
    // CHECK_MAX_AUTO_RETRIES bound the retries instead of the old silent
    // infinite skip loop (#461).
    const visuals = require('./visuals');
    await visuals.storeChecks(
      pool, session.id, session.checks_commit_sha || null,
      { state: 'error', results: [] },
      `could not compare ${compareHead} with main: ${err.message}`.slice(0, 280)
    ).catch((e) => log.warn('staging-recovery', 'compare-failure verdict write failed', {
      sessionId: session.id, err: e.message,
    }));
    return 'skipped';
  }

  if (compare.ahead_by === 0) {
    await recordChecksSkipped({
      config, pool, session,
      commitSha: compare.base_commit?.sha || session.checks_commit_sha || null,
      expectedCommitSha: session.checks_commit_sha || null,
      reason: imported
        ? 'imported PR has no commits beyond main — nothing to test'
        : 'branch has no commits beyond main — nothing to test',
    });
    return 'skipped';
  }

  log.info('staging-recovery', 'Rebuilding staging preview', {
    sessionId: session.id, status: session.status, branch: session.branch_name,
    imported, head: compareHead, aheadBy: compare.ahead_by, reason,
  });

  // #866: for an imported row the commit to build is the RECORDED head —
  // the SHA the votes and checks describe — not the compare's tip. They're
  // usually the same commit, but "usually" is how a preview ends up
  // showing code nobody voted on: a push that lands between the sweep
  // reading the row and this compare running moves the tip while
  // imported_pr_head_sha (and every vote cast against it) still points at
  // the older commit. The head-change sweep is what advances that SHA, and
  // it clears the tally when it does; this path must not front-run it.
  const commitHash = importedHead
    || compare.commits[compare.commits.length - 1]?.sha
    || 'latest';
  const app = { id: session.app_id, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };
  const visuals = require('./visuals');

  // Recovery can discover a newer native branch tip than the verdict stored
  // on the row. Claim that exact commit before the build so a boot failure is
  // allowed through storeChecks' latest-head CAS instead of being discarded
  // as stale and leaving the old commit permanently pending. Imported rows
  // remain pinned to importedHead above.
  await visuals.setChecksPending(pool, session.id, commitHash, null, checkTriggerForReason(reason)).catch((err) =>
    log.warn('staging-recovery', 'rebuild setChecksPending failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    }));
  visuals.notifyChecksPending(session.id, commitHash, null, checkTriggerForReason(reason));

  // Create PR if missing (active-session recovery only). Route through
  // applyPrMetadata — NOT a bare createPR — so the PR gets a real
  // generated title/body and pr_title/session_title are persisted. A
  // bare createPR here used to mint PRs titled "Changes on <branch>"
  // with pr_title left NULL; the promote path then trusted pr_number's
  // presence and skipped its own metadata pass, so the throwaway title
  // stuck (the UI then renders its own "Change by <user>" NULL-fallback).
  //
  // #866: never for an imported row. It already HAS a PR (that's what it
  // tracks), and the platform doesn't own its branch — a missing pr_number
  // on an imported session is a broken row, not an invitation to open a
  // second PR from someone else's fork. The `imported` guard makes that
  // explicit rather than relying on pr_number always being set.
  if (!session.pr_number && !imported) {
    try {
      // username + latest user message give applyPrMetadata the same
      // signals the live dev-turn path has; without the username the
      // fallback title would read "undefined's changes".
      const { rows: ctxRows } = await pool.query(
        `SELECT u.username,
                (SELECT content FROM chat_session_messages
                  WHERE session_id = cs.id AND role = 'user'
                  ORDER BY id DESC LIMIT 1) AS last_user_message
           FROM chat_sessions cs LEFT JOIN users u ON u.id = cs.user_id
          WHERE cs.id = $1`,
        [session.id]
      );
      const username = ctxRows[0]?.username || session.username || 'someone';
      const recoveredUserMessage = ctxRows[0]?.last_user_message || '';
      const prMetadata = require('./pr-metadata');
      const limits = require('./limits');
      let metadataApiKey = null;
      let metadataGenerationAllowed = false;
      try {
        const billing = await limits.resolveBillingPath(
          pool, config.dataEncryptionKey, session.user_id,
        );
        if (!billing.error) {
          metadataApiKey = billing.apiKey;
          metadataGenerationAllowed = true;
        }
      } catch (err) {
        log.warn('staging-recovery', 'PR metadata billing resolve failed; using deterministic draft', {
          sessionId: session.id, err: err.message,
        });
      }
      await prMetadata.applyPrMetadata({
        pool, session, repoOwner: owner, repoName: repo,
        userMessage: recoveredUserMessage,
        ccSummary: '',
        username,
        apiKey: metadataApiKey,
        userId: session.user_id,
        allowModelGeneration: metadataGenerationAllowed,
        broadcast: (event, data) =>
          broadcastGlobal({ type: 'session_event', sessionId: session.id, event, ...data }),
      });
    } catch (err) {
      log.warn('staging-recovery', 'Recovery PR creation via applyPrMetadata failed', {
        sessionId: session.id, code: err.code || null,
        ...require('./github').describeGithubError(err),
      });
    }
  }

  // Announce the rebuild BEFORE it starts. Building a preview takes
  // minutes — cloning the self-app's own database alone runs ~4:45 — and
  // until now this path posted nothing until it succeeded. Session 2954 is
  // what that costs: the owner watched a chat sitting on an unfinished
  // "Building staging preview..." for five minutes with no sign the
  // platform was already fixing it, sent "continue" to force progress, and
  // got a second full build turn for work that was already committed.
  //
  // Same wording as the live dev-turn path's sendStatus (routes/sessions.js)
  // so the client's existing status-row rendering and the `stagingBuild`
  // metadata apply unchanged. `active: true` on the broadcast asks open
  // tabs to spin this row (there's no in-flight turn for /status to report
  // when the heal sweep or a preview click drives the rebuild).
  await announceRebuildStarted({ pool, session, imported });

  let stagingResult;
  try {
    stagingResult = await staging.buildAndDeployStaging(config, session, app, commitHash);
  } catch (err) {
    // The staging preview failed to build or boot. Before #237's fix this
    // threw straight past the checks capture below, leaving check_state NULL
    // — the merge gate fail-closes on NULL with no signal and the sweeper
    // retried the identical failing build forever (silent deadlock). Record
    // a TERMINAL 'error' verdict carrying a concise reason + nudge the owner
    // once per streak, then re-throw so callers keep their existing WARN
    // logging + retry-cooldown bookkeeping.
    await recordStagingBootFailure({ config, pool, session, commitHash, err }).catch((e) =>
      log.warn('staging-recovery', 'recordStagingBootFailure failed (non-fatal)', {
        sessionId: session.id, err: e.message,
      }));
    throw err;
  }
  await pool.query(
    `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
    [stagingResult.containerId, stagingResult.stagingUrl, session.id]
  );

  // Breadcrumb. Native rows get it in the dev-chat transcript; an imported
  // proposal has no dev chat, so a chat_session_messages row there would be
  // written to a surface nobody can open (#866). Its equivalent is the group
  // discussion thread the proposal card links to.
  if (imported) {
    const { sendSystemMessage } = require('./ws');
    const label = session.pr_title
      ? `PR #${session.pr_number} — ${session.pr_title}`
      : `PR #${session.pr_number}`;
    await sendSystemMessage(
      pool, session.app_id,
      // #896: one wording for every rebuild reason. Why the preview went
      // away (a restart, the idle GC, a lost container) is operator
      // detail; the reader only needs to know the button works again.
      // `reason` still rides the log line at the end of this function.
      `The staging preview for ${label} was rebuilt — the Preview button works again.`,
      'system',
      { stagingBuild: 'ready', prNumber: session.pr_number || null, stagingUrl: stagingResult.stagingUrl },
      { type: 'session', ref: session.id }
    ).catch((err) => log.warn('staging-recovery', 'imported rebuild note failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    }));
  } else {
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [
        session.id,
        // #896: same single wording as the imported-proposal note above.
        'Staging preview rebuilt',
        JSON.stringify({ stagingUrl: stagingResult.stagingUrl }),
      ]
    );
  }

  broadcastGlobal({
    type: 'session_event', sessionId: session.id,
    event: 'staging_ready', url: stagingResult.stagingUrl,
    // #127: keep any open dev-chat's testing affordances in sync after a
    // staging rebuild (the guidance itself lives on the session row).
    testingMd: session.testing_md || null,
    testingPath: session.testing_path || null,
  });
  pushSessionUpdate({ action: 'staging_ready', sessionId: session.id, appSlug: session.app_slug });

  // #447: re-run the proposal checks ("CI for proposals") against the fresh
  // build. Before this, rebuildSessionStaging — the shared path behind
  // startup recovery, the heal sweep (Pass 3), and the on-demand
  // ensure-staging preview click — rebuilt the preview but never refreshed
  // check_state, so a proposal whose staging was GC'd and rebuilt kept a
  // stale 'pending'/NULL verdict and stayed blocked from merging forever.
  // Fire-and-forget with the same failure-swallowing as the dev-turn
  // callers; captureForSession is itself _inFlight-guarded so a concurrent
  // live capture isn't duplicated.
  visuals.captureForSession(config, session, app, commitHash, stagingResult, {
    send: () => {},
    trigger: checkTriggerForReason(reason),
    // Deliberately NOT forced: a rebuild whose head already has a passing
    // verdict has nothing new to learn, and this path fires on every heal
    // sweep and every preview click.
  })
    .catch((err) => log.warn('staging-recovery', 'Post-rebuild checks capture failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    }));

  log.info('staging-recovery', 'Staging preview rebuilt', { sessionId: session.id, url: stagingResult.stagingUrl, reason });
  return 'built';
}

// The in-progress half of a background preview rebuild — the row the user
// sees while the ~5-minute build runs. Its success counterpart is the
// 'Staging preview rebuilt' row in rebuildSessionStaging; its failure
// counterpart is recordStagingBootFailure's explanatory row. Every path
// out of the build therefore lands a row AFTER this one, so it can never
// be left as the transcript's last word.
//
// Best-effort throughout: narration must never be why a rebuild fails.
const STAGING_REBUILD_IN_PROGRESS = 'Building staging preview...';

async function announceRebuildStarted({ pool, session, imported }) {
  const { broadcastGlobal, pushSessionUpdate, sendSystemMessage } = require('./ws');
  const metadata = {
    stagingBuild: 'running',
    recovered: true,
    ...(session.pr_number ? { prNumber: session.pr_number } : {}),
  };
  try {
    if (imported) {
      // An imported proposal has no dev chat, so the equivalent surface is
      // the group discussion thread its card links to (#866) — same split
      // the success note below makes.
      const label = session.pr_title
        ? `PR #${session.pr_number} — ${session.pr_title}`
        : `PR #${session.pr_number}`;
      await sendSystemMessage(
        pool, session.app_id,
        `Rebuilding the staging preview for ${label}...`,
        'system', metadata, { type: 'session', ref: session.id }
      );
    } else {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [session.id, STAGING_REBUILD_IN_PROGRESS, JSON.stringify(metadata)]
      );
    }
  } catch (err) {
    log.warn('staging-recovery', 'rebuild-started note failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    });
  }
  try {
    broadcastGlobal({
      type: 'session_event', sessionId: session.id, event: 'status',
      text: imported
        ? `Rebuilding the staging preview for PR #${session.pr_number}...`
        : STAGING_REBUILD_IN_PROGRESS,
      stagingBuild: 'running',
      // Client-side hint: render this row with the live arc spinner even
      // though no turn is in flight (public/js/dev-chat.js).
      active: true,
    });
    pushSessionUpdate({
      action: 'staging_building', sessionId: session.id, appSlug: session.app_slug,
    });
  } catch (err) {
    log.warn('staging-recovery', 'rebuild-started broadcast failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    });
  }
}

// #461: record a terminal, gate-passing 'skipped' checks verdict (with its
// reason) for a session whose checks genuinely cannot / need not run, then
// tell open clients and re-drive the auto-merge drain — a proposal whose vote
// already passed should merge the moment its checks resolve to 'skipped',
// exactly as it would on 'passing'. Best-effort: never throws.
async function recordChecksSkipped({
  config, pool, session, commitSha, expectedCommitSha = commitSha, reason,
}) {
  const visuals = require('./visuals');
  try {
    const stored = await visuals.storeChecksSkipped(
      pool, session.id, commitSha, reason, expectedCommitSha
    );
    if (stored === false) {
      log.info('staging-recovery', 'Discarded stale skipped-checks result', {
        sessionId: session.id, commitSha: commitSha || null,
      });
      return;
    }
  } catch (err) {
    log.warn('staging-recovery', 'skipped-verdict write failed', {
      sessionId: session.id, err: err.message,
    });
    return;
  }
  log.info('staging-recovery', 'Checks marked skipped', { sessionId: session.id, reason });
  try {
    const { broadcastGlobal } = require('./ws');
    broadcastGlobal({ type: 'session_event', sessionId: session.id, event: 'checks_ready', state: 'skipped' });
  } catch (err) {
    log.warn('staging-recovery', 'skipped-verdict notify failed', { sessionId: session.id, err: err.message });
  }
  visuals.maybeAutoMergeAfterChecks(config, pool, session, 'skipped');
}

// #237: record a staging build/boot failure as a terminal proposal-checks
// 'error' verdict (with a concise reason) and nudge the proposal owner — once
// per failure streak — so an app that crashes only in staging no longer
// dead-ends as a silent, unexplained "votes passed but nothing merges".
// Idempotent across retries: storeChecks bumps consecutive_check_failures +
// schedules the next backoff retry; the owner notification + thread post fire
// only on the first failure of a streak (check_error_notified_at gate), which
// setChecksPending clears when a new commit is pushed.
async function recordStagingBootFailure({ config, pool, session, commitHash, err }) {
  const visuals = require('./visuals');
  const detail = visuals.summarizeBootFailure(err);

  const stored = await visuals.storeChecks(
    pool, session.id, commitHash, { state: 'error', results: [] }, detail
  );
  if (stored === false) {
    log.info('staging-recovery', 'Discarded stale staging failure', {
      sessionId: session.id, commitHash: commitHash || null,
    });
    return;
  }

  // Read back the streak bookkeeping to decide whether this is the first
  // failure of the streak (→ notify + post) or a quiet backoff retry.
  let row = null;
  try {
    const { rows } = await pool.query(
      `SELECT user_id, app_id, pr_number, consecutive_check_failures, check_error_notified_at
         FROM chat_sessions WHERE id = $1`,
      [session.id]
    );
    row = rows[0] || null;
  } catch (e) {
    log.warn('staging-recovery', 'boot-failure readback failed', { sessionId: session.id, err: e.message });
  }

  log.warn('staging-recovery', 'Staging preview failed to boot — recorded checks error', {
    sessionId: session.id,
    failures: row ? row.consecutive_check_failures : null,
    detail,
  });

  const alreadyNotified = row && row.check_error_notified_at;
  if (!row || alreadyNotified) return;

  // First failure of this streak: stamp so we don't re-nudge on every retry.
  await pool.query(
    `UPDATE chat_sessions SET check_error_notified_at = NOW() WHERE id = $1`,
    [session.id]
  ).catch(() => {});

  // Visible-in-thread record of why the preview won't come up.
  //
  // #866: "visible" depends on the kind of proposal. A native session shows
  // chat_session_messages in its dev chat. An imported PR has no dev chat at
  // all, so the same row lands on a surface nobody can open — the reason for
  // the blocked merge existed only in the pill tooltip. Imported rows get the
  // note in the group discussion thread the proposal card links to instead.
  // Still exactly one post per failure streak, either way: setChecksPending
  // clears check_error_notified_at when a new commit arrives, so a fresh
  // build failure always narrates, and quiet backoff retries never do.
  const body = `⚠️ Staging preview failed to start, so automated checks can't run and this proposal can't merge yet. Reason: ${detail}`;
  try {
    if (session.source === 'imported') {
      const { sendSystemMessage } = require('./ws');
      await sendSystemMessage(
        pool, row.app_id || session.app_id, body, 'system',
        { checkError: true, detail, prNumber: row.pr_number || session.pr_number || null },
        { type: 'session', ref: session.id }
      );
    } else {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [session.id, body, JSON.stringify({ checkError: true, detail })]
      );
    }
  } catch (e) {
    log.warn('staging-recovery', 'boot-failure thread post failed', { sessionId: session.id, err: e.message });
  }

  // Notify the owner + refresh any open card's checks badge.
  try {
    const notifications = require('./notifications');
    const created = await notifications.createCheckFailedNotification(pool, {
      userId: row.user_id, appId: row.app_id, sessionId: session.id,
    });
    if (created.length) await notifications.hydrateAndPush(pool, created[0]);
    const { broadcastGlobal } = require('./ws');
    broadcastGlobal({ type: 'session_event', sessionId: session.id, event: 'checks_ready', state: 'error' });
  } catch (e) {
    log.warn('staging-recovery', 'boot-failure notify failed', { sessionId: session.id, err: e.message });
  }
}

// #447: reconcile a single session's proposal checks. Used by the manual
// "Re-run checks" endpoint and the boot-time / periodic stale-check sweep.
// If the staging preview is missing or dead, rebuild it (the rebuild now
// re-runs the checks via the capture fired above). Otherwise the preview is
// healthy, so re-run the checks directly against the live container. Both
// paths are fire-and-forget at the capture layer and never throw for the
// no-op cases (no repo / no bot token → rebuildSessionStaging returns
// 'skipped'); a genuine build failure propagates to the caller.
async function recheckSessionChecks({ config, pool, session, reason }) {
  // #607: stamp 'pending' + tell open clients the moment the re-run is
  // requested — a needed staging rebuild can take minutes, and before this
  // the badge kept showing the stale verdict (or nothing at all for a
  // NULL-verdict row) the whole time. Best-effort; captureForSession
  // re-stamps idempotently (same commit sha → failure streak preserved).
  {
    const visuals = require('./visuals');
    await visuals.setChecksPending(pool, session.id, session.checks_commit_sha || null, 'building', checkTriggerForReason(reason))
      .catch((err) => log.warn('staging-recovery', 'recheck setChecksPending failed (non-fatal)', {
        sessionId: session.id, err: err.message,
      }));
    visuals.notifyChecksPending(session.id, session.checks_commit_sha || null, 'building', checkTriggerForReason(reason));
  }
  if (await stagingNeedsRebuild(session, { config })) {
    // rebuildSessionStaging owns the capture (see above) and the no-op
    // short-circuits (missing owner/repo or bot token → 'skipped').
    return rebuildSessionStaging({ config, pool, session, reason });
  }
  // Healthy preview: re-run the checks directly. captureForSession reaches
  // the staging container by name over the docker network, so it needs only
  // the app descriptor + a commit to stamp (best-effort: the commit the
  // prior verdict described). _inFlight-guarded internally.
  const visuals = require('./visuals');
  const app = { id: session.app_id, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };
  visuals.captureForSession(config, session, app, session.checks_commit_sha || null, null, {
    send: () => {},
    trigger: checkTriggerForReason(reason),
    // A human pressing "Re-run checks" — or an agent correcting the capture
    // routes (#1199) — is asking for a FRESH verdict, so these paths force
    // the run even when the row already reads passing.
    force: FORCED_RECHECK_REASONS.has(reason),
  })
    .catch((err) => log.warn('staging-recovery', 'Direct checks re-run failed (non-fatal)', {
      sessionId: session.id, reason, err: err.message,
    }));
  return 'rechecked';
}

module.exports = {
  stagingNeedsRebuild,
  rebuildSessionStaging,
  recheckSessionChecks,
  // Exported for tests + so the client-facing wording has one owner.
  STAGING_REBUILD_IN_PROGRESS,
  announceRebuildStarted,
  // #461: exported so the dev-turn tails (routes/sessions.js) and the
  // post-promote build catch (routes/votes.js) can record an 'error'
  // verdict when their staging build fails, instead of leaving the
  // previous commit's check_state in place.
  recordStagingBootFailure,
  recordChecksSkipped,
};
