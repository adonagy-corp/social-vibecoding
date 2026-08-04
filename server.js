require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { load: loadConfig } = require('./src/config');
const { migrate } = require('./src/db/migrate');
const { shellAssetCacheControl } = require('./src/services/static-cache');
const { authMiddleware } = require('./src/middleware/auth');
const { authRoutes } = require('./src/routes/auth');
const { appRoutes } = require('./src/routes/apps');
const { chatRoutes } = require('./src/routes/chat');
const { conversationRoutes } = require('./src/routes/conversations');
const { sessionRoutes } = require('./src/routes/sessions');
const { proposalHandoffRoutes } = require('./src/routes/proposal-handoff');
const { voteRoutes } = require('./src/routes/votes');
const { kudosRoutes } = require('./src/routes/kudos');
const { publicApiRoutes } = require('./src/routes/public-api');
const { publicProfileRoutes } = require('./src/routes/profiles');
const { waitlistConnectRoutes } = require('./src/routes/waitlist-connect');
const { issueRoutes } = require('./src/routes/issues');
const { campaignRoutes } = require('./src/routes/campaigns');
const { adminRoutes } = require('./src/routes/admin');
const { dashboardRoutes } = require('./src/routes/dashboard');
const { feedbackRoutes } = require('./src/routes/feedback');
const { notificationsRoutes } = require('./src/routes/notifications');
const { collaboratorRoutes } = require('./src/routes/collaborators');
const appDirectoryRoutes = require('./src/routes/app-directory');
const { approverRoutes } = require('./src/routes/approvers');
const { statusRoutes } = require('./src/routes/status');
const { internalRoutes } = require('./src/routes/internal');
const { appErrorRoutes } = require('./src/routes/app-error');
const { visualsRoutes } = require('./src/routes/visuals');
const { appIconRoutes } = require('./src/routes/app-icons');
const { issueImageRoutes } = require('./src/routes/issue-images');
const { avatarRoutes } = require('./src/routes/avatars');
const { profileRoutes } = require('./src/routes/profile');
const { appFileServeRoutes, appFileShellRoutes } = require('./src/routes/app-files');
const appStorageRoutes = require('./src/routes/app-storage');
const anthropicProxyRoutes = require('./src/routes/anthropic-proxy');
const { credentialRoutes } = require('./src/routes/credentials');
const appLlmProxyRoutes = require('./src/routes/app-llm-proxy');
const appPlatformApiRoutes = require('./src/routes/app-platform-api');
const { llmGrantsRoutes } = require('./src/routes/llm-grants');
const { userAgentFilesRoutes } = require('./src/routes/user-agent-files');
const { topicAttributeRoutes } = require('./src/routes/topic-attributes');
const { boardOrderRoutes } = require('./src/routes/board-order');
const { reportAiRoutes } = require('./src/routes/report-ai');
const { reportSnapshotRoutes, reportShareRoutes } = require('./src/routes/report-snapshots');
const { homePanelRoutes } = require('./src/routes/home-panels');
const { homeLayoutRoutes } = require('./src/routes/home-layout');
const { chatDraftsRoutes } = require('./src/routes/chat-drafts');
const { devFlowRoutes } = require('./src/routes/dev-flow');
const { pmOrderRoutes } = require('./src/routes/pm-order');
const { debugRoutes } = require('./src/routes/debug');
const { galleryRoutes } = require('./src/routes/gallery');
const {
  cliAuthGate,
  cliApiBearerAuth,
  cliPreAuthRoutes,
  cliBrowserRoutes,
} = require('./src/routes/cli-auth');
// Hosted MCP connector (Claude.ai / ChatGPT). Same three-way split as the
// CLI surface above: a hard staging/enablement gate, then the public +
// bearer routes before cookie auth, then the browser-session management
// routes after it.
const {
  mcpConnectGate,
  mcpPreAuthRoutes,
  mcpBrowserRoutes,
} = require('./src/routes/mcp-remote');
const { socialIdentityRoutes } = require('./src/routes/social-identities');
// Topochain v4 (plan Task 3): public/partner/ingest/mobile carry their own
// auth and mount BEFORE authMiddleware; admin reuses the platform's own
// admin auth and mounts AFTER it (architecture decision #2 — see the mount
// sites below for the full rationale).
const { topochainPublicRoutes } = require('./src/routes/topochain/public');
const { topochainPartnerRoutes } = require('./src/routes/topochain/partner');
const { topochainIngestRoutes } = require('./src/routes/topochain/ingest');
const { topochainMobileRoutes } = require('./src/routes/topochain/mobile');
const { topochainAdminRoutes } = require('./src/routes/topochain/admin');
const github = require('./src/services/github');
const llm = require('./src/services/llm');
const llmTelemetry = require('./src/services/llm-telemetry');
const worker = require('./src/services/worker');
const activeWorkersSvc = require('./src/services/active-workers');
const turnWatchdog = require('./src/services/turn-watchdog');
const recoveryRetry = require('./src/services/recovery-retry');
const turnLifecycle = require('./src/services/turn-lifecycle');
const turnEffects = require('./src/services/turn-effects');
const recoveryPills = require('./src/services/recovery-pills');
const sessionLifecycle = require('./src/services/session-lifecycle');
const stagingRecovery = require('./src/services/staging-recovery');
const stagingReap = require('./src/services/staging-reap');
// #866: the sweeper needs staging.hasInFlightBuild() to leave sessions whose
// preview is being built right now alone (see Pass 2 / Pass 3 below). Named
// stagingSvc because recoverActiveWorkers() already binds a local `staging`.
const stagingSvc = require('./src/services/staging');
const limits = require('./src/services/limits');
const events = require('./src/services/events');
const ws = require('./src/services/ws');
const log = require('./src/services/logger');
const lifecycle = require('./src/services/lifecycle');
const chainPoller = require('./src/services/chain-poller');
const genesisAccounts = require('./src/services/genesis-accounts');
const nodeStatus = require('./src/services/node-status');
const statusService = require('./src/services/status');
const mobilePush = require('./src/services/mobile-push');
const { getActiveWorkerCount } = require('./src/routes/sessions');
const { sweepStuckCreatingApps } = require('./src/routes/apps');
const appAccess = require('./src/services/app-access');
const platformJwt = require('./src/services/platform-jwt');
const { getPool } = require('./src/db/pool');
const { createLeadership, withMigrationLock } = require('./src/services/leadership');
const { trustedProxyClientIp } = require('./src/services/client-ip');
const { currentVotePredicateSql } = require('./src/services/pr-vote-revision');

const config = loadConfig();
log.setLevel(config.logLevel);

const app = express();

// Express never trusts forwarding headers globally. Docker mode resolves one
// configured proxy peer; Kubernetes mode lets Cilium/Envoy supply the client
// address without a proxy hostname. Direct child/worker calls carry no
// forwarding header and therefore retain their real socket address.
app.set('trust proxy', false);
app.use(trustedProxyClientIp({
  hostname: config.trustedProxyHost,
  trustDirectPeer: config.appRuntime === 'kubernetes',
}));

// Global CLI authentication has a hard staging/enablement gate before any
// body parser, cookie lookup, bearer lookup, or static fallback. Public
// device + bearer routes also mount here so they never inherit browser
// session semantics.
app.use(cliAuthGate(config));
app.use(cliPreAuthRoutes(config));

// The hosted MCP connector gets the same treatment for the same reason: a
// staging preview's browser identity comes from an iframe token, so a
// connector credential must never be mintable or usable there. POST /mcp
// authenticates with its own OAuth bearer and must never see a cookie, so
// it mounts here rather than behind authMiddleware.
app.use(mcpConnectGate(config));
app.use(mcpPreAuthRoutes(config));

// ── Explorer API passthrough ───────────────────────────────────────────────
// The mobile app's in-webview "Transaction Log" panel resolves the explorer
// against the origin it is loaded from and calls
// `GET /explorer-api/active_chain` + `POST /explorer-api/<chain>/transactions`
// (usernode flutter `dapp_webview_screen.dart`). On the per-dApp subdomains
// the dapp template server (usernode-dapp-homepage/server.js `proxyExplorer`)
// proxies that prefix to the explorer; on the launcher origin the path used to
// fall through the JWT gate and 302 to /login.html, so the webview got HTML
// back and `jsonDecode` threw "Explorer fetch failed". Mounting the same
// public passthrough here — before the JSON body parser so the raw body
// streams through, and before authMiddleware so it isn't redirected — makes
// the panel work without an app redeploy. Matches the documented
// PUBLIC_PREFIXES = ['/explorer-api/'] convention (src/prompts/app-conventions.md).
const EXPLORER_UPSTREAM =
  process.env.EXPLORER_UPSTREAM || 'testnet-explorer.usernodelabs.org';
const EXPLORER_UPSTREAM_BASE = process.env.EXPLORER_UPSTREAM_BASE || '/api';
const EXPLORER_USE_HTTP = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01]))/.test(
  EXPLORER_UPSTREAM.replace(/:\d+$/, '')
);

app.use('/explorer-api', (req, res) => {
  const transport = EXPLORER_USE_HTTP ? require('http') : require('https');
  // req.url is the path *after* the /explorer-api mount point, e.g.
  // "/active_chain" or "/<chain>/transactions" (query string preserved).
  const subPath = req.url.replace(/^\/+/, '');
  const upstreamPath = `${EXPLORER_UPSTREAM_BASE}/${subPath}`;
  const [hostname, portStr] = EXPLORER_UPSTREAM.split(':');
  const port = portStr ? Number(portStr) : EXPLORER_USE_HTTP ? 80 : 443;

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const bodyBuf = chunks.length ? Buffer.concat(chunks) : null;
    const upReq = transport.request(
      {
        hostname,
        port,
        path: upstreamPath,
        method: req.method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(bodyBuf ? { 'content-length': bodyBuf.length } : {}),
        },
      },
      (upRes) => {
        const rChunks = [];
        upRes.on('data', (c) => rChunks.push(c));
        upRes.on('end', () => {
          res.writeHead(upRes.statusCode || 502, {
            'content-type': upRes.headers['content-type'] || 'application/json',
            'access-control-allow-origin': '*',
          });
          res.end(Buffer.concat(rChunks));
        });
      }
    );
    upReq.on('error', (err) => {
      log.error('explorer-proxy', 'upstream error', { err: err.message });
      res.status(502).type('text/plain').send(`Explorer proxy error: ${err.message}`);
    });
    if (bodyBuf) upReq.write(bodyBuf);
    upReq.end();
  });
});

// ── Challenges API (SV web shell) ──────────────────────────────────────────
// /challenges-api/* used to be a READ-ONLY proxy to the (now retired)
// external leaderboard deployment. Since the topochain merge the same five
// GET surfaces are served in-process by topochainMobileRoutes (see the
// "/challenges-api (SV web shell reads)" section of
// src/routes/topochain/mobile.js), authenticated by the platform session
// cookie — so there is no proxy block here anymore.

// Skip the global JSON parser for the Anthropic-proxy path so the proxy
// can mount its own parser with a 32MB limit (matching Anthropic's
// actual request-size cap). With the default 100kb limit a normal CC
// turn body (often a few MB of file context) gets 413'd at the parser
// boundary, and the `claude` CLI surfaces the generic
// "Request too large (max 32MB). Try with a smaller file." message —
// even though our parser, not Anthropic, is the one rejecting. Keep
// the rest of the app on the small default; only the proxy needs the
// large limit. See routes/anthropic-proxy.js for the scoped parser.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/internal/anthropic/')) return next();
  if (req.path.startsWith('/api/app-llm/')) return next();
  // CLI-auth POSTs own a strict 4 KiB route-scoped parser. Browser approval
  // reaches its parser only after cookie auth; public device routes were
  // already handled by cliPreAuthRoutes above.
  if (req.path.startsWith('/api/cli/')) return next();
  if (req.path === '/api/me/cli-tokens'
      || req.path.startsWith('/api/me/cli-tokens/')) return next();
  // Native CLI proposal payloads deliberately carry a bounded spec, durable
  // history, structured local test summaries, and (for /commits) a bounded
  // base64 snapshot of the changed Git blobs. These endpoints own scoped
  // parsers in routes/proposal-handoff.js (512 KiB normally, 12 MiB only for
  // commit upload). Do not widen the rest of the app's JSON surface.
  if (req.method === 'POST'
      && (/^\/api\/apps\/[^/]+\/proposal-handoffs$/.test(req.path)
          || /^\/api\/sessions\/[^/]+\/proposal-handoff\/(?:context|build|commits)$/.test(req.path))) {
    return next();
  }
  // Private conversation uploads carry raw bytes and own a bounded 21 MB
  // parser in routes/conversations.js. In particular, a .json file may have
  // application/json content-type; letting this global parser consume it
  // first would turn valid attachment bytes into an object/empty upload.
  if (req.method === 'POST'
      && /^\/api\/conversations\/[^/]+\/attachments$/.test(req.path)) {
    return next();
  }
  // Agent-file uploads (#460) carry up to 48 KB of file content, which
  // can exceed the 100kb default once JSON-escaped — the route mounts
  // its own 256kb parser (see routes/user-agent-files.js).
  if (req.path === '/api/me/agent-files' && req.method === 'POST') return next();
  // Locked report snapshots (report-lock-share) carry the full standalone
  // report HTML, which routinely exceeds 100kb; the route mounts its own
  // 3mb parser (routes/report-snapshots.js).
  if (req.method === 'POST' && /^\/api\/apps\/[^/]+\/report-snapshots$/.test(req.path)) return next();
  express.json()(req, res, next);
});
app.use(cookieParser());

app.get('/health', (_req, res) => {
  // `topochain: true` (plan Task 3; SPEC 815-818 "merge into the platform's
  // existing health check") — a static presence flag confirming this
  // deployment carries the /api/v4 topochain surface, not a live subsystem
  // probe (there's no separate topochain process to be unhealthy).
  res.json({ status: 'ok', topochain: true });
});

// The platform is never a dapp in "mock mode". The shared usernode-bridge
// auto-detects mock mode by probing `GET /__mock/enabled` and treating ANY
// 200 as "use the local-dev /__mock/* endpoints". Our SPA catch-all
// (`app.get('*')` below) answers that probe with index.html + 200, which
// fools the bridge into routing `sendTransaction` to `/__mock/sendTransaction`
// — an endpoint we don't implement — so the POST 404s and surfaces the
// misleading "Mock API not enabled" error on the wallet register flow.
// Explicitly 404 the whole mock namespace (before authMiddleware so it's
// authoritative for anonymous + authenticated callers alike) so the bridge
// correctly concludes mock is off and uses the native transport.
app.all('/__mock/*', (_req, res) => {
  res.status(404).json({ error: 'mock mode not available on the platform' });
});

// Lightweight endpoint polled by the header "platform version" pill
// (public/js/app.js → renderPlatformVersionPill). Four pieces of
// information packaged together so the client only needs one fetch:
//   - `sha`            : the SHA the running platform was built from.
//   - `name`           : short label shown in the pill (mirrors how the
//                        per-app pill leads with the app slug, so the
//                        two read symmetrically as "usernode · sha"
//                        and "myapp · sha · #pr"). Overridable via env.
//   - `repoUrl`        : where to link the pill (commit on GitHub).
//                        Overridable via env so forks point at their own repo.
//   - `deployProgress` : null in idle state, or { deploying, sha, startedAt }
//                        when the deploy workflow has flagged a redeploy in
//                        flight (see services/deploy-status.js + deploy.yml).
const deployStatus = require('./src/services/deploy-status');
app.get('/api/version', (_req, res) => {
  res.json({
    sha: process.env.GIT_SHA || 'dev',
    name: process.env.USERNODE_PROJECT_NAME || 'usernode',
    repoUrl: process.env.USERNODE_REPO_URL || 'https://github.com/Usernode-Labs/social-vibecoding',
    deployProgress: deployStatus.read(),
    // Which environment this build is: 'staging' | 'production' | null.
    // Only used to NAME the no-SHA state in the drawer's "Platform
    // version" row: staging previews of the platform are built without
    // GIT_SHA, so `sha` comes back as the literal "dev" there and a row
    // reading "Platform version  dev" tells a tester nothing. With this,
    // the client renders "staging" instead. Purely a label — nothing
    // gates behaviour on it, and USERNODE_ENV is platform-injected (a
    // reserved key), so there's no new declaration to make.
    env: process.env.USERNODE_ENV || null,
    // SELF-HOSTING.md Phase 2f: the platform's own slug in the apps
    // table, so a client can recognize self-app surfaces without
    // guessing. No client reads it today — the "Platform updating…"
    // banner that did was removed in #1015 — but it stays as the
    // documented way to identify the self-app: cheap to include
    // (already in config) and it saves a second round-trip for any
    // future code path that needs it.
    selfAppSlug: config.selfAppSlug,
  });
});

// Public conventions endpoint. Apps' own CLAUDE.md files point here so
// a developer (or Claude Code) running locally against a repo can
// fetch the current platform rules without cloning the harness.
// Mounted before authMiddleware so it's open to anyone.
app.get('/claude.md', (_req, res) => {
  const fs = require('fs');
  const fp = path.join(__dirname, 'src', 'prompts', 'app-conventions.md');
  try {
    const body = fs.readFileSync(fp, 'utf-8');
    const stat = fs.statSync(fp);
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Last-Modified', stat.mtime.toUTCString());
    // No strong caching — the whole point is that this URL serves the
    // current conventions, not a snapshot.
    res.set('Cache-Control', 'public, max-age=60');
    res.send(body);
  } catch (err) {
    log.error('conventions', 'Failed to serve /claude.md', { err: err.message });
    res.status(500).type('text/plain').send('conventions unavailable');
  }
});

// Public sidecar-status endpoints. All read the cached snapshot maintained
// by `services/node-status.js` (one poll per process, regardless of how
// many clients are watching). Mounted before authMiddleware so anonymous
// visitors and embedded child-app pages can both read them. All on-chain
// info is already public, so no progressive disclosure here.
//
// Three surfaces:
//   - /api/node-status        : compact node snapshot (powers the summary
//                                card in the #admin/status section)
//   - /api/node-status/full   : full snapshot (server + node + explorer +
//                                chain-dependent services). Powers the
//                                #admin/node section.
//   - /node-status            : redirect stub into #admin/node (#860)
//
// The two JSON endpoints stay mounted here, BEFORE authMiddleware, and must
// not move: since #860 folded the viewer pages into the signed-in console,
// these are the anonymous surface — external monitoring and embedded
// child-app reads depend on them being open.
app.get('/api/node-status', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(nodeStatus.get());
});

app.get('/api/node-status/full', (_req, res) => {
  // Lazy require here (rather than top of file) keeps the import graph
  // straight: chain-poller and genesis-accounts are leaf modules; node-
  // status doesn't import them. The callback shape is what wires them
  // together at request time.
  const chainPollerSvc = require('./src/services/chain-poller');
  const genesisAccountsSvc = require('./src/services/genesis-accounts');
  res.set('Cache-Control', 'no-store');
  res.json(nodeStatus.getFull({
    name: 'usernode-social-vibecoding',
    mode: process.env.USERNODE_LOCAL_DEV ? 'local-dev' : 'production',
    services: () => ({
      chainPoller: chainPollerSvc.getStatus(),
      // getStatus() carries the same outage shape as chainPoller's
      // (consecutiveFailures / downSince / lastError) on top of the
      // loaded/count pair, so the viewer can say how long the genesis
      // fetch has been failing rather than just "not loaded".
      genesisAccounts: genesisAccountsSvc.getStatus(),
    }),
  }));
});

app.get('/node-status', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'node-status.html'));
});

// Status routes are public (with progressive disclosure for admins) —
// mount before authMiddleware so they don't redirect anonymous visitors.
app.use(statusRoutes(config));

// Worker → platform internal API (git push proxy, PR creation).
// Mounted BEFORE authMiddleware because requests come from worker
// containers, not users — they carry a session-scoped JWT in
// Authorization: Bearer, verified by internal-auth middleware inside
// the router. Also gated by a private-IP check; not reachable through
// Caddy's external vhosts in production.
app.use(internalRoutes(config));

// Worker → platform Anthropic proxy. The CC worker container holds a
// session-scoped JWT (in ANTHROPIC_API_KEY env, picked up as x-api-key
// by the SDK) and ANTHROPIC_BASE_URL points at /api/internal/anthropic
// here. The proxy verifies the JWT, swaps in the real platform key, and
// forwards to api.anthropic.com — so the platform key never enters the
// worker container and "echo $ANTHROPIC_API_KEY" exfiltrates only a
// short-lived JWT useless against Anthropic directly. Same private-IP
// gate as internalRoutes; not reachable through Caddy externally.
app.use(anthropicProxyRoutes(config));

// Dapp → platform LLM proxy (issue #34). App containers call
// /api/app-llm/v1/messages with their per-app token
// (USERNODE_LLM_PROXY_TOKEN) plus the user's iframe JWT; the proxy
// verifies both, requires an active per-(app,user) grant, swaps in the
// real key (platform or the user's own, per the grant), meters spend
// against the user's daily budget AND the grant's per-app cap, and
// forwards to api.anthropic.com. Same private-IP gate as the worker
// proxy; mounted before authMiddleware because callers are app
// containers, not browser sessions.
app.use(appLlmProxyRoutes(config));

// Dapp → platform app-storage API (#752). App containers upload/delete
// user files with their per-app token (USERNODE_STORAGE_TOKEN) plus the
// user's iframe JWT — same credential pattern and private-IP gate as
// the app-LLM proxy above; mounted before authMiddleware because
// callers are app containers, not browser sessions.
app.use(appStorageRoutes(config));

// App-facing read-only platform API (#744). App containers call
// /api/app-platform/governance/feed with the same per-app token
// (USERNODE_LLM_PROXY_TOKEN) to read their OWN proposal/vote/merge
// feed for in-app "what's changing" strips. App-token-only (no user
// token or grant — the feed holds nothing an app viewer can't already
// see in the vote panel), same private-IP gate; mounted before
// authMiddleware because callers are app containers, not browser
// sessions.
app.use(appPlatformApiRoutes(config));

// Before/after visuals artifacts (#195). Public by design: GitHub's camo
// proxy fetches the PR-body embeds anonymously, so this must not redirect
// to login. Access control is the unguessable 32-hex artifact id.
app.use(visualsRoutes(config));

// App homescreen icon images. Public for the same reason as visuals:
// home tiles load them with plain <img> tags; access control is the
// unguessable 32-hex icon id.
app.use(appIconRoutes(config));

// Issue-screenshot images (#683). Public for the same reason as visuals:
// GitHub's camo proxy fetches the issue-body embeds anonymously; access
// control is the unguessable 32-hex screenshot id.
app.use(issueImageRoutes(config));

// Profile pictures (#982). Public for the same reason as app-icons: the
// profile screen and the hamburger drawer load them with plain <img>
// tags; access control is the unguessable 32-hex avatar id, and the image
// is published to other users by design.
app.use(avatarRoutes(config));

// Publicly shared locked report snapshots (report-lock-share). Mounted
// before authMiddleware like visuals: access control is the unguessable
// 32-hex share token, and the HTML is served under a sandbox CSP.
app.use(reportShareRoutes(config));

// App-stored user files (#752). Public for the same reason as app-icons:
// app pages load them with plain <img> tags from their own subdomains.
// visibility='public' rows are guarded by the unguessable 32-hex id;
// visibility='private' rows additionally require a user JWT (?token=)
// inside the route. Bytes stream from the MinIO sidecar.
app.use(appFileServeRoutes(config));

// Friendly "app is restarting" page for dead app containers (#426).
// Caddy's wildcard-site handle_errors rewrites upstream 502/503/504s to
// /__app_unavailable and proxies them here with the original app-
// subdomain Host. Mounted before authMiddleware: the request carries no
// platform session (and needs none — for view-private apps the edge
// gate already passed before the proxy attempt failed).
app.use(appErrorRoutes(config));

// Topochain v4 (plan Task 3; architecture decision #2). Public/partner/
// ingest/mobile each carry their OWN auth (optionalSessionAuth /
// partnerApiKey / mobileTokenAuth, applied per-route inside these
// routers — never a platform session), so they mount BEFORE
// authMiddleware like the pre-auth routers above. A request that matches
// one of these routers' paths is answered here and never reaches
// authMiddleware at all.
//
// NOTE on unmatched /api/v4/* paths: these four routers currently only
// expose their Task-3 __ping stubs (real endpoints land in Tasks 5-10), so
// most /api/v4/* paths are NOT yet matched here and fall through to
// authMiddleware below. /api/v4 is deliberately NOT added to
// authMiddleware's PUBLIC_PATHS: an anonymous request for an unmounted v4
// path therefore gets authMiddleware's standard 401 JSON (`{"error": "Not
// authenticated"}`), not a 404. This is intentional — unmounted API
// surface fails closed (requires auth) rather than being anonymously
// reachable by default; it also means every REAL public v4 endpoint (Task
// 5 onward) must be mounted in one of these pre-auth routers itself (as
// this file already does), never rely on falling through past
// authMiddleware. See tests/topochain-foundation.test.js for the exercised
// behavior.
app.use(topochainPublicRoutes(config));
app.use(topochainPartnerRoutes(config));
app.use(topochainIngestRoutes(config));
app.use(topochainMobileRoutes(config));

