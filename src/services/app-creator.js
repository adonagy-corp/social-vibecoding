const log = require('./logger');
const github = require('./github');
const docker = require('./docker');
const applicationRuntime = require('./application-runtime');
const caddy = require('./caddy');
const dbManager = require('./db-manager');
const appManifest = require('./app-manifest');
const appSecrets = require('./app-secrets');
const appLlmEnv = require('./app-llm-env');
const appStorageEnv = require('./app-storage-env');
const { appIdentityEnv } = require('./app-identity-env');
const deployFailure = require('./deploy-failure');
const { getTemplateFiles, getConnectorScaffoldFiles } = require('./template');
const { getPool } = require('../db/pool');
const { pushAppStatusUpdate } = require('./ws');

async function createApp(config, appRow) {
  const pool = getPool(config);
  const { id: appId, name, slug } = appRow;

  // SELF-HOSTING.md sub-step 2g (Guard A): the platform's own app
  // row is seeded at boot with status='running' pointing at the harness
  // container. There's nothing to create — no DB to spin up, no repo to
  // clone, no container to start. Returning early avoids the rest of
  // this function trying to clobber state that's already correct.
  if (appRow.self_hosted) {
    log.info('app-creator', 'Skipping create for self-hosted app',
             { appId, slug });
    return;
  }

  try {
    log.info('app-creator', 'Starting app creation', { appId, slug });

    await updateStatus(pool, appId, 'creating');

    // 1. Create the database for this app, plus its dedicated postgres
    // role. Persist the role's random password to apps.db_password so
    // future deploys / restarts / staging clones can reconstruct the
    // per-role URL without the shared superuser credential. See
    // SELF-HOSTING.md "Per-app postgres roles".
    const dbName = dbManager.appDbName(slug);
    const { password: dbPassword } = await dbManager.createDatabase(dbName);
    await pool.query(
      'UPDATE apps SET db_password = $1 WHERE id = $2',
      [dbPassword, appId]
    );
    const dbUrl = dbManager.connectionUrl(dbName, dbPassword);

    // 2. GitHub repo handling
    //    - Import-existing path: appRow.repo_url is preset by the route
    //      after pre-flighting bot access. Skip create+push and just
    //      record useGitHub=true so the clone block below runs.
    //    - New-app path: create a fresh repo under the bot's account and
    //      seed it with the template (existing behavior).
    let repoUrl = appRow.repo_url || null;
    let useGitHub = !!repoUrl;

    if (!repoUrl && github.isEnabled()) {
      try {
        const botUsername = await github.getBotUsername();
        // adoptExisting: a Retry after a create that died between the
        // GitHub create call and the repo_url persist re-runs with the
        // SAME slug, so the repo already exists on the bot account and a
        // plain create would 422 "name already exists" on every retry.
        const repo = await github.createRepo(botUsername, slug, {
          description: `${name} — built on Usernode Social Vibecoding`,
          adoptExisting: true,
        });
        repoUrl = repo.html_url;

        const files = getTemplateFiles(name, slug, dbUrl);
        await github.pushFiles(botUsername, slug, files, {
          message: `Initialize ${name} from Usernode template`,
        });

        await pool.query('UPDATE apps SET repo_url = $1 WHERE id = $2', [repoUrl, appId]);
        useGitHub = true;
      } catch (err) {
        // GitHub is enabled but the repo couldn't be provisioned. Falling
        // back to a local build here used to leave a healthy-looking app
        // whose dev workflow could never work (repo_url NULL → every chat
        // turn bails; see the session-2585 incident). Fail the creation
        // instead: the outer catch records last_failure (stage 'repo') and
        // flips status to 'error', so the creator sees the failed card and
        // the Retry button re-runs creation. The local-template fallback
        // below remains the designed path when GitHub is disabled entirely.
        err.repoFailed = true;
        throw err;
      }
    } else if (repoUrl) {
      log.info('app-creator', 'Importing existing repo (skipping create+push)', { appId, slug, repoUrl });

      // An import skips the template push above, so before #1218's
      // follow-up an imported app never received `.claude/settings.json`
      // and its users kept getting a permission prompt on every read-only
      // connector call, forever. Add just the connector scaffold — an
      // import must keep the repo it imported, so this is the two
      // `.claude/` files and nothing else.
      //
      // Deliberately NOT fatal, and deliberately NOT `repoFailed`: the
      // fresh-create branch above fails the whole creation when its push
      // dies because there is no app without it, whereas here the app is
      // complete and working, just noisier to drive. A GitHub App with no
      // write access to a user-owned repo is a normal import, not an
      // error.
      try {
        const parsed = github.parseGithubUrl(repoUrl);
        if (github.isEnabled() && parsed) {
          const existing = await github.getFileContent(
            parsed.owner, parsed.repo, '.claude/settings.json', 'main');
          if (existing === null) {
            await github.pushFiles(parsed.owner, parsed.repo, getConnectorScaffoldFiles(), {
              message: 'Add Usernode connector permissions',
            });
            log.info('app-creator', 'Added connector scaffold to imported repo',
                     { appId, slug, repoUrl });
          }
        }
      } catch (err) {
        log.warn('app-creator', 'Could not add connector scaffold to imported repo',
                 { appId, slug, repoUrl, error: err.message });
      }
    }

    // 3. Clone (or write) the working tree that the shared deploy tail
    // will build from. Container/image naming lives in finalizeDeploy.
    const tempDir = `/tmp/usernode-build-${slug}`;
    const fs = require('fs');
    const path = require('path');

    await docker.execFileAsync('rm', ['-rf', tempDir]).catch(() => {});

    if (useGitHub) {
      // For new-app builds the repo lives at <botUsername>/<slug> (the
      // create+push block above just made it). For import-existing the
      // repo lives at whatever owner/name the user pasted, so we parse
      // owner+repo back out of repo_url. parseGithubUrl handles all the
      // URL shapes we accept on the way in, so this round-trip is safe.
      const parsed = github.parseGithubUrl(repoUrl);
      let cloneOwner;
      let cloneRepo;
      if (parsed) {
        cloneOwner = parsed.owner;
        cloneRepo = parsed.repo;
      } else {
        cloneOwner = await github.getBotUsername();
        cloneRepo = slug;
      }
      const cloneUrl = await github.getCloneUrl(cloneOwner, cloneRepo);
      // --recurse-submodules + --shallow-submodules so dapps that vendor
      // upstream sources via submodules (e.g. falling-sands → sandspiel)
      // get a complete tree at build time. No-op for dapps without
      // submodules. Timeout bumped to absorb worst-case submodule fetch.
      try {
        await docker.execFileAsync('git', [
          'clone', '--depth', '1',
          '--recurse-submodules', '--shallow-submodules',
          cloneUrl, tempDir,
        ], {
          timeout: 120000,
        });
      } catch (err) {
        // Stage marker so the outer catch records this as a clone
        // failure in apps.last_failure (#416).
        err.cloneFailed = true;
        throw err;
      }
    } else {
      fs.mkdirSync(tempDir, { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'public'), { recursive: true });

      const files = getTemplateFiles(name, slug, dbUrl);
      for (const f of files) {
        const filePath = path.join(tempDir, f.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, f.content);
      }
    }

    // Snapshot the SHA (if this was a git clone) so the UI can show
    // what commit is live on prod (#21). Local-template builds stay
    // null; that's fine — the pill just hides until the first merge.
    let mainSha = null;
    if (useGitHub) {
      try {
        const { stdout } = await docker.execFileAsync('git', [
          '-C', tempDir, 'rev-parse', 'HEAD',
        ], { timeout: 5000 });
        mainSha = (stdout || '').trim() || null;
      } catch (err) {
        log.warn('app-creator', 'Failed to capture initial SHA', { slug, err: err.message });
      }
    }

    // Steps 3b–9 are identical for a fresh create and a fork (build →
    // run → health → reconcile → finalize), so they live in the shared
    // finalizeDeploy() below. app-forker.js calls the exact same helper
    // after it has staged the fork's cloned repo + db, so the two paths
    // can't drift.
    await finalizeDeploy(config, { appId, name, slug, tempDir, dbUrl, repoUrl, mainSha });
  } catch (err) {
    log.error('app-creator', 'App creation failed', { appId, slug, err: err.message });
    const failure = deployFailure.record(err);
    await recordFailure(pool, appId, failure);
    await updateStatus(pool, appId, 'error');
    pushAppStatusUpdate({ id: appId, slug, status: 'error', errorReason: failure.reason });
  }
}

