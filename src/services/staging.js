const log = require('./logger');
const docker = require('./docker');
const applicationRuntime = require('./application-runtime');
const caddy = require('./caddy');
const dbManager = require('./db-manager');
const github = require('./github');
const appManifest = require('./app-manifest');
const appSecrets = require('./app-secrets');
const appLlmEnv = require('./app-llm-env');
const appStorageEnv = require('./app-storage-env');
const { appIdentityEnv } = require('./app-identity-env');
const stagingEnv = require('./staging-env');
const events = require('./events');
const { getPool } = require('../db/pool');

// Custom error thrown by both staging + prod build paths when the cloned
// repo's `dapp.json` declares required secrets that have no stored value. Callers (votes.js merge path, drift poller, dev-chat
// retries) inspect `.missingSecrets` to render a tailored "fix this"
// toast instead of a generic "build failed".
class MissingSecretsError extends Error {
  constructor(missingSecrets) {
    super(`Cannot deploy: missing required secrets [${missingSecrets.join(', ')}]`);
    this.name = 'MissingSecretsError';
    this.missingSecrets = missingSecrets;
  }
}

// Distinct error for the staging-specific case where a `required + private`
// secret has no manifest-committed `staging_default` (or `default`). Surfaces
// with a different message because the remediation is different from
// MissingSecretsError: the user can't fix this from Settings → Secrets
// (private secrets are *intentionally* not staged from the prod store).
// They have to either commit a `staging_default` to dapp.json or unmark
// the entry private. See app-conventions.md "Public vs private secrets".
class PrivateSecretMissingStagingDefaultError extends Error {
  constructor(missingKeys) {
    super(
      `Cannot stage: required+private secret(s) [${missingKeys.join(', ')}] ` +
      `have no staging fallback. Add a \`staging_default\` (or \`default\`) ` +
      `to each entry in dapp.json, or unmark them private.`
    );
    this.name = 'PrivateSecretMissingStagingDefaultError';
    this.missingKeys = missingKeys;
  }
}

// Local-dev URLs are emitted with `localhost` as the host and rewritten to
// whatever hostname the client is actually reaching the platform on. See
// public/js/dev-host.js — this keeps laptop + phone-on-LAN working without
// any env-var config.

// Per-session staging-build serialization + same-commit coalescing.
//
// Staging builds for one session are triggered from several independent
// places — a worker push, the startup/interval recovery sweeper, the
// stale-pending vote kick, the manual deploy button — and nothing used to
// stop two of them running concurrently. The failure mode is nasty
// because a build's slowest step is cloning the prod DB (pg_dump |
// pg_restore, minutes for big apps) and a build BEGINS by dropping any
// prior clone via pg_terminate_backend: build B's teardown kills build
// A's in-flight pg_restore mid-COPY ("server closed the connection
// unexpectedly"), A dies loudly, records a checks 'error', and posts a
// scary ⚠ to the session chat — for a failure that was pure friendly
// fire (session 2258, 2026-07-14). The two builds also share the
// /tmp/usernode-staging-<id> checkout dir, so B's rm -rf could yank A's
// tree mid-build.
//
// Same single-process reasoning as serializeRebuild below: an in-process
// chain keyed by session id is sufficient. Builds for one session run
// one-at-a-time; different sessions still build in parallel. As a bonus,
// a caller requesting the SAME commit as the in-flight/queued build joins
// it and shares the result instead of rebuilding an identical image+clone
// back-to-back ('latest' never coalesces — it can point at different
// content at different times).
const _stagingBuilds = new Map(); // sessionId -> { commitHash, promise, tail }

// Is a staging build currently in flight (or queued) for this session?
// Consumed by staging-reap's orphan-DB sweep: a build's clone DB exists
// before the session row's staging_url points at it, so without this
// check the sweep could classify a mid-build clone as orphaned and drop
// it out from under pg_restore — the exact friendly-fire failure the
// per-session build serialization above exists to prevent.
function hasInFlightBuild(sessionId) {
  return _stagingBuilds.has(Number(sessionId));
}

// #866 — display-only preview state for a proposal row, derived on read.
//
// An imported PR is promoted the instant it's imported, so its card exists
// for minutes before its preview does. With nothing but `staging_url` to go
// on the client can't tell "still building" from "will never build", and a
// row with no Preview button reads as a bug either way. These two derived
// fields close that gap WITHOUT a persisted staging_state column: the
// building flag is the in-memory build map above, the error is the reason
// the checks pass already captured in check_error_detail.
//
// Deliberate limitation of the in-memory flag: a platform restart mid-build
// loses it, so the card falls back to "unavailable" until the staging-heal
// sweep (server.js Pass 3) re-arms a build and the next refresh flips it
// back to building. Sub-optimal for a few minutes after a restart, versus a
// schema change plus a write path that has to be correct on every crash —
// the trade the spec picks on purpose.
function previewDisplayState(row) {
  const missing = !row.staging_url;
  return {
    staging_building: !!(missing && hasInFlightBuild(row.id)),
    staging_error: (missing && row.check_state === 'error' && row.check_error_detail)
      ? row.check_error_detail
      : null,
  };
}