// User-facing JSON APIs may authenticate with a scoped CLI bearer token.
// This mounts after internal/app/topochain bearer surfaces so the CLI token
// can never be confused for one of those distinct credentials.
app.use(cliApiBearerAuth(config));
app.use(authMiddleware(config));
app.use(cliBrowserRoutes(config));
// Social identity proofs are a platform account surface, independent of
// the hosted MCP connector. They remain reviewable (with fixtures only) in
// staging even when connector credential minting is disabled there.
app.use(socialIdentityRoutes(config));
// Connector consent decision + connected-chat-product management. These
// need a real platform session, so they mount after authMiddleware — the
// consent POST must never be satisfiable by a bearer token approving itself.
app.use(mcpBrowserRoutes(config));
app.use(authRoutes(config));
app.use(credentialRoutes(config));
app.use(appRoutes(config));
// Shell relay for usernode.uploadFile()/deleteFile()/getStorageUsage()
// (#752): session-cookie authed, called only by public/js/app-view.js's
// storage bridge handler on behalf of the app iframe.
app.use(appFileShellRoutes(config));
app.use(chatRoutes(config));
app.use(conversationRoutes(config));
app.use(proposalHandoffRoutes(config));
app.use(sessionRoutes(config, {
  scheduleInteractiveRecovery: scheduleInteractiveTurnRecovery,
}));
app.use(voteRoutes(config));
app.use(kudosRoutes(config));
// Public read-only apps + contributors API. Mounted after authMiddleware
// like kudosRoutes; reachable anonymously via the `/api/public/` prefix in
// PUBLIC_PATHS (src/middleware/auth.js).
app.use(publicApiRoutes(config));
// Public-profile reads use the anonymous /api/public prefix; owner controls,
// reports and moderation share this router but remain behind authMiddleware.
app.use(publicProfileRoutes(config));
// Waitlist social-connect OAuth round-trip (two-stage waitlist survey).
// Anonymous via the '/waitlist/connect/' PUBLIC_PATHS prefix.
app.use(waitlistConnectRoutes(config));
app.use(issueRoutes(config));
app.use(campaignRoutes(config));
app.use(adminRoutes(config));
app.use(dashboardRoutes(config));
app.use(feedbackRoutes(config));
app.use(notificationsRoutes(config));
app.use(collaboratorRoutes(config));
// Session-authenticated user directory for the shell's iframe bridge
// relay (#1195) — must be AFTER authMiddleware; req.user is required.
app.use(appDirectoryRoutes(config));
app.use(approverRoutes(config));
app.use(llmGrantsRoutes(config));
app.use(userAgentFilesRoutes(config));
app.use(topicAttributeRoutes(config));
app.use(boardOrderRoutes(config));
app.use(reportAiRoutes(config));
app.use(reportSnapshotRoutes(config));
// Home-screen panels (#911): the challenges card's data + its per-user
// show/hide. Me-scoped reads, so it sits behind authMiddleware like the
// ordering routes above.
app.use(homePanelRoutes(config));
// Free-form home-grid placement: where each app tile and widget sits, per
// breakpoint. Me-scoped like the panels route above.
app.use(homeLayoutRoutes(config));
// Profile customization (#982): the display name / bio / handle write, the
// avatar upload-delete pair, and the viewer's own completed challenges.
// Me-scoped, so behind authMiddleware — the avatar READ side is the
// separate public avatarRoutes mounted above.
app.use(profileRoutes(config));
// #940: saved dev-chat drafts, now server-backed so they follow a user
// across devices. Owner-scoped per session, like the /api/sessions/* family
// in routes/sessions.js.
app.use(chatDraftsRoutes(config));
// #1049: the alternate development flows (Claude Code / Codex web UI) as
// ordinary browser routes rather than MCP-only tools. App-scoped with the
// same 'collab' bar as the other dev surfaces, so behind authMiddleware.
app.use(devFlowRoutes(config));
app.use(pmOrderRoutes(config));
app.use(debugRoutes(config));
app.use(galleryRoutes(config));
// Topochain v4 admin (plan Task 3; architecture decision #2): mounted
// AFTER authMiddleware — req.user is already resolved by the time this
// router's own adminMiddleware runs, exactly like src/routes/admin.js.
app.use(topochainAdminRoutes(config));

// Mint the iframe identity token the shell injects into an app iframe.
//
// The token is APP-SCOPED (RS256, audience `usernode:app:<apps.id>`), so
// the caller must name which app it is for: `?app=<slug>`. That is what
// closes the cross-app replay hole the single shared-secret token had —
// every app used to be handed a credential that every OTHER app would
// also accept, so any app operator could take a visitor's token and
// spend it against an unrelated app's API as that user.
//
// The slug is resolved through appAccess.getAppForUser at the 'view'
// level: you cannot mint an identity for an app you are not allowed to
// see. Unknown slug and no-view-access both return the SAME 404 — see
// the comment on that branch.
app.get('/api/iframe-token', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

  const slug = typeof req.query.app === 'string' ? req.query.app.trim() : '';
  if (!slug) {
    return res.status(400).json({ error: 'app query parameter is required' });
  }

  const pool = getPool(config);
  let appRow;
  try {
    // ACCESS_COLUMNS, not a trimmed list. checkAppAccess() reads
    // `view_visibility` off the row it is handed; trimming it away used to
    // make the gate below silently pass for every app — including the
    // view-private ones whose existence the 404 is here to hide. That
    // default is gone (checkAppAccess now THROWS on a missing column, and
    // the catch below turns it into a 500), but keep the full list: a 500
    // on every iframe token is its own outage.
    appRow = await appAccess.getAppForUser(pool, slug, req.user, 'view', appAccess.ACCESS_COLUMNS);
  } catch (err) {
    log.error('iframe-token', 'App resolve failed', { slug, err: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
  if (!appRow) {
    // Existence-hiding, and deliberately the SAME response for "no such
    // slug" and "you can't view this app". getAppForUser cannot tell the
    // two apart (both are a null return), and splitting them into
    // 400-vs-404 would hand an unauthenticated prober an app-existence
    // oracle for every private app — precisely what the existence-hiding
    // 404 exists to prevent. The 400 above is reserved for a caller that
    // named no app at all, which leaks nothing.
    return res.status(404).json({ error: 'App not found' });
  }

  let usernodePubkey = null;
  // Platform-level language preference (issue #757): a BCP-47 tag or null
  // when unset. Always present in the payload so app servers never need
  // `'locale' in payload` checks.
  let userLocale = null;
  try {
    const { rows } = await pool.query(
      'SELECT usernode_pubkey, locale FROM users WHERE id = $1',
      [req.user.id]
    );
    usernodePubkey = rows[0]?.usernode_pubkey || null;
    userLocale = rows[0]?.locale || null;
  } catch {}

  const tokenUser = {
    id: req.user.id,
    username: req.user.username,
    usernode_pubkey: usernodePubkey,
    locale: userLocale,
  };

  // App-scoped RS256 is the ONLY mint path. There is deliberately no
  // downgrade branch: a staging-only pre-cutover bootstrap shim signed a
  // bare-HS256 token here for the one deploy window in which previews were
  // built by a platform with no IFRAME_JWT_PRIVATE_KEY, and it has been
  // removed. A staging clone — which still gets no platform keys — self-signs
  // an ephemeral pair at boot instead (config.load() →
  // platformJwt.generateStagingIframeKeyPair), so it reaches this line with a
  // real key and takes the identical path production does. A deployment that
  // genuinely cannot sign gets the structured 503 below.
  let token = null;
  let signErr = null;
  try {
    token = platformJwt.signAppIdentityToken({ appId: appRow.id, user: tokenUser });
  } catch (err) {
    signErr = err;
  }

  if (!token) {
    // A missing/broken IFRAME_JWT_PRIVATE_KEY is an operator problem, not a
    // client one, and it is not transient within the life of the process —
    // so say which it is instead of a bare 500.
    // config.load() refuses to boot production without the key, so this is
    // the self-hosted / misconfigured-staging edge.
    log.error('iframe-token', 'Signing failed', { slug, err: signErr && signErr.message });
    return res.status(503).json({
      error: 'App identity signing is not configured on this deployment',
      code: 'signing_unavailable',
    });
  }
  res.json({ token });
});

// Bridge centralization: versioned bridge served from /usernode-bridge/vN/.
// Within a major version (e.g. v1), bug fixes ship by editing the file in
// SV and redeploying — every dapp picks the fix up on next page load.
// Browsers must therefore revalidate on every request so changes propagate
// quickly; the file is ~100KB and revalidates via 304 when unchanged.
// Across major versions the URL changes (/v1/ → /v2/) so caches segregate
// naturally. Dapps still vendor their own copy for now; this is the
// additive scaffolding for a future migration off vendoring.
app.use('/usernode-bridge', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  next();
});

// Serve the shell's static assets, but force HTML/JS/CSS to revalidate on
// every load (see src/services/static-cache.js). Without this, mobile
// WebViews cached the shell's own /js/app.js on a PR's stable staging URL
// and kept running pre-fix code across redeploys — fixes appeared to have
// no effect ("same as before"). setHeaders runs as `send` streams the file,
// so it reliably overrides send's default `max-age=0`. 304s still apply.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    const cc = shellAssetCacheControl(filePath);
    if (cc) res.setHeader('Cache-Control', cc);
  },
}));

// ── Retired standalone admin pages → #admin console sections (#860) ──────
//
// /admin, /admin-features, /dashboard, /debug and /gallery used to be
// full-browser pages of their own. They are now SECTIONS of the in-app
// admin console, and each of these routes serves a tiny client-side
// redirect stub (public/<name>.html) that rewrites the URL into the
// matching #admin/<section>. The static handler above already serves the
// `.html` forms of the same stubs, so both /admin and /admin.html forward.
//
// The stubs are client-side rather than a server 302 on purpose: a 302's
// own Location fragment wins over the request's, so /admin#campaign-3
// would silently lose the campaign id. Only a stub sees both halves.
//
// Access control is unchanged and lives where it always did — the console
// gates navigation on App.user.isAdmin and every /api/admin/*, /api/debug/*
// and /api/gallery/* endpoint is independently enforced server-side.
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin-features', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-features.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/debug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'debug.html'));
});

app.get('/gallery', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'gallery.html'));
});

app.get('*', (req, res) => {
  if (req.accepts('html')) {
    // Client-side-routing fallback: serve the SPA shell. Same revalidation
    // policy as the static handler so a redeployed index.html (which pulls
    // in fresh /js/*.js) is never pinned in a WebView cache.
    res.setHeader('Cache-Control', shellAssetCacheControl('index.html'));
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Leadership coordinator for blue-green deploys (assigned in start()).
// During a rollout both colors serve HTTP, but singleton background work
// is gated to the leader so it never double-runs. See services/leadership.js.
let leadership = null;

// Leader-only singleton work. Runs exactly once per cluster — at boot for
// the leader / the single-instance case (PLATFORM_LEADER_LOCK unset), or at
// promotion for a follower whose old leader has exited (blue-green handoff).
// EVERYTHING here either mutates shared cluster state (worker containers,
// PR/merge rows, staging, Postgres roles, GitHub) or is a singleton
// poller/sweeper that must never double-run across the two colors. The
// follower serves HTTP from boot; the couple of leader-scoped capabilities
// (prod-debug SQL, whose role password lives in the leader's memory) degrade
// to a clean 503 on the follower for the seconds until promotion.
async function becomeLeader() {
  log.info('server', 'Running leader duties (role bootstraps, recovery, sweepers)', {
    identity: leadership && leadership.identity,
  });

  // Credential rows deliberately outlive their active period for settings
  // and audit correlation, then age out on the documented schedule.
  const { cleanupCliAuth } = require('./src/services/cli-auth');
  const runCliAuthCleanup = () => cleanupCliAuth(getPool(config))
    .then((counts) => {
      if (Object.values(counts).some((count) => count > 0)) {
        log.info('cli-auth', 'Retention cleanup completed', counts);
      }
    })
    .catch((err) => {
      log.warn('cli-auth', 'Retention cleanup failed', { message: err.message });
    });
  runCliAuthCleanup();
  setInterval(() => {
    runCliAuthCleanup();
  }, 6 * 60 * 60 * 1000).unref?.();

  // #616: ensure the read-only prod-debug Postgres role (fresh in-memory
  // password every boot) and refresh its deny-listed grants so tables
  // added by this deploy's migrations are covered. On failure the
  // prod-debug endpoints return 503 and dev sessions run without the
  // capability — boot proceeds normally.
  //
  // #891: these two role bootstraps MUST run in sequence, not concurrently.
  // Both sweep `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public` plus a
  // per-table GRANT loop over the SAME catalog rows, so firing them together
  // (as they were, both un-awaited) made Postgres raise `tuple concurrently
  // updated` on whichever lost. In production prod-debug lost every time —
  // observed 42ms apart across consecutive deploys — and because nothing
  // re-invokes ensureRole, `usernode-debug sql` stayed dead for the entire
  // process lifetime, then the next deploy re-ran the same race. Awaiting
  // them costs a few hundred ms of boot; each still swallows its own
  // failures, so neither can block startup.
  const debugAccess = require('./src/services/debug-access');
  await debugAccess.ensureRole(config).catch((err) => {
    log.warn('server', 'prod-debug role bootstrap failed (capability disabled)', {
      err: err.message,
    });
  });

  // Task 13 fix round: same pattern as debugAccess.ensureRole just above,
  // for the topochain admin SQL console's dedicated read-only, column-
  // scoped Postgres role (src/services/topochain/db-console-role.js) —
  // it, not the regex validation in sql-console.js, is the actual
  // security boundary for POST /api/v4/admin/sql-query/execute. Self-
  // contained (ensureConsoleRole never rejects; it catches its own
  // failures and leaves the capability unavailable), so this `.catch()`
  // is defense-in-depth, matching the debugAccess call above line for
  // line. On failure, execute degrades to a 503 rather than ever running
  // a console query unscoped — boot proceeds normally.
  const topochainConsoleRole = require('./src/services/topochain/db-console-role');
  await topochainConsoleRole.ensureConsoleRole(config).catch((err) => {
    log.warn('server', 'topochain SQL console role bootstrap failed (capability disabled)', {
      err: err.message,
    });
  });

  // Any app stuck in 'creating' from a previous process crash gets flipped
  // to 'error' so the creator can retry instead of staring at a spinner.
  await sweepStuckCreatingApps(getPool(config)).catch(() => {});

  // Backfill `main_sha` for apps created before #21 added the column.
  // Non-blocking: we log and continue so a single slow/unauthorized
  // repo doesn't delay the server coming up.
  const { backfillMainShas } = require('./src/services/app-version');
  backfillMainShas(getPool(config)).catch((err) => {
    log.warn('server', 'main_sha backfill failed', { err: err.message });
  });

  // Public-only audit: scan existing `apps` rows and log a warning for
  // any repo that's currently private. The worker bootstrap guard
  // refuses to spawn against private repos, so these apps will fail
  // to start a dev session until the user makes the repo public —
  // surfacing them at boot lets operators see the impact ahead of
  // first user contact. Non-blocking.
  auditExistingRepoPrivacy(getPool(config)).catch((err) => {
    log.warn('server', 'private-repo audit failed', { err: err.message });
  });

  // One-time, idempotent: convert any open legacy rename *issues* into
  // rename PRs (the new dapp.json-name flow), then close the issues so
  // the backlog drains. Runs after github.init so it can actually open
  // PRs; no-op when GitHub isn't configured. Non-blocking + guarded
  // per-app so one failing repo doesn't hold up boot or the batch.
  const { migrateOpenRenameIssues } = require('./src/services/rename-pr');
  migrateOpenRenameIssues(config, getPool(config)).catch((err) => {
    log.warn('server', 'rename-issue migration failed', { err: err.message });
  });

  // Resume fleet maintenance campaigns interrupted by the restart —
  // campaign state is a DB state machine (maintenance_campaign_apps),
  // so re-entering the loop just continues from the first pending app.
  const { resumeRunningCampaigns } = require('./src/services/fleet-maintenance');
  resumeRunningCampaigns(config, getPool(config)).catch((err) => {
    log.warn('server', 'Campaign resume failed', { err: err.message });
  });

  // The push SENDER claims queued jobs — a singleton. Enqueueing (HTTP
  // side) works on every color; only the leader drains the queue.
  mobilePush.start();
  // Periodically check imported / bot-owned repos for new commits on
  // `main` we didn't make ourselves and redeploy via the same path
  // that the dev-chat merge flow uses. See main-drift-poller.js.
  require('./src/services/main-drift-poller').start(config);
  // Anonymous-shell probe: classifies each running app's shell as
  // public/gated for the landing page's app directory. Re-probes after
  // deploys and hourly. See services/shell-probe.js.
  require('./src/services/shell-probe').start(config);
  // Production app-container watchdog (#426): restart/rebuild
  // status='running' apps whose `usernode-app-<slug>` container is
  // stopped or missing — the drift poller above only acts on new
  // commits, so without this a dead container 502s forever. Not gated
  // on GitHub config: the fast `docker start` path needs none.
  require('./src/services/app-heal').start(config);
  // #892: resolve progress-estimate rows orphaned by a server restart
  // mid-run. The live backfill only exists inside the turn, so ~10% of runs
  // historically stayed unscored forever — which the v1-vs-v2 accuracy
  // comparison can't afford. See services/estimate-backfill.js.
  require('./src/services/estimate-backfill').start(config);

  // Adopt any worker containers left over from a previous server run —
  // either still executing or already exited but un-finalized. These
  // orphans are a feature, not a bug: workers are intentionally detached
  // from the server lifecycle so `node --watch` restarts don't interrupt
  // in-flight Claude Code sessions.
  reconcilePendingTurnCleanup(config)
    .catch((err) => {
      log.warn('server', 'Pending turn cleanup reconciliation failed', { err: err.message });
    })
    .then(() => recoverActiveWorkers(config))
    .catch((err) => {
      log.warn('server', 'Worker adoption failed', { err: err.message });
    })
    .finally(() => {
      // Resume headless auto sessions that were 'generating' when the
      // previous process died. Runs after worker adoption so any warm
      // container for a headless session is already registered (the
      // resume path also tolerates adoption not having finished — it
      // falls back to the deterministic container name). Each row is
      // carried forward from its persisted headless_step checkpoint;
      // unresumable rows are marked 'failed' (the pre-resume behavior).
      const { resumeHeadlessRuns } = require('./src/routes/sessions');
      resumeHeadlessRuns(config)
        .catch((err) => {
          log.warn('server', 'Headless resume failed', { err: err.message });
        })
        // #786: last of the recovery chain — repair dev-chat pill bars the
        // restart emptied in shapes that leave NO breadcrumb of their own
        // (a Mayor turn killed mid-stream, a phase-2 wrap-up lost while the
        // worker was merely warm-idle, plus sessions left broken by earlier
        // restarts). Runs after the paths above have claimed their sessions,
        // and its busy / active_turn guards skip anything still in flight.
        .then(() => restoreMissingQuickReplies(config))
        .catch((err) => {
          log.warn('server', 'Quick-reply backfill failed', { err: err.message });
        });
    });

  // Idle-eviction sweeper. Warm workers cost ~256MB resident; eviction
  // reclaims that memory after a tunable idle period. The CC volume
  // (cc-volume-<sessionId>) is preserved so the next dispatch's
  // re-warm replays prior conversation state via `claude --resume`.
  //
  // WORKER_IDLE_EVICTION_MS is the only knob (default 10min). Lower it
  // if memory headroom shrinks; raise it if we're seeing frequent
  // re-warms in production logs.
  startIdleEvictionSweeper();

  // Session auto-pause sweeper (separate, longer timer than worker
  // eviction above). Flips long-idle 'active' sessions to 'paused' so
  // they stop counting against the per-user / global session caps. The
  // CC volume + branch + PR are preserved; reopening auto-resumes.
  startConversationAttachmentSweeper(config);
  startSessionAutoPauseSweeper(config);

  // Stale-promoted-PR policy + reversible-archive GC. Warns authors of
  // promoted PRs that have gone quiet, auto-archives them after a grace
  // period, and hard-purges archived CC volumes once their retention
  // window elapses. Day-scale, so it polls on its own slow interval.
  startStalePrSweeper(config);

  // #907: release local coding-agent leases whose machine stopped
  // heartbeating, and fail the turn they were holding.
  startLocalAgentLeaseSweeper(config);

  // #1010: fast, gate-first governance applies (minute-scale). Complements
  // the hourly sweeper's Pass 0b, which keeps ownership of the close-issue
  // superseded sweep (its GitHub fetch is too costly to run per minute).
  startGovernanceApplyTicker(config);

  // Reconcile open PR sessions ('promoted'/'merging') against GitHub's
  // actual merge state. Heals sessions that merged on GitHub but whose
  // post-merge step (prod rebuild, etc.) failed — those would otherwise
  // stay 'promoted' and keep showing as "up for voting" forever — and
  // demotes 'merging' rows GitHub never merged (crash mid-merge) back to
  // 'promoted' so the next vote/retry can redrive. See the function body.
  // #390: after the GitHub-state reconcile completes (which demotes
  // crash-stuck 'merging' rows back to 'promoted' so they're eligible
  // again this same boot), re-drive the per-app drain for every app with
  // open proposals so any PR that crossed the vote-majority threshold
  // while the process was down — or whose background merge was lost to the
  // restart — actually merges now instead of waiting for a fresh vote.
  // Both stay off the critical path so the server still comes up
  // immediately, like the other recovery steps below.
  recoverStuckMerges(config)
    .then(() => reconcileEligibleMerges(config))
    // #447: after reconciling merge state, re-run any stuck/never-recorded
    // proposal checks so PRs left permanently "still running its tests" by a
    // restart mid-capture self-heal on boot. Off the critical path; the
    // re-checked PRs become merge-eligible and the next vote (or the eligible-
    // merge reconcile on a later boot) merges them.
    .then(() => reconcileStuckChecks(config))
    .catch((err) => {
      log.warn('server', 'Stuck-merge recovery / eligible-merge reconcile failed', {
        err: err.message,
      });
    });

  // #144: re-arm post-merge issue-close watches a restart killed. The
  // watcher (services/issue-close-watcher.js) is fired-and-forgotten
  // in-process from the merge path; for the self-edits app a merge
  // triggers the GitHub Actions deploy that rolls THIS platform process,
  // so the watcher dies before it can confirm GitHub's async auto-close
  // and refresh the "Open Issues" panel — the closed issue then lingers
  // until someone happens to reload after the cache TTL. Re-watching
  // recently-merged sessions on boot closes that gap (and covers crash
  // restarts mid-watch for ordinary apps too).
  resumeIssueCloseWatches(config).catch((err) => {
    log.warn('server', 'Issue-close watch resume failed', { err: err.message });
  });

  // Fallback recovery: for sessions whose container is already gone but
  // whose branch is ahead of main (i.e. CC pushed commits during an old
  // pre-autonomous-worker run), complete the PR + staging tail.
  recoverSessions(config).catch((err) => {
    log.warn('server', 'Session recovery failed', { err: err.message });
  });

  // #851: one stale-env preview pass at boot, then on the sweeper's long
  // interval (Pass 7). A restart is exactly when a platform env change has
  // just landed, which is when the fleet is most likely to be holding stale
  // env — the same "a restart is when to look" reasoning the quick-reply
  // backfill documents. This also means the pass still happens at least once
  // per deploy on a host that has the session sweeper disabled
  // (SESSION_AUTOPAUSE_IDLE_MS=0), where Pass 7 never ticks.
  //
  // Ordered after recoverSessions so the vote-backed previews it REBUILDS are
  // already current by the time this looks for ones to tear down. Detached
  // and self-swallowing: sweepStale never throws, and boot must not wait on
  // docker.
  if (stagingReap.staleSweepDue()) {
    stagingReap.sweepStale(config, { isInFlight: (id) => activeWorkersSvc.isSessionBusy(id) })
      .catch((err) => log.warn('server', 'Boot stale-preview sweep failed', { err: err.message }));
  }

  // Merge-debug retention: prune /debug runs (and their cascaded steps)
  // older than the window once at boot and then on a slow timer, so the
  // staging:private merge_debug_* tables can't grow without bound. Off the
  // critical path; swallows its own errors.
  const mergeDebug = require('./src/services/merge-debug');
  const MERGE_DEBUG_RETENTION_DAYS = parseInt(process.env.MERGE_DEBUG_RETENTION_DAYS || '30', 10);
  mergeDebug.pruneOldRuns(getPool(config), MERGE_DEBUG_RETENTION_DAYS).catch(() => {});
  setInterval(() => {
    mergeDebug.pruneOldRuns(getPool(config), MERGE_DEBUG_RETENTION_DAYS).catch(() => {});
  }, 6 * 60 * 60 * 1000).unref();

  // #451: periodic auto-merge safety net. The boot sequence above runs
  // reconcileEligibleMerges / reconcileStuckChecks exactly once; the live
  // triggers (a vote landing, a checks verdict turning green — see
  // services/visuals.js, services/conflict-resolver.js, routes/votes.js)
  // cover the common case, but a lost broadcast or a crash between the
  // checks-store and its drain trigger could still leave a PR that has both
  // a winning vote AND passing checks sitting in review until the next
  // restart. Re-run the same idempotent, bounded reconcilers on a slow
  // interval so a genuinely-ready proposal can never stall indefinitely.
  // Off the critical path, single-flight per app inside the drain, and a
  // no-op when GitHub isn't wired up. Tunable via ELIGIBLE_MERGE_SWEEP_MS.
  startEligibleMergeSweeper(config);

  // Title auto-heal: retry LLM title generation for PRs/feedback issues
  // that were filed with the fallback template while the Anthropic API was
  // unavailable (services/title-heal.js). Bounded, non-overlapping, no-op
  // while the LLM stays disabled.
  startTitleHealSweeper(config);
}

async function start() {
  // Schema migration is serialized across colors with an advisory lock so
  // two booting platform containers can't run DDL concurrently during a
  // blue-green rollout. No-op wrapper in single-instance mode. Orthogonal
  // to the lock_timeout retry INSIDE migrate() (applySchemaWithLockRetry):
  // this serializes the two colors against each other; that one survives
  // lock contention with pg_dump'ing staging clones.
  // Kubernetes runs the same migration through a bounded pre-deploy Job;
  // Docker/single-server mode keeps the advisory-lock boot migration.
  if (process.env.RUN_MIGRATIONS_ON_STARTUP !== 'false') {
    await withMigrationLock(getPool(config), () => migrate(config));
  }
  await mobilePush.initialize(config);
  await github.init(config);
  // Configure the collection kill switch even on deployments with no
  // Anthropic client. OpenRouter/local coding runs are initialized by their
  // own paths and still need the provider-neutral collector.
  llmTelemetry.init(config);
  await llm.init(config);

  worker.ensureWorkerImage().catch((err) => {
    log.warn('server', 'Worker image build deferred', { err: err.message });
  });

  // ── Per-instance services ────────────────────────────────────────────
  // Started on EVERY color so a follower can serve traffic the moment the
  // rollout cuts over to it. These are request-serving / in-memory read
  // caches — safe (just briefly redundant) to run in both colors during
  // the rollout overlap.
  //
  // Module-scoped so cleanup() can close it on SIGTERM (#767) — a
  // function-local handle left the listener accepting new connections
  // for the entire drain, then exited from under them.
  const server = app.listen(config.port, () => {
    log.info('server', `Listening on :${config.port}`);
  });
  httpServer = server;
  shutdownPool = getPool(config);

  ws.attach(server, config);
  chainPoller.start(config);
  genesisAccounts.start();
  nodeStatus.start({ nodeRpcUrl: process.env.NODE_RPC_URL });
  // Warm the /api/status cache so the first dashboard load doesn't have
  // to wait 1-2s on `docker stats`. Subsequent loads are served from
  // cache via stale-while-revalidate (see services/status.js).
  statusService.start(config);

  // ── Leader-only singleton work ───────────────────────────────────────
  // Elect a single leader across the colors. The leader runs becomeLeader()
  // immediately; a follower serves HTTP now and runs it later, once the old
  // leader exits and frees the advisory lock. Single-instance / dev / tests
  // (PLATFORM_LEADER_LOCK unset) become leader instantly — identical to the
  // pre-blue-green boot path.
  leadership = createLeadership({ databaseUrl: config.databaseUrl });
  leadership.start(becomeLeader).catch((err) => {
    log.error('server', 'Leadership coordinator failed', { err: err.message });
  });

  return server;
}

// Boot only when run as the entry point (`node server.js` — the Docker CMD
// and npm start path). Tests require() this module to reach the recovery
// internals exported below without starting servers or sweepers.
if (require.main === module) {
  start().catch((err) => {
    // pg's ECONNREFUSED and some Octokit errors leave `.message` empty, so
    // also surface `.code` and the stack — otherwise boot failures print
    // as `{"message":""}` and there's nothing to act on.
    log.error('server', 'Failed to start', {
      message: err.message || '(empty)',
      code: err.code,
      stack: err.stack,
    });
    process.exit(1);
  });
}

// Test-only surface (#183): the orphan-adoption + recovered-turn finalize
// internals, so the headless-recovery guards stay covered by node --test.
// `recoverStuckMerges` rides along so the GitHub-reconciliation sweep stays
// covered too, and `reconcileEligibleMerges` (#390) so the boot-time
// auto-merge eligibility sweep is covered. `cleanup` + `__setShutdownTargets`
// (#767) let tests drive the graceful-shutdown sequence against a stubbed
// listener and pool without booting a server. Not used by any runtime caller.
module.exports = {
  adoptOrphanWorker,
  finalizeRecoveredTurn,
  restoreMissingQuickReplies,
  recoverStuckMerges,
  reconcileEligibleMerges,
  reconcileStuckChecks,
  cleanup,
  // Getters, not values: this module.exports literal is evaluated long
  // before the `const`s down by cleanup(), so a direct reference would hit
  // the temporal dead zone and crash the whole require.
  get DRAIN_TIMEOUT_MS() { return DRAIN_TIMEOUT_MS; },
  get POOL_CLOSE_TIMEOUT_MS() { return POOL_CLOSE_TIMEOUT_MS; },
  __setShutdownTargets: ({ server, pool } = {}) => {
    httpServer = server ?? null;
    shutdownPool = pool ?? null;
    cleanupStarted = false;
  },
};

// Scan existing imported apps for privacy violations. Usernode workers
// run with zero GitHub credentials and rely on unauthenticated public
// HTTPS clones; a private repo can't be cloned by the worker, so dev
// sessions against it will fail at bootstrap. Surface those rows at
// boot so the operator can decide whether to ask the user to make
// the repo public or delete the import.
//
// Bounded concurrency (a small pool) keeps the scan from spending
// minutes on a large `apps` table during startup. The check is purely
// read-only — we log and move on.
async function auditExistingRepoPrivacy(pool) {
  const github = require('./src/services/github');
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT id, slug, repo_url FROM apps
       WHERE repo_url IS NOT NULL AND status != 'archived'`
    ));
  } catch (err) {
    log.warn('server', 'private-repo audit: query failed', { err: err.message });
    return;
  }
  if (!rows.length) return;

  log.info('server', 'Starting private-repo audit', { count: rows.length });

  // Cap concurrency so a 100-row deployment doesn't fire 100 GitHub
  // API calls in parallel and trip secondary rate limits.
  const CONCURRENCY = 4;
  const queue = rows.slice();
  let privateCount = 0;
  let errorCount = 0;

  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      const m = (row.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!m) continue;
      const [, owner, repo] = m;
      try {
        const result = await github.checkRepoPublic(owner, repo);
        if (!result.ok) {
          errorCount++;
          log.warn('server', 'private-repo audit: lookup failed', {
            appId: row.id, slug: row.slug, repo: `${owner}/${repo}`, err: result.message,
          });
        } else if (result.private) {
          privateCount++;
          log.warn('server', 'private-repo audit: app references a PRIVATE repo (dev sessions will fail)', {
            appId: row.id, slug: row.slug, repo: `${owner}/${repo}`,
          });
        }
      } catch (err) {
        errorCount++;
        log.warn('server', 'private-repo audit: unexpected error', {
          appId: row.id, slug: row.slug, err: err.message,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  log.info('server', 'Private-repo audit complete', {
    total: rows.length, private: privateCount, errors: errorCount,
  });
}

// Reconcile open PR sessions against GitHub's actual merge state.
// See the call site for rationale.
//
// Two failure modes are healed here:
//   1. A session merged on GitHub whose post-merge step (prod rebuild,
//      etc.) failed, leaving the row stuck in 'promoted'/'merging' even
//      though the PR is merged. Such a row keeps appearing in the Dev
//      forum's vote panel forever (GET /api/apps/:slug/promoted returns
//      `status IN ('promoted','merging')`). This is the whiteboard
//      #41/#44/#52/#54 bug.
//   2. A crash mid-merge that left a row in 'merging'. If GitHub never
//      merged it, flip it back to 'promoted' so the next vote/retry can
//      redrive (the original recoverStuckMerges behavior).
//
// We ask GitHub the truth rather than guessing. Bounded concurrency keeps
// the boot scan cheap; genuinely-open PRs simply report merged=false and
// are left untouched (only 'merging' rows are demoted to 'promoted').
async function recoverStuckMerges(config) {
  const { getPool } = require('./src/db/pool');
  const github = require('./src/services/github');
  const pool = getPool(config);

  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT cs.id, cs.status, cs.pr_number, cs.merge_commit_sha,
              a.repo_url
         FROM chat_sessions cs
         JOIN apps a ON a.id = cs.app_id
        WHERE cs.status IN ('promoted', 'merging')`
    ));
  } catch (err) {
    log.warn('server', 'recoverStuckMerges query failed', { err: err.message });
    return;
  }
  if (!rows.length) return;

  // Without GitHub auth we can't ask the truth. Preserve the original
  // crash-recovery behavior for 'merging' rows (flip back to 'promoted')
  // and leave 'promoted' rows alone.
  if (!github.isEnabled()) {
    try {
      const { rows: flipped } = await pool.query(
        `UPDATE chat_sessions SET status = 'promoted'
          WHERE status = 'merging' RETURNING id`
      );
      if (flipped.length) {
        log.info('server', 'Unstuck merging sessions on startup (no GitHub auth)', {
          count: flipped.length, ids: flipped.map((r) => r.id),
        });
      }
    } catch (err) {
      log.warn('server', 'recoverStuckMerges fallback flip failed', { err: err.message });
    }
    return;
  }

  log.info('server', 'Reconciling open PR sessions against GitHub', { count: rows.length });

  const CONCURRENCY = 4;
  const queue = rows.slice();
  let healed = 0;
  let demoted = 0;
  let errors = 0;

  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      const m = (row.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!m || !row.pr_number) {
        // Can't ask GitHub. Only demote 'merging' (crash recovery); leave
        // 'promoted' rows as-is.
        if (row.status === 'merging') {
          await pool.query(
            `UPDATE chat_sessions SET status = 'promoted'
              WHERE id = $1 AND status = 'merging'`,
            [row.id]
          ).catch(() => {});
          demoted++;
        }
        continue;
      }
      const [, owner, repo] = m;
      try {
        const pr = await github.getPR(owner, repo, row.pr_number);
        if (pr && pr.merged) {
          const { rowCount } = await pool.query(
            `UPDATE chat_sessions
                SET status = 'merged',
                    merged_at = COALESCE(merged_at, $2),
                    merge_commit_sha = COALESCE(merge_commit_sha, $3)
              WHERE id = $1 AND status IN ('promoted', 'merging')`,
            [row.id, pr.merged_at || null, pr.merge_commit_sha || null]
          );
          if (rowCount) {
            healed++;
            log.info('server', 'Reconciled merged-on-GitHub session to merged', {
              sessionId: row.id, prNumber: row.pr_number,
              repo: `${owner}/${repo}`, mergeSha: pr.merge_commit_sha || null,
            });
          }
        } else if (row.status === 'merging') {
          // Not merged on GitHub and stuck in 'merging' (crash mid-merge):
          // demote so the next vote/retry can redrive.
          await pool.query(
            `UPDATE chat_sessions SET status = 'promoted'
              WHERE id = $1 AND status = 'merging'`,
            [row.id]
          ).catch(() => {});
          demoted++;
        }
        // Not merged + 'promoted' == genuinely open proposal: leave alone.
      } catch (err) {
        errors++;
        log.warn('server', 'recoverStuckMerges: GitHub lookup failed', {
          sessionId: row.id, prNumber: row.pr_number,
          repo: `${owner}/${repo}`, err: err.message,
        });
        // On a lookup error, fall back to the safe crash-recovery move for
        // 'merging' rows only.
        if (row.status === 'merging') {
          await pool.query(
            `UPDATE chat_sessions SET status = 'promoted'
              WHERE id = $1 AND status = 'merging'`,
            [row.id]
          ).catch(() => {});
          demoted++;
        }
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  } catch (err) {
    log.warn('server', 'recoverStuckMerges reconciliation failed', { err: err.message });
  }
  log.info('server', 'PR session reconciliation complete', {
    scanned: rows.length, healed, demoted, errors,
  });
}

