'use strict';

const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { getPool } = require('../db/pool');
const { internalAuth, internalAuthPurpose } = require('../middleware/internal-auth');
const log = require('../services/logger');
const worker = require('../services/worker');
const docker = require('../services/docker');
const statusSvc = require('../services/status');
const debugAccess = require('../services/debug-access');
const github = require('../services/github');
// #945: the issue's Usernode-side Discussion thread, merged into the
// by-number issue response the worker's usernode-issues CLI prints.
const threadContext = require('../services/thread-context');
const { USERNODE_DOMAIN } = require('../services/caddy');
const appAccess = require('../services/app-access');
// #1037: shared draft-card creation (validation, de-dupe, insert, live
// push), also used by the Mayor's in-process draft_issue_report tool
// (src/routes/sessions.js). The ws / session-bus plumbing the draft card
// needs now lives inside that service.
const issueDraft = require('../services/issue-draft');
const platformJwt = require('../services/platform-jwt');

// On-demand-TLS gate for Caddy. Caddy GETs this before issuing a Let's
// Encrypt cert for a hostname it has never seen (see Caddyfile's
// `on_demand_tls { ask ... }`). We approve a host iff it maps to a real
// app row (`<slug>.<domain>`) or a live staging session whose stored
// staging_url is exactly that host (`<slug>--s<id>--<hash>.<domain>`).
// Everything else is refused so random `*.<domain>` probes can't burn
// Let's Encrypt issuance quota for the registered domain.
async function isKnownHost(pool, rawDomain) {
  const domain = String(rawDomain || '').trim().toLowerCase().replace(/:\d+$/, '');
  if (!domain) return false;
  // The apex is served by its own (non-on-demand) site, but allow it
  // defensively so a stray on-demand handshake for it never gets stuck.
  if (domain === USERNODE_DOMAIN) return true;

  const suffix = '.' + USERNODE_DOMAIN;
  if (!domain.endsWith(suffix)) return false;
  const label = domain.slice(0, -suffix.length);
  // Only single-level subdomains are routable (the wildcard matches one
  // label); reject anything with a further dot.
  if (!label || label.includes('.')) return false;

  // Production app: leftmost label is the app slug. (Staging labels carry
  // a `--s<id>--<hash>` suffix and so never collide with a real slug.)
  const appHit = await pool.query('SELECT 1 FROM apps WHERE slug = $1 LIMIT 1', [label]);
  if (appHit.rowCount) return true;

  // Staging preview: must match a session's current staging_url exactly,
  // so we don't vouch for stale (superseded) preview hostnames.
  const stagingHit = await pool.query(
    'SELECT 1 FROM chat_sessions WHERE staging_url = $1 LIMIT 1',
    ['https://' + domain]
  );
  return stagingHit.rowCount > 0;
}

// Worker → platform internal API surface.
//
// Mounted in server.js BEFORE the global authMiddleware so cookie auth
// doesn't apply. Auth is handled by the internalAuth middleware, which
// verifies a session-scoped JWT minted at warm-container bootstrap (see
// src/services/worker.js's mintWorkerJwt).
//
// These endpoints are the only path by which a worker container can
// affect anything outside its own filesystem. The worker carries no
// GitHub credentials at all — its sole write capability is whatever
// this router chooses to expose. Today:
//   - POST /api/internal/sessions/:id/push  →  git push the session's
//     canonical branch (looked up from the DB; the worker doesn't get
//     to pick).
//   - POST /api/internal/sessions/:id/pr    →  create a PR for the
//     session's canonical branch.
//
// Both endpoints are rate-limited per session to bound the blast
// radius of a runaway CC turn. A push storm at 60/min still gives us
// plenty of headroom for normal use (typical session pushes 1–5 times)
// while preventing 1000+/sec API hammering.