async function buildAndDeployStaging(config, session, app, commitHash) {
  const key = session.id;
  const current = _stagingBuilds.get(key);
  if (current && commitHash && commitHash !== 'latest' && current.commitHash === commitHash) {
    log.info('staging', 'Joining in-flight staging build for same commit', {
      sessionId: key, commitHash,
    });
    return current.promise;
  }
  const prevTail = current ? current.tail : Promise.resolve();
  // Run after the predecessor settles either way — a failed build must
  // not block the next one (it's often exactly the retry that heals it).
  const promise = prevTail.then(
    () => buildAndDeployStagingInner(config, session, app, commitHash),
    () => buildAndDeployStagingInner(config, session, app, commitHash)
  );
  // The stored tail never rejects, so waiters always run and no unhandled
  // rejection is parked on the chain; callers still get the real result
  // or the real error via `promise`.
  const tail = promise.then(() => {}, () => {});
  const entry = { commitHash, promise, tail };
  _stagingBuilds.set(key, entry);
  tail.then(() => {
    // Self-clean once we're the last link so idle sessions don't leak
    // entries. Identity-guarded so a newer queued build isn't dropped.
    if (_stagingBuilds.get(key) === entry) _stagingBuilds.delete(key);
  });
  return promise;
}

async function buildAndDeployStagingInner(config, session, app, commitHash) {
  const containerName = `usernode-staging-${app.slug}--${session.id}`;
  const imageName = `usernode-staging-${app.slug}-${session.id}:${commitHash.substring(0, 6)}`;

  log.info('staging', 'Building staging', { sessionId: session.id, app: app.slug });

  // Per-phase wall-clock for the build half of a checks run. Nothing
  // persisted how long any of this took, which is why diagnosing the
  // proposal-checks slowdown meant reading a container log tail.
  const buildStartedAt = Date.now();
  const timings = {};

  try {
    // 1. Clone the PR branch
    const [, owner, repo] = app.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    if (!owner || !repo) throw new Error('Could not parse repo URL');

    const cloneUrl = await github.getCloneUrl(owner, repo);
    const cloneDir = `/tmp/usernode-staging-${session.id}`;

    // Whether the caller pinned a concrete commit. 'latest' (and any falsy
    // value) keeps the historical "build the current branch tip" behaviour
    // used by native sessions and the recovery/manual-deploy callers; a real
    // SHA means we must build EXACTLY that commit even if the branch has
    // advanced since it was captured. The image tag and clone-DB name below
    // already key off commitHash, so before this the build could tag one SHA
    // but actually compile the branch tip — harmless while the platform owns
    // the branch, but wrong for an imported PR whose external author keeps
    // pushing (#687). Pinning the checkout closes that gap.
    const pinnedSha = commitHash && commitHash !== 'latest' ? commitHash : null;

    // #866: a PR opened FROM A FORK has a head ref that doesn't exist in this
    // app's repo, so `git clone --branch <head ref>` fails outright and the
    // preview never builds (the reviewer just sees "Checks couldn't run").
    // GitHub publishes every PR's head commit — fork or not — under
    // refs/pull/<N>/head in the BASE repo, so when the caller pinned a
    // concrete commit and the session carries a PR number we clone the repo's
    // default branch and fetch that ref instead of the head branch. One path
    // covers both same-repo and fork imports.
    //
    // Native sessions (branches the platform itself owns and pushed) keep the
    // historical branch clone untouched — same behaviour, same timings.
    const prNumber = Number(session.pr_number) || null;
    const viaPullRef = !!(pinnedSha && prNumber);

    await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});
    // --recurse-submodules + --shallow-submodules so dapps that vendor
    // upstream sources via submodules (e.g. falling-sands → sandspiel)
    // get a complete tree at build time. No-op for dapps without
    // submodules. Timeout bumped to absorb worst-case submodule fetch.
    await docker.execFileAsync('git', [
      'clone', '--depth', '1',
      '--recurse-submodules', '--shallow-submodules',
      ...(viaPullRef ? [] : ['--branch', session.branch_name]),
      cloneUrl, cloneDir,
    ], { timeout: 120000 });

    // Exact-SHA pin (#687): when a concrete commit was requested, check out
    // exactly that commit. The shallow clone above only carries one tip, so
    // the commit usually isn't present yet: fetch it first (via the PR head
    // ref when we have a PR number — the only way to reach a fork's commit
    // through the base repo — else the bare SHA, which GitHub permits for a
    // reachable commit), then check it out. Detaches HEAD at the pinned
    // commit; a no-op detach when the tip already IS that SHA. Submodules are
    // re-synced to the checked-out commit afterwards (a no-op for dapps
    // without any). Scoped strictly to this checkout step — the rest of the
    // build (secrets gating, DB clone, container run, teardown) is unchanged.
    if (pinnedSha) {
      const detach = () => docker.execFileAsync('git', [
        '-C', cloneDir, 'checkout', '--detach', pinnedSha,
      ], { timeout: 30000 });
      const fetchRefs = [
        ...(viaPullRef ? [`refs/pull/${prNumber}/head`] : []),
        pinnedSha,
      ];
      let checkedOut = false;
      // A plain detach only works when the pinned commit is already in the
      // shallow clone (same-repo import whose branch tip IS the pinned SHA).
      // Skip it for the pull-ref path: we cloned the default branch there, so
      // it can only ever fail.
      if (!viaPullRef) {
        try {
          await detach();
          checkedOut = true;
        } catch { /* fall through to the fetch attempts below */ }
      }
      let lastErr = null;
      for (const ref of fetchRefs) {
        if (checkedOut) break;
        try {
          await docker.execFileAsync('git', [
            '-C', cloneDir, 'fetch', '--depth', '1', 'origin', ref,
          ], { timeout: 120000 });
          await detach();
          checkedOut = true;
        } catch (err) { lastErr = err; }
      }
      if (!checkedOut) throw lastErr || new Error(`Could not check out ${pinnedSha}`);
      await docker.execFileAsync('git', [
        '-C', cloneDir, 'submodule', 'update', '--init', '--recursive', '--depth', '1',
      ], { timeout: 120000 }).catch(() => {});
    }

    // 2. Read the dapp's manifest from the PR branch and check that all
    //    required secrets have stored values. Staging shares the prod
    //    secrets store for *non-private* keys (one set of values per
    //    app, not per env), so a PR introducing a new required key
    //    needs that key set in the app's Settings → Secrets first —
    //    same gate prod uses below.
    //
    //    Private secrets (the staging:private analog for env vars;
    //    see app-conventions.md "Public vs private secrets") are
    //    NOT propagated from the prod store. They resolve from
    //    manifest-committed `staging_default` / `default` only; if
    //    neither is set on a `required + private` entry, we fail
    //    loudly so the operator knows to commit a staging fallback or
    //    unmark private.
    const stagingManifest = appManifest.read(cloneDir);
    const stagingPool = getPool(config);
    const stagingStored = await appSecrets.getRawValues(stagingPool, app.id, config.dataEncryptionKey);
    // A proposal may DECLARE a new secret and carry its value (the panel's
    // "+ New variable" flow — services/pending-secrets.js). That value is
    // not in `app_secrets` yet, so without this a PR adding a new required
    // secret couldn't build its own preview. Only NON-private pending
    // values are injected: a private value is kept out of an unreviewed
    // PR's container exactly as mergeForDeploy's private-in-staging branch
    // keeps the stored one out. Best-effort — a lookup failure must not
    // fail a build that would otherwise succeed.
    try {
      // eslint-disable-next-line global-require
      const pendingSecrets = require('./pending-secrets');
      const heldValues = await pendingSecrets.rawValuesForSession(
        stagingPool, session.id, config.dataEncryptionKey
      );
      for (const [k, v] of Object.entries(heldValues)) {
        if (!Object.prototype.hasOwnProperty.call(stagingStored, k)) stagingStored[k] = v;
      }
      if (Object.keys(heldValues).length) {
        log.info('staging', 'Injected pending declared secrets into staging env', {
          sessionId: session.id, keys: Object.keys(heldValues),
        });
      }
    } catch (err) {
      log.warn('staging', 'Pending declared-secret lookup failed', {
        sessionId: session.id, err: err.message,
      });
    }
    const stagingMerge = appSecrets.mergeForDeploy(
      stagingManifest, stagingStored, appSecrets.platformDefaultsFromEnv(),
      { forStaging: true }
    );
    if (stagingMerge.missingRequired.length) {
      await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});
      throw new MissingSecretsError(stagingMerge.missingRequired);
    }
    if (stagingMerge.missingPrivateStagingDefault.length) {
      await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});
      throw new PrivateSecretMissingStagingDefaultError(
        stagingMerge.missingPrivateStagingDefault
      );
    }

    const imageBuildStartedAt = Date.now();
    // Everything up to here — the shallow clone, its submodules, and the
    // manifest/secrets gating — was the one leg of the build half with no
    // phase of its own. It showed up in the trace only as the gap before the
    // first step, which is precisely where an unexplained regression hides.
    timings.sourceFetchMs = imageBuildStartedAt - buildStartedAt;
    const { stdout: revisionOut } = await docker.execFileAsync('git', [
      '-C', cloneDir, 'rev-parse', 'HEAD',
    ], { timeout: 5000 });
    const resolvedRevision = (revisionOut || '').trim();
    const build = await applicationRuntime.build(config, {
      app,
      revision: resolvedRevision,
      environment: 'staging',
      sessionId: session.id,
      sourceDir: cloneDir,
      dockerImage: imageName,
    });
    timings.imageBuildMs = Date.now() - imageBuildStartedAt;
    await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});

    // 3. Clone the production database. cloneDatabase creates a fresh
    // per-clone postgres role with its own random password — the
    // staging container connects as that ephemeral role, not as the
    // shared superuser. The password lives only in the staging
    // container's DATABASE_URL env (never persisted on the platform);
    // teardown drops the role with the clone DB.
    const prodDbName = dbManager.appDbName(app.slug);
    const stagingDbNameStr = dbManager.stagingDbName(app.slug, `s${session.id}`, commitHash);
    const cloneStartedAt = Date.now();
    const { password: stagingDbPassword } = await dbManager.cloneDatabase(prodDbName, stagingDbNameStr);
    timings.cloneMs = Date.now() - cloneStartedAt;
    const stagingDbUrl = dbManager.connectionUrl(stagingDbNameStr, stagingDbPassword);

    // 4. Stop existing staging container if any. Short grace: a preview
    // being replaced has nothing worth draining (#767).
    //
    // Best-effort by design, unlike teardownStaging: the runtime name is
    // deterministic and the deploy below reconciles it. But it is no longer
    // SILENT (#851) — a resource that resists removal is still worth surfacing.
    if (session.staging_runtime_name || session.staging_container_id) {
      const runtimeName = session.staging_runtime_name || session.staging_container_id;
      const stopped = await applicationRuntime.remove(config, {
        runtimeKind: session.staging_runtime_kind || 'docker',
        runtimeName,
      }, {
        stopTimeoutSec: docker.STAGING_STOP_GRACE_SEC,
      }).then((result) => result || { removed: true })
        .catch((err) => ({ removed: false, error: err.message }));
      // Only an EXPLICIT false is a failure — see teardownStaging below for
      // why the absence of the flag is not treated as one.
      if (stopped.removed === false) {
        log.warn('staging', 'Previous preview runtime did not remove; relying on deploy-time reconciliation', {
          sessionId: session.id, runtimeName, err: stopped.error || null,
        });
      }
    }

    // 5. Run staging container
    //
    // Forward display-only locators so a fork running self-hosted under its
    // own domain / GitHub org sees correct URLs in its self-app staging
    // preview (otherwise the staging UI falls back to the canonical
    // Usernode-Labs defaults baked into services/caddy.js + config.js).
    //
    // Explicitly NOT forwarded:
    //   - DOCKER_NETWORK: only consumed by docker.js / worker.js when
    //     spawning containers, which staging cannot do anyway (no Docker
    //     socket mount, Phase 2g). Forwarding adds nothing.
    //   - DB_ADMIN_URL: staging gets only its dedicated DATABASE_URL and
    //     never the platform's database-admin connection. No legitimate
    //     staging consumer needs cross-database administrative access.
    //     See SELF-HOSTING.md Phase 5 risks.
    //
    // The platform-owned half of the env (identity trio, PORT, USERNODE_ENV,
    // the inherited locators) now comes from services/staging-env.js, which
    // ALSO fingerprints it into the `usernode.env.fp` label below. Assembling
    // it there rather than inline is what guarantees the label describes the
    // env that was actually injected: a future var added to platformStagingEnv
    // moves the fingerprint automatically, so previews built before it are
    // detected as stale with no change to the sweeper (#851).
    const platformEnv = stagingEnv.platformStagingEnv(app, config);

    const healthStartedAt = Date.now();
    const deployed = await applicationRuntime.deploy(config, {
      app,
      environment: 'staging',
      sessionId: session.id,
      imageRef: build.imageRef,
      dockerName: containerName,
      env: {
        DATABASE_URL: stagingDbUrl,
        ...platformEnv,
        ...stagingMerge.env,
      },
      port: 3000,
      // #816: state the preview's resourcing rather than inheriting the
      // production-app defaults by omission. See docker.STAGING_CPUS for
      // why a preview needs more than half a core.
      memory: docker.STAGING_MEMORY,
      cpus: docker.STAGING_CPUS,
      labels: {
        [stagingEnv.LABEL_ENV_FP]: stagingEnv.envFingerprint(platformEnv),
      },
    });
    timings.healthMs = Date.now() - healthStartedAt;
    const { hostname, url: stagingUrl } = deployed;
    await getPool(config).query(
      `UPDATE chat_sessions SET staging_image_ref = $1, staging_build_ref = $2,
         staging_runtime_kind = $3, staging_runtime_name = $4 WHERE id = $5`,
      [build.imageRef, build.buildRef, deployed.runtimeKind, deployed.runtimeName, session.id]
    );

    // NOTE: the edge verification intentionally does NOT happen here. The
    // caller persists staging_url after this function returns, and that is
    // the point at which the URL becomes referenceable at all — so the
    // caller runs verifyStagingEdge() right after the persist and before
    // revealing the preview button.

    timings.totalMs = Date.now() - buildStartedAt;
    log.info('staging', 'Staging deployed', {
      sessionId: session.id, url: stagingUrl, ...timings,
    });

    // `timings` is threaded out so the checks tracer can attribute the wait
    // to a phase (visuals.captureForSession opens the kind='checks' run and
    // records these as its build-half steps). Purely diagnostic — no caller
    // branches on it, and it is absent on paths that reuse a live preview.
    return {
      containerId: deployed.runtimeKind === 'docker' ? deployed.runtimeName : null,
      runtimeKind: deployed.runtimeKind,
      runtimeName: deployed.runtimeName,
      imageRef: build.imageRef,
      buildRef: build.buildRef,
      stagingUrl,
      hostname,
      timings,
    };
  } catch (err) {
    log.error('staging', 'Staging build failed', { sessionId: session.id, err: err.message });
    // Cleanup on failure — short grace, this container is being discarded.
    // Best-effort (the build already failed; nothing downstream forgets this
    // container, and the by-name sweeper is the backstop) but logged rather
    // than swallowed, same reasoning as step 4 above (#851).
    // Kubernetes deploys reconcile deterministic resource names on retry;
    // Docker needs an explicit by-name cleanup after a partial start.
    if (applicationRuntime.mode(config) === 'docker') {
      const cleaned = await docker.stopAndRemove(containerName, {
        stopTimeoutSec: docker.STAGING_STOP_GRACE_SEC,
      }).catch((e) => ({ removed: false, error: e.message })) || {};
      if (cleaned.removed === false) {
        log.warn('staging', 'Failed-build cleanup left a container behind', {
          sessionId: session.id, containerName, err: cleaned.error || null,
        });
      }
    }
    throw err;
  }
}