// Boot-time auto-merge reconcile sweep (#390). recoverStuckMerges above
// reconciles each open session's status against GitHub's actual merge
// state, but it deliberately leaves genuinely-open 'promoted' rows alone
// (see its body: "Not merged + 'promoted' == genuinely open proposal:
// leave alone"). It never re-checks whether a proposal has crossed the
// vote-majority threshold.
//
// Auto-merge is otherwise PURELY event-driven: a merge is only attempted
// in the background of a live vote (routes/votes.js fires checkAndMerge
// fire-and-forget). So a proposal that crossed threshold while the process
// was down — or whose background merge was lost to a restart mid-flight,
// or that became eligible because the active-user count (and thus the
// majority) dropped — sits in the Dev vote panel forever until someone
// happens to cast a fresh vote. That is the "auto-merge stops after
// restart/update" bug.
//
// The fix re-drives the existing per-app drain (checkAndResolveConflicts →
// drainApp) once at boot for every app that has any open proposal. The
// drain re-reads everything from Postgres, only ever touches PRs already
// at/above the active-user majority (the same bar checkAndMerge gates on,
// so nothing below threshold is resolved pre-emptively — #380), merges
// them in the normal priority order, and inherits the normal single-flight
// + Phase 1/Phase 2 conflict handling. It is idempotent and safe to run on
// every boot. Bounded cross-app concurrency keeps a many-app fleet from
// fanning out unbounded GitHub calls; per-app work is already serialized
// by the drain's own single-flight.
async function reconcileEligibleMerges(config) {
  const github = require('./src/services/github');
  // Without GitHub auth the drain's per-session resolve is a no-op
  // (github_disabled_or_no_pr merges nothing), so skip the work entirely —
  // matches the no-auth short-circuit in recoverStuckMerges above.
  if (!github.isEnabled()) return;

  const { getPool } = require('./src/db/pool');
  const { checkAndResolveConflicts } = require('./src/services/conflict-resolver');
  const pool = getPool(config);

  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT DISTINCT app_id FROM chat_sessions WHERE status = 'promoted'`
    ));
  } catch (err) {
    log.warn('server', 'reconcileEligibleMerges query failed', { err: err.message });
    return;
  }
  if (!rows.length) return;

  log.info('server', 'Reconciling eligible auto-merges on startup', { apps: rows.length });

  const CONCURRENCY = 4;
  const queue = rows.slice();
  let drained = 0;
  let errors = 0;

  async function worker() {
    while (queue.length) {
      const { app_id: appId } = queue.shift();
      try {
        await checkAndResolveConflicts(config, { app_id: appId });
        drained++;
      } catch (err) {
        // checkAndResolveConflicts swallows drainApp errors internally, so
        // this is belt-and-braces; never let one app's failure abort the rest.
        errors++;
        log.warn('server', 'reconcileEligibleMerges: drain failed', {
          appId, err: err.message,
        });
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  } catch (err) {
    log.warn('server', 'reconcileEligibleMerges sweep failed', { err: err.message });
  }
  log.info('server', 'Eligible auto-merge reconciliation complete', {
    apps: rows.length, drained, errors,
  });
}

// #447: how long a 'pending' check may sit before it's treated as stuck.
// The headless capture run is capped at RUN_TIMEOUT_MS (240s in
// services/visuals.js) plus the staging build, so 10 minutes is comfortably
// beyond any legitimately in-flight run. Tunable via CHECKS_STALE_MS.
const CHECKS_STALE_MS = parseInt(
  process.env.CHECKS_STALE_MS || String(10 * 60 * 1000),
  10
);

// #237: crash-loop short-circuit. A staging build that crashes deterministically
// (e.g. an app whose staging-only seed hits a missing constraint) used to be
// retried by the sweeper every sweep forever — a silent, churning deadlock.
// Build/boot failures now land a terminal 'error' verdict (services/visuals
// storeChecks) with an exponential backoff retry schedule (check_next_retry_at:
// 2m → 4m → … → 30m). The sweeper only re-picks an errored row once its backoff
// has elapsed AND it's still under this cap; past the cap we stop auto-retrying
// and leave it 'error' (the owner is already notified, and a NEW commit resets
// the streak via setChecksPending so a fix re-enables checks). Tunable.
const CHECK_MAX_AUTO_RETRIES = parseInt(
  process.env.CHECK_MAX_AUTO_RETRIES || '6',
  10
);

// #447: reconcile stuck proposal checks. check_state is only ever advanced
// out of 'pending' by the same captureForSession invocation that set it, so
// a process restart/crash mid-capture (or a staging rebuild that predated
// the #447 capture wiring) can leave a promoted PR 'pending'/NULL forever —
// past the vote threshold but permanently "still running its tests", blocked
// from merging with no retry. This re-runs the checks for promoted sessions
// whose verdict is NULL or has been 'pending' longer than CHECKS_STALE_MS.
// captureForSession always resolves to a terminal state (or 'error' via its
// catch), so this guarantees no row stays 'pending' indefinitely. Bounded
// per run like the staging-heal sweep; runs at boot and from the session
// sweeper (Pass 4). Safe + idempotent on every boot.
async function reconcileStuckChecks(config) {
  const github = require('./src/services/github');
  // Without GitHub auth a rebuild/capture is a no-op (rebuildSessionStaging
  // returns 'skipped' with no bot token), so skip the work entirely.
  if (!github.isEnabled()) return;

  const { getPool } = require('./src/db/pool');
  const pool = getPool(config);

  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
         FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
        WHERE cs.status = 'promoted'
          AND cs.branch_name IS NOT NULL
          AND (cs.check_state IS NULL
               OR (cs.check_state = 'pending'
                   AND cs.checks_checked_at < NOW() - make_interval(secs => $1::double precision / 1000.0))
               OR (cs.check_state = 'error'
                   AND cs.consecutive_check_failures < $2
                   AND cs.check_next_retry_at IS NOT NULL
                   AND cs.check_next_retry_at < NOW()))
        ORDER BY cs.promoted_at ASC NULLS FIRST
        LIMIT 50`,
      [CHECKS_STALE_MS, CHECK_MAX_AUTO_RETRIES]
    ));
  } catch (err) {
    log.warn('server', 'reconcileStuckChecks query failed', { err: err.message });
    return;
  }
  if (!rows.length) return;

  log.info('server', 'Reconciling stuck proposal checks on startup', { count: rows.length });

  const MAX_RECHECKS = 5;
  let rechecked = 0;
  for (const session of rows) {
    if (rechecked >= MAX_RECHECKS) break;
    if (activeWorkersSvc.isSessionBusy(session.id)) continue;
    rechecked++;
    try {
      await stagingRecovery.recheckSessionChecks({
        config, pool, session, reason: 'stuck-checks-boot',
      });
    } catch (err) {
      log.warn('server', 'reconcileStuckChecks recheck failed', {
        sessionId: session.id, err: err.message,
      });
    }
  }
  log.info('server', 'Stuck-check reconciliation complete', {
    scanned: rows.length, rechecked,
  });
}

// #451: how often the auto-merge safety-net sweep runs. A few minutes is
// well below the cost of letting a ready proposal linger but far above the
// per-pass work (one indexed query per app with an open proposal, then the
// single-flight drain). Tunable via ELIGIBLE_MERGE_SWEEP_MS; floored so a
// mis-set tiny value can't busy-loop the drain.
const ELIGIBLE_MERGE_SWEEP_MS = Math.max(
  parseInt(process.env.ELIGIBLE_MERGE_SWEEP_MS || String(4 * 60 * 1000), 10) || (4 * 60 * 1000),
  30 * 1000
);

// #451: periodic re-drive of the boot-time auto-merge reconcilers. Both
// reconcileEligibleMerges (merge any promoted PR that now has votes + passing
// checks) and reconcileStuckChecks (re-run checks left 'pending'/NULL by a
// mid-capture restart, so they reach a terminal verdict the eligible-merge
// pass can then act on) are idempotent and bounded, so re-running them on a
// timer is safe. Guards: skip when GitHub isn't enabled (both are no-ops
// then), never overlap a still-running sweep, and swallow all errors so the
// timer can't crash the process. Not awaited — fire-and-forget per tick.
function startEligibleMergeSweeper(config) {
  const github = require('./src/services/github');
  let running = false;
  setInterval(() => {
    if (running) return;
    if (!github.isEnabled()) return;
    running = true;
    Promise.resolve()
      .then(() => reconcileStuckChecks(config))
      .then(() => reconcileEligibleMerges(config))
      .catch((err) => {
        log.warn('server', 'Eligible-merge sweep tick failed', { err: err.message });
      })
      .finally(() => { running = false; });
  }, ELIGIBLE_MERGE_SWEEP_MS).unref?.();
}

// How often the title auto-heal sweep runs (services/title-heal.js). Ten
// minutes keeps the placeholder window short once credits/API come back
// without hammering a still-dead API (each pass is a handful of Haiku
// calls at most, and issue rows carry their own per-row backoff on top).
// Tunable via TITLE_HEAL_SWEEP_MS; floored so a mis-set value can't spin.
const TITLE_HEAL_SWEEP_MS = Math.max(
  parseInt(process.env.TITLE_HEAL_SWEEP_MS || String(10 * 60 * 1000), 10) || (10 * 60 * 1000),
  60 * 1000
);

// Periodic re-drive of title generation for fallback-titled PRs and
// feedback issues. Same guard shape as startEligibleMergeSweeper: never
// overlap a still-running pass, swallow all errors, unref'd timer. An
// early first pass (~90s after boot) covers the common "credits restored,
// platform redeployed" sequence so placeholders heal right away instead
// of waiting out the first full interval.
function startTitleHealSweeper(config) {
  const titleHeal = require('./src/services/title-heal');
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    titleHeal.sweep(config)
      .catch((err) => {
        log.warn('server', 'Title-heal sweep tick failed', { err: err.message });
      })
      .finally(() => { running = false; });
  };
  setTimeout(tick, 90 * 1000).unref?.();
  setInterval(tick, TITLE_HEAL_SWEEP_MS).unref?.();
}

// #907: how often expired local-agent leases are swept. A lease is a 120s
// TTL refreshed by a 30s heartbeat, so a machine that goes to sleep is
// already ignorable within two minutes on read (every query filters on
// expires_at). The sweep exists to mark the row released and fail any turn
// still sitting on it, so the dev chat stops saying "running on your
// machine" about a laptop in a bag. One minute is well inside that TTL.
const LOCAL_AGENT_SWEEP_MS = 60 * 1000;

// Release leases whose machine stopped heartbeating. Same guard shape as the
// sweepers above: never overlap a running pass, swallow every error, unref'd
// timer so it can't hold the process open during shutdown.
function startLocalAgentLeaseSweeper(config) {
  const localAgent = require('./src/services/local-agent');
  const { getPool } = require('./src/db/pool');
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    localAgent.sweepExpiredLeases(getPool(config))
      .catch((err) => {
        log.warn('server', 'Local-agent lease sweep tick failed', { err: err.message });
      })
      .finally(() => { running = false; });
  };
  setInterval(tick, LOCAL_AGENT_SWEEP_MS).unref?.();
}