// Shared deploy tail used by BOTH createApp and app-forker.forkApp.
// Preconditions: the app's working tree is on disk at `tempDir`, its
// per-app Postgres DB exists and `dbUrl` connects to it, and (for a
// fork) any copied non-private secrets are already in app_secrets. This
// reads the manifest, reconciles name/visibility/screenshot/icon, gates
// on missing required secrets, then builds + runs + health-checks the
// production container and flips the row to `running`. Cleans up
// `tempDir` on every exit path.
async function finalizeDeploy(config, { appId, name, slug, tempDir, dbUrl, repoUrl, mainSha }) {
  const pool = getPool(config);
  const containerName = `usernode-app-${slug}`;
  const imageName = `usernode-app-${slug}:latest`;

  try {
  // Read the dapp's `dapp.json` from the cloned working tree, then
    // snapshot it onto the app row so the Secrets API can render the
    // manifest-declared keys without re-cloning. Bail out
    // (without building/running) if any required key is unset — the
    // UI will surface 'awaiting_secrets' so the creator (or app
    // majority) can fill them in, then call POST /api/apps/:slug/redeploy
    // to retry.
    const manifest = appManifest.read(tempDir);
    await pool.query(
      `UPDATE apps SET manifest_snapshot = $1 WHERE id = $2`,
      [JSON.stringify(manifest), appId]
    );

    // dapp.json's top-level `name` takes precedence over the platform
    // name: reconcile apps.name to it now (no-op when the manifest
    // carries no name). Best-effort — a rename hiccup must not fail
    // app creation.
    await appManifest.reconcileAppName(pool, { id: appId, slug, name }, manifest)
      .catch((err) => log.warn('app-creator', 'Name reconcile failed', { appId, err: err.message }));

    // Likewise for the manifest's `visibility` block (issue #124): an
    // imported repo whose dapp.json declares visibility wins over the
    // creation-form pick on this first deploy — the manifest is the
    // source of truth. No-op when the block is absent.
    await appManifest.reconcileAppVisibility(pool, { id: appId, slug }, manifest)
      .catch((err) => log.warn('app-creator', 'Visibility reconcile failed', { appId, err: err.message }));

    // And the manifest's `governance` block (issue #646): an imported
    // repo declaring proposal-approval settings gets them applied on
    // this first deploy. No-op when the block is absent.
    await appManifest.reconcileAppGovernance(pool, { id: appId, slug }, manifest)
      .catch((err) => log.warn('app-creator', 'Governance reconcile failed', { appId, err: err.message }));

    // And the manifest's `admins` block (issue #788): an imported repo
    // declaring per-app admins gets the roster applied on this first
    // deploy. No-op when the block is absent; an explicit [] clears it.
    await appManifest.reconcileAppAdmins(pool, { id: appId, slug }, manifest)
      .catch((err) => log.warn('app-creator', 'Admins reconcile failed', { appId, err: err.message }));

    // And the manifest's `screenshot.deviceScaleFactor` (issue #360):
    // persist the density the before/after preview shots are captured at
    // onto apps.screenshot_device_scale so the capture orchestrator can
    // read it without re-cloning. Default 2× when the block is absent.
    await appManifest.reconcileAppScreenshot(pool, { id: appId, slug }, manifest)
      .catch((err) => log.warn('app-creator', 'Screenshot reconcile failed', { appId, err: err.message }));

    // And the manifest's `icon` block: an imported repo whose dapp.json
    // declares a homescreen icon (emoji or committed image file) gets it
    // applied on this first deploy. The clone dir is still on disk here,
    // so the image bytes are read from it directly. Best-effort.
    await appManifest.reconcileAppIcon(pool, { id: appId, slug }, manifest, tempDir)
      .catch((err) => log.warn('app-creator', 'Icon reconcile failed', { appId, err: err.message }));

    const storedValues = await appSecrets.getRawValues(pool, appId, config.dataEncryptionKey);
    const merge = appSecrets.mergeForDeploy(
      manifest, storedValues, appSecrets.platformDefaultsFromEnv()
    );
    if (merge.missingRequired.length) {
      log.info('app-creator', 'Required secrets unset; entering awaiting_secrets', {
        appId, slug, missing: merge.missingRequired,
      });
      await pool.query(
        `UPDATE apps SET status = 'awaiting_secrets', repo_url = COALESCE($1, repo_url), main_sha = COALESCE($2, main_sha)
         WHERE id = $3`,
        [repoUrl || null, mainSha || null, appId]
      );
      await docker.execFileAsync('rm', ['-rf', tempDir]).catch(() => {});
      pushAppStatusUpdate({
        id: appId, slug, status: 'awaiting_secrets', missingSecrets: merge.missingRequired,
      });
      return;
    }

    const build = await applicationRuntime.build(config, {
      app: { id: appId, slug, repo_url: repoUrl },
      revision: mainSha,
      environment: 'production',
      sourceDir: tempDir,
      dockerImage: imageName,
    });
    await docker.execFileAsync('rm', ['-rf', tempDir]).catch(() => {});

    // 5. Run the container. Production containers additionally get the
    // LLM-proxy env pair (URL + per-app token, generated lazily here on
    // first deploy) so the app can call the platform's app-LLM proxy.
    // Staging deploys deliberately don't (see services/app-llm-env.js).
    const llmEnv = await appLlmEnv.productionLlmEnv(pool, appId);
    // Likewise the app-storage env pair (#752) — production only.
    const storageEnv = await appStorageEnv.productionStorageEnv(pool, appId);
    const deployed = await applicationRuntime.deploy(config, {
      app: { id: appId, slug },
      environment: 'production',
      imageRef: build.imageRef,
      dockerName: containerName,
      env: {
        DATABASE_URL: dbUrl,
        ...appIdentityEnv({ id: appId }, config),
        PORT: '3000',
        USERNODE_ENV: 'production',
        ...llmEnv,
        ...storageEnv,
        ...merge.env,
      },
    });
    const { hostname, url: appUrl } = deployed;

    // 9. Update app status. last_deploy_at is bumped here so the home-
    // card "updated Xt ago" reflects the moment the prod container
    // first went live, not the (slightly earlier) row creation time.
    // last_failure clears on every successful deploy (#416) so a stale
    // failure record can't outlive the retry that fixed it.
    await pool.query(
      `UPDATE apps SET status = $1, container_id = $2, main_sha = $3,
                       image_ref = $4, build_ref = $5, runtime_kind = $6,
                       runtime_name = $7, last_deploy_at = NOW(), last_failure = NULL
       WHERE id = $8`,
      ['running', deployed.runtimeKind === 'docker' ? deployed.runtimeName : null,
       mainSha || null, build.imageRef, build.buildRef, deployed.runtimeKind,
       deployed.runtimeName, appId]
    );

    pushAppStatusUpdate({ id: appId, slug, status: 'running', url: appUrl });
    log.info('app-creator', 'App created successfully', { appId, slug, hostname, appUrl, repoUrl });
  } catch (err) {
    log.error('app-creator', 'App creation failed', { appId, slug, err: err.message });
    const failure = deployFailure.record(err, { sha: mainSha || null });
    await recordFailure(pool, appId, failure);
    await updateStatus(pool, appId, 'error');
    pushAppStatusUpdate({ id: appId, slug, status: 'error', errorReason: failure.reason });
  }
}

async function updateStatus(pool, appId, status) {
  await pool.query('UPDATE apps SET status = $1 WHERE id = $2', [status, appId]);
}

// Persist an apps.last_failure record (#416). Best-effort — a failed
// write must never mask the deploy error being reported.
async function recordFailure(pool, appId, failure) {
  try {
    await pool.query(
      'UPDATE apps SET last_failure = $1 WHERE id = $2',
      [JSON.stringify(failure), appId]
    );
  } catch (err) {
    log.warn('app-creator', 'Failed to persist last_failure', { appId, err: err.message });
  }
}

module.exports = { createApp, finalizeDeploy };