// ── Edge visibility gate (Caddy forward_auth) ─────────────────────────
//
// The Caddyfile's wildcard site forward_auths EVERY request to a child-
// app / staging subdomain here before proxying it to the app container.
// This closes the "direct <slug>.<domain> access isn't gated" hole for
// view-private apps: the platform UI checks were already in place, but
// anyone holding the URL could hit the container straight through Caddy.
//
// Decision tree (per request, in order):
//   1. host → slug (parseAppHost; staging previews inherit the prod
//      app's visibility). Unknown/unroutable host → 404.
//   2. view-public app → 200. This is the hot path: one 10s-TTL cached
//      lookup, no session work at all, so public apps stay ~zero-cost.
//   3. /__usernode_access callback → exchange a short-lived grant
//      (minted by the apex /__access/authorize route from the user's
//      real platform session) for a per-host scoped access cookie.
//   4. Scoped access cookie → verify + re-check membership → 200.
//   5. Platform iframe JWT (?token= query or x-usernode-token header,
//      the exact credential the shell already injects) → membership
//      check; header → 200 directly (API fetches always carry it);
//      query → 302-to-self that sets the scoped cookie so the page's
//      assets (which carry neither token nor header) pass too.
//   6. Nothing valid: browser GETs bounce to the apex authorize route
//      (which reads the existing session cookie — host-only, so it
//      never reaches subdomains directly); everything else gets the
//      same existence-hiding 404 the API routes use.
//
// The scoped cookie is a JWT bound to {host, appId, uid} — NOT the
// platform session token. Child apps run user-authored code, so the
// platform credential must never be readable on their hosts; the scoped
// cookie grants nothing beyond "may load this one host" and membership
// is still re-verified server-side on every request.
//
// Both the grant and the cookie are signed with EDGE_JWT_SECRET, an
// authority that exists nowhere but the platform process (see
// src/services/platform-jwt.js). They are distinguished by their `pur`
// claim, so a 120s grant cannot be replayed as a 12h cookie even though
// they share a key. Step 5's iframe token is a third authority again —
// the RS256 app-identity key, verified against the app whose host is
// being gated, so a token minted for another app cannot open this one.

const ACCESS_COOKIE = '__usernode_access';
// 12h, re-minted via authorize after expiry. The signer owns the TTL;
// mirrored here for the cookie's own maxAge.
const ACCESS_COOKIE_TTL_S = platformJwt.EDGE_COOKIE_TTL_S;
// Marker appended when we 302-to-self to set the cookie from an iframe
// token. If we see it again WITHOUT the cookie (cookies blocked), we
// serve the page anyway rather than redirect-looping — the app itself
// still auths via the token, only same-host asset caching degrades.
const RETRY_MARKER = '__ua';

function authorizeUrl(host, next) {
  return `https://${USERNODE_DOMAIN}/__access/authorize`
    + `?host=${encodeURIComponent(host)}&next=${encodeURIComponent(next)}`;
}

function parseUriQuery(uri) {
  try { return new URL('http://x' + uri).searchParams; } catch { return new URLSearchParams(); }
}