// Resume post-merge issue-close watches for sessions merged shortly
// before this process started. See the call site for rationale. The
// 15-minute window comfortably covers the merge → GHA build → rolling
// restart sequence of the self-edits app; re-watching an issue GitHub
// already closed is cheap (first poll confirms, one cache bust + panel
// broadcast) and idempotent.
async function resumeIssueCloseWatches(config) {
  const github = require('./src/services/github');
  if (!github.isEnabled()) return;
  const { getPool } = require('./src/db/pool');
  const pool = getPool(config);
  const { rows } = await pool.query(
    `SELECT cs.id, cs.pr_number, cs.linked_issues,
            a.repo_url, a.slug AS app_slug, a.id AS app_id
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.status = 'merged'
        AND cs.merged_at > NOW() - INTERVAL '15 minutes'
        AND cs.pr_number IS NOT NULL`
  );
  if (!rows.length) return;
  const { watchIssuesClosedAfterMerge } = require('./src/services/issue-close-watcher');
  log.info('server', 'Resuming post-merge issue-close watches', {
    count: rows.length, sessionIds: rows.map((r) => r.id),
  });
  for (const row of rows) {
    const [, owner, repo] = (row.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    if (!owner || !repo) continue;
    watchIssuesClosedAfterMerge({
      owner, repo,
      prNumber: row.pr_number,
      linkedIssues: row.linked_issues,
      appSlug: row.app_slug,
      appId: row.app_id,
      // The merge-time superseded-proposal resolve ran in the dead
      // pre-restart process — the resumed watch re-runs it for observed
      // closes so no close-issue proposal is left dangling.
      pool,
    }).catch((err) => {
      log.warn('server', 'Resumed issue-close watch failed', {
        sessionId: row.id, err: err.message,
      });
    });
  }
}

// stagingNeedsRebuild + rebuildSessionStaging moved to
// src/services/staging-recovery.js so the startup recovery, the heal
// sweep (Pass 3), and the on-demand ensure-staging route share one
// implementation. Imported as stagingRecovery at the top of this file.

// Recover sessions where CC finished but post-processing didn't complete,
// AND promoted/merging PRs whose staging preview is missing or dead.
//
// The staging gap: GC (sweeper Pass 2 → teardownStagingForSession) nulls
// staging_url for idle sessions, and a container can also be lost
// independently (host restart that didn't bring it back, manual cleanup,
// crash). Either way a promoted PR's group-chat vote card loses its
// working preview. recoverSessions heals these on startup; the sweeper's
// Pass 3 heals them live without a restart. The liveness check
// (stagingNeedsRebuild) means healthy, still-running previews are left
// untouched — only genuinely broken ones are rebuilt.
async function recoverSessions(config) {
  const { getPool } = require('./src/db/pool');
  const pool = getPool(config);

  const { rows } = await pool.query(
    `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
     FROM chat_sessions cs
     JOIN apps a ON cs.app_id = a.id
     WHERE cs.status IN ('active', 'promoted', 'merging')
       AND cs.branch_name IS NOT NULL`
  );

  for (const session of rows) {
    try {
      if (!(await stagingRecovery.stagingNeedsRebuild(session, { config }))) continue;
      await stagingRecovery.rebuildSessionStaging({ config, pool, session, reason: 'startup' });
    } catch (err) {
      log.warn('server', 'Failed to recover session', { sessionId: session.id, err: err.message });
    }
  }
}

// Boot-time dev-chat quick-reply backfill (#786).
//
// The recovery paths above each drop a breadcrumb carrying pills, but two
// restart shapes leave no breadcrumb at all and so no pills:
//
//   1. A Mayor-only turn (no dispatch) killed mid-stream. It isn't in
//      activeWorkers, so the 5s drain doesn't wait for it and nothing is
//      persisted — the session's last rows are the user's message and the
//      "Thinking about your request..." status line, and the user has no
//      indication their message was dropped.
//   2. A phase-2 wrap-up lost while the worker was already warm-idle:
//      adoptOrphanWorker's warm-idle branch adopts silently (correctly —
//      nothing was interrupted), so the dispatch turn's pills, which only
//      ever come from phase 2, never land.
//
// Both leave the newest user/assistant row without quickReplies, which is
// exactly what the client's pill resolution reads. Repair them in place:
// attach derived pills to an assistant row, or post the missed-reply
// breadcrumb when the turn died before replying at all. The reap/skip
// decision itself is the pure classifyMissingPills policy in
// services/recovery-pills.js.
//
// Deliberately a one-shot boot sweep (not a sweeper pass): the shapes it
// heals are created by a restart, so a restart is exactly when to look.
// Bounded by LIMIT + a recency window so a large history can't make boot
// recovery expensive. Exported for tests.
const QR_BACKFILL_LIMIT = 200;
const QR_BACKFILL_WINDOW_DAYS = 7;

async function restoreMissingQuickReplies(config) {
  const pool = getPool(config);
  const { broadcastGlobal } = require('./src/services/ws');

  const { rows } = await pool.query(
    `SELECT id, pr_number, spec_md FROM chat_sessions
     WHERE status IN ('active', 'promoted')
       AND source IS DISTINCT FROM 'imported'
       AND is_headless = FALSE
       AND active_turn IS NULL
       AND last_activity_at > NOW() - make_interval(days => $1::int)
     ORDER BY last_activity_at DESC
     LIMIT $2`,
    [QR_BACKFILL_WINDOW_DAYS, QR_BACKFILL_LIMIT]
  );
  if (!rows.length) return;

  let attached = 0;
  let breadcrumbs = 0;
  let skipped = 0;

  for (const session of rows) {
    try {
      // A live consumer owns this session right now (a detached-turn
      // resume started above, or a turn came in while we were sweeping) —
      // its own wrap-up/breadcrumb will supply the pills.
      if (activeWorkersSvc.isSessionBusy(session.id)) { skipped++; continue; }

      // System rows are transparent to the client's pill resolution, so
      // the deciding row is the newest user/assistant one.
      const { rows: lastRows } = await pool.query(
        `SELECT id, role, content, metadata FROM chat_session_messages
         WHERE session_id = $1 AND role IN ('user', 'assistant')
         ORDER BY id DESC LIMIT 1`,
        [session.id]
      );
      const lastRow = lastRows[0] || null;
      const verdict = recoveryPills.classifyMissingPills({ lastRow });

      if (verdict === 'attach_assistant') {
        const kind = recoveryPills.backfillKindForSession({
          hasPr: session.pr_number != null,
          hasSpec: !!(session.spec_md || '').trim(),
        });
        const pills = recoveryPills.buildRecoveryQuickReplies(kind);
        if (!pills) { skipped++; continue; }
        await pool.query(
          `UPDATE chat_session_messages
           SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{quickReplies}', $1::jsonb)
           WHERE id = $2`,
          [JSON.stringify(pills), lastRow.id]
        );
        attached++;
        continue;
      }

      if (verdict === 'breadcrumb_unanswered') {
        // Idempotence across boots: if this sweep already posted its
        // breadcrumb (and the user hasn't sent anything since), the row is
        // still the session's newest system row.
        const { rows: sysRows } = await pool.query(
          `SELECT content FROM chat_session_messages
           WHERE session_id = $1 AND role = 'system'
           ORDER BY id DESC LIMIT 1`,
          [session.id]
        );
        // #896: match earlier wordings too — the breadcrumb text changed,
        // and comparing only against the current string would post a
        // second breadcrumb on top of a pre-rename one at the next boot.
        if (sysRows.length && recoveryPills.isUnansweredBreadcrumb(sysRows[0].content)) {
          skipped++;
          continue;
        }
        const pills = recoveryPills.buildRecoveryQuickReplies('unanswered', {
          lastUserText: lastRow.content || '',
        });
        await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', $2, $3)`,
          [session.id, recoveryPills.UNANSWERED_BREADCRUMB,
            JSON.stringify({
              ...(pills ? { quickReplies: pills } : {}),
              recovered: true,
              recoveredReason: 'unanswered',
            })]
        );
        broadcastGlobal({
          type: 'session_event', sessionId: session.id, event: 'status',
          text: recoveryPills.UNANSWERED_BREADCRUMB,
          quickReplies: pills || undefined,
        });
        breadcrumbs++;
        continue;
      }

      skipped++;
    } catch (err) {
      skipped++;
      log.warn('server', 'Quick-reply backfill skipped a session', {
        sessionId: session.id, err: err.message,
      });
    }
  }

  log.info('server', 'Dev-chat quick-reply backfill done', {
    scanned: rows.length, attached, breadcrumbs, skipped,
  });
}

// Adopt orphan worker containers on startup.
//
// A worker is "orphan" if its container (usernode-worker-<sessionId>)
// still exists on the host after the server comes up. That can happen
// two ways:
//
//   1) The previous server exited (SIGTERM from `node --watch`, crash,
//      host reboot) while a worker was in flight. Because the worker's
//      entrypoint runs the full clone→claude→commit→push pipeline on
//      its own, it may be STILL RUNNING or may have EXITED cleanly
//      while we were gone.
//   2) A past server exited after push but before building staging.
//
// For each case we re-attach to `docker logs -f` (which blocks on
// running containers and dumps everything immediately on exited ones),
// parse the final __USERNODE_RESULT__ line, and run PR + staging the
// same way the live chat handler does. All client updates go over the
// global WebSocket so any open tab sees the tail of its own session.
async function recoverActiveWorkers(config) {
  const pool = getPool(config);
  const staging = require('./src/services/staging');
  const ghub = require('./src/services/github');
  const { broadcastGlobal } = require('./src/services/ws');

  const orphans = await worker.listOrphanWorkers();
  if (!orphans.length) return;

  log.info('server', 'Adopting orphan worker containers', {
    count: orphans.length,
    names: orphans.map((o) => o.name),
  });

  for (const orphan of orphans) {
    // Run each adoption in parallel; they're IO-bound and isolated.
    const deps = { config, pool, staging, ghub, broadcastGlobal };
    adoptOrphanWorker(orphan, deps)
      .catch((err) => {
        if (err?.retainActiveTurn && recoveryRetry.shouldRetryRecoveryError(err)) {
          log.warn('server', 'Orphan adoption paused with durable turn state retained', {
            name: orphan.name, sessionId: orphan.sessionId, err: err.message,
          });
          scheduleRetainedOrphanRecovery(orphan, deps);
          return;
        }
        log.warn('server', 'Orphan adoption failed', {
          name: orphan.name, err: err.message,
        });
      });
  }
}

async function persistedActiveTurnExists(pool, sessionId) {
  try {
    const { rows } = await pool.query(
      'SELECT active_turn FROM chat_sessions WHERE id = $1',
      [sessionId]
    );
    return !!rows[0]?.active_turn;
  } catch {
    // An unavailable DB cannot prove the retained state disappeared. Keep
    // ownership and try again rather than letting the watchdog race us.
    return null;
  }
}

function turnCleanupArgs(activeTurn) {
  return turnLifecycle.cleanupArgs(activeTurn);
}

async function reconcilePendingTurnCleanup(config) {
  const pool = getPool(config);
  const { rows } = await pool.query(
    `SELECT id, active_turn
       FROM chat_sessions
      WHERE active_turn->>'phase' = $1`,
    [turnLifecycle.PHASE_CLEANUP_PENDING],
  );
  for (const row of rows) {
    const args = turnCleanupArgs(row.active_turn);
    const cleared = await worker.finishTurn(row.id, args);
    if (!cleared) {
      log.warn('server', 'Pending turn cleanup remains durable for a later sweep', {
        sessionId: row.id,
      });
    }
  }
}

function scheduleRetainedOrphanRecovery(orphan, deps) {
  const sessionId = Number(orphan.sessionId);
  let releaseReservation = null;
  return recoveryRetry.scheduleRetainedRecovery({
    key: `interactive:${sessionId}`,
    hold: () => {
      if (!releaseReservation) {
        releaseReservation = activeWorkersSvc.beginSessionOperation(sessionId);
      }
    },
    release: () => {
      releaseReservation?.();
      releaseReservation = null;
    },
    // Every retry re-reads the durable phase. The timer is only scheduling;
    // it never remembers semantic recovery state in a closure.
    run: async () => {
      const activeTurn = await turnLifecycle.loadActiveTurn(deps.pool, sessionId);
      const action = turnLifecycle.recoveryAction(activeTurn);
      if (action === 'none') return;
      if (action === 'cleanup') {
        const args = turnCleanupArgs(activeTurn);
        recoveryRetry.requireDurableTurnCleanup(
          await worker.finishTurn(sessionId, args),
          args,
        );
        return;
      }
      if (action === 'quarantine') return;
      await adoptOrphanWorker(orphan, deps);
    },
    onError: async (err, { failures }) => {
      if (!recoveryRetry.shouldRetryRecoveryError(err)) {
        log.error('server', 'Orphan recovery has invalid durable state; leaving it quarantined', {
          name: orphan.name, sessionId, err: err.message,
        });
        return false;
      }
      const retained = err?.retainActiveTurn
        ? true
        : await persistedActiveTurnExists(deps.pool, sessionId);
      if (retained !== false) {
        log.warn('server', 'Retrying retained orphan recovery', {
          name: orphan.name, sessionId, failures, err: err.message,
          activeTurnObservable: retained !== null,
        });
        return true;
      }
      log.warn('server', 'Retried orphan adoption failed after durable turn cleared', {
        name: orphan.name, sessionId, err: err.message,
      });
      return false;
    },
    onComplete: () => log.info('server', 'Retained orphan recovery completed', {
      name: orphan.name, sessionId,
    }),
    onHookError: (err) => log.warn('server', 'Orphan recovery retry hook failed', {
      name: orphan.name, sessionId, err: err.message,
    }),
  });
}

// Live handlers use the exact orphan-adoption state machine after retaining
// an active_turn. Supplying it at route construction avoids a circular
// sessions.js -> server.js import while keeping one semantic recovery path
// for live failures and process restarts.
function scheduleInteractiveTurnRecovery(sessionId) {
  const id = Number(sessionId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const key = `interactive:${id}`;
  const scheduled = scheduleRetainedOrphanRecovery({
    name: worker.workerContainerName(id),
    sessionId: id,
    // Warm workers remain running after their detached turn exits; cleanup
    // phases bypass this value before adoption is attempted.
    state: 'running',
  }, {
    config,
    pool: getPool(config),
    staging: stagingSvc,
    ghub: github,
    broadcastGlobal: ws.broadcastGlobal,
  });
  // A duplicate request means the retained owner is already scheduled, not
  // that recovery is absent.
  return scheduled || recoveryRetry.isScheduled(key);
}

function recoveredAgentIdentity(session, activeTurn = null) {
  const backend = activeTurn?.backend || session?.agent_backend || 'claude_code';
  const isOpenRouter = backend === 'codex_openrouter';
  return {
    backend,
    isOpenRouter,
    name: isOpenRouter ? 'OpenRouter' : 'Claude Code',
    metadata: {
      agentBackend: backend,
      agentModel: activeTurn?.model || session?.agent_model || null,
    },
  };
}

async function adoptOrphanWorker(orphan, { config, pool, staging, ghub, broadcastGlobal }) {
  const { name: containerName, sessionId, state: containerState } = orphan;

  const { rows } = await pool.query(
    // #896: app_self_hosted rides along so the recovered turn's Mayor
    // wrap-up gets the same system prompt a live turn would (the
    // self-hosted block changes what the Mayor is allowed to say).
    `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url,
            a.self_hosted AS app_self_hosted, u.username
     FROM chat_sessions cs
     JOIN apps a ON cs.app_id = a.id
     JOIN users u ON cs.user_id = u.id
     WHERE cs.id = $1`,
    [sessionId]
  );
  if (!rows.length) {
    // Session gone (archived/deleted). Just reap the container.
    log.info('server', 'Orphan has no session row — removing', { containerName });
    await worker.destroyWorker(containerName);
    return;
  }
  const session = rows[0];

  const recoveryAction = turnLifecycle.recoveryAction(session.active_turn);
  if (recoveryAction === 'quarantine') {
    log.error('server', 'Orphan turn is quarantined; preserving durable state and stopping worker', {
      sessionId,
      turnId: turnLifecycle.turnIdentity(session.active_turn),
      quarantineCode: session.active_turn?.quarantineCode || null,
    });
    // destroyWorker removes only the container/registry entry; the session
    // volume (and therefore the quarantined journal) remains for operators.
    await worker.destroyWorker(containerName);
    return;
  }
  if (recoveryAction === 'cleanup') {
    const args = turnCleanupArgs(session.active_turn);
    recoveryRetry.requireDurableTurnCleanup(
      await worker.finishTurn(sessionId, args),
      args,
    );
    session.active_turn = null;
  }

  if (!['active', 'promoted'].includes(session.status)) {
    // Session became non-runnable while we were down — drop the container.
    await worker.destroyWorker(containerName);
    return;
  }

  // #183: headless auto sessions own their multi-step loop for ALL
  // container states — the turn resume AND the Mayor wrap-up continuation
  // both happen in resumeHeadlessRuns (runs right after worker adoption).
  // Running containers are registered warm so that loop can drive them;
  // exited ones are left strictly alone: scraping them here would replay
  // the interactive post-turn tail (PR + staging on the auto branch — the
  // original #183 bug) and clearing active_turn would destroy the journal
  // pointer the cc_running resume step needs. Leftover exited containers
  // are reaped by the normal worker sweeps once the run goes terminal.
  if (session.is_headless) {
    if (containerState === 'running') {
      log.info('server', 'Adopting headless worker (resume owned by resumeHeadlessRuns)', {
        containerName, sessionId,
      });
      worker.adoptWarmWorker(sessionId, containerName);
    } else {
      log.info('server', 'Leaving exited headless worker to resumeHeadlessRuns', {
        containerName, sessionId,
      });
    }
    return;
  }

  // Long-lived worker reality check: a *running* container could be
  //   (a) a warm-idle wrapper sitting in `sleep infinity` — clean adopt,
  //       no log scrape needed.
  //   (b) a legacy single-shot still in flight — only possible during
  //       rollout from the old worker contract; tail logs as before.
  //   (c) a warm wrapper with a detached turn in flight (or finished
  //       while we were down). The turn's output lives in a journal
  //       file in the CC volume, recorded on chat_sessions.active_turn
  //       — resume it from line 0 and finish the post-turn work as if
  //       we'd never restarted.
  //   (d) a mid-exec wrapper from BEFORE the detached-turn contract
  //       (no active_turn record). Its output went to a dead pipe and
  //       is unrecoverable; kill it so it can't race the next dispatch.
  if (containerState === 'running') {
    // Case (c): detached turn with a durable record — resume it. This now
    // covers TWO shapes, distinguished only by `phase`:
    //   - phase absent  → the exec itself may still be running; the replay
    //                     follows the journal live before the tail runs.
    //   - phase 'tail'  → the agent finished cleanly and the PLATFORM side
    //                     was cut off (session 2954). The journal is
    //                     complete, so the replay returns immediately and
    //                     finalizeRecoveredTurn picks the tail up where it
    //                     stopped, skipping whatever already landed.
    // Both go down the same path deliberately: the tail is the same tail.
    const activeTurn = session.active_turn || null;
    if (activeTurn && activeTurn.journal) {
      worker.adoptWarmWorker(sessionId, containerName);
      await resumeDetachedTurn({
        config, pool, staging, broadcastGlobal, session, sessionId,
        containerName, activeTurn,
      });
      return;
    }

    const busy = await worker.isWorkerExecuting(containerName);
    if (busy === false) {
      // Nothing is executing and there's no record to resume — normally
      // an idle warm container, correctly adopted in silence.
      //
      // But this branch is ALSO where a lost tail landed before the record
      // was held across it: the container was idle (the agent really had
      // finished), so adoption returned here and the chat kept
      // "Building staging preview..." as its last word forever, with no
      // spinner, no card and no error. Change 1 makes that unreachable —
      // this stays as the guard for a record lost some other way (a
      // clearActiveTurn bug, a journal deleted under us, a pre-upgrade row
      // written by an older build).
      const dangling = await findDanglingTail(pool, sessionId);
      if (dangling) {
        log.warn('server', 'Adopting warm-idle worker with a DANGLING tail — narrating', {
          containerName, sessionId, lastRow: dangling.content,
        });
        await narrateDanglingTail({ config, pool, session, sessionId, broadcastGlobal });
        worker.adoptWarmWorker(sessionId, containerName);
        return;
      }
      log.info('server', 'Adopting warm-idle worker (no in-flight exec)', {
        containerName, sessionId,
      });
      worker.adoptWarmWorker(sessionId, containerName);
      return;
    }
    if (busy === true && session.cc_session_id) {
      // Case (d) conservative recovery: the prior in-flight turn
      // predates the detached contract and is unrecoverable from the
      // host. Kill the orphan exec to free the warm container for
      // fresh dispatches, then post a system message so the user
      // knows to retry.
      log.info('server', 'Adopting mid-exec worker — killing orphan exec', {
        containerName, sessionId,
      });
      // worker.stopTurn walks /proc inside the container — the worker
      // image has no pkill (see TURN_PROC_KILL_SCRIPT in worker.js).
      await worker.stopTurn(sessionId).catch(() => {});
      // #786: the breadcrumb carries the turn's quick-reply pills. The
      // Mayor wrap-up that normally supplies them can't run here, and
      // without pills the bar above the composer stays empty until the
      // user types — so there'd be no one-tap way to retry.
      const killedPills = recoveryPills.buildRecoveryQuickReplies('unrecoverable');
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [
          sessionId,
          recoveryPills.TURN_UNFINISHED_BREADCRUMB,
          JSON.stringify({
            ...(killedPills ? { quickReplies: killedPills } : {}),
            // #896: the restart moves off the user's screen and into the
            // row's metadata — same text for every unresumable shape,
            // `recoveredReason` keeps them apart for an operator.
            recovered: true,
            recoveredReason: 'mid_exec_killed',
          }),
        ]
      ).catch(() => {});
      broadcastGlobal({
        type: 'session_event', sessionId, event: 'status',
        text: recoveryPills.TURN_UNFINISHED_BREADCRUMB,
        quickReplies: killedPills || undefined,
      });
      worker.adoptWarmWorker(sessionId, containerName);
      return;
    }
    // busy === null (couldn't probe) or true with no cc_session_id
    // (legacy single-shot rollout): fall through to the legacy
    // watchWorker scrape. Safe on already-exited containers; for a
    // hung warm wrapper it'd block, but the idle sweeper plus session
    // archive cap the worst case.
  } else if (session.active_turn) {
    // A detached turn was recorded but its container is gone (evicted /
    // host reboot). The journal lives in the unreachable volume, so the
    // turn itself can't be replayed — but if it pushed before dying,
    // recoverSessions' staging heal picks the branch up. Clear the
    // record and let the user know.
    const goneTurn = session.active_turn;
    const goneTail = (goneTurn && typeof goneTurn.tail === 'object' && goneTurn.tail) || {};
    // Did the work actually land? A held TAIL record knows: the exec is
    // over and its seed milestones carry the commit + push outcome. When
    // it did, "send your request again" is simply wrong — the commit is on
    // GitHub, and resending buys a duplicate run (see
    // buildCodeLandedBreadcrumb). Say what landed and repair the preview.
    const codeLanded = !!goneTail.sha && goneTail.pushOk === true;
    // Codex owns a durable per-attempt ledger row in addition to active_turn.
    // Once the latter is cleared there is no remaining pointer from this
    // recovery path to the running attempt, so terminalize it first. A
    // transient ledger failure retains the turn for retry; a missing attempt
    // quarantines it through the same policy used by the stale-turn watchdog.
    if (goneTurn?.backend === 'codex_openrouter' && goneTurn?.turnUuid) {
      const agentTurn = require('./src/services/agent-turn');
      try {
        await agentTurn.completeCodexAttempt({
          pool,
          turnUuid: goneTurn.turnUuid,
          status: 'failed',
          errorCode: 'recovery_abandoned',
          errorDetail: 'Durable turn was abandoned after its worker container disappeared.',
          telemetryComponent: turnLifecycle.phaseOf(goneTurn) === turnLifecycle.PHASE_DISPATCH_PENDING
            ? null
            : goneTurn.telemetryComponent || null,
        });
      } catch (ledgerErr) {
        const disposition = await recoveryRetry.retainOrQuarantineRecoveryError({
          pool,
          sessionId,
          activeTurn: goneTurn,
          error: ledgerErr,
        });
        log.error('server', disposition.action === 'retry'
          ? 'Gone Codex turn retained because ledger terminalization failed'
          : 'Gone Codex turn quarantined because its ledger attempt is missing', {
          sessionId, err: ledgerErr.message,
        });
        throw ledgerErr;
      }
    }
    recoveryRetry.requireDurableTurnCleanup(
      await worker.clearActiveTurn(sessionId, turnCleanupArgs(goneTurn)),
      turnCleanupArgs(goneTurn),
    );
    // Terminal marker so the dead turn's progress card doesn't stay
    // frozen on its last in-progress line ("Pushing", "Editing …").
    await appendTerminalProgressLine(pool, sessionId, '[interrupted]');
    if (codeLanded) {
      const prNumber = goneTail.prNumber || session.pr_number || null;
      // 'code_done' rather than 'unrecoverable': the useful next steps are
      // Propose / tweak, not "try that again".
      const landedPills = recoveryPills.buildRecoveryQuickReplies('code_done');
      const landedText = recoveryPills.buildCodeLandedBreadcrumb({
        prNumber, rebuildingPreview: true,
      });
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [
          sessionId,
          landedText,
          JSON.stringify({
            ...(landedPills ? { quickReplies: landedPills } : {}),
            recovered: true,
            recoveredReason: 'tail_worker_gone',
            sha: goneTail.sha,
            ...(prNumber ? { prNumber } : {}),
          }),
        ]
      ).catch(() => {});
      broadcastGlobal({
        type: 'session_event', sessionId, event: 'status',
        text: landedText,
        quickReplies: landedPills || undefined,
      });
      log.warn('server', 'Tail record with a dead worker — code landed, healing preview', {
        sessionId, sha: String(goneTail.sha).substring(0, 8), prNumber,
      });
      // The preview is the only missing artefact, and rebuildSessionStaging
      // is the shared path that also re-runs the proposal checks. Awaited
      // (not fire-and-forget) so boot recovery's per-session try/catch owns
      // the failure, same as recoverSessions' own heal call.
      try {
        await stagingRecovery.rebuildSessionStaging({
          config, pool, session, reason: 'tail_worker_gone',
        });
      } catch (err) {
        log.warn('server', 'Tail-recovery staging rebuild failed', {
          sessionId, err: err.message,
        });
      }
      return;
    }
    // #786: pills on the breadcrumb — see the mid-exec branch above.
    const goneP = recoveryPills.buildRecoveryQuickReplies('unrecoverable');
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [
        sessionId,
        recoveryPills.TURN_UNFINISHED_BREADCRUMB,
        JSON.stringify({
          ...(goneP ? { quickReplies: goneP } : {}),
          recovered: true,
          recoveredReason: 'worker_gone',
        }),
      ]
    ).catch(() => {});
  }

  const [, repoOwner, repoName] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];

  const emit = (event, data) => {
    broadcastGlobal({ type: 'session_event', sessionId, event, ...data });
  };

  // #896: the same in-flight label a live turn shows. The recovery is
  // plumbing; from the user's side a coding agent is simply running.
  const recoveryAgent = recoveredAgentIdentity(session, session.active_turn);
  emit('status', {
    text: `${recoveryAgent.name} is running...`,
    ...recoveryAgent.metadata,
  });

  const result = await worker.watchWorker(containerName, {
    onProgress: (text) => {
      emit('cc_progress', { text, ...recoveryAgent.metadata });
      pool.query(
        `UPDATE chat_session_messages
         SET metadata = jsonb_set(
           metadata, '{progressLog}',
           (COALESCE(metadata->'progressLog', '[]'::jsonb) || $1::jsonb)
         )
         WHERE id = (
           SELECT id FROM chat_session_messages
           WHERE session_id = $2 AND role = 'system'
             AND metadata->>'progressLog' IS NOT NULL
           ORDER BY id DESC LIMIT 1
         )`,
        [JSON.stringify([text]), sessionId]
      ).catch(() => {});
    },
  });

  const finalized = await finalizeRecoveredTurn({
    config, pool, staging, session, sessionId, result, repoOwner, repoName,
    emit, containerName,
    activeTurn: session.active_turn || null,
    // Legacy single-shot containers are per-turn; reap when done.
    keepWorker: false,
  });
  if (recoveryAgent.isOpenRouter && finalized?.summary) {
    const { runRecoveredWrapUp } = require('./src/routes/sessions');
    await runRecoveredWrapUp({
      pool, config, session, sessionId,
      outcome: result.ahead > 0 && result.sha ? 'code' : 'no_changes',
      dispatchSummary: finalized.summary,
      fallbackPillKind: result.ahead > 0 && result.sha ? 'code_done' : 'chat_generic',
      turnModel: recoveryAgent.metadata.agentModel,
      turnId: session.active_turn?.turnId || null,
      emit,
    });
  }
}