// Make ONE real end-to-end request to a freshly-deployed staging host,
// before its preview button is revealed (#816).
//
// This used to be `warmStagingCert`, a handshake-only probe sized for the
// on-demand-TLS era. That era is gone: every preview is served by the single
// pre-existing wildcard cert (see Caddyfile + services/caddy.js), so there is
// no certificate to warm and the handshake alone proves almost nothing.
//
// What DOES still cost the first visitor is everything past the handshake:
// Caddy resolving the upstream container name, the forward_auth gate round
// trip, and the app's own lazy first-request work. `handshakeOnly: false`
// makes the PLATFORM pay that once, at reveal time, instead of the reviewer
// paying it on the click — and it is the only signal that proves the edge can
// actually route to the new container rather than merely terminate TLS.
//
// Ordering contract: call this only AFTER the session's staging_url has been
// persisted to chat_sessions. That persist is what makes the hostname a
// referenceable preview; probing before it just measures a URL nothing points
// at yet.
//
// Bounded by probeEdge's internal timeout and always resolves, so a slow or
// failed probe never blocks or fails a deploy. No-op for local-dev http URLs.
async function verifyStagingEdge(session, hostname, stagingUrl) {
  if (!hostname || !stagingUrl || !stagingUrl.startsWith('https://')) return;
  log.info('staging', 'Verifying edge before exposing preview', { sessionId: session.id, hostname });
  const probe = await caddy.probeEdge(hostname, { handshakeOnly: false });
  if (probe.ok) {
    log.info('staging', 'Edge verified', {
      sessionId: session.id, hostname, code: probe.code,
      ttfbMs: probe.timings ? probe.timings.ttfbMs : null,
    });
  } else {
    log.warn('staging', 'Edge verification did not complete; preview may be slow on first hit', { sessionId: session.id, hostname, err: probe.error?.message });
  }
}