// `next` must be a same-host relative path — never absolute / protocol-
// relative — so the grant callback can't be used as an open redirect.
function safeNext(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

function internalRoutes(_config) {
  const router = Router();
  const pool = getPool(_config);

  router.get('/__caddy/access', async (req, res) => {
    const rawHost = req.headers['x-forwarded-host'] || req.headers.host;
    const method = String(req.headers['x-forwarded-method'] || 'GET').toUpperCase();
    const uri = typeof req.headers['x-forwarded-uri'] === 'string' && req.headers['x-forwarded-uri']
      ? req.headers['x-forwarded-uri'] : '/';
    try {
      const parsed = appAccess.parseAppHost(rawHost);
      if (!parsed) return res.status(404).send('Not found');
      const { slug, host } = parsed;

      const vis = await appAccess.getHostVisibility(pool, slug);
      if (!vis) return res.status(404).send('Not found');
      if (!vis.viewPrivate) return res.status(200).send('ok');

      const query = parseUriQuery(uri);

      // 3. Grant callback from the apex authorize route. Handled before
      // the cookie so a fresh grant always re-mints (cookie refresh).
      // This path never reaches the app container — deny responses are
      // copied to the client by forward_auth, which is exactly how the
      // Set-Cookie + redirect get out.
      if (uri.startsWith('/__usernode_access')) {
        const grant = platformJwt.orNull(
          () => platformJwt.verifyEdgeGrant(query.get('grant') || '')
        );
        if (grant && grant.host === host
            && grant.appId === vis.appId
            && await appAccess.isViewMember(pool, vis.appId, grant.uid)) {
          const cookieToken = platformJwt.signEdgeCookie({
            uid: grant.uid, appId: vis.appId, host,
          });
          res.cookie(ACCESS_COOKIE, cookieToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: ACCESS_COOKIE_TTL_S * 1000,
          });
          return res.redirect(302, safeNext(query.get('next')));
        }
        // Bad/expired grant: restart the dance rather than dead-ending.
        return res.redirect(302, authorizeUrl(host, safeNext(query.get('next'))));
      }

      // 4. Scoped access cookie.
      const cookiePayload = platformJwt.orNull(
        () => platformJwt.verifyEdgeCookie(req.cookies?.[ACCESS_COOKIE] || '')
      );
      if (cookiePayload && cookiePayload.host === host
          && cookiePayload.appId === vis.appId
          && await appAccess.isViewMember(pool, vis.appId, cookiePayload.uid)) {
        return res.status(200).send('ok');
      }

      // 5. Platform iframe JWT — the credential the shell injects on
      // iframe load (?token=) and that app frontends forward on fetches
      // (x-usernode-token). Same verification as the child apps' own
      // middleware (see app-conventions.md).
      const headerToken = typeof req.headers['x-usernode-token'] === 'string'
        ? req.headers['x-usernode-token'] : null;
      const queryToken = query.get('token');
      const iframeJwt = platformJwt.orNull(
        () => platformJwt.verifyAppIdentityToken(
          queryToken || headerToken || '', { appId: vis.appId }
        )
      );
      if (iframeJwt && Number.isInteger(iframeJwt.id)
          && await appAccess.isViewMember(pool, vis.appId, iframeJwt.id)) {
        // WebSocket handshakes can't follow redirects — the 302 cookie-set
        // dance below would kill the upgrade. forward_auth copies the
        // original request headers (including Upgrade/Sec-WebSocket-*), so
        // detect the handshake and allow it as-is (the WS carries ?token=
        // for the app's own auth). Sec-WebSocket-Key is checked too in case
        // an intermediary strips the hop-by-hop Upgrade header.
        const isWsUpgrade = String(req.headers.upgrade || '').toLowerCase() === 'websocket'
          || !!req.headers['sec-websocket-key'];
        if (!queryToken || isWsUpgrade || query.get(RETRY_MARKER) === '1') {
          // Header-credentialed fetch, WS upgrade, or cookie-set retry that
          // came back cookieless: allow this request as-is.
          return res.status(200).send('ok');
        }
        // Initial iframe document load: set the scoped cookie and bounce
        // back to the same URL (+ loop-breaker marker) so the page's
        // asset requests pass via the cookie.
        // The cookie is an edge credential regardless of which credential
        // earned it, so it is minted with the edge authority here too.
        const cookieToken = platformJwt.signEdgeCookie({
          uid: iframeJwt.id, appId: vis.appId, host,
        });
        res.cookie(ACCESS_COOKIE, cookieToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: ACCESS_COOKIE_TTL_S * 1000,
        });
        const sep = uri.includes('?') ? '&' : '?';
        return res.redirect(302, `${uri}${sep}${RETRY_MARKER}=1`);
      }

      // 6. No valid credential. Top-level document navigations to a
      // PRODUCTION app host (share links pasted into a browser) go to
      // the platform shell's chromeless view — the shell embeds the app
      // with a real iframe token, so the link works instead of ending
      // at the app container's own 401 (the authorize dance below only
      // satisfies THIS gate; the app never receives a token on a direct
      // visit). Sec-Fetch-Dest distinguishes the address-bar navigation
      // from iframe/asset/fetch loads, which — like staging previews
      // and older browsers that don't send the header — keep the
      // existing flow: browser GETs go authorize via the apex (where
      // the platform session cookie lives); everything else gets the
      // existence-hiding 404 the API surfaces use.
      const isDocNav = method === 'GET'
        && String(req.headers['sec-fetch-dest'] || '').toLowerCase() === 'document';
      if (isDocNav && parsed.label === slug) {
        return res.redirect(302, `https://${USERNODE_DOMAIN}/#app/${slug}/full`);
      }
      if (method === 'GET') {
        return res.redirect(302, authorizeUrl(host, uri));
      }
      return res.status(404).send('Not found');
    } catch (err) {
      // Fail closed: an error must never open a private app.
      log.error('internal-api', 'Caddy access check failed', {
        host: rawHost, err: err.message,
      });
      return res.status(503).send('unavailable');
    }
  });

  // Caddy on-demand-TLS permission check. Public (called by Caddy from
  // inside the Docker network, before any cert exists), GET, no side
  // effects. 200 authorizes issuance; 404 refuses. Keep it cheap — Caddy
  // caches the decision per host, and the lookups are single-row indexed
  // probes.
  router.get('/__caddy/ask', async (req, res) => {
    const domain = req.query.domain;
    try {
      const ok = await isKnownHost(pool, domain);
      if (ok) return res.status(200).send('ok');
      log.warn('internal-api', 'Caddy ask refused unknown host', { domain });
      return res.status(404).send('unknown host');
    } catch (err) {
      // Fail closed: a DB blip must not let arbitrary hosts mint certs.
      log.error('internal-api', 'Caddy ask check failed', { domain, err: err.message });
      return res.status(503).send('unavailable');
    }
  });

  const pushLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `session:${req.workerSession?.sessionId || 'anon'}`,
    handler: (req, res) => {
      log.warn('internal-api', 'Push proxy rate-limited', {
        sessionId: req.workerSession?.sessionId,
      });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });

  router.post(
    '/api/internal/sessions/:sessionId/push',
    internalAuthPurpose([platformJwt.PUR_WORKER_PUSH, platformJwt.PUR_WORKER]),
    pushLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        log.warn('internal-api', 'Session mismatch between JWT and route', {
          jwt: req.workerSession.sessionId, route: sessionId,
        });
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }

      let session;
      try {
        const { rows } = await pool.query(
          `SELECT cs.id, cs.branch_name, cs.status, a.repo_url
           FROM chat_sessions cs
           JOIN apps a ON a.id = cs.app_id
           WHERE cs.id = $1`,
          [sessionId]
        );
        if (!rows.length) {
          return res.status(404).json({ ok: false, code: 'session_not_found' });
        }
        session = rows[0];
      } catch (err) {
        log.error('internal-api', 'Session lookup failed', { sessionId, err: err.message });
        return res.status(500).json({ ok: false, code: 'db_error' });
      }

      if (!session.branch_name) {
        return res.status(400).json({ ok: false, code: 'no_branch' });
      }
      if (['closed', 'archived', 'merged', 'failed'].includes(session.status)) {
        return res.status(409).json({ ok: false, code: 'session_inactive', status: session.status });
      }

      // Defensive: re-confirm the repo is public before pushing. The
      // worker bootstrap guard catches most cases, but a user could
      // flip the repo to private mid-session. Keeping the worker's
      // push proxy public-only matches the import-time enforcement.
      const parsed = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!parsed) {
        return res.status(400).json({ ok: false, code: 'bad_repo_url' });
      }
      const [, owner, repo] = parsed;
      const privacy = await github.checkRepoPublic(owner, repo);
      if (!privacy.ok) {
        return res.status(502).json({ ok: false, code: privacy.code, message: privacy.message });
      }
      if (privacy.private) {
        return res.status(403).json({
          ok: false, code: 'private_repo',
          message: `${owner}/${repo} is private; Usernode supports public repos only.`,
        });
      }

      try {
        const { sha } = await worker.execPushFromWorker(sessionId, session.branch_name);
        return res.json({ ok: true, branch: session.branch_name, sha });
      } catch (err) {
        return res.status(502).json({
          ok: false,
          code: err.code || 'push_failed',
          message: err.message,
        });
      }
    }
  );

  // Read-only: list the session repo's OPEN GitHub issues. Backs the
  // worker's usernode-issues CLI (scout + build), giving Claude Code the
  // same list_github_issues capability the Mayor has in-process. Anonymous
  // public fetch with no credentials — caching, pagination, and PR-filtering
  // all live in github.fetchPublicIssues. GET because it mutates nothing;
  // accepts the session-scoped ISSUES_JWT via the same internalAuth gate.
  router.get(
    '/api/internal/sessions/:sessionId/issues',
    internalAuthPurpose([platformJwt.PUR_ISSUES_READ, platformJwt.PUR_WORKER]),
    pushLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        log.warn('internal-api', 'Session mismatch between JWT and route (issues)', {
          jwt: req.workerSession.sessionId, route: sessionId,
        });
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }

      let repoUrl = '';
      try {
        const { rows } = await pool.query(
          `SELECT a.repo_url
             FROM chat_sessions cs
             JOIN apps a ON a.id = cs.app_id
            WHERE cs.id = $1`,
          [sessionId]
        );
        if (!rows.length) {
          return res.status(404).json({ ok: false, code: 'session_not_found' });
        }
        repoUrl = rows[0].repo_url || '';
      } catch (err) {
        log.error('internal-api', 'Issues session lookup failed', { sessionId, err: err.message });
        return res.status(500).json({ ok: false, code: 'db_error' });
      }

      // Same .git-tolerant parse the push route uses. No repo → return the
      // well-formed empty-with-note shape so the agent gets a clean answer.
      const parsed = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!parsed) {
        return res.json({ ok: true, issues: [], truncatedList: false, note: 'no repo' });
      }
      const [, owner, repo] = parsed;
      // Clip verbose bodies for the agent's context — the cache carries
      // full bodies for the web route / Create-PR seeding (#158). The
      // marker names the CLI form that returns the full text on demand.
      const result = github.truncateIssueBodies(
        await github.fetchPublicIssues(owner, repo),
        (n) => `usernode-issues ${n}`
      );
      return res.json({ ok: true, ...result });
    }
  );

  // Read-only: fetch ONE GitHub issue with its FULL (untruncated) body and
  // BOTH of its discussion surfaces — the GitHub comment thread (#396) and
  // the issue's Usernode-side Discussion thread (#945). Backs the worker's
  // `usernode-issues <number>` CLI form — the escape hatch for bodies the
  // list route clips (#158) and the discussion the original post doesn't
  // carry. Same auth posture as the list route (session-scoped ISSUES_JWT,
  // both scout and build), and the session_mismatch guard is what scopes
  // the thread read to the agent's OWN app.
  // Always 200 with `{ ok: true, issue, comments, commentsTruncated,
  // usernodeThread?, usernodeThreadTruncated?, note?, commentsNote? }` once
  // the session checks pass — every fetcher/loader never throws and
  // resolves failure to a well-formed shape, so the CLI always prints
  // parseable JSON.
  router.get(
    '/api/internal/sessions/:sessionId/issues/:number',
    internalAuthPurpose([platformJwt.PUR_ISSUES_READ, platformJwt.PUR_WORKER]),
    pushLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        log.warn('internal-api', 'Session mismatch between JWT and route (issue)', {
          jwt: req.workerSession.sessionId, route: sessionId,
        });
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }

      let repoUrl = '';
      let appId = null;
      try {
        const { rows } = await pool.query(
          `SELECT a.repo_url, cs.app_id
             FROM chat_sessions cs
             JOIN apps a ON a.id = cs.app_id
            WHERE cs.id = $1`,
          [sessionId]
        );
        if (!rows.length) {
          return res.status(404).json({ ok: false, code: 'session_not_found' });
        }
        repoUrl = rows[0].repo_url || '';
        appId = rows[0].app_id;
      } catch (err) {
        log.error('internal-api', 'Issue session lookup failed', { sessionId, err: err.message });
        return res.status(500).json({ ok: false, code: 'db_error' });
      }

      // #945: the platform-side Discussion thread is keyed on the app, not
      // the repo — so it resolves even for a session whose app has no
      // parseable GitHub remote.
      const thread = await threadContext.loadIssueThread(pool, appId, req.params.number);
      const threadFields = thread.messages.length
        ? { usernodeThread: thread.messages, usernodeThreadTruncated: thread.truncated }
        : {};

      const parsed = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!parsed) {
        return res.json({ ok: true, issue: null, ...threadFields, note: 'no repo' });
      }
      const [, owner, repo] = parsed;
      // fetchPublicIssue validates the number itself ('bad issue number').
      // #396: merge the issue's comment thread (clipped) so the worker CLI
      // surfaces the discussion, not just the body. Both fetchers never
      // throw; `comments` is always an array and `commentsNote` carries a
      // comment-fetch failure independently of the issue's own `note`.
      const { issue, note } = await github.fetchPublicIssue(owner, repo, req.params.number);
      const rawComments = await github.fetchIssueComments(owner, repo, req.params.number);
      const { comments, truncated } = github.clipIssueComments(
        rawComments.comments, { wasTruncated: rawComments.truncated }
      );
      return res.json({
        ok: true,
        issue,
        comments,
        commentsTruncated: truncated,
        ...threadFields,
        ...(note ? { note } : {}),
        ...(rawComments.note ? { commentsNote: rawComments.note } : {}),
      });
    }
  );

  // Read-only: list this session's dev-chat file attachments (#450).
  // Backs the worker's usernode-attachments CLI (scout + build) so
  // Claude Code can discover user-attached files. Same auth posture as
  // the issues routes: session-scoped ISSUES_JWT via internalAuth, so
  // scout (which never gets WORKER_JWT) can still read. Metadata only —
  // bytes come from the sibling route below. Only linked (sent)
  // attachments are listed; pending uploads aren't context yet.
  router.get(
    '/api/internal/sessions/:sessionId/attachments',
    internalAuthPurpose([platformJwt.PUR_ISSUES_READ, platformJwt.PUR_WORKER]),
    pushLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        log.warn('internal-api', 'Session mismatch between JWT and route (attachments)', {
          jwt: req.workerSession.sessionId, route: sessionId,
        });
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }
      try {
        const { rows } = await pool.query(
          `SELECT id, kind, filename, content_type, size_bytes, meta, created_at
             FROM chat_session_attachments
            WHERE session_id = $1 AND message_id IS NOT NULL
            ORDER BY created_at ASC, id ASC`,
          [sessionId]
        );
        return res.json({
          ok: true,
          attachments: rows.map((r) => ({
            id: r.id, kind: r.kind, filename: r.filename,
            contentType: r.content_type, sizeBytes: r.size_bytes,
            meta: r.meta || null,
            createdAt: r.created_at,
          })),
        });
      } catch (err) {
        log.error('internal-api', 'Attachment list failed', { sessionId, err: err.message });
        return res.status(500).json({ ok: false, code: 'db_error' });
      }
    }
  );

  // Read-only: fetch ONE attachment's raw bytes (#450). Backs
  // `usernode-attachments <id> <outpath>` — the worker downloads an
  // image into its container and Reads it (Claude Code's Read tool
  // handles image files natively). Session-scoped like everything else
  // here: an id from another session 404s.
  router.get(
    '/api/internal/sessions/:sessionId/attachments/:attId',
    internalAuthPurpose([platformJwt.PUR_ISSUES_READ, platformJwt.PUR_WORKER]),
    pushLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        log.warn('internal-api', 'Session mismatch between JWT and route (attachment)', {
          jwt: req.workerSession.sessionId, route: sessionId,
        });
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }
      const attId = String(req.params.attId || '');
      if (!/^[a-f0-9]{32}$/.test(attId)) {
        return res.status(404).json({ ok: false, code: 'not_found' });
      }
      try {
        const { rows } = await pool.query(
          `SELECT content_type, data FROM chat_session_attachments
            WHERE id = $1 AND session_id = $2`,
          [attId, sessionId]
        );
        if (!rows.length) return res.status(404).json({ ok: false, code: 'not_found' });
        res.set('Content-Type', rows[0].content_type || 'application/octet-stream');
        res.set('X-Content-Type-Options', 'nosniff');
        return res.send(rows[0].data);
      } catch (err) {
        log.error('internal-api', 'Attachment fetch failed', { sessionId, attId, err: err.message });
        return res.status(500).json({ ok: false, code: 'db_error' });
      }
    }
  );

  // PR creation endpoint. Today's `git push` path doesn't strictly
  // need a worker-callable PR endpoint (the platform's sessions route
  // creates PRs as part of the per-turn finalization flow), but
  // exposing it here closes the last hole where the worker would need
  // a token to do something cross-cutting. It's a thin wrapper around
  // github.createPR; same per-session auth + rate limit as push.
  router.post(
    '/api/internal/sessions/:sessionId/pr',
    internalAuth,
    pushLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }

      const { title, body } = req.body || {};
      if (typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ ok: false, code: 'bad_title' });
      }

      let session;
      try {
        const { rows } = await pool.query(
          `SELECT cs.id, cs.branch_name, cs.status, a.repo_url
           FROM chat_sessions cs
           JOIN apps a ON a.id = cs.app_id
           WHERE cs.id = $1`,
          [sessionId]
        );
        if (!rows.length) return res.status(404).json({ ok: false, code: 'session_not_found' });
        session = rows[0];
      } catch (err) {
        return res.status(500).json({ ok: false, code: 'db_error', message: err.message });
      }

      if (!session.branch_name) {
        return res.status(400).json({ ok: false, code: 'no_branch' });
      }
      const parsed = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!parsed) return res.status(400).json({ ok: false, code: 'bad_repo_url' });
      const [, owner, repo] = parsed;

      try {
        const pr = await github.createPR(owner, repo, {
          branch: session.branch_name,
          title,
          body: body || '',
        });
        return res.json({ ok: true, number: pr.number, url: pr.html_url });
      } catch (err) {
        log.warn('internal-api', 'PR create via worker proxy failed', {
          sessionId, owner, repo, err: err.message,
        });
        return res.status(502).json({ ok: false, code: 'pr_failed', message: err.message });
      }
    }
  );

  // ── Platform-issue escalation valve (build-turn coding agent) ─────────
  //
  // The worker can only edit + push ITS OWN app repo. Some blockers live
  // outside it — the shared bridge, wallet / native WebView, the
  // staging/preview pipeline, the checks gate. When the build-turn agent
  // is confident the root cause is platform-level (rather than looping on
  // a fix it structurally cannot make), it calls this to DRAFT a report.
  // Backs the worker's usernode-report-platform-issue CLI (WORKER_JWT,
  // build-only).
  //
  // Human-gated: this endpoint files NOTHING on GitHub. It persists a
  // pending draft as a system row in the session timeline (metadata.
  // platformIssueDraft) and pushes a live session event so the dev-chat
  // UI renders a card with "Report to platform" / "Dismiss" buttons. The
  // actual GitHub issue is only created when a user taps confirm — see
  // POST /api/sessions/:id/platform-issue/:msgId/confirm in
  // src/routes/sessions.js.
  //
  // Guardrails: session-scoped auth (like push/pr), a hard per-session
  // rate cap, and a normalised-title de-dupe against open agent reports
  // AND this session's earlier drafts, so a stuck turn can't spam either
  // the tracker or the timeline.
  const platformIssueLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `session:${req.workerSession?.sessionId || 'anon'}`,
    handler: (req, res) => {
      log.warn('internal-api', 'Platform-issue proxy rate-limited', {
        sessionId: req.workerSession?.sessionId,
      });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });

  router.post(
    '/api/internal/sessions/:sessionId/platform-issue',
    // Drafting an issue mutates platform state. The read-only Codex scout
    // token must never authorize it; only the general Claude worker token
    // used by build-capable sessions may reach this route.
    internalAuthPurpose([platformJwt.PUR_WORKER]),
    platformIssueLimiter,
    async (req, res) => {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ ok: false, code: 'bad_session_id' });
      }
      if (req.workerSession.sessionId !== sessionId) {
        return res.status(403).json({ ok: false, code: 'session_mismatch' });
      }

      // All the real work (validation, destination resolution, both
      // de-dupes, the insert, the live push) lives in the shared service
      // so the Mayor's draft_issue_report tool cannot drift from the
      // agent's CLI. This route only maps the result object back onto the
      // HTTP contract `worker/usernode-report-platform-issue` expects.
      // The agent CLI always targets the PLATFORM repo — an app-repo
      // issue is something the agent would just fix in its own repo.
      const result = await issueDraft.createDraft(pool, _config, {
        sessionId,
        title: req.body?.title,
        body: req.body?.body,
        target: 'platform',
        source: 'agent',
      });

      if (result.ok) return res.json(result);

      const status = {
        bad_title: 400,
        title_too_long: 400,
        body_too_long: 400,
        session_not_found: 404,
        rate_limited: 429,
        not_configured: 503,
        no_repo: 500,
        db_error: 500,
      }[result.code] || 500;
      // Preserve the historical codes for the two config failures — the
      // CLI surfaces the raw body in its __USERNODE_WARN__ line and these
      // strings are what an operator greps for.
      const code = result.code === 'not_configured'
        ? 'github_unconfigured'
        : (result.code === 'no_repo' ? 'no_platform_repo' : result.code);
      return res.status(status).json({ ok: false, code });
    }
  );

  // ── Prod-debug surface (#616) ─────────────────────────────────────────
  //
  // Read-only production access for the usernode-debug worker CLI. Only
  // reachable with a purpose-bound PROD_DEBUG_JWT (worker.mintProdDebugJwt
  // — carries `worker:prod-debug` plus the `prod_debug: true` claim), which
  // the dispatch path mints solely
  // for build/scout turns of admin-owned sessions on the self-edit app.
  // The guard below ALSO re-checks eligibility in the DB on every request
  // so revoking admin (or the session moving off the self-edit app) cuts
  // access immediately despite the JWT's 24h TTL. Everything here is a
  // read: SQL runs under the deny-listed usernode_debug_ro role
  // (services/debug-access.js), docker access is `logs`/`ps` against an
  // allowlist — no write or exec path exists.
  const debugLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `session:${req.workerSession?.sessionId || 'anon'}`,
    handler: (req, res) => {
      log.warn('internal-api', 'Prod-debug rate-limited', {
        sessionId: req.workerSession?.sessionId,
      });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });
  const prodDebugAuth = internalAuthPurpose([platformJwt.PUR_PROD_DEBUG]);

  const requireProdDebug = async (req, res, next) => {
    const sessionId = parseInt(req.params.sessionId, 10);
    if (!Number.isFinite(sessionId)) {
      return res.status(400).json({ ok: false, code: 'bad_session_id' });
    }
    if (req.workerSession.sessionId !== sessionId) {
      log.warn('prod-debug', 'Session mismatch between JWT and route', {
        jwt: req.workerSession.sessionId, route: sessionId,
      });
      return res.status(403).json({ ok: false, code: 'session_mismatch' });
    }
    if (!req.workerSession.prodDebug) {
      log.warn('prod-debug', 'Rejected token without prod_debug claim', { sessionId });
      return res.status(403).json({ ok: false, code: 'not_prod_debug' });
    }
    let check;
    try {
      check = await debugAccess.checkSessionEligibility(pool, sessionId);
    } catch (err) {
      log.error('prod-debug', 'Eligibility check failed', { sessionId, err: err.message });
      return res.status(500).json({ ok: false, code: 'db_error' });
    }
    if (!check.found) return res.status(404).json({ ok: false, code: 'session_not_found' });
    if (!check.eligible) {
      log.warn('prod-debug', 'Rejected ineligible session', {
        sessionId, selfHosted: check.selfHosted, isAdmin: check.isAdmin,
      });
      return res.status(403).json({ ok: false, code: 'not_eligible' });
    }
    // Audit trail: every prod-debug call, before it executes, with the
    // owner it's attributed to. Route handlers add call-specific detail
    // (the SQL text, the container name) on top.
    req.prodDebug = { sessionId, ownerId: check.ownerId };
    log.info('prod-debug', 'Prod-debug call', {
      sessionId, ownerId: check.ownerId, method: req.method, path: req.path,
    });
    next();
  };

  // Read-only SQL against the platform DB via the usernode_debug_ro
  // role. Deny-listed tables/columns error at the Postgres-grant layer;
  // writes are impossible (role-level default_transaction_read_only + no
  // write grants). Postgres errors are surfaced verbatim so the agent
  // can self-correct its query.
  router.post(
    '/api/internal/sessions/:sessionId/prod-debug/sql',
    prodDebugAuth,
    debugLimiter,
    requireProdDebug,
    async (req, res) => {
      const query = typeof req.body?.query === 'string' ? req.body.query : '';
      // Audit the query text itself (redacted) before executing, so even
      // failed/unavailable attempts are on the record.
      log.info('prod-debug', 'SQL query', {
        sessionId: req.prodDebug.sessionId,
        ownerId: req.prodDebug.ownerId,
        query: log.redactString(query.slice(0, 2000)),
      });
      if (!query.trim()) {
        return res.status(400).json({ ok: false, code: 'bad_query' });
      }
      try {
        const result = await debugAccess.runQuery(query, { config: _config });
        return res.json({
          ok: true,
          rows: result.rows,
          rowCount: result.rowCount,
          truncated: result.truncated,
        });
      } catch (err) {
        if (err.code === 'unavailable') {
          return res.status(503).json({ ok: false, code: 'unavailable', message: err.message });
        }
        if (err.code === 'bad_query') {
          return res.status(400).json({ ok: false, code: 'bad_query', message: err.message });
        }
        // Postgres-level error (syntax, permission denied on a denied
        // column, read-only violation, timeout) — a 200-with-error so the
        // CLI prints something the agent can act on.
        return res.json({ ok: false, code: 'query_error', message: log.redactString(err.message || '') });
      }
    }
  );

  // Container inventory: `docker ps -a` + `docker stats` summaries via
  // the status service's existing helpers.
  router.get(
    '/api/internal/sessions/:sessionId/prod-debug/containers',
    prodDebugAuth,
    debugLimiter,
    requireProdDebug,
    async (req, res) => {
      try {
        const [containers, stats] = await Promise.all([
          statusSvc.listContainers(_config),
          statusSvc.getStats(_config),
        ]);
        return res.json({
          ok: true,
          containers: containers.map((c) => ({
            ...c,
            mem: stats[c.name]?.mem || null,
            cpu: stats[c.name]?.cpu || null,
          })),
        });
      } catch (err) {
        log.error('prod-debug', 'Container list failed', {
          sessionId: req.prodDebug.sessionId, err: err.message,
        });
        return res.status(500).json({ ok: false, code: 'docker_error' });
      }
    }
  );

  // Recent log lines from ONE allowlisted container. Output is capped
  // and passed through the logger's secret scrubber — the platform's own
  // stdout is already redacted at write time, but child-app logs are
  // not, so redact here as defense in depth.
  router.get(
    '/api/internal/sessions/:sessionId/prod-debug/logs/:container',
    prodDebugAuth,
    debugLimiter,
    requireProdDebug,
    async (req, res) => {
      const name = String(req.params.container || '');
      if (!debugAccess.isAllowedLogContainer(name)) {
        return res.status(400).json({ ok: false, code: 'bad_container' });
      }
      const tail = debugAccess.clampTail(req.query.tail);
      log.info('prod-debug', 'Container logs read', {
        sessionId: req.prodDebug.sessionId, container: name, tail,
      });
      try {
        const { stdout, stderr } = await docker.execFileAsync('docker', [
          'logs', '--tail', String(tail), name,
        ], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
        // docker writes the container's stderr stream to its own stderr;
        // both are log content here.
        let text = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`;
        let truncated = false;
        if (text.length > debugAccess.MAX_LOG_BYTES) {
          text = text.slice(-debugAccess.MAX_LOG_BYTES);
          truncated = true;
        }
        return res.json({
          ok: true, container: name, tail, truncated,
          logs: log.redactString(text),
        });
      } catch (err) {
        return res.status(404).json({
          ok: false, code: 'container_unavailable',
          message: log.redactString(String(err.message || '')),
        });
      }
    }
  );

  // Platform health snapshot: the admin /status payload (stuck sessions,
  // warm workers, staging, budgets, deploy state) plus the recent
  // redacted platform log ring.
  router.get(
    '/api/internal/sessions/:sessionId/prod-debug/status',
    prodDebugAuth,
    debugLimiter,
    requireProdDebug,
    async (req, res) => {
      try {
        const payload = await statusSvc.gather(_config, { isAdmin: true });
        return res.json({ ok: true, status: payload, recentLog: log.tail(100) });
      } catch (err) {
        log.error('prod-debug', 'Status snapshot failed', {
          sessionId: req.prodDebug.sessionId, err: err.message,
        });
        return res.status(500).json({ ok: false, code: 'status_error' });
      }
    }
  );

  return router;
}

module.exports = { internalRoutes, isKnownHost };