// Shared post-turn finalization for both recovery transports (legacy
// `docker logs` scrape and detached-journal resume): persist the CC
// session id, then — when the turn pushed a commit — run the same PR +
// staging tail the live dev-turn path runs. `keepWorker` distinguishes
// the long-lived warm contract (container stays adoptable) from the
// legacy single-shot contract (container is reaped when done).
// Append one line to the session's latest persisted progressLog row —
// the same row flushProgress/onProgress write to. Used to stamp a
// terminal marker ([interrupted] etc.) on turns whose journal can't
// provide one, so the dev-chat progress card never ends frozen on an
// in-progress label. Best-effort: a session with no progress row is a
// clean no-op (the WHERE id subquery matches nothing).
// The status texts a dev turn's TAIL emits before it is finished. If one
// of these is a session's newest system row and no completion artefact
// followed it, the tail was cut off: the transcript's last word is
// "…preview" or "PR #N created" and nothing will ever come after it.
//
// Matched loosely (prefix / regex) because the wording is shared with the
// live path, which owns it — see sendStatus in routes/sessions.js.
const TAIL_IN_PROGRESS_PATTERNS = [
  /^Building staging preview/i,
  /^PR #\d+ created$/i,
];

// Is session `sessionId`'s transcript sitting on an unfinished tail?
//
// "Finished" means the newest system row carries one of the artefacts a
// completed tail produces — the agent's summary card (ccOutput), the
// Changes-ready card (stagingUrl / changesReady), an explicit failure
// (stagingFailed / checkError / turnError) — or an assistant reply came
// after it (the Mayor's wrap-up, which is always last). Anything else
// with a tail-in-progress row on top is dangling.
//
// Returns the offending row or null. Deliberately cheap: one indexed
// lookup of the last few rows.
async function findDanglingTail(pool, sessionId) {
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT role, content, metadata FROM chat_session_messages
        WHERE session_id = $1 AND role IN ('system', 'assistant')
        ORDER BY id DESC LIMIT 1`,
      [sessionId]
    ));
  } catch (err) {
    log.warn('server', 'Dangling-tail probe failed', { sessionId, err: err.message });
    return null;
  }
  const row = rows[0];
  if (!row || row.role !== 'system') return null;
  const meta = row.metadata || {};
  if (meta.ccOutput || meta.stagingUrl || meta.changesReady
      || meta.stagingFailed || meta.checkError || meta.turnError) {
    return null;
  }
  const content = String(row.content || '');
  return TAIL_IN_PROGRESS_PATTERNS.some((re) => re.test(content)) ? row : null;
}

// Close out a dangling tail we cannot resume (no record, no journal): the
// honest breadcrumb, a terminal progress marker so the card stops reading
// as in-flight, and a preview heal when the branch carries work.
//
// This is the fallback wording, so it can't inspect a milestone map —
// what it knows comes from the session row. A session with a pr_number
// pushed successfully (the PR could not exist otherwise), so it earns the
// "code landed" wording; anything else gets the resend breadcrumb.
async function narrateDanglingTail({ config, pool, session, sessionId, broadcastGlobal }) {
  await appendTerminalProgressLine(pool, sessionId, '[interrupted]');
  const landed = !!session.pr_number;
  const kind = landed ? 'code_done' : 'unrecoverable';
  const pills = recoveryPills.buildRecoveryQuickReplies(kind);
  const text = landed
    ? recoveryPills.buildCodeLandedBreadcrumb({
      prNumber: session.pr_number, rebuildingPreview: true,
    })
    : recoveryPills.TURN_UNFINISHED_BREADCRUMB;
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata)
     VALUES ($1, 'system', $2, $3)`,
    [sessionId, text, JSON.stringify({
      ...(pills ? { quickReplies: pills } : {}),
      recovered: true,
      recoveredReason: 'dangling_tail',
    })]
  ).catch(() => {});
  broadcastGlobal({
    type: 'session_event', sessionId, event: 'status',
    text, quickReplies: pills || undefined,
  });
  if (!landed) return;
  // recoverSessions' own sweep would eventually heal the preview, but it
  // runs before adoption on a cold boot — so heal it here too rather than
  // leaving the row promising a rebuild that nothing started.
  try {
    if (await stagingRecovery.stagingNeedsRebuild(session, { config })) {
      await stagingRecovery.rebuildSessionStaging({
        config, pool, session, reason: 'dangling_tail',
      });
    }
  } catch (err) {
    log.warn('server', 'Dangling-tail staging rebuild failed', { sessionId, err: err.message });
  }
}

async function appendTerminalProgressLine(pool, sessionId, line) {
  await pool.query(
    `UPDATE chat_session_messages
     SET metadata = jsonb_set(metadata, '{progressLog}',
       (COALESCE(metadata->'progressLog', '[]'::jsonb) || $1::jsonb))
     WHERE id = (
       SELECT id FROM chat_session_messages
       WHERE session_id = $2 AND role = 'system'
         AND metadata->>'progressLog' IS NOT NULL
       ORDER BY id DESC LIMIT 1
     )`,
    [JSON.stringify([line]), sessionId]
  ).catch(() => {});
}