// Deprecated alias (#816). Kept so any caller still on the old name keeps
// working; new code calls verifyStagingEdge. Remove once no references
// remain.
const warmStagingCert = verifyStagingEdge;

// Tear down a session's staging preview: stop+remove the container, drop the
// cloned staging database, and stop vouching for the hostname. The single
// chokepoint every teardown caller (merge, archive, idle-reclaim, the
// stale-preview sweeper) funnels through.
//
// Returns { removed, leaked }. `leaked: true` means the container is STILL
// RUNNING and this session's row deliberately still names it.
//
// #851 — WHY THE ORDER AND THE RETURN VALUE MATTER. This function used to
// swallow the stopAndRemove result and null the staging_* columns
// unconditionally. When a removal failed (and stopAndRemove could not even
// report that it had), the container kept running while the only record
// pointing at it was erased: ten merged sessions in production ended up that
// way, discoverable only by enumerating docker and joining back to the DB.
//
// So nothing is forgotten before removal is CONFIRMED:
//   - the DB drop is skipped on a leak — dropDatabase's
//     pg_terminate_backend would kill the live container's connections and
//     leave it running against a dropped database, which is strictly worse
//     than a preview that still works;
//   - both columns are kept on a leak, so the row stays a truthful pointer.
//     staging-reap's `linked` branch re-enters this same function on the next
//     automatic pass and finishes the job; keeping staging_url populated for
//     that window is correct precisely because the container IS still
//     serving that hostname.
async function teardownStaging(session, app) {
  log.info('staging', 'Tearing down staging', { sessionId: session.id });

  // Short grace: the preview is going away for good, so there is nothing
  // to drain. Before #767 this step alone cost a flat ~10.9s on every
  // merge, purely waiting out a SIGTERM the container never received.
  if (session.staging_runtime_name || session.staging_container_id) {
    const runtimeKind = session.staging_runtime_kind || 'docker';
    const runtimeName = session.staging_runtime_name || session.staging_container_id;
    const teardownConfig = {
      appRuntime: runtimeKind,
      kubernetes: { appNamespace: process.env.APP_NAMESPACE || 'social-apps' },
    };
    const result = await applicationRuntime.remove(teardownConfig, {
      runtimeKind,
      runtimeName,
    }, {
      stopTimeoutSec: docker.STAGING_STOP_GRACE_SEC,
    }).then((value) => value || { removed: true })
      .catch((err) => ({ removed: false, error: err.message }));

    // An EXPLICIT `removed: false` is the leak. A result with no flag at all
    // means the removal reported nothing either way, and the pre-#851
    // behaviour (proceed) is the right answer there: refusing to null on
    // "unknown" would strand every row behind any caller or wrapper that
    // doesn't carry the flag. docker.stopAndRemove always sets it.
    if (result.removed === false) {
      log.error('staging', 'Staging teardown LEAKED a runtime — keeping the DB link so it can be retried', {
        sessionId: session.id,
        runtimeKind,
        runtimeName,
        err: result.error || null,
      });
      // The only durable trace: the job that noticed is in-memory, and the
      // session row looks untouched by design. Best-effort like every
      // events.record.
      events.record(getPool(), {
        type: events.EVENT_TYPES.STAGING_TEARDOWN_LEAKED,
        metadata: {
          sessionId: session.id,
          containerId: runtimeKind === 'docker' ? runtimeName : null,
          runtimeKind,
          runtimeName,
          appSlug: app ? app.slug : null,
          error: result.error || null,
        },
      });
      return { removed: false, leaked: true };
    }
  }

  // Drop staging database. Derive the name from the still-in-memory
  // staging_url *before* we null the column below. Only reached once the
  // container is confirmed gone, so there is nothing left connected to it.
  if (app) {
    const commitHash = session.staging_url?.match(/--(\w{6})\./)?.[1] || '000000';
    const stagingDbNameStr = dbManager.stagingDbName(app.slug, `s${session.id}`, commitHash);
    await dbManager.dropDatabase(stagingDbNameStr).catch(() => {});
  }

  // Stop vouching for the now-dead hostname. Caddy's on-demand `ask` gate
  // (routes/internal.js isKnownHost) approves a staging host iff
  // chat_sessions.staging_url still equals it. Leaving it populated after the
  // container is gone makes Caddy keep (re)issuing/renewing certs for a dead
  // upstream and lets stale preview links resolve to a 502 instead of a clean
  // refusal. Nulling it here — the single chokepoint every teardown caller
  // (merge, archive, idle-reclaim) funnels through — frees those certs from
  // renewal churn and makes the gate refuse the host. (No Caddy route to
  // remove: the wildcard site maps hostnames to container names dynamically,
  // so stopping the container is what takes the preview offline; the cached
  // cert expires on its own.)
  await getPool().query(
    `UPDATE chat_sessions SET staging_url = NULL, staging_container_id = NULL,
       staging_image_ref = NULL, staging_build_ref = NULL,
       staging_runtime_kind = NULL, staging_runtime_name = NULL WHERE id = $1`,
    [session.id]
  ).catch((err) => log.warn('staging', 'Failed to clear staging_url on teardown', { sessionId: session.id, err: err.message }));

  log.info('staging', 'Staging torn down', { sessionId: session.id });
  return { removed: true, leaked: false };
}