// Returns { outcome, summary } for the recovered turn:
//
//   outcome — the terminal state for the progress card: 'done' (turn
//     wrapped up, including the no-changes case), 'push_failed' (commit
//     exists only in the worker — re-push heal failed), or 'skip'
//     (headless — owned by resumeHeadlessRuns).
//   summary — the dispatch narrative for the Mayor wrap-up, assembled the
//     same way runClaudeCodeTool builds its `summaryParts` tool result.
//     Null on 'skip'. #896: without this the wrap-up would have to
//     re-derive what happened from the transcript.
//
// Every persisted row carries metadata.recovered so an operator can find
// recovery-written rows in SQL — the audit trail that replaces the
// restart wording the build cards used to carry (#896).
//
// `alreadyDone` is the interrupted turn's tail-milestone map
// (active_turn.tail — written by the live tail as each step landed; see
// the "Post-agent TAIL" note in services/worker.js). It exists because
// this function is now also reached for a turn whose EXEC finished
// cleanly and whose TAIL was cut in half by a restart, so some of the
// work below has already happened once. Every step it gates is one that
// is NOT naturally idempotent: a duplicate completion card, a duplicate
// PR-opened event, a redundant ~5-minute staging rebuild. Absent/empty
// (a genuine mid-exec recovery) means "nothing landed yet" and the whole
// tail runs, exactly as before.
async function finalizeRecoveredTurn({
  config, pool, staging, session, sessionId, result, repoOwner, repoName,
  emit, containerName, keepWorker, startedAtMs, alreadyDone = null,
  activeTurn = null,
}) {
  const done = alreadyDone && typeof alreadyDone === 'object' ? alreadyDone : {};
  const recoveryAgent = recoveredAgentIdentity(session, activeTurn);
  const noteMilestone = async (milestone) => {
    if (!activeTurn) return false;
    const noted = await worker.noteTailMilestone(
      sessionId,
      milestone,
      turnLifecycle.cleanupArgs(activeTurn),
    );
    if (noted) Object.assign(done, milestone);
    return noted;
  };
  // #183 belt-and-braces: headless rows must never get the interactive
  // post-turn tail (PR on the auto branch + staging + system message) from
  // any recovery transport — resumeHeadlessRuns owns them. adoptOrphanWorker
  // already routes headless sessions away before reaching here; this guard
  // protects against future transports forgetting to.
  if (session.is_headless) {
    log.info('server', 'Skipping recovered-turn finalize for headless session (owned by resumeHeadlessRuns)', {
      sessionId,
    });
    return { outcome: 'skip', summary: null };
  }

  const summaryParts = [];
  // Turn duration for the completion card's "(took 4m 12s)" suffix. The
  // pre-restart process recorded when the turn started on active_turn;
  // a legacy record without it just omits the suffix.
  const durationMs = startedAtMs ? Date.now() - startedAtMs : null;

  // #896: the live path persists an outcome-aware completion row carrying
  // the agent's own summary (sessions.js runClaudeCodeTool). Recovery
  // persisted none, so the coding-agent completion card was missing
  // AND every later Mayor turn was blind to what this turn built
  // (buildMayorMessages folds ccOutput rows into the model's context).
  const persistCompletionRow = async (ccText, ccOutcome) => {
    if (!ccText) return;
    const directOpenRouterReply = recoveryAgent.isOpenRouter && ccOutcome === 'no_changes';
    // The interrupted tail already wrote this card — a second one would
    // duplicate the agent's summary in the transcript AND double-count it
    // in every later Mayor turn's context (buildMayorMessages folds
    // ccOutput rows in). The summary still goes to the wrap-up below.
    if (done.completionRowPosted) {
      log.info('server', 'Recovered turn: completion card already posted — skipping', { sessionId });
      if (directOpenRouterReply) summaryParts.unshift(ccText);
      else summaryParts.unshift(`What the agent did:\n${ccText}`);
      return;
    }
    const statusText = ccOutcome === 'success'
      ? `${recoveryAgent.name} finished`
      : ccOutcome === 'no_changes'
        ? (recoveryAgent.isOpenRouter
          ? `${recoveryAgent.name} replied`
          : `${recoveryAgent.name} made no changes`)
        : `${recoveryAgent.name} did not complete`;
    const metadata = {
      ccOutput: ccText,
      ccOutcome,
      ...recoveryAgent.metadata,
      ...(durationMs != null ? { durationMs } : {}),
      recovered: true,
    };
    let emitted = true;
    if (!directOpenRouterReply) {
      if (activeTurn?.turnId) {
        const receipt = await turnEffects.runDbEffect({
          pool,
          turnId: activeTurn.turnId,
          effectKey: 'completion_row',
          sessionId,
          run: async (client) => {
            await client.query(
              `INSERT INTO chat_session_messages (session_id, role, content, metadata)
               VALUES ($1, 'system', $2, $3)`,
              [sessionId, statusText, JSON.stringify(metadata)],
            );
            return { persisted: true };
          },
        });
        emitted = receipt.applied;
      } else {
        await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', $2, $3)`,
          [sessionId, statusText, JSON.stringify(metadata)],
        );
      }
      if (emitted) emit('status', { text: statusText, ...metadata });
    }
    await noteMilestone({ completionRowPosted: true });
    if (directOpenRouterReply) summaryParts.unshift(ccText);
    else summaryParts.unshift(`What the agent did:\n${ccText}`);
  };

  // #127 parity: peel the TESTING block off the agent's summary once, up
  // front — the cleaned text is both what the completion card shows and
  // what feeds the PR body prompt below.
  const testingNotes = require('./src/services/testing-notes');
  const recoveredTesting = testingNotes.extract(result.lastResultText || '');
  const recoveredCcSummary = (recoveredTesting.cleanedText || '').trim();

  // Capture the CC session id so the next turn can --resume, even though
  // the server process that originally spawned this worker is gone.
  const newCcId = result.sessionId || result.initSessionId || null;
  if (newCcId && newCcId !== session.cc_session_id) {
    await pool.query(
      `UPDATE chat_sessions SET cc_session_id = $1 WHERE id = $2`,
      [newCcId, sessionId]
    ).catch(() => {});
  }

  const hasChanges = result.ahead > 0 && !!result.sha;
  if (!hasChanges) {
    // #896: persist the same outcome-aware row the live path writes, so
    // the no-changes case survives a reload instead of vanishing with the
    // emit — and so the wrap-up below has something honest to describe.
    const noChangeOutcome = (result.fatalError || result.ccIsError) ? 'error' : 'no_changes';
    await persistCompletionRow(recoveredCcSummary, noChangeOutcome);
    if (result.fatalError) {
      summaryParts.push(`The coding agent hit an error: ${String(result.fatalError).substring(0, 200)}`);
    } else if (!recoveryAgent.isOpenRouter) {
      summaryParts.push('The coding agent finished without committing any changes.');
    }
    if (!keepWorker) await worker.destroyWorker(containerName);
    return { outcome: 'done', summary: summaryParts.join('\n\n') };
  }

  // The turn committed locally (ahead/sha set) but the worker's
  // usernode-push callback never landed the branch on GitHub
  // (push_ok=0 — e.g. the platform was mid-restart when the worker
  // called POST /api/internal/sessions/:id/push). `result.ahead` is
  // computed from the worker's LOCAL `origin/main..HEAD`, so it's >0
  // even with the remote branch still empty. Heal it here, while the
  // worker container still exists, before applyPrMetadata's createPR —
  // otherwise createPR 422s ("No commits between main and <branch>")
  // and, once the worker is evicted, the only copy of the commit is
  // gone. (chat 510 / issue #295: a restart mid-push left the branch
  // un-pushable and the work recoverable only from the CC transcript.)
  if (!result.pushOk) {
    try {
      const pushed = await worker.execPushFromWorker(sessionId, session.branch_name);
      result.pushOk = true;
      log.info('server', 'Recovered turn: re-pushed un-pushed branch', {
        sessionId, branch: session.branch_name,
        sha: (pushed?.sha || result.sha || '').substring(0, 8),
      });
    } catch (err) {
      log.warn('server', 'Recovered turn: re-push failed — skipping PR creation', {
        sessionId, branch: session.branch_name, err: err.message,
      });
      const pushFailedText =
        "Your changes were committed but couldn't be pushed to GitHub — "
        + 'send your request again to re-push and open the PR.';
      emit('status', { text: pushFailedText });
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [sessionId, pushFailedText, JSON.stringify({ recovered: true })]
      ).catch(() => {});
      await persistCompletionRow(recoveredCcSummary, 'error');
      summaryParts.push(
        `The agent committed ${result.sha.substring(0, 8)} locally, but the push to `
        + `${session.branch_name} failed, so no PR was opened and no preview was built. `
        + 'Tell the user to send their request again to re-push and open the PR.'
      );
      if (!keepWorker) await worker.destroyWorker(containerName);
      return { outcome: 'push_failed', summary: summaryParts.join('\n\n') };
    }
  }

  try {
    // Pull the user's most recent message so the PR title helper has
    // the same "what did you ask for?" signal that the normal dev-turn
    // path gets via the live SSE request body. Without this, recovery
    // would hit the fallback template ("<user>'s changes") and never
    // regenerate titles for iterative edits.
    const { rows: userMsgRows } = await pool.query(
      `SELECT content FROM chat_session_messages
       WHERE session_id = $1 AND role = 'user'
       ORDER BY id DESC LIMIT 1`,
      [sessionId]
    );
    const recoveredUserMessage = userMsgRows[0]?.content || '';

    // The turn committed and pushed: this is the live path's 'success'
    // completion card, written before the PR/staging work so the row
    // order matches a normal turn's transcript.
    await persistCompletionRow(recoveredCcSummary, 'success');
    summaryParts.push(`Commit ${result.sha.substring(0, 8)} pushed to ${session.branch_name}.`);

    // #127: same TESTING-block handling as the live dev-turn path —
    // persist the guidance (peeled off above) before applyPrMetadata
    // reads it back for the "How to test" section.
    if (recoveredTesting.testingMd || recoveredTesting.testingPath) {
      await pool.query(
        `UPDATE chat_sessions SET testing_md = $1, testing_path = $2 WHERE id = $3`,
        [recoveredTesting.testingMd, recoveredTesting.testingPath, sessionId]
      ).catch(() => {});
      session.testing_md = recoveredTesting.testingMd;
      session.testing_path = recoveredTesting.testingPath;
    }

    // Resolve a payer for a genuinely new recovery-side metadata call. A
    // completed/pending live receipt still carries and replays its original
    // payer; if this effect was never started and no payer is available, the
    // PR is completed with deterministic metadata instead of hidden spend.
    let prMetadataApiKey = null;
    let prMetadataGenerationAllowed = false;
    try {
      const billing = await limits.resolveBillingPath(
        pool, config.dataEncryptionKey, session.user_id,
      );
      if (!billing.error) {
        prMetadataApiKey = billing.apiKey;
        prMetadataGenerationAllowed = true;
      } else {
        log.info('server', 'Recovered turn using deterministic PR metadata', {
          sessionId, reason: billing.reason || null,
        });
      }
    } catch (err) {
      log.warn('server', 'Recovered PR metadata billing resolve failed', {
        sessionId, err: err.message,
      });
    }
    const prMetadataBillingByok = prMetadataGenerationAllowed && !!prMetadataApiKey;

    const wasNewPR = !session.pr_number;
    const prMetadata = require('./src/services/pr-metadata');
    const prResult = await prMetadata.applyPrMetadata({
      pool, session, repoOwner, repoName,
      userMessage: recoveredUserMessage,
      ccSummary: recoveredCcSummary,
      username: session.username,
      broadcast: (event, data) => emit(event, data),
      apiKey: prMetadataApiKey,
      userId: session.user_id,
      effectTurnId: activeTurn?.turnId || null,
      effectSessionId: sessionId,
      effectBillingByok: prMetadataBillingByok,
      allowModelGeneration: prMetadataGenerationAllowed,
    });
    // Live-path parity: a freshly opened PR gets its own transcript row,
    // so the recovered turn reads "PR #N created" like any other.
    // `done.prNumber` means the interrupted tail already opened (and
    // announced) this PR, so it isn't "new" here even though the session
    // row we were handed may predate that write.
    const prAnnounced = !!done.prNumber || !!done.prOpenedEventRecorded;
    if (prResult && prResult.prNumber && wasNewPR && !prAnnounced) {
      const prStatus = `PR #${prResult.prNumber} created`;
      let emitted = true;
      if (activeTurn?.turnId) {
        const receipt = await turnEffects.runDbEffect({
          pool,
          turnId: activeTurn.turnId,
          effectKey: 'pr_opened_announcement',
          sessionId,
          run: async (client) => {
            await client.query(
              `INSERT INTO chat_session_messages (session_id, role, content, metadata)
               VALUES ($1, 'system', $2, $3)`,
              [sessionId, prStatus,
                JSON.stringify({ prNumber: prResult.prNumber, recovered: true })],
            );
            await client.query(
              `INSERT INTO events (user_id, app_id, session_id, event_type, metadata)
               VALUES ($1, $2, $3, $4, $5::jsonb)`,
              [
                session.user_id,
                session.app_id,
                sessionId,
                events.EVENT_TYPES.PR_OPENED,
                JSON.stringify({ prNumber: prResult.prNumber }),
              ],
            );
            return { prNumber: prResult.prNumber };
          },
        });
        emitted = receipt.applied;
      } else {
        await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', $2, $3)`,
          [sessionId, prStatus,
            JSON.stringify({ prNumber: prResult.prNumber, recovered: true })],
        );
        await events.record(pool, {
          type: events.EVENT_TYPES.PR_OPENED,
          userId: session.user_id,
          appId: session.app_id,
          sessionId,
          metadata: { prNumber: prResult.prNumber },
        });
      }
      if (emitted) emit('status', { text: prStatus });
      await noteMilestone({
        prNumber: prResult.prNumber,
        prOpenedEventRecorded: true,
      });
      summaryParts.push(`Opened PR #${prResult.prNumber}: ${prResult.prUrl}`);
    } else if (session.pr_number || prResult?.prNumber) {
      summaryParts.push(`Pushed to existing PR #${session.pr_number || prResult.prNumber}.`);
    }

    // Live-path parity for a PROMOTED session (sessions.js's post-staging
    // block): a new commit invalidates the votes cast against the old one.
    // Recovery used to skip this entirely, which was harmless while an
    // interrupted tail simply never finished — now that it DOES finish, a
    // resumed tail must not leave a promoted proposal carrying votes for a
    // commit nobody reviewed. Gated on the milestone so a reset the live
    // tail already performed is never re-announced.
    if (session.status === 'promoted' && done.votesResetFor !== result.sha) {
      try {
        // Claim before the destructive delete. If recovery dies after this
        // point, repeating the reset/announcement would be worse than
        // leaving the already-reset votes unannounced.
        await noteMilestone({ votesResetFor: result.sha });
        await require('./src/services/app-admins')
          .refreshExplicitApproval(pool, session, session);
        const { rowCount } = await pool.query(
          `DELETE FROM pr_votes WHERE session_id = $1`, [sessionId]
        );
        if (rowCount > 0) {
          const { sendSystemMessage, pushVoteUpdate } = require('./src/services/ws');
          pushVoteUpdate({ sessionId, appSlug: session.app_slug, merged: false });
          const resetMsg = `Votes reset on PR #${session.pr_number || sessionId} — new commit ${result.sha.substring(0, 8)} pushed.`;
          await sendSystemMessage(pool, session.app_id, resetMsg, 'system').catch(() => {});
          await sendSystemMessage(pool, session.app_id, resetMsg, 'system',
            null, { type: 'session', ref: sessionId }).catch(() => {});
          summaryParts.push('Group-chat votes were reset for the new commit.');
          log.info('server', 'Recovered turn: reset PR votes after new commit', {
            sessionId, commitHash: result.sha.substring(0, 8), votesDropped: rowCount,
          });
        }
      } catch (err) {
        log.warn('server', 'Recovered turn: vote reset failed (non-fatal)', {
          sessionId, err: err.message,
        });
      }
    }

    const app = { id: session.app_id, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };

    const stagingFailureSummary = (failure = {}) => (
      `Staging build failed.\n\nWhat still happened: commit ${result.sha.substring(0, 8)} was pushed to `
      + `${session.branch_name}${session.pr_number ? ` and PR #${session.pr_number} was created/updated` : ''}. `
      + `Only the staging preview container is missing — there is no preview URL for this commit.\n\n`
      + `${failure.fix || 'Retry the preview build when the staging issue is resolved.'}`
    );

    // The transcript card and its replay checkpoint commit together. The
    // staging build itself is external and may already have happened, but a
    // retained tail must never publish its outcome twice on a later wrap-up
    // retry. A failed outcome is checkpointed too so retrying Mayor/spend
    // work does not launch another expensive build known to have failed.
    const publishRecoveredStaging = async ({ outcome, stagingUrl = null, failure = null }) => {
      const succeeded = outcome === 'success';
      const content = succeeded ? 'Staging deployed!' : 'Staging build failed';
      const metadata = succeeded
        ? {
            stagingUrl,
            changesReady: true,
            prNumber: prResult?.prNumber || session.pr_number || null,
            prUrl: prResult?.prUrl || session.pr_url || null,
            recovered: true,
          }
        : {
            error: failure?.errMsg || 'Staging build failed',
            changesReady: true,
            stagingFailed: true,
            stagingErrorName: failure?.errName || 'Error',
            stagingMissingKeys: failure?.missingKeys || [],
            prNumber: prResult?.prNumber || session.pr_number || null,
            prUrl: prResult?.prUrl || session.pr_url || null,
            recovered: true,
          };
      const checkpoint = succeeded
        ? { stagingPublished: true }
        : { stagingPublished: true, stagingFailed: failure || { errMsg: metadata.error } };
      const persist = async (client) => {
        await client.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', $2, $3)`,
          [sessionId, content, JSON.stringify(metadata)],
        );
        if (activeTurn) {
          await turnLifecycle.mergeTailMilestones(client, {
            sessionId,
            ...turnLifecycle.cleanupArgs(activeTurn),
            milestones: checkpoint,
          });
        }
        return { outcome, metadata, failure, checkpoint };
      };

      let applied = true;
      let value;
      if (activeTurn?.turnId) {
        const receipt = await turnEffects.runDbEffect({
          pool,
          turnId: activeTurn.turnId,
          effectKey: turnEffects.EFFECT_KEYS.RECOVERED_STAGING_PUBLICATION,
          sessionId,
          run: persist,
        });
        applied = receipt.applied;
        value = receipt.value || { outcome, metadata, failure, checkpoint };
      } else {
        value = await persist(pool);
      }
      // A completed receipt is authoritative if two recovery owners reached
      // this boundary with different observations. Restore the checkpoint
      // that committed with the card, not the retrying owner's proposal.
      const settledCheckpoint = value.checkpoint
        && typeof value.checkpoint === 'object'
        && !Array.isArray(value.checkpoint)
        ? value.checkpoint
        : (value.outcome === 'success'
            ? { stagingPublished: true }
            : {
                stagingPublished: true,
                stagingFailed: value.failure || { errMsg: value.metadata?.error || 'Staging build failed' },
              });
      Object.assign(done, settledCheckpoint);

      if (applied && value.outcome === 'success') {
        emit('staging_ready', {
          url: value.metadata.stagingUrl,
          changesReady: true,
          testingMd: session.testing_md || null,
          testingPath: session.testing_path || null,
        });
      } else if (applied) {
        emit('staging_failed', {
          error: value.metadata.error,
          errorName: value.metadata.stagingErrorName,
          missingKeys: value.metadata.stagingMissingKeys,
          changesReady: true,
          prNumber: value.metadata.prNumber,
          prUrl: value.metadata.prUrl,
        });
      }
      return { applied, ...value };
    };

    if (done.stagingFailed) {
      log.info('server', 'Recovered turn: staging failure already published — skipping rebuild', {
        sessionId,
      });
      summaryParts.push(stagingFailureSummary(
        typeof done.stagingFailed === 'object' ? done.stagingFailed : {},
      ));
      return { outcome: 'done', summary: summaryParts.join('\n\n') };
    }

    // Did the interrupted tail already build a preview for this commit,
    // and is that container still healthy? Rebuilding one costs minutes
    // (~4:45 of DB clone on the self-app), so a live preview is reused
    // rather than replaced. A recorded-but-dead container falls through to
    // a real rebuild, which is the whole point of this path.
    let reusedStaging = null;
    if (done.stagingUrl) {
      const { rows: liveRows } = await pool.query(
        `SELECT staging_url, staging_container_id FROM chat_sessions WHERE id = $1`,
        [sessionId]
      ).catch(() => ({ rows: [] }));
      const live = liveRows[0] || null;
      if (live && live.staging_url === done.stagingUrl) {
        const needsRebuild = await stagingRecovery
          .stagingNeedsRebuild({ ...session, ...live }, { config })
          .catch(() => true);
        if (!needsRebuild) reusedStaging = live.staging_url;
      }
    }

    if (!reusedStaging) emit('status', { text: 'Building staging preview...' });

    // #461 parity: pend the checks for the NEW commit before the build
    // starts, so the previous commit's verdict (e.g. a stale 'passing')
    // can't satisfy the merge gate while this build runs — or after it
    // fails. The live dev-turn path does this; recovery used to skip it.
    const visuals = require('./src/services/visuals');
    await visuals.setChecksPending(pool, sessionId, result.sha, 'building', 'boot-reconcile')
      .catch((err) => log.warn('server', 'Recovered turn: setChecksPending failed (non-fatal)', {
        sessionId, err: err.message,
      }));

    // Preview already up for this commit: skip straight to the
    // Changes-ready card the interrupted tail never got to post. The
    // checks capture still re-runs below (setChecksPending just voided the
    // verdict), so the merge gate resolves either way.
    if (reusedStaging) {
      log.info('server', 'Recovered turn: reusing healthy staging preview', {
        sessionId, url: reusedStaging,
      });
      await publishRecoveredStaging({ outcome: 'success', stagingUrl: reusedStaging });
      summaryParts.push(`Staging preview is live: ${reusedStaging}`);
      visuals.captureForSession(config, session, app, result.sha, null, { send: () => {}, trigger: 'boot-reconcile' })
        .catch((err) => log.warn('server', 'Recovered turn: reused-preview capture failed (non-fatal)', {
          sessionId, err: err.message,
        }));
      // The `finally` below owns worker teardown — don't pre-empt it.
      return { outcome: 'done', summary: summaryParts.join('\n\n') };
    }

    // #896: staging is a recoverable failure point — the commit, push and
    // PR already landed real-world artefacts. Before this catch, a failed
    // preview build threw straight out of the recovery task: no staging
    // row, no wrap-up, no pills, and a progress card frozen on
    // [interrupted]. Mirror the live path instead — persist the
    // `changesReady` failure card (Propose still works; promote rebuilds
    // staging itself) and let the wrap-up explain it.
    let stagingResult = null;
    let stagingErr = null;
    try {
      stagingResult = await staging.buildAndDeployStaging(config, session, app, result.sha);
    } catch (e) {
      stagingErr = e;
    }

    if (stagingResult) {
      await pool.query(
        `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
        [stagingResult.containerId, stagingResult.stagingUrl, sessionId]
      );
      await noteMilestone({ stagingUrl: stagingResult.stagingUrl });

      // Make the first real request through the edge now that staging_url
      // is persisted and BEFORE staging_ready reveals the preview button,
      // so the reviewer's click doesn't pay the container's cold first
      // request (live-path parity). Best-effort exactly like the live path:
      // never blocks or fails the recovery.
      try {
        await staging.verifyStagingEdge(session, stagingResult.hostname, stagingResult.stagingUrl);
      } catch (err) {
        log.warn('server', 'Recovered turn: staging edge verification failed (non-fatal)', {
          sessionId, err: err.message,
        });
      }

      await publishRecoveredStaging({
        outcome: 'success',
        stagingUrl: stagingResult.stagingUrl,
      });
      summaryParts.push(`Staging redeployed: ${stagingResult.stagingUrl}`);
      log.info('server', 'Orphan finalized', {
        sessionId, commitHash: result.sha.substring(0, 8), url: stagingResult.stagingUrl,
      });
    } else {
      const { describeStagingFailure } = require('./src/routes/sessions');
      const { fix, missingKeys, errMsg, errName } = describeStagingFailure(stagingErr);
      // #461: record the failure as a terminal 'error' checks verdict
      // instead of leaving the pending state looking "still running".
      await stagingRecovery.recordStagingBootFailure({
        config, pool, session, commitHash: result.sha, err: stagingErr,
      }).catch((e) => log.warn('server', 'Recovered turn: recordStagingBootFailure failed (non-fatal)', {
        sessionId, err: e.message,
      }));
      const failure = { fix, missingKeys, errMsg, errName };
      await publishRecoveredStaging({ outcome: 'failed', failure });
      summaryParts.push(stagingFailureSummary(failure));
      log.error('server', 'Recovered turn: staging build failed', {
        sessionId, slug: app.slug, errName, err: errMsg, missingKeys,
      });
    }
  } finally {
    if (!keepWorker) await worker.destroyWorker(containerName);
  }
  return { outcome: 'done', summary: summaryParts.join('\n\n') };
}

// Resume a detached CC turn after a restart. The turn kept running (or
// finished) while we were down — its output is in the journal file
// recorded on chat_sessions.active_turn. Replays the journal from line
// 0 (rebuilding progress + result state), follows it live if the turn
// is still going, then runs the standard post-turn tail. The warm
// container stays registered for the session's next dispatch.
async function resumeDetachedTurn(args) {
  const { pool, sessionId } = args;
  // Register the whole recovery (journal tail + finalize's PR/staging
  // work) in the shared activeWorkers set so the auto-pause/staging-GC
  // sweepers see the session as busy — the sessions 2391/2386 incident
  // was the sweeper pausing sessions and destroying their workers in
  // the window between the journal tail ending and finalize completing.
  activeWorkersSvc.activeWorkers.add(sessionId);
  try {
    return await resumeDetachedTurnInner(args);
  } catch (err) {
    let retainedTurn;
    try {
      retainedTurn = await turnLifecycle.loadActiveTurn(pool, sessionId);
    } catch (loadErr) {
      // A DB outage cannot prove that recovery ownership disappeared.
      // Retry the durable read rather than demoting the original failure to
      // an ordinary, reapable orphan.
      loadErr.retainActiveTurn = true;
      throw loadErr;
    }
    if (retainedTurn) {
      await recoveryRetry.retainOrQuarantineRecoveryError({
        pool,
        sessionId,
        activeTurn: retainedTurn,
        error: err,
      });
    }
    throw err;
  } finally {
    activeWorkersSvc.activeWorkers.delete(sessionId);
    // Turn completion counts as activity: give the freshly recovered
    // session a full idle window instead of leaving last_activity_at at
    // the pre-restart user message (which made it instantly pause-
    // eligible the moment the busy guard dropped).
    await pool.query(
      `UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1`,
      [sessionId]
    ).catch(() => {});
  }
}

async function resumeDetachedTurnInner({
  config, pool, staging, broadcastGlobal, session, sessionId,
  containerName, activeTurn,
}) {
  const [, repoOwner, repoName] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  const emit = (event, data) => {
    broadcastGlobal({ type: 'session_event', sessionId, event, ...data });
  };

  // The milestone map of an interrupted TAIL (empty for a mid-exec
  // recovery). Read once here and threaded into finalizeRecoveredTurn so
  // the tail's non-idempotent steps aren't repeated.
  let tailDone = (activeTurn && typeof activeTurn.tail === 'object' && activeTurn.tail) || {};
  let recoveryActiveTurn = activeTurn;
  const recoveryAgent = recoveredAgentIdentity(session, activeTurn);
  log.info('server', 'Resuming detached turn from journal', {
    sessionId, containerName, mode: activeTurn.mode, journal: activeTurn.journal,
    // 'tail' distinguishes "the agent was done, the platform side wasn't"
    // from a genuine mid-exec resume — the two look identical in the logs
    // otherwise, and only one of them means a turn lost minutes of work.
    phase: activeTurn.phase || 'exec',
    tailDone: Object.keys(tailDone),
  });
  // #896: the same in-flight label a live turn shows — see the note in
  // adoptOrphanWorker. Emit-only (never persisted), as before.
  emit('status', {
    text: `${recoveryAgent.name} is running...`,
    ...recoveryAgent.metadata,
  });

  // The journal replay re-feeds every line from the start of the turn,
  // including ones the previous process already appended to the latest
  // "Claude Code progress" row. Rebuild that row's progressLog
  // WHOLESALE from the replayed lines (idempotent) instead of appending
  // duplicates; live tabs still get each line over the WebSocket.
  const progressLines = [];
  let flushQueued = false;
  const flushProgress = () => {
    flushQueued = false;
    pool.query(
      `UPDATE chat_session_messages
       SET metadata = jsonb_set(metadata, '{progressLog}', $1::jsonb)
       WHERE id = (
         SELECT id FROM chat_session_messages
         WHERE session_id = $2 AND role = 'system'
           AND metadata->>'progressLog' IS NOT NULL
         ORDER BY id DESC LIMIT 1
       )`,
      [JSON.stringify(progressLines), sessionId]
    ).catch(() => {});
  };

  const onRecoveredProgress = (text) => {
    emit('cc_progress', { text, ...recoveryAgent.metadata });
    progressLines.push(text);
    if (!flushQueued) {
      flushQueued = true;
      setTimeout(flushProgress, 1000);
    }
  };
  let result;
  try {
    result = await worker.resumeTurnFromJournal(sessionId, {
      journal: activeTurn.journal,
      turnId: activeTurn.turnId || null,
      agentBackend: activeTurn.backend || 'claude_code',
      telemetryComponent: activeTurn.telemetryComponent
        || (activeTurn.mode === 'scout' ? 'coding_agent_scout'
          : activeTurn.mode === 'build' ? 'coding_agent_build' : null),
      telemetryCorrelationId: activeTurn.telemetryCorrelationId || activeTurn.turnId || null,
      telemetryAttemptNumber: activeTurn.telemetryAttemptNumber || activeTurn.attemptNumber || 1,
      requestedModel: activeTurn.model || null,
      startedAt: activeTurn.startedAt || null,
      attemptNumber: activeTurn.attemptNumber || 1,
      billingByok: activeTurn.byok === true,
      providerWasDispatched: turnLifecycle.phaseOf(activeTurn) !== turnLifecycle.PHASE_DISPATCH_PENDING,
      // #664: seed the per-turn BYOK tally from the persisted record so
      // post-restart switched calls accumulate on top of pre-restart ones.
      byokCentsSoFar: Number(activeTurn.byokCents || 0),
      onProgress: onRecoveredProgress,
    });
  } catch (err) {
    log.warn('server', 'Detached-turn resume failed', { sessionId, err: err.message });
    // Fail the Codex ledger row on a resume failure too (review P1c): the
    // success path terminalizes, but a thrown resume also must not leave
    // the row 'running' / the token usable until expiry.
    if (activeTurn?.backend === 'codex_openrouter' && activeTurn?.turnUuid) {
      const agentTurn = require('./src/services/agent-turn');
      try {
        await agentTurn.completeCodexTurn({
          pool,
          turnUuid: activeTurn.turnUuid,
          status: 'failed',
          errorCode: agentTurn.classifyErrorCode(err),
          errorDetail: agentTurn.sanitizeError(err),
        });
      } catch (ledgerErr) {
        const disposition = await recoveryRetry.retainOrQuarantineRecoveryError({
          pool,
          sessionId,
          activeTurn,
          error: ledgerErr,
        });
        log.error('server', disposition.action === 'retry'
          ? 'Recovered Codex terminalization failed; retaining durable state'
          : 'Recovered Codex attempt is missing; durable turn quarantined', {
          sessionId, err: ledgerErr.message,
        });
        throw ledgerErr;
      }
    }
    // Terminal marker: the card must not stay frozen on the last line
    // the journal managed to deliver before the resume died. When the
    // replay produced no lines at all, append to the persisted row
    // instead — a wholesale flush of just ['[interrupted]'] would wipe
    // the log the pre-restart process already persisted.
    emit('cc_progress', { text: '[interrupted]' });
    if (progressLines.length) {
      turnWatchdog.appendTerminalLine(progressLines, '[interrupted]');
      flushProgress();
    } else {
      await appendTerminalProgressLine(pool, sessionId, '[interrupted]');
    }
    // #786: the failed-resume breadcrumb carries retry pills — the
    // phase-2 wrap-up that would normally supply them is gone with the
    // dead SSE, so this is the turn's only chance to refill the bar.
    const failedPills = recoveryPills.buildRecoveryQuickReplies('unrecoverable');
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [sessionId, recoveryPills.TURN_UNFINISHED_BREADCRUMB,
        JSON.stringify({
          ...(failedPills ? { quickReplies: failedPills } : {}),
          recovered: true,
          recoveredReason: 'resume_failed',
        })]
    ).catch(() => {});
    emit('status', {
      text: recoveryPills.TURN_UNFINISHED_BREADCRUMB,
      quickReplies: failedPills || undefined,
    });
    // Cleanup is deliberately last: if its durable clear needs a retry, the
    // retry scheduler can repeat only cleanup without duplicating narration.
    const cleanupArgs = turnCleanupArgs(activeTurn);
    recoveryRetry.requireDurableTurnCleanup(
      await worker.finishTurn(sessionId, cleanupArgs),
      cleanupArgs,
    );
    return;
  }
  flushProgress();

  // Mirror execInWorker's finally: the exec is over, hand the durable
  // record to the tail. A journal that detached MID-EXEC leaves active_turn
  // in 'executing', and every milestone write below requires 'tail_pending'
  // (mergeTailMilestones) — without this stamp the tail's first
  // noteTailMilestone throws invalid_turn_transition, the tail aborts with
  // the turn retained, and the retained-recovery timer replays the whole
  // tail every minute forever (session 3180: 13+ identical resume attempts,
  // each re-running the finalize narration). Only the mid-exec case needs
  // the stamp — an interrupted TAIL is already 'tail_pending' and re-stamping
  // would clobber its milestone map with the seed. A failed stamp propagates
  // to the caller's retain/quarantine triage like any other recovery error.
  if (turnLifecycle.phaseOf(recoveryActiveTurn) === turnLifecycle.PHASE_EXECUTING) {
    await worker.markTurnTail(sessionId, {
      sha: result.sha || null,
      pushOk: result.pushOk === true,
    }, turnLifecycle.cleanupArgs(recoveryActiveTurn));
  }

  // A recovered missing-thread marker still owns its one fresh attempt.
  // Re-dispatch it before consuming the journal, then make thread + ledger
  // persistence required. Any failure here deliberately escapes BEFORE the
  // tail's clearing finally, leaving active_turn and the journal replayable.
  try {
    const agentTurn = require('./src/services/agent-turn');
    const sessionsRoutes = require('./src/routes/sessions');
    const retried = await sessionsRoutes.resumeRecoveredCodexFreshRetry({
      pool, config, session, activeTurn, result,
      onProgress: onRecoveredProgress,
    });
    if (retried) {
      result = retried.result;
      recoveryActiveTurn = retried.activeTurn;
      tailDone = (recoveryActiveTurn.tail
        && typeof recoveryActiveTurn.tail === 'object'
        && recoveryActiveTurn.tail) || {};
    }

    await agentTurn.persistRecoveredAgentThread({ pool, session, result });
    await agentTurn.settleRecoveredAgentAttempt({
      pool,
      activeTurn: recoveryActiveTurn,
      result,
      settleClaude: async () => {
        if (!result.costUsd) return null;
        let byok = recoveryActiveTurn.byok;
        if (byok === undefined || byok === null) {
          try {
            const { rows } = await pool.query(
              'SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND anthropic_key_enc IS NOT NULL) AS byok',
              [session.user_id]
            );
            byok = !!rows[0]?.byok;
          } catch {
            byok = false;
          }
        }
        const limits = require('./src/services/limits');
        return limits.settleTurnSpend(pool, session.user_id, Math.round(result.costUsd * 100), {
          turnByok: !!byok,
          byokObservedCents: worker.getTurnByokCents(sessionId),
          turnId: turnLifecycle.turnIdentity(recoveryActiveTurn),
          sessionId,
        });
      },
    });
  } catch (err) {
    const disposition = await recoveryRetry.retainOrQuarantineRecoveryError({
      pool,
      sessionId,
      activeTurn: recoveryActiveTurn,
      error: err,
    });
    log.error('server', disposition.action === 'retry'
      ? 'Required recovered-turn persistence failed; retaining durable state'
      : 'Recovered turn has invalid durable state; leaving it quarantined without retry', {
      sessionId, err: err.message,
    });
    throw err;
  }

  // Terminal marker for the progress card: pessimistic default so a
  // throw anywhere below still stamps [interrupted]; the happy paths
  // overwrite it with [done] / [push_failed] before the finally runs.
  let terminalLine = '[interrupted]';
  // #786: which pill set the generic breadcrumb below should carry. The
  // scout branches attach their own pills to their own (more specific)
  // row and leave this null — a pill-less system row is transparent to
  // the client's pill resolution, so the earlier row still wins.
  // #896: which recovery-pill set the Mayor wrap-up falls back to when
  // the model declines to call suggest_replies, and what to tell it the
  // dispatch produced. Null wrapUpOutcome means "no wrap-up" — a sync
  // turn, which has no Mayor reply on the live path either.
  let wrapUpOutcome = null;
  let wrapUpPillKind = null;
  let wrapUpSummary = null;
  let durableTailComplete = false;
  try {
    if (recoveryActiveTurn.mode === 'scout') {
      // Scout turns push nothing — their product is the spec text.
      // Persist it the same way runScoutTool does (spec_md + frozen
      // version) so the draft isn't lost with the dead SSE.
      const {
        stripSpecWrapperFence, persistScoutPublication,
      } = require('./src/routes/sessions');
      const ccText = stripSpecWrapperFence((result.lastResultText || '').trim());
      if (ccText) {
        const hadSpec = !!(session.spec_md || '').trim();
        // #786: "spec drafted" pills ride the spec row itself rather than
        // the wrap-up — it's the row that describes the state the session
        // actually landed in. They stay as a safety net for the case where
        // the wrap-up below can't run at all.
        const specPills = recoveryPills.buildRecoveryQuickReplies('spec_done');
        const publication = await persistScoutPublication({
          pool,
          sessionId,
          turnId: recoveryActiveTurn.turnId || null,
          content: ccText,
          hadSpec,
          quickReplies: specPills,
          recovered: true,
        });
        session.spec_md = ccText;
        if (publication.applied) {
          emit('status', { text: publication.scoutText, ...publication.metadata });
          emit('spec_updated', {
            length: ccText.length,
            lines: publication.lineCount,
            version: publication.specVersion,
          });
        }
        wrapUpOutcome = 'spec';
        wrapUpPillKind = 'spec_done';
        wrapUpSummary = publication.hadSpec
          ? `The scout revised the session's spec doc (now ${publication.lineCount} lines). `
            + 'The user can review it in the dev-chat spec viewer. When they are ready to ship, '
            + 'they will ask you to dispatch the coding agent.'
          : `The scout investigated the repo and drafted a ${publication.lineCount}-line markdown spec. `
            + "It now lives in the session's spec doc; the user can review it in the dev-chat "
            + 'spec viewer. When they are ready to ship, they will ask you to dispatch the coding agent.';
      } else {
        // #786: previously emit-only, so a recovered-but-empty scout turn
        // left no trace at all after a reload. Persist it (with retry
        // pills) so the state is visible and actionable.
        const noSpecPills = recoveryPills.buildRecoveryQuickReplies('unrecoverable');
        await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', $2, $3)`,
          [
            sessionId,
            recoveryPills.SCOUT_NO_SPEC_BREADCRUMB,
            JSON.stringify({
              ...(noSpecPills ? { quickReplies: noSpecPills } : {}),
              recovered: true,
            }),
          ]
        ).catch(() => {});
        emit('status', {
          text: recoveryPills.SCOUT_NO_SPEC_BREADCRUMB,
          quickReplies: noSpecPills || undefined,
        });
      }
      // Persist the CC session id for the next --resume.
      const newCcId = result.sessionId || result.initSessionId || null;
      if (newCcId && newCcId !== session.cc_session_id) {
        await pool.query(
          'UPDATE chat_sessions SET cc_session_id = $1 WHERE id = $2',
          [newCcId, sessionId]
        ).catch(() => {});
      }
      terminalLine = '[done]';
    } else if (recoveryActiveTurn.mode === 'sync') {
      // A sync turn is system work: it posts its own status rows via
      // sync-main's sendStatus and has no Mayor reply on the live path
      // either, so there is nothing to wrap up here. Logged only.
      log.info('server', 'Recovered sync turn — no Mayor wrap-up', { sessionId });
      terminalLine = '[done]';
    } else {
      const { outcome: finalizeOutcome, summary } = await finalizeRecoveredTurn({
        config, pool, staging, session, sessionId, result, repoOwner, repoName,
        emit, containerName,
        // Warm contract: the container outlives the turn.
        keepWorker: true,
        startedAtMs: recoveryActiveTurn.startedAt
          ? Date.parse(recoveryActiveTurn.startedAt) || null
          : null,
        alreadyDone: tailDone,
        activeTurn: recoveryActiveTurn,
      });
      terminalLine = finalizeOutcome === 'push_failed' ? '[push_failed]' : '[done]';
      const recoveredNoChanges = !(result.ahead > 0 && result.sha);
      wrapUpPillKind = finalizeOutcome === 'push_failed' ? 'push_failed' : 'code_done';
      if (recoveryAgent.isOpenRouter && finalizeOutcome !== 'push_failed' && recoveredNoChanges) {
        wrapUpPillKind = 'chat_generic';
      }
      wrapUpOutcome = finalizeOutcome === 'push_failed'
        ? 'push_failed'
        : (recoveredNoChanges ? 'no_changes' : 'code');
      wrapUpSummary = summary;
    }

    // #896: re-issue the Mayor's phase-2 wrap-up. It used to be skipped
    // outright — the turn ended on a bare recovery breadcrumb and no
    // Mayor reply at all, which is exactly what the issue reported.
    // Provider failure degrades to a short static close carrying these pills.
    // Durable receipt/message/spend failures still throw so this tail remains
    // owned and is retried from its committed effects.
    // ...unless the interrupted tail already got its wrap-up onto the
    // transcript (a restart in the seconds between the wrap-up persisting
    // and the record being released). Re-issuing it would post a second
    // assistant reply describing the same build.
    if (wrapUpOutcome && tailDone.wrapUpPosted) {
      log.info('server', 'Recovered turn: wrap-up already posted — skipping re-issue', { sessionId });
      wrapUpOutcome = null;
    }
    if (wrapUpOutcome) {
      const { runRecoveredWrapUp } = require('./src/routes/sessions');
      await runRecoveredWrapUp({
        pool, config, session, sessionId,
        outcome: wrapUpOutcome,
        dispatchSummary: wrapUpSummary,
        fallbackPillKind: wrapUpPillKind,
        turnModel: recoveryActiveTurn.model || null,
        turnId: recoveryActiveTurn.turnId || null,
        emit,
      });
      await worker.noteTailMilestone(
        sessionId,
        { wrapUpPosted: true },
        turnLifecycle.cleanupArgs(recoveryActiveTurn),
      );
      tailDone = { ...tailDone, wrapUpPosted: true };
    }

    // #161: the pre-restart SSE is guaranteed dead, so the owner cannot
    // have been watching this turn finish — treat recovered turns as
    // armed regardless of the persisted notify_on_done flag: clear it
    // and always create the session_done notification (the WS push
    // reaches them if they have a tab open elsewhere in the app).
    try {
      const notifications = require('./src/services/notifications');
      await pool.query(
        `UPDATE chat_sessions SET notify_on_done = FALSE WHERE id = $1`,
        [sessionId]
      ).catch(() => {});
      const created = await notifications.createSessionDoneNotification(pool, {
        userId: session.user_id, appId: session.app_id, sessionId,
      });
      if (created.length) await notifications.hydrateAndPush(pool, created[0]);
    } catch (err) {
      log.warn('server', 'recovered-turn session_done notify failed', {
        sessionId, err: err.message,
      });
    }
    durableTailComplete = true;
  } finally {
    // Stamp the terminal marker on the rebuilt log (dedup: journals from
    // new worker images already end with their own [done]/[push_failed])
    // so the collapsed card label can't stay frozen on "Pushing".
    if (turnWatchdog.appendTerminalLine(progressLines, terminalLine)) {
      emit('cc_progress', { text: terminalLine });
    }
    flushProgress();
    if (durableTailComplete) {
      const cleanupArgs = turnCleanupArgs(recoveryActiveTurn);
      recoveryRetry.requireDurableTurnCleanup(
        await worker.finishTurn(sessionId, cleanupArgs),
        cleanupArgs,
      );
    } else {
      log.warn('server', 'Recovered tail failed; retaining durable turn for replay', {
        sessionId,
        turnId: turnLifecycle.turnIdentity(recoveryActiveTurn),
      });
    }
  }
}

// Idle-eviction sweeper for warm worker containers.
//
// Runs every SWEEP_INTERVAL_MS. For each session in the warm registry,
// if there's no in-flight exec AND the container hasn't been used in
// WORKER_IDLE_EVICTION_MS, we `docker stop && docker rm` it. The
// per-session CC volume is preserved so the next dispatch can re-warm
// with `claude --resume <id>` and replay conversation state.
//
// Tuning: WORKER_IDLE_EVICTION_MS (default 10min). The sweeper itself
// is cheap — a `Map` walk + at most a couple of execs per cycle — so
// the interval is fixed at 30s.
const WORKER_IDLE_EVICTION_MS = parseInt(
  process.env.WORKER_IDLE_EVICTION_MS || (10 * 60 * 1000),
  10
);
const SWEEP_INTERVAL_MS = 30 * 1000;

let sweeperHandle = null;

function startIdleEvictionSweeper() {
  if (sweeperHandle) return;
  log.info('server', 'Worker idle-eviction sweeper started', {
    idleEvictionMs: WORKER_IDLE_EVICTION_MS,
    sweepIntervalMs: SWEEP_INTERVAL_MS,
  });
  sweeperHandle = setInterval(async () => {
    if (lifecycle.isShuttingDown()) return;
    const now = Date.now();
    const snapshot = worker.warmRegistrySnapshot();
    for (const meta of snapshot) {
      if (meta.inFlight) continue;
      if (meta.bootstrapping) continue;
      if (now - meta.lastUsedMs < WORKER_IDLE_EVICTION_MS) continue;
      try {
        await worker.evictWorker(meta.sessionId);
        log.info('server', 'Idle warm worker evicted', {
          sessionId: meta.sessionId,
          containerName: meta.containerName,
          idleMs: now - meta.lastUsedMs,
        });
      } catch (err) {
        log.warn('server', 'Idle eviction failed', {
          sessionId: meta.sessionId, err: err.message,
        });
      }
    }
  }, SWEEP_INTERVAL_MS).unref();
  // .unref() so the sweeper doesn't hold the event loop open if everything
  // else has shut down. We still clearInterval explicitly in cleanup() to
  // race-free stop the sweeper before exit.
}

// Session auto-pause sweeper. Distinct from the worker idle-eviction
// sweeper above: that one reclaims container RAM on a short timer; this
// one frees the cap *slot* on a long timer by transitioning idle
// 'active' sessions to 'paused' (worker + staging torn down, CC volume +
// branch + PR preserved). Reopening a paused session auto-resumes it.
//
// Tunables: SESSION_AUTOPAUSE_IDLE_MS (default 2h; 0 disables) and
// SESSION_SWEEP_INTERVAL_MS (default 60s). We only ever pause status=
// 'active' here — never 'promoted' (those are awaiting merge votes and
// should stay live, and pausing+resuming would currently lose the
// promoted distinction).
let sessionSweeperHandle = null;
let conversationAttachmentSweeperHandle = null;