// Per-app rebuild serialization. Every prod-rebuild caller (dev-chat
// merge, post-merge sibling sweep, drift poller, manual check-updates,
// issues auto-fix) funnels through rebuildProduction. When two of them
// fire for the SAME app close together — e.g. PR #25 and #26 both
// merging within a minute, each kicking off its own rebuild — their
// `stopAndRemove(name)` / `runContainer(name)` calls interleave and the
// second `docker run` 405s with "container name is already in use"
// (exactly the failure that left whiteboard #26 merged-on-GitHub but
// not-marked-merged). The platform is a single Node process, so an
// in-process promise chain keyed by slug is sufficient: concurrent
// rebuilds of one app run one-at-a-time, each cloning the latest main
// and converging on HEAD. Different apps still rebuild in parallel.
const _rebuildChains = new Map(); // slug -> Promise (rejection-swallowing tail)

function serializeRebuild(slug, fn) {
  const prev = _rebuildChains.get(slug) || Promise.resolve();
  // Run after the predecessor settles, regardless of whether it
  // succeeded — one app's failed rebuild must not block the next one.
  const result = prev.then(() => fn(), () => fn());
  // The stored tail never rejects, so the next waiter's `.then` always
  // runs and an unhandled rejection is never parked on the chain.
  const tail = result.then(() => {}, () => {});
  _rebuildChains.set(slug, tail);
  // Self-clean the map once we're the last link, so idle apps don't leak
  // entries. Guard the identity check so a newer rebuild isn't dropped.
  tail.finally(() => {
    if (_rebuildChains.get(slug) === tail) _rebuildChains.delete(slug);
  });
  return result; // callers still get the real containerId/sha or the real error
}