// Messages attachment retention is independent of session auto-pause. In
// deployments that disable SESSION_AUTOPAUSE_IDLE_MS, abandoned private
// composer uploads must still be reclaimed. Run once at leader start and on
// a slow independent cadence; linked rows remain retained with messages.
function startConversationAttachmentSweeper(config) {
  if (conversationAttachmentSweeperHandle) return;
  const pool = getPool(config);
  const sweep = async () => {
    if (lifecycle.isShuttingDown()) return;
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM conversation_message_attachments
          WHERE message_id IS NULL
            AND created_at < NOW() - INTERVAL '24 hours'`
      );
      if (rowCount) log.info('server', 'GC\'d orphaned conversation attachments', { count: rowCount });
    } catch (err) {
      log.warn('server', 'Orphaned conversation attachment sweep failed', { err: err.message });
    }
  };
  sweep();
  conversationAttachmentSweeperHandle = setInterval(sweep, 60 * 60 * 1000);
  conversationAttachmentSweeperHandle.unref?.();
}

// Per-session throttle for the sweeper's staging-heal pass (Pass 3). Maps
// sessionId -> last rebuild-attempt epoch ms so a promoted PR whose build
// keeps failing (missing secret, broken manifest) isn't rebuilt on every
// 60s tick. Entries are dropped once a build succeeds; the set is bounded
// by the (small) number of promoted sessions currently missing staging.
const stagingHealAttempts = new Map();
const STAGING_HEAL_COOLDOWN_MS = parseInt(
  process.env.STAGING_HEAL_COOLDOWN_MS || String(10 * 60 * 1000),
  10
);

// #447: per-session throttle for the sweeper's stuck-check pass (Pass 4),
// mirroring stagingHealAttempts above. Maps sessionId -> last recheck-attempt
// epoch ms so a check that keeps failing to record (broken build, missing
// secret) isn't re-run on every tick. Same cooldown as the staging heal.
const checkRecheckAttempts = new Map();

// #687 Slice 3: per-session throttle for the sweeper's imported-PR head-sync
// pass (Pass 6), mirroring the two maps above. Maps sessionId -> last
// getPR-check epoch ms so an open imported proposal is polled at most once
// per cooldown (one GitHub getPR per open imported proposal per interval),
// not on every 60s tick — bounding the API cost the spec calls out. Entries
// are naturally evicted when the proposal leaves the open set.
// #851: the stale-env preview pass (Pass 7) needs no throttle map here — it is
// fleet-wide rather than per-session, and its cadence lives in
// services/staging-reap.js (staleSweepDue / STAGING_STALE_SWEEP_INTERVAL_MS) so
// the boot run and this sweeper's tick cannot disagree about when it is due.

const importedHeadSyncAttempts = new Map();
const IMPORTED_HEAD_SYNC_COOLDOWN_MS = Math.max(
  parseInt(process.env.IMPORTED_HEAD_SYNC_COOLDOWN_MS || String(3 * 60 * 1000), 10) || (3 * 60 * 1000),
  30 * 1000
);

function startSessionAutoPauseSweeper(config) {
  if (sessionSweeperHandle) return;
  if (!config.sessionAutopauseIdleMs || config.sessionAutopauseIdleMs <= 0) {
    log.info('server', 'Session auto-pause sweeper disabled', { reason: 'SESSION_AUTOPAUSE_IDLE_MS<=0' });
    return;
  }
  const pool = getPool(config);
  log.info('server', 'Session auto-pause sweeper started', {
    idleMs: config.sessionAutopauseIdleMs,
    stagingIdleMs: config.stagingIdleTeardownMs,
    sweepIntervalMs: config.sessionSweepIntervalMs,
  });
  sessionSweeperHandle = setInterval(async () => {
    if (lifecycle.isShuttingDown()) return;

    // Pass 1: auto-pause idle 'active' sessions (worker + slot only;
    // staging is left up for the cheap-resume window). Never pause a
    // session mid-turn: `active_turn IS NULL` excludes detached turns at
    // the SQL level (the watchdog pass below reaps stale rows, so this
    // can't block pausing forever), and isSessionBusy covers the whole
    // in-process window including the post-exec PR/staging tail — the
    // bare isInFlight check used to miss that tail and paused sessions
    // mid-wrap-up (sessions 2391/2386).
    //
    // STAGING ONLY: the `staging-fixture/*` sessions are exempt. They are
    // seeded 'active' by migrate.js because the states they exist to show —
    // the wrap-up quick-reply pills, the "Propose to group" button on the
    // changes-ready card, the starter suggestions on an empty session —
    // render on an ACTIVE session and on nothing else. Their seed comment
    // stamps `last_activity_at = NOW()` to survive the first sweep, but that
    // only buys one auto-pause window: five minutes after a deploy every one
    // of them flips to 'paused' and a dozen dapp.json checks start asserting
    // against a screen that can no longer paint what they name. Nobody is
    // holding a worker for them (they were never dispatched), so exempting
    // them costs no capacity. The predicate is the branch prefix migrate.js
    // seeds them under, and it is gated on USERNODE_ENV so production's
    // sweep is byte-for-byte what it was.
    const exemptFixtures = process.env.USERNODE_ENV === 'staging';
    try {
      const { rows } = await pool.query(
        `SELECT id FROM chat_sessions
         WHERE status = 'active'
           AND active_turn IS NULL
           AND source IS DISTINCT FROM 'imported'
           AND last_activity_at < NOW() - make_interval(secs => $1::double precision / 1000.0)
           AND NOT ($2::boolean AND COALESCE(branch_name, '') LIKE 'staging-fixture/%')
         ORDER BY last_activity_at ASC
         LIMIT 50`,
        [config.sessionAutopauseIdleMs, exemptFixtures]
      );
      for (const row of rows) {
        if (activeWorkersSvc.isSessionBusy(row.id)) continue;
        try {
          await sessionLifecycle.pauseSession({ pool, sessionId: row.id, reason: 'auto-idle' });
        } catch (err) {
          log.warn('server', 'Auto-pause failed', { sessionId: row.id, err: err.message });
        }
      }
    } catch (err) {
      log.warn('server', 'Session auto-pause sweep failed', { err: err.message });
    }

    // Pass 2: staging GC. Reclaim the staging container + cloned DB from
    // sessions cold past the (much longer) staging-idle window. Skips
    // promoted/merging (their preview backs the group vote) and anything
    // mid-turn. Status is untouched — only the preview is reclaimed.
    //
    // #866: 'archived' is now IN scope. A withdrawn proposal keeps no vote
    // to back, so its container is pure waste — and imported proposals made
    // that leak routine: the build takes minutes, the author can withdraw
    // mid-build, and the post-build status re-check (pr-import-sync) only
    // tears down the container it built itself. Anything already running
    // when the withdrawal landed (or built by a process that then died)
    // stayed up forever, since the old filter excluded archived rows. The
    // in-flight guard below is what keeps this from racing a live build.
    if (config.stagingIdleTeardownMs && config.stagingIdleTeardownMs > 0) {
      try {
        const { rows } = await pool.query(
          `SELECT id FROM chat_sessions
           WHERE staging_container_id IS NOT NULL
             AND status NOT IN ('promoted', 'merging', 'merged')
             AND last_activity_at < NOW() - make_interval(secs => $1::double precision / 1000.0)
           ORDER BY last_activity_at ASC
           LIMIT 20`,
          [config.stagingIdleTeardownMs]
        );
        for (const row of rows) {
          if (activeWorkersSvc.isSessionBusy(row.id)) continue;
          // Never reclaim under a build that's still running in this process:
          // it would delete the container/DB the build is about to record,
          // leaving a staging_url pointing at nothing.
          if (stagingSvc.hasInFlightBuild(row.id)) continue;
          try {
            await sessionLifecycle.teardownStagingForSession({ pool, sessionId: row.id, reason: 'idle-gc' });
          } catch (err) {
            log.warn('server', 'Staging GC failed', { sessionId: row.id, err: err.message });
          }
        }
      } catch (err) {
        log.warn('server', 'Staging GC sweep failed', { err: err.message });
      }
    }

    // Stale active_turn watchdog: an active_turn row whose session is
    // not busy in-process is orphaned — in healthy operation dispatch
    // holds the warm-registry inFlight flag and the recovery flows hold
    // activeWorkers for their full duration, so no live consumer means
    // the process that owned the turn died (e.g. a crash between boot
    // adoption and finalize). Left alone it looks "working" forever and
    // (with Pass 1's active_turn guard) blocks auto-pause. Reap it:
    // clear the record, stamp the progress card [interrupted], tell the
    // user to retry, and notify like any other finished turn. The pure
    // reap/skip policy lives in services/turn-watchdog.js.
    try {
      const { rows } = await pool.query(
        // pr_number: a reaped TAIL row names the PR its work landed on.
        `SELECT id, user_id, app_id, pr_number, active_turn FROM chat_sessions
         WHERE active_turn IS NOT NULL
         ORDER BY (active_turn->>'startedAt') ASC NULLS FIRST
         LIMIT 20`
      );
      const nowMs = Date.now();
      const { broadcastGlobal } = require('./src/services/ws');
      for (const row of rows) {
        // cleanup_pending means all user-visible/economic work committed and
        // only the identity-safe clear remains. Complete it silently; never
        // narrate a false interruption or replay the tail.
        if (turnLifecycle.recoveryAction(row.active_turn) === 'cleanup') {
          const args = turnCleanupArgs(row.active_turn);
          const cleared = await worker.finishTurn(row.id, args);
          if (!cleared) {
            log.warn('server', 'Watchdog could not finish pending turn cleanup', {
              sessionId: row.id,
            });
          }
          continue;
        }
        const busy = activeWorkersSvc.isSessionBusy(row.id);
        // Cheap pre-filter (no docker probe): fresh or busy rows skip.
        if (turnWatchdog.classifyStaleTurn({
          activeTurn: row.active_turn, nowMs, busy, executing: false,
        }) !== 'reap') continue;
        // Only now pay for the container probe. A live (or unobservable)
        // detached exec is left strictly alone — boot recovery or the
        // next dispatch will consume its journal.
        const executing = await worker.isWorkerExecuting(worker.workerContainerName(row.id));
        const verdict = turnWatchdog.classifyStaleTurn({
          activeTurn: row.active_turn, nowMs, busy, executing,
        });
        if (verdict !== 'reap') {
          log.warn('server', 'Stale active_turn has a live/unobservable exec — leaving for recovery', {
            sessionId: row.id, executing, startedAt: row.active_turn?.startedAt || null,
          });
          continue;
        }
        try {
          const reapTail = (row.active_turn && typeof row.active_turn.tail === 'object'
            && row.active_turn.tail) || {};
          // A reaped TAIL row is a different animal from a reaped exec: the
          // agent's work is done and (usually) pushed, so the breadcrumb
          // must not ask for a resend. `phase` in the log tells an operator
          // which one they're looking at.
          const reapCodeLanded = !!reapTail.sha && reapTail.pushOk === true;
          log.warn('server', 'Reaping orphaned active_turn', {
            sessionId: row.id, startedAt: row.active_turn?.startedAt || null,
            phase: row.active_turn?.phase || 'exec', codeLanded: reapCodeLanded,
          });
          if (row.active_turn?.backend === 'codex_openrouter'
              && row.active_turn?.turnUuid) {
            const agentTurn = require('./src/services/agent-turn');
            try {
              await agentTurn.completeCodexAttempt({
                pool,
                turnUuid: row.active_turn.turnUuid,
                status: 'failed',
                errorCode: 'recovery_abandoned',
                errorDetail: 'Durable turn was abandoned after its worker became stale.',
                telemetryComponent: turnLifecycle.phaseOf(row.active_turn) === turnLifecycle.PHASE_DISPATCH_PENDING
                  ? null
                  : row.active_turn.telemetryComponent || null,
              });
            } catch (ledgerErr) {
              const disposition = await recoveryRetry.retainOrQuarantineRecoveryError({
                pool,
                sessionId: row.id,
                activeTurn: row.active_turn,
                error: ledgerErr,
              });
              log.error('server', disposition.action === 'retry'
                ? 'Stale Codex turn retained because ledger terminalization failed'
                : 'Stale Codex turn quarantined because its ledger attempt is missing', {
                sessionId: row.id, err: ledgerErr.message,
              });
              continue;
            }
          }
          const reaped = await worker.clearActiveTurn(row.id, turnCleanupArgs(row.active_turn));
          if (!reaped) {
            log.warn('server', 'Stale turn changed while watchdog was reaping it', {
              sessionId: row.id,
            });
            continue;
          }
          await appendTerminalProgressLine(pool, row.id, '[interrupted]');
          const msg = reapCodeLanded
            ? recoveryPills.buildCodeLandedBreadcrumb({
              prNumber: reapTail.prNumber || row.pr_number || null,
              // Nothing is rebuilding it here — the staging heal sweep owns
              // that, on its own schedule. Don't promise what this path
              // isn't doing.
              rebuildingPreview: false,
            })
            : recoveryPills.TURN_UNFINISHED_BREADCRUMB;
          // #786: retry pills on the breadcrumb — no wrap-up will run for
          // a reaped turn, so this row is the pill bar's only source.
          const reapPills = recoveryPills.buildRecoveryQuickReplies(
            reapCodeLanded ? 'code_done' : 'unrecoverable'
          );
          await pool.query(
            `INSERT INTO chat_session_messages (session_id, role, content, metadata)
             VALUES ($1, 'system', $2, $3)`,
            [row.id, msg, JSON.stringify({
              ...(reapPills ? { quickReplies: reapPills } : {}),
              recovered: true,
              recoveredReason: reapCodeLanded ? 'watchdog_reap_tail' : 'watchdog_reap',
              ...(reapCodeLanded ? { sha: reapTail.sha } : {}),
            })]
          ).catch(() => {});
          broadcastGlobal({
            type: 'session_event', sessionId: row.id, event: 'status', text: msg,
            quickReplies: reapPills || undefined,
          });
          // Same "the owner cannot have watched this finish" rationale as
          // the recovered-turn notify block in resumeDetachedTurn.
          try {
            const notifications = require('./src/services/notifications');
            await pool.query(
              `UPDATE chat_sessions SET notify_on_done = FALSE WHERE id = $1`,
              [row.id]
            ).catch(() => {});
            const created = await notifications.createSessionDoneNotification(pool, {
              userId: row.user_id, appId: row.app_id, sessionId: row.id,
            });
            if (created.length) await notifications.hydrateAndPush(pool, created[0]);
          } catch (err) {
            log.warn('server', 'stale-turn reap notify failed', { sessionId: row.id, err: err.message });
          }
        } catch (err) {
          log.warn('server', 'Stale active_turn reap failed', { sessionId: row.id, err: err.message });
        }
      }
    } catch (err) {
      log.warn('server', 'Stale active_turn watchdog sweep failed', { err: err.message });
    }

    // Pass 3: staging heal. The flip side of Pass 2 — rebuild the staging
    // preview for promoted/merging sessions whose preview is missing or
    // dead. Two shapes (see stagingNeedsRebuild): staging_url IS NULL
    // (GC'd before/after promotion → no Preview button, gated on
    // staging_url in app-view.js), OR staging_url set but the container
    // is gone (Preview renders but the iframe can't connect). Their
    // preview backs the group's PR vote, so either way it must come back.
    // recoverSessions() heals these on startup; this keeps them healed
    // live without a restart. We over-fetch candidates and gate each on a
    // cheap liveness check, rebuilding at most a few per sweep so healthy
    // previews are never rebuilt and the heavy (docker build + pg clone)
    // work stays bounded. Per-session cooldown so a persistently failing
    // build (missing secret, broken manifest) doesn't retry every tick.
    try {
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
         FROM chat_sessions cs
         JOIN apps a ON cs.app_id = a.id
         WHERE cs.status IN ('promoted', 'merging')
           AND cs.branch_name IS NOT NULL
         ORDER BY cs.promoted_at ASC NULLS FIRST
         LIMIT 50`
      );
      const MAX_HEALS_PER_SWEEP = 5;
      let healed = 0;
      for (const session of rows) {
        if (healed >= MAX_HEALS_PER_SWEEP) break;
        if (activeWorkersSvc.isSessionBusy(session.id)) continue;
        // #866: worker.isInFlight only covers agent turns. An imported
        // proposal's first staging build runs from the import path with no
        // worker attached, and it can take minutes — during which
        // staging_url is still NULL, so stagingNeedsRebuild() says "missing"
        // and this pass would start a second, concurrent build of the same
        // commit. hasInFlightBuild() is the flag that build sets.
        if (stagingSvc.hasInFlightBuild(session.id)) continue;
        if (!(await stagingRecovery.stagingNeedsRebuild(session, { config }))) continue;
        const last = stagingHealAttempts.get(session.id) || 0;
        if (Date.now() - last < STAGING_HEAL_COOLDOWN_MS) continue;
        // Stamp the attempt BEFORE the (minutes-long) build so a later
        // tick won't kick off a duplicate concurrent rebuild for the same
        // session while this one is still in flight.
        stagingHealAttempts.set(session.id, Date.now());
        healed++;
        try {
          const result = await stagingRecovery.rebuildSessionStaging({ config, pool, session, reason: 'heal' });
          if (result === 'built') stagingHealAttempts.delete(session.id);
        } catch (err) {
          log.warn('server', 'Staging heal failed', { sessionId: session.id, err: err.message });
        }
      }
    } catch (err) {
      log.warn('server', 'Staging heal sweep failed', { err: err.message });
    }

    // Pass 4: stuck-check reconcile (#447). The flip side of the merge gate
    // — a promoted PR whose proposal checks are NULL or stuck 'pending' past
    // CHECKS_STALE_MS is permanently blocked from merging ("still running its
    // tests") because nothing ever advances check_state out of 'pending'
    // after a restart mid-capture. Re-run the checks (rebuild staging if the
    // preview is gone, else recheck the live container) so legitimately-
    // passing PRs flip to 'passing' and become mergeable. Bounded per sweep
    // with a per-session cooldown, exactly like the staging-heal pass above;
    // the boot-time reconcileStuckChecks handles the restart case, this keeps
    // them healed live without a restart.
    try {
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
           FROM chat_sessions cs
           JOIN apps a ON cs.app_id = a.id
          WHERE cs.status = 'promoted'
            AND cs.branch_name IS NOT NULL
            AND (cs.check_state IS NULL
                 OR (cs.check_state = 'pending'
                     AND cs.checks_checked_at < NOW() - make_interval(secs => $1::double precision / 1000.0))
                 OR (cs.check_state = 'error'
                     AND cs.consecutive_check_failures < $2
                     AND cs.check_next_retry_at IS NOT NULL
                     AND cs.check_next_retry_at < NOW()))
          ORDER BY cs.promoted_at ASC NULLS FIRST
          LIMIT 50`,
        [CHECKS_STALE_MS, CHECK_MAX_AUTO_RETRIES]
      );
      const MAX_RECHECKS_PER_SWEEP = 5;
      let rechecked = 0;
      for (const session of rows) {
        if (rechecked >= MAX_RECHECKS_PER_SWEEP) break;
        if (activeWorkersSvc.isSessionBusy(session.id)) continue;
        const last = checkRecheckAttempts.get(session.id) || 0;
        if (Date.now() - last < STAGING_HEAL_COOLDOWN_MS) continue;
        // Stamp BEFORE the (minutes-long) recheck so a later tick won't kick
        // off a duplicate concurrent run for the same session.
        checkRecheckAttempts.set(session.id, Date.now());
        rechecked++;
        try {
          await stagingRecovery.recheckSessionChecks({ config, pool, session, reason: 'stuck-checks-sweep' });
        } catch (err) {
          log.warn('server', 'Stuck-check recheck failed', { sessionId: session.id, err: err.message });
        }
      }
    } catch (err) {
      log.warn('server', 'Stuck-check reconcile sweep failed', { err: err.message });
    }

    // Pass 5: orphaned dev-chat attachments GC (#450). An upload that was
    // never sent (message_id still NULL — the user removed it from the
    // composer, or navigated away) has no owner message to cascade from,
    // so reclaim its bytea after 24h. Linked rows live with their session.
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM chat_session_attachments
          WHERE message_id IS NULL
            AND created_at < NOW() - INTERVAL '24 hours'`
      );
      if (rowCount) log.info('server', 'GC\'d orphaned chat attachments', { count: rowCount });
    } catch (err) {
      log.warn('server', 'Orphaned-attachment sweep failed', { err: err.message });
    }

    // Pass 6: orphaned issue screenshots GC (#683). An upload whose
    // feedback modal was cancelled (issue_number still NULL — never
    // linked to a filed issue) has nothing referencing it, so reclaim
    // its bytea after 24h. Linked rows live forever with their issue.
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM issue_screenshots
          WHERE issue_number IS NULL
            AND created_at < NOW() - INTERVAL '24 hours'`
      );
      if (rowCount) log.info('server', 'GC\'d orphaned issue screenshots', { count: rowCount });
    } catch (err) {
      log.warn('server', 'Orphaned-screenshot sweep failed', { err: err.message });
    }

    // Same sweep for group-chat attachments (#694): uploads never linked
    // to a message (removed from the composer, or the tab was abandoned)
    // reclaim their bytea after 24h. Linked rows live with their message.
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM chat_message_attachments
          WHERE message_id IS NULL
            AND created_at < NOW() - INTERVAL '24 hours'`
      );
      if (rowCount) log.info('server', 'GC\'d orphaned group-chat attachments', { count: rowCount });
    } catch (err) {
      log.warn('server', 'Orphaned group-chat attachment sweep failed', { err: err.message });
    }

    // Staging app-file GC (#752): uploads made from staging previews
    // (bridge relay path, app_files.staging = TRUE) are test data and
    // reclaim their object-store bytes after 7 days. Object first, row
    // second — a row whose object delete failed is retried next sweep.
    try {
      const appFilesSvc = require('./src/services/app-files');
      const removed = await appFilesSvc.sweepStagingFiles(pool, appFilesSvc.getStore(config));
      if (removed) log.info('server', 'GC\'d expired staging app files', { count: removed });
    } catch (err) {
      log.warn('server', 'Staging app-file sweep failed', { err: err.message });
    }

    // Pass 6: imported-PR head sync (#687, Slice 3). For each live imported
    // row, fetch the PR's current head.sha and no-op on an unchanged head;
    // on a head change refresh its preview/checks (and, once promoted, reset
    // the vote tally). Reuses this sweeper's cadence
    // + a per-session cooldown (importedHeadSyncAttempts) so the added
    // getPR-per-open-imported-proposal cost stays bounded.
    try {
      const prImportSync = require('./src/services/pr-import-sync');
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
           FROM chat_sessions cs
           JOIN apps a ON cs.app_id = a.id
          WHERE cs.source = 'imported'
            AND cs.status IN ('active', 'promoted', 'merging')
            AND cs.pr_number IS NOT NULL
          ORDER BY cs.promoted_at ASC NULLS FIRST
          LIMIT 50`
      );
      const MAX_HEAD_SYNCS_PER_SWEEP = 10;
      let synced = 0;
      for (const session of rows) {
        if (synced >= MAX_HEAD_SYNCS_PER_SWEEP) break;
        if (worker.isInFlight(session.id)) continue;
        const last = importedHeadSyncAttempts.get(session.id) || 0;
        if (Date.now() - last < IMPORTED_HEAD_SYNC_COOLDOWN_MS) continue;
        // Stamp BEFORE the getPR (+ possible minutes-long rebuild) so a
        // later tick won't kick off a duplicate concurrent sync.
        importedHeadSyncAttempts.set(session.id, Date.now());
        synced++;
        try {
          await prImportSync.syncImportedProposal({ config, pool, session });
        } catch (err) {
          log.warn('server', 'Imported-PR head sync failed', { sessionId: session.id, err: err.message });
        }
      }
    } catch (err) {
      log.warn('server', 'Imported-PR head-sync sweep failed', { err: err.message });
    }

    // Pass 7: stale-env preview teardown (#851). The counterpart to Pass 3:
    // Pass 3 REBUILDS a stale preview that backs a live vote, this tears down
    // the stale rest (merged / abandoned / paused / session-gone), so the next
    // Preview click rebuilds with current env behind the existing loader.
    // Together they replace #850's one-off admin sweep.
    //
    // Throttled to its own long interval rather than given a timer of its
    // own — this sweeper already ticks, and a `docker ps` + teardown of a few
    // containers every 15 minutes has no business running every 60 seconds.
    // STAGING_STALE_SWEEP_INTERVAL_MS=0 disables it (the admin sweep stays).
    try {
      // The interval + "is it due" bookkeeping lives in the service, so this
      // tick and the boot run share one throttle. sweepStale never throws and
      // bounds its own work per pass.
      if (stagingReap.staleSweepDue()) {
        await stagingReap.sweepStale(config, { isInFlight: (id) => activeWorkersSvc.isSessionBusy(id) });
      }
    } catch (err) {
      log.warn('server', 'Stale-preview sweep failed', { err: err.message });
    }

    // Pass 8: orphaned staging-DATABASE reconciliation. Pass 7 (and every
    // other teardown path) only drops a staging DB alongside a matching
    // container; clones whose container is already gone used to accumulate
    // forever (3,479 DBs / 198 GB by 2026-07-30). This drops the ones no
    // session, build, or connection can reach anymore. Long interval (6h),
    // bounded batch, own throttle in the service; never throws.
    // STAGING_ORPHAN_DB_SWEEP_INTERVAL_MS=0 disables it.
    try {
      if (stagingReap.orphanDbSweepDue()) {
        await stagingReap.sweepOrphanDbs(config);
      }
    } catch (err) {
      log.warn('server', 'Orphan staging-DB sweep failed', { err: err.message });
    }
  }, config.sessionSweepIntervalMs).unref();
}

let governanceApplyTickerHandle = null;

// #1010: FAST governance-apply ticker.
//
// A governance proposal (rename / secret_change / close_issue /
// maintenance_campaign) can become mergeable purely through the passage of
// time — the threshold is met and the minimum visibility window runs out with
// no further vote to drive the apply. Before this ticker the ONLY thing that
// noticed was the hourly stale-PR sweeper's Pass 0b, so a close proposal whose
// countdown reached zero sat visibly decided-but-open for up to an hour. That
// is the dead air issue #1010 is about, and it is also what would make the
// client's derived "Closing issue…" spinner a lie — so the indicator and this
// ticker ship together.
//
// Deliberately narrower than Pass 0b in one way that matters: it is
// **gate-first for every kind**, including close_issue. Pass 0b dispatches
// close_issue rows UNCONDITIONALLY because maybeApplyCloseIssueProposal's
// superseded guard doubles as the catch-all for issues closed by hand on
// GitHub — and that guard costs a `fetchPublicIssues` per app. Replicating it
// at 60s cadence would mean a GitHub fetch per app per minute, so the
// superseded sweep STAYS hourly and this ticker only touches rows whose gate
// already says "apply me". Cost here is one small query plus a DB-only
// governedGate per open governance row.
//
// Its own interval + own enable knob (GOVERNANCE_APPLY_TICK_MS, 0 disables)
// so it is not silently switched off along with the stale-PR sweeper, which
// disables itself entirely when both PR_STALE_NOTIFY_MS and
// ARCHIVED_RETENTION_MS are zero.
function startGovernanceApplyTicker(config) {
  if (governanceApplyTickerHandle) return;
  const intervalMs = config.governanceApplyTickMs;
  if (!(intervalMs > 0)) {
    log.info('server', 'Governance-apply ticker disabled');
    return;
  }
  const pool = getPool(config);
  const issuesModule = require('./src/routes/issues');
  const governance = require('./src/services/governance');
  log.info('server', 'Governance-apply ticker started', { intervalMs });
  governanceApplyTickerHandle = setInterval(async () => {
    if (lifecycle.isShuttingDown()) return;
    try {
      const { rows } = await pool.query(
        `SELECT i.*, a.slug AS app_slug, a.repo_url,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'up')   AS up_count,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'down') AS down_count
           FROM issues i JOIN apps a ON a.id = i.app_id
          WHERE i.status = 'open' AND i.kind IN ('rename', 'secret_change', 'close_issue', 'maintenance_campaign')
          LIMIT 100`
      );
      for (const issue of rows) {
        try {
          // Gate-first for EVERY kind — see the header comment.
          const gate = await governance.governedGate(pool, issue.app_id, {
            kind: 'issue', id: issue.id, openedAt: issue.created_at,
          });
          if (!gate.mergeable) continue;
          // The apply helpers re-check the gate and lock the issue row
          // atomically, so this can never double-apply against a concurrent
          // vote, the hourly sweep, or another color's ticker.
          let result;
          if (issue.kind === 'close_issue') {
            result = await issuesModule.maybeApplyCloseIssueProposal(pool, issue);
          } else if (issue.kind === 'rename') {
            result = await issuesModule.maybeApplyRenameProposal(pool, issue);
          } else if (issue.kind === 'maintenance_campaign') {
            result = await issuesModule.maybeApplyMaintenanceCampaignProposal(config, pool, issue);
          } else {
            result = await issuesModule.maybeApplySecretChangeProposal(config, pool, issue);
          }
          if (result && (result.applied || result.superseded)) {
            log.info('server', 'Governance proposal applied by ticker', {
              issueId: issue.id, appId: issue.app_id, kind: issue.kind,
              applied: !!result.applied, superseded: !!result.superseded,
            });
          }
        } catch (err) {
          log.warn('server', 'Governance-apply tick failed for row', {
            issueId: issue.id, kind: issue.kind, err: err.message,
          });
        }
      }
    } catch (err) {
      log.warn('server', 'Governance-apply tick failed', { err: err.message });
    }
  }, intervalMs).unref();
}

let stalePrSweeperHandle = null;

// Stale-promoted-PR policy + reversible-archive hard GC.
//   Pass 1 (notify): a promoted PR with no voting interest for
//     PR_STALE_NOTIFY_MS gets its author a 'stale_pr' notification, and
//     we stamp stale_notified_at so the warning fires once.
//   Pass 2 (archive): if still untouched PR_STALE_GRACE_MS after that
//     warning, auto-archive it (reversible — keeps CC + branch).
//   Pass 3 (GC): archived sessions past ARCHIVED_RETENTION_MS get their
//     CC volume purged so memory stops occupying disk.
// "Interest" = the later of promoted_at and the newest vote; casting a
// vote clears stale_notified_at (see routes/votes.js), reviving the PR.
function startStalePrSweeper(config) {
  if (stalePrSweeperHandle) return;
  const notifyEnabled = config.prStaleNotifyMs > 0;
  const gcEnabled = config.archivedRetentionMs > 0;
  if (!notifyEnabled && !gcEnabled) {
    log.info('server', 'Stale-PR / archived-GC sweeper disabled');
    return;
  }
  const pool = getPool(config);
  const notifications = require('./src/services/notifications');
  log.info('server', 'Stale-PR / archived-GC sweeper started', {
    notifyMs: config.prStaleNotifyMs, graceMs: config.prStaleGraceMs,
    retentionMs: config.archivedRetentionMs, intervalMs: config.staleSweepIntervalMs,
  });
  const {
    checkAndMerge,
    reconcilePromotedSweepHead,
  } = require('./src/routes/votes');
  const issuesModule = require('./src/routes/issues');
  const governance = require('./src/services/governance');
  const appAdmins = require('./src/services/app-admins');
  stalePrSweeperHandle = setInterval(async () => {
    if (lifecycle.isShuttingDown()) return;

    // Pass 0: window-elapsed merges. A promoted PR can become mergeable
    // purely through the passage of time, with no further vote to drive
    // checkAndMerge — either the threshold path (eased Yes threshold met,
    // minimum visibility window elapses) or the lazy-consensus path (below
    // threshold but unopposed Yes lead, its count-based clock elapses —
    // silence is consent). This pass re-checks each promoted PR's gate and
    // fires the merge once its window has elapsed. Latency is bounded by
    // staleSweepIntervalMs (default 1h) — acceptable; see SPEC "Post-window
    // latency". checkAndMerge re-validates and claims atomically, so a
    // racing vote can't double-merge.
    try {
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug AS app_slug, a.repo_url, a.self_hosted AS app_self_hosted,
                (SELECT COUNT(*)::int FROM pr_votes pv
                  WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                    AND ${currentVotePredicateSql('pv', 'cs')}) AS yes_count,
                (SELECT COUNT(*)::int FROM pr_votes pv
                  WHERE pv.session_id = cs.id AND pv.vote = 'no'
                    AND ${currentVotePredicateSql('pv', 'cs')}) AS no_count
           FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
          WHERE cs.status = 'promoted' AND cs.is_headless = FALSE
            AND (cs.behind_main IS NULL OR cs.behind_main = 0)
          LIMIT 100`
      );
      for (const session of rows) {
        if (activeWorkersSvc.isSessionBusy(session.id)) continue;
        try {
          // Native PR branches can be updated outside Usernode. Refresh their
          // immutable reviewed revision before any timed governance decision,
          // including automatic rejection. Imported proposals retain their
          // existing imported-head synchronization behavior.
          const sweepRevision = await reconcilePromotedSweepHead({
            config, pool, session,
          });
          if (sweepRevision.blocked) {
            log.warn('server', 'Window-elapsed sweep skipped: native revision unavailable', {
              sessionId: session.id,
              transient: !!sweepRevision.transient,
              reason: sweepRevision.reason,
            });
            continue;
          }
          // #788: backfill the explicit-approval flag for never-classified
          // rows AND re-verify rows stored TRUE (a flag can go stale once
          // main moves or a sync rewrites the branch); FALSE rows are
          // skipped. All the policy lives in
          // services/app-admins.js sweepExplicitApproval.
          session.requires_explicit_approval =
            await appAdmins.sweepExplicitApproval(pool, session);
          // #646: governance-aware gate — honors the app's approver
          // policy + at-least-N mode (governance/electorate lookups are
          // TTL-cached in the service, so no per-app cache needed here).
          // #788: plus the no-timer modifier for an admins-changing
          // proposal, so the sweeper can never auto-merge one on a clock.
          const gate = await governance.governedGate(pool, session.app_id, {
            kind: 'pr', id: session.id,
            openedAt: session.promoted_at || session.created_at,
            explicitApproval: !!session.requires_explicit_approval,
            // Count only votes on the current immutable revision for both
            // imported and native GitHub-backed proposals.
            headSha: sweepRevision.headSha,
          });
          // Merge takes precedence: a row that just became mergeable should
          // merge, not reject. checkAndMerge re-confirms both gates atomically.
          if (gate.mergeable) {
            const result = await checkAndMerge(config, pool, session);
            if (result?.merged) {
              log.info('server', 'Window-elapsed PR merged by sweeper', {
                sessionId: session.id, yesCount: session.yes_count,
              });
            }
            continue;
          }
          // Auto-takedown: the rejection window has elapsed on a promoted PR
          // the group is voting down (No > Yes, under the keep-alive support
          // line). Reuse the real close/un-promote path (archiveSession),
          // then nudge clients to refetch /promoted so the row drops out (the
          // session_update 'archived' broadcast isn't wired to the vote panel).
          if (gate.rejectable) {
            const res = await sessionLifecycle.archiveSession({
              pool, sessionId: session.id, reason: 'auto-rejected',
            });
            if (res?.archived) {
              try {
                ws.pushVoteUpdate({
                  sessionId: session.id, appSlug: session.app_slug, merged: false,
                });
              } catch {}
              log.info('server', 'Promoted PR auto-rejected by sweeper', {
                sessionId: session.id,
                yesCount: session.yes_count, noCount: session.no_count,
              });
            }
          }
        } catch (err) {
          log.warn('server', 'Window-elapsed merge check failed', {
            sessionId: session.id, err: err.message,
          });
        }
      }
    } catch (err) {
      log.warn('server', 'Window-elapsed merge sweep failed', { err: err.message });
    }

    // Pass 0b: window-elapsed governance applies (rename + secret_change +
    // close_issue + maintenance_campaign). Same rationale as Pass 0 — an
    // open governance proposal
    // can satisfy both gates with no further vote. The apply helpers re-check
    // the gate and lock the issue row atomically, so this can't double-apply
    // against a vote. close_issue rows are dispatched UNCONDITIONALLY (not
    // just when mergeable): maybeApplyCloseIssueProposal runs its superseded
    // guard on every invocation, so the hourly sweep doubles as the catch-all
    // that retires proposals whose target was closed by hand on GitHub. The
    // guard reads the cached fetchPublicIssues — one cheap fetch per app.
    try {
      const { rows } = await pool.query(
        `SELECT i.*, a.slug AS app_slug, a.repo_url,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'up')   AS up_count,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'down') AS down_count
           FROM issues i JOIN apps a ON a.id = i.app_id
          WHERE i.status = 'open' AND i.kind IN ('rename', 'secret_change', 'close_issue', 'maintenance_campaign')
          LIMIT 100`
      );
      for (const issue of rows) {
        try {
          if (issue.kind === 'close_issue') {
            await issuesModule.maybeApplyCloseIssueProposal(pool, issue);
            continue;
          }
          // #646: governance-aware gate for issue-vote proposals too.
          const gate = await governance.governedGate(pool, issue.app_id, {
            kind: 'issue', id: issue.id, openedAt: issue.created_at,
          });
          if (!gate.mergeable) continue;
          if (issue.kind === 'rename') {
            await issuesModule.maybeApplyRenameProposal(pool, issue);
          } else if (issue.kind === 'maintenance_campaign') {
            await issuesModule.maybeApplyMaintenanceCampaignProposal(config, pool, issue);
          } else {
            await issuesModule.maybeApplySecretChangeProposal(config, pool, issue);
          }
        } catch (err) {
          log.warn('server', 'Window-elapsed governance apply failed', {
            issueId: issue.id, err: err.message,
          });
        }
      }
    } catch (err) {
      log.warn('server', 'Window-elapsed governance sweep failed', { err: err.message });
    }

    if (notifyEnabled) {
      // Pass 1: warn authors of quiet promoted PRs (once).
      try {
        const { rows } = await pool.query(
          `SELECT cs.id AS session_id, cs.user_id, cs.app_id, cs.pr_title, cs.pr_number,
                  a.slug AS app_slug, a.name AS app_name
           FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
           WHERE cs.status = 'promoted'
             AND cs.stale_notified_at IS NULL
             AND GREATEST(
                   COALESCE(cs.promoted_at, cs.created_at),
                   COALESCE((SELECT MAX(created_at) FROM pr_votes WHERE session_id = cs.id), cs.promoted_at, cs.created_at)
                 ) < NOW() - make_interval(secs => $1::double precision / 1000.0)
           LIMIT 50`,
          [config.prStaleNotifyMs]
        );
        for (const row of rows) {
          try {
            const inserted = await notifications.createStalePrNotification(pool, {
              userId: row.user_id, appId: row.app_id, sessionId: row.session_id,
            });
            await pool.query(`UPDATE chat_sessions SET stale_notified_at = NOW() WHERE id = $1`, [row.session_id]);
            if (inserted[0]) {
              ws.pushNotificationToUser(row.user_id, {
                type: 'notification_new',
                notification: notifications.serialize({
                  id: inserted[0].id, kind: 'stale_pr', read_at: null, created_at: inserted[0].created_at,
                  app_id: row.app_id, app_slug: row.app_slug, app_name: row.app_name,
                  chat_message_id: null, message_content: null,
                  session_id: row.session_id, pr_title: row.pr_title, pr_number: row.pr_number,
                  source_username: null, detail: null,
                }),
              });
            }
          } catch (err) {
            log.warn('server', 'Stale-PR notify failed', { sessionId: row.session_id, err: err.message });
          }
        }
      } catch (err) {
        log.warn('server', 'Stale-PR notify sweep failed', { err: err.message });
      }

      // Pass 2: archive PRs still untouched after the grace period.
      try {
        const { rows } = await pool.query(
          `SELECT id FROM chat_sessions
           WHERE status = 'promoted' AND stale_notified_at IS NOT NULL
             AND stale_notified_at < NOW() - make_interval(secs => $1::double precision / 1000.0)
           LIMIT 50`,
          [config.prStaleGraceMs]
        );
        for (const row of rows) {
          if (activeWorkersSvc.isSessionBusy(row.id)) continue;
          try {
            await sessionLifecycle.archiveSession({ pool, sessionId: row.id, reason: 'stale-pr' });
          } catch (err) {
            log.warn('server', 'Stale-PR archive failed', { sessionId: row.id, err: err.message });
          }
        }
      } catch (err) {
        log.warn('server', 'Stale-PR archive sweep failed', { err: err.message });
      }
    }

    if (gcEnabled) {
      // Pass 3: hard-GC archived CC volumes past the retention window.
      try {
        const { rows } = await pool.query(
          `SELECT id FROM chat_sessions
           WHERE status = 'archived' AND cc_purged = FALSE AND archived_at IS NOT NULL
             AND archived_at < NOW() - make_interval(secs => $1::double precision / 1000.0)
           LIMIT 50`,
          [config.archivedRetentionMs]
        );
        for (const row of rows) {
          try {
            await sessionLifecycle.purgeArchivedCc({ pool, sessionId: row.id });
          } catch (err) {
            log.warn('server', 'Archived CC GC failed', { sessionId: row.id, err: err.message });
          }
        }
      } catch (err) {
        log.warn('server', 'Archived CC GC sweep failed', { err: err.message });
      }
    }
  }, config.staleSweepIntervalMs).unref();
}

// Graceful shutdown: mark drain state so new chats/app-creates/builds get
// 503'd, wait up to DRAIN_TIMEOUT_MS for in-flight HTTP handlers to
// finish flushing DB writes, then exit.
//
// IMPORTANT: we deliberately do NOT force-remove worker containers here.
// Two reasons in the long-lived worker world:
//   - In-flight execs (workers in `activeWorkers`): killing them would
//     drop the user's turn mid-CC. Better to drain naturally; if the
//     drain times out the host-side `docker exec` child dies with us
//     and recoverActiveWorkers handles the orphan on restart.
//   - Warm-idle workers (NOT in `activeWorkers`): these are siblings
//     on the host Docker daemon, so they survive a `docker compose up`
//     redeploy of the server. Next boot's recoverActiveWorkers adopts
//     them as warm-idle, so the next dispatch is fast even across
//     production redeploys. The idle sweeper reclaims their memory in
//     steady state.
// Right-sized for deploys (#711): Docker SIGKILLs at stop_grace_period
// (docker-compose.yml, 10s), so the old 60s wait was unreachable dead
// time — and workers are deliberately restart-safe anyway (adopted by
// recoverActiveWorkers on the next boot), so waiting out a whole CC turn
// buys nothing. 5s is enough for in-flight HTTP handlers to flush DB
// writes while keeping the deploy cutover short. Must stay BELOW the
// compose stop_grace_period (tests/caddy-deploy-grace.test.js pins the
// relationship).
const DRAIN_TIMEOUT_MS = 5000;
// Budget for closing the pg pool after the handler drain (#767). Sits
// INSIDE the same compose stop_grace_period as DRAIN_TIMEOUT_MS —
// tests/caddy-deploy-grace.test.js pins DRAIN + POOL_CLOSE <= grace — so a
// pool that refuses to settle can never push the exit past the SIGKILL.
const POOL_CLOSE_TIMEOUT_MS = 1000;
let cleanupStarted = false;
// Set by start() once the listener is up. cleanup() runs at module scope,
// so both need to be reachable from here.
let httpServer = null;
let shutdownPool = null;

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  lifecycle.setShuttingDown();
  // Stop claiming push jobs immediately. The bounded drain runs in
  // parallel with HTTP/session draining and is awaited before pool close.
  const pushStop = mobilePush.stop({ timeoutMs: DRAIN_TIMEOUT_MS }).catch((err) => {
    log.warn('server', 'Mobile push shutdown failed', {
      code: typeof err?.code === 'string' ? err.code : 'unknown',
    });
  });

  // Stop accepting BEFORE draining. Caddy's apex proxy and the wildcard
  // forward_auth gate both hold-and-retry a refused dial for 30s
  // (Caddyfile, #711), so a connection refused during the drain is
  // re-dialled into the new container — strictly better than accepting a
  // request into a process that is about to exit. Idle keep-alives are
  // dropped at once; connections still serving a request get until the
  // drain deadline, then closeAllConnections cuts them so `close()` can
  // actually complete.
  if (httpServer) {
    try {
      httpServer.close(() => {});
      httpServer.closeIdleConnections?.();
      const cutoff = setTimeout(() => {
        try { httpServer.closeAllConnections?.(); } catch { /* already gone */ }
      }, DRAIN_TIMEOUT_MS);
      cutoff.unref?.();
      log.info('server', 'Listener closed to new connections', { timeoutMs: DRAIN_TIMEOUT_MS });
    } catch (err) {
      log.warn('server', 'Listener close failed', { err: err.message });
    }
  }
  if (sweeperHandle) {
    clearInterval(sweeperHandle);
    sweeperHandle = null;
  }
  if (sessionSweeperHandle) {
    clearInterval(sessionSweeperHandle);
    sessionSweeperHandle = null;
  }
  if (conversationAttachmentSweeperHandle) {
    clearInterval(conversationAttachmentSweeperHandle);
    conversationAttachmentSweeperHandle = null;
  }
  if (stalePrSweeperHandle) {
    clearInterval(stalePrSweeperHandle);
    stalePrSweeperHandle = null;
  }
  if (governanceApplyTickerHandle) {
    clearInterval(governanceApplyTickerHandle);
    governanceApplyTickerHandle = null;
  }

  const startingCount = getActiveWorkerCount();
  log.info('server', 'Shutdown initiated, draining handlers', {
    activeWorkers: startingCount, timeoutMs: DRAIN_TIMEOUT_MS,
  });

  const drained = await lifecycle.waitFor(() => getActiveWorkerCount() === 0, {
    timeoutMs: DRAIN_TIMEOUT_MS, intervalMs: 500,
  });

  if (!drained) {
    log.warn('server', 'Drain timeout — exiting; workers keep running and will be adopted on restart', {
      remaining: getActiveWorkerCount(),
    });
  } else if (startingCount > 0) {
    log.info('server', 'All handlers drained; worker containers persist across restart');
  }
  await pushStop;

  // Close the pg pool so in-flight queries settle instead of being severed
  // by process.exit(). Bounded: a pool that won't drain must not hold the
  // process past the SIGKILL deadline.
  if (shutdownPool) {
    const poolStartedAt = Date.now();
    // Deliberately NOT unref'd, unlike the drain cutoff above: this timer
    // is what guarantees forward progress to process.exit(0) when end()
    // never settles. Unref'ing it would let the loop drain empty and exit
    // implicitly instead, skipping the exit log. Cleared the moment the
    // race resolves so it holds the loop for at most POOL_CLOSE_TIMEOUT_MS.
    let poolTimer = null;
    try {
      await Promise.race([
        shutdownPool.end(),
        new Promise((resolve) => { poolTimer = setTimeout(resolve, POOL_CLOSE_TIMEOUT_MS); }),
      ]);
      log.info('server', 'Pool closed', { durationMs: Date.now() - poolStartedAt });
    } catch (err) {
      log.warn('server', 'Pool close failed', {
        err: err.message, durationMs: Date.now() - poolStartedAt,
      });
    } finally {
      if (poolTimer) clearTimeout(poolTimer);
    }
  }

  // Release the leader advisory lock LAST — only after draining — so the
  // standby color promotes and runs recovery (incl. orphan worker adoption)
  // against a quiesced process, not one still finishing a turn. Uses its
  // own dedicated pg connection, so the pool close above doesn't affect
  // it. (Process exit would release the session lock anyway; doing it
  // explicitly just hands off promptly.)
  if (leadership) {
    await leadership.stop().catch(() => {});
  }

  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