async function rebuildProduction(config, app) {
  return serializeRebuild(app.slug, () => rebuildProductionInner(config, app));
}

async function rebuildProductionInner(config, app) {
  const containerName = `usernode-app-${app.slug}`;
  const imageName = `usernode-app-${app.slug}:latest`;

  log.info('staging', 'Rebuilding production', { app: app.slug });

  // Single chokepoint for "this app is being rebuilt right now": every
  // caller (dev-chat merge, drift-poller, manual check-updates) ends up
  // here, so wrapping the body once means the version-pill UI flips to
  // its deploying state regardless of who triggered the rebuild.
  const appDeployStatus = require('./app-deploy-status');
  appDeployStatus.markStart(app.slug, { fromSha: app.main_sha || null });
  let succeeded = false;
  let resultSha = null;
  let missingSecretsFromErr = null;
  // Hoisted out of the try so the catch can stamp the failed commit
  // onto the apps.last_failure record (#416).
  let mainSha = null;

  try {
    const [, owner, repo] = app.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    if (!owner || !repo) throw new Error('Could not parse repo URL');

    const cloneUrl = await github.getCloneUrl(owner, repo);
    const cloneDir = `/tmp/usernode-rebuild-${app.slug}`;

    await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});
    // --recurse-submodules + --shallow-submodules so dapps that vendor
    // upstream sources via submodules (e.g. falling-sands → sandspiel)
    // get a complete tree at build time. No-op for dapps without
    // submodules. Timeout bumped to absorb worst-case submodule fetch.
    try {
      await docker.execFileAsync('git', [
        'clone', '--depth', '1',
        '--recurse-submodules', '--shallow-submodules',
        cloneUrl, cloneDir,
      ], { timeout: 120000 });
    } catch (err) {
      // Stage marker for the last_failure classifier (#416).
      err.cloneFailed = true;
      throw err;
    }

    // Capture the exact SHA this build is pinned to so the UI can show
    // what commit is running in production (#21). The shallow clone's
    // HEAD is the tip of the default branch at clone time.
    try {
      const { stdout } = await docker.execFileAsync('git', [
        '-C', cloneDir, 'rev-parse', 'HEAD',
      ], { timeout: 5000 });
      mainSha = (stdout || '').trim() || null;
    } catch (err) {
      log.warn('staging', 'Failed to capture main SHA', { app: app.slug, err: err.message });
    }

    // Read manifest from the cloned working tree. Snapshot it onto
    // the app row first so the Secrets UI knows about a brand-new
    // required key the moment we observe it (even if the deploy then
    // blocks because that key has no stored value). Then block before
    // docker build if any required secret is unset — no point
    // compiling an image we can't run. The thrown MissingSecretsError
    // carries the list so callers (votes.js merge, drift poller,
    // manual rebuild) can render an actionable error.
    const manifest = appManifest.read(cloneDir);
    const prodPool = getPool(config);
    await prodPool.query(
      `UPDATE apps SET manifest_snapshot = $1 WHERE id = $2`,
      [JSON.stringify(manifest), app.id]
    );

    // dapp.json's top-level `name` takes precedence over the platform
    // name. Reconciling here is what makes a merged rename PR (which
    // edits dapp.json's name and triggers this rebuild) actually apply
    // the new display name — no rename-specific apply code needed.
    // No-op when the manifest carries no name; best-effort so a rename
    // hiccup never fails the rebuild.
    await appManifest.reconcileAppName(prodPool, app, manifest)
      .catch((err) => log.warn('staging', 'Name reconcile failed', { app: app.slug, err: err.message }));
    // Same deal for the manifest's `visibility` block (issue #124): a
    // merged visibility-change PR applies here, on the rebuild its
    // merge triggered. No-op when the manifest carries no visibility;
    // best-effort so it never fails the rebuild.
    await appManifest.reconcileAppVisibility(prodPool, app, manifest)
      .catch((err) => log.warn('staging', 'Visibility reconcile failed', { app: app.slug, err: err.message }));
    // And the manifest's `governance` block (issue #646): a merged
    // governance-change PR applies here, on the rebuild its merge
    // triggered. No-op when the block is absent; best-effort.
    await appManifest.reconcileAppGovernance(prodPool, app, manifest)
      .catch((err) => log.warn('staging', 'Governance reconcile failed', { app: app.slug, err: err.message }));
    // And the manifest's `admins` block (issue #788): a merged PR that
    // edits the per-app admin roster applies here, on the rebuild its
    // merge triggered — which is why such a PR needs explicit approval
    // to get merged in the first place. An ABSENT block is a no-op; an
    // explicit [] clears the roster. Best-effort.
    await appManifest.reconcileAppAdmins(prodPool, app, manifest)
      .catch((err) => log.warn('staging', 'Admins reconcile failed', { app: app.slug, err: err.message }));
    // And the manifest's `screenshot.deviceScaleFactor` (issue #360): a
    // merged PR that toggles the capture density applies here on the
    // rebuild it triggered. readScreenshot defaults to 2×, so this keeps
    // apps.screenshot_device_scale current on every prod rebuild.
    await appManifest.reconcileAppScreenshot(prodPool, app, manifest)
      .catch((err) => log.warn('staging', 'Screenshot reconcile failed', { app: app.slug, err: err.message }));
    // And the manifest's `icon` block: a merged PR that changes the
    // homescreen icon (emoji or committed image file) applies here, on
    // the rebuild its merge triggered. The manifest is fully
    // authoritative for the icon — an absent block clears it back to
    // the letter tile. Best-effort; needs cloneDir for the image bytes.
    await appManifest.reconcileAppIcon(prodPool, app, manifest, cloneDir)
      .catch((err) => log.warn('staging', 'Icon reconcile failed', { app: app.slug, err: err.message }));
    const stored = await appSecrets.getRawValues(prodPool, app.id, config.dataEncryptionKey);
    const merge = appSecrets.mergeForDeploy(
      manifest, stored, appSecrets.platformDefaultsFromEnv()
    );
    if (merge.missingRequired.length) {
      await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});
      throw new MissingSecretsError(merge.missingRequired);
    }

    const build = await applicationRuntime.build(config, {
      app,
      revision: mainSha,
      environment: 'production',
      sourceDir: cloneDir,
      dockerImage: imageName,
    });
    await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});

    // Reload the app row to pick up apps.db_password — the per-role
    // migration in db/migrate.js may have populated it after the
    // caller fetched `app`, and createApp may have set it on a
    // first-deploy path that arrives here on the next rebuild.
    const { rows: dbPwdRows } = await prodPool.query(
      'SELECT db_password FROM apps WHERE id = $1', [app.id]
    );
    const appDbPassword = dbPwdRows[0]?.db_password;
    if (!appDbPassword) {
      throw new Error(
        `rebuildProduction: app ${app.slug} has no db_password — ` +
        `migrateAppDbsToPerRole should have populated it at platform boot.`
      );
    }
    const dbUrl = dbManager.connectionUrl(dbManager.appDbName(app.slug), appDbPassword);
    // Production containers get the LLM-proxy env pair (URL + per-app
    // token); the staging path above deliberately does not — staging
    // containers must not be able to spend LLM grants (issue #34).
    const llmEnv = await appLlmEnv.productionLlmEnv(prodPool, app.id);
    // Likewise the app-storage env pair (#752) — production only; the
    // staging path above deliberately injects neither storage var.
    const storageEnv = await appStorageEnv.productionStorageEnv(prodPool, app.id);
    const deployed = await applicationRuntime.deploy(config, {
      app,
      environment: 'production',
      imageRef: build.imageRef,
      dockerName: containerName,
      env: {
        DATABASE_URL: dbUrl,
        ...appIdentityEnv(app, config),
        PORT: '3000',
        USERNODE_ENV: 'production',
        ...llmEnv,
        ...storageEnv,
        ...merge.env,
      },
    });

    // No Caddy route to register. The wildcard site in the Caddyfile
    // maps `<slug>.<domain>` straight to this container
    // (usernode-app-<slug>) and issues TLS on-demand, so a healthy,
    // correctly-named container is automatically reachable. This closed
    // the old "Secure Connection Failed" class of bug where a rebuild
    // came up healthy but its per-host route block was missing or got
    // clobbered by a concurrent conf rewrite.

    // Clear any stale last_failure (#416): every successful deploy
    // funnels through here, so this is the single reset chokepoint for
    // the rebuild paths (dev-chat merge, drift poller, /redeploy).
    await prodPool.query(
      `UPDATE apps SET last_failure = NULL, container_id = $1, image_ref = $2,
         build_ref = $3, runtime_kind = $4, runtime_name = $5 WHERE id = $6`,
      [deployed.runtimeKind === 'docker' ? deployed.runtimeName : null,
       build.imageRef, build.buildRef, deployed.runtimeKind, deployed.runtimeName, app.id]
    ).catch((e) => log.warn('staging', 'Failed to clear last_failure', { app: app.slug, err: e.message }));

    log.info('staging', 'Production rebuilt', { app: app.slug, sha: mainSha });
    succeeded = true;
    resultSha = mainSha;
    return {
      containerId: deployed.runtimeKind === 'docker' ? deployed.runtimeName : null,
      runtimeKind: deployed.runtimeKind,
      runtimeName: deployed.runtimeName,
      imageRef: build.imageRef,
      buildRef: build.buildRef,
      sha: mainSha,
    };
  } catch (err) {
    if (err instanceof MissingSecretsError) {
      missingSecretsFromErr = err.missingSecrets;
      log.warn('staging', 'Production rebuild blocked — missing required secrets', {
        app: app.slug, missing: err.missingSecrets,
      });
    } else {
      log.error('staging', 'Production rebuild failed', { app: app.slug, err: err.message });
      // Persist the failure detail (#416) so the "View build log" panel
      // covers failed rebuilds too. Status deliberately stays 'running'
      // (the old container keeps serving) — see app-deploy-status.js for
      // why rebuild progress never touches apps.status. Best-effort.
      const deployFailure = require('./deploy-failure');
      try {
        await getPool(config).query(
          'UPDATE apps SET last_failure = $1 WHERE id = $2',
          [JSON.stringify(deployFailure.record(err, { sha: mainSha || null })), app.id]
        );
      } catch (e) {
        log.warn('staging', 'Failed to persist last_failure', { app: app.slug, err: e.message });
      }
    }
    throw err;
  } finally {
    appDeployStatus.markEnd(app.slug, {
      toSha: resultSha,
      failed: !succeeded,
      missingSecrets: missingSecretsFromErr,
    });
  }
}

module.exports = {
  buildAndDeployStaging,
  hasInFlightBuild,
  previewDisplayState,
  verifyStagingEdge,
  warmStagingCert,
  teardownStaging,
  rebuildProduction,
  // Exported for services/app-rollover.js: its cheap respawn path
  // (appRespawn.runExistingImage) does its own stopAndRemove +
  // runContainer without going through rebuildProduction, so it has to
  // take the same per-slug lock or it can interleave with a
  // merge-triggered rebuild of the same app — the exact "container name is
  // already in use" race the comment above documents. Do NOT call it from
  // inside a function that rebuildProduction already wraps: the chain is
  // not re-entrant.
  serializeRebuild,
  MissingSecretsError,
  PrivateSecretMissingStagingDefaultError,
};
