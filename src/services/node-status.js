// Lightweight probe over the sidecar Usernode `GET /status` endpoint, plus
// an explorer `GET /active_chain` probe.
//
// Pattern is copied from `examples/lib/dapp-server.js::createNodeStatusProbe`
// in the usernode-dapp-starter repo. Same single-poller-many-readers
// model: one Node process polls the sidecar + explorer on a self-adapting
// cadence, every other consumer (status dashboard, public /api/node-status,
// etc.) just reads the cached snapshot. Without this, every connected tab
// would do its own sidecar/explorer request — N tabs ≠ N upstream requests.
//
// Two snapshot shapes are exposed:
//
//   get()      → just the node fields (used by /api/node-status and the
//                summary card on the main /status page)
//
//   getFull()  → dapp-server-shaped snapshot with `server`, `node`,
//                `explorer`, and `services` (chain-poller +
//                genesis-accounts state). Powers the full
//                /node-status viewer page.
//
// Node fields (snapshot from sidecar /status):
//   status:           "Synced" | "Syncing" | "Connected" | "Connecting"
//                    | "unreachable" | "unknown" | "mock"
//   peers:            number of connected peers
//   bestTipHeight:    our local tip's block height
//   peerBestTipHeight: max best_tip_height across connected peers
//   hasBeenSynced:    latched true once we ever observe Synced. Lets the
//                     UI distinguish "fresh boot, still catching up" from
//                     "node is fine, just applying new tip blocks".
//   hasFullUtxoDb:    parsed from `node.flags`. False here means the
//                     sidecar's recent-tx stream may silently drop tx
//                     from non-tracked senders (PARTIAL_LEDGER bug).
//   error:            last error message if `status === "unreachable"`
//   at:               Date.now() of last successful update
//
// Explorer fields (snapshot from explorer /active_chain):
//   status:    "ok" | "unreachable" | "bad_response" | "unknown" | "mock"
//   host:      configured upstream
//   chainId:   chain_id from /active_chain (when ok)
//   latencyMs: round-trip time of last probe
//   error:     last error message if not ok
//   hasBeenOk: latched true once we ever observe ok
//   consecutiveFailures: probes that have failed back-to-back (0 when ok)
//   downSince: Date.now() of the FIRST failure in the current streak, or
//              null when the explorer is reachable. The status pages turn
//              this into "unreachable for 2h" — without it a blip and a
//              day-long outage render identically.
//   at:        Date.now() of last update

const https = require('https');
const http = require('http');
const log = require('./logger');

// `usernode-node` is the docker compose service name (see docker-compose.yml).
// In local dev (no sidecar), the snapshot stays "unknown" forever and the
// dashboard renders an explicit "no NODE_RPC_URL configured" hint instead
// of pretending the node is broken.
const DEFAULT_NODE_RPC_URL = process.env.NODE_RPC_URL || null;

// Match the chain-poller / genesis-accounts defaults — same upstream, same
// HTTP/HTTPS rule (private IPs go HTTP, public hostnames go HTTPS).
const EXPLORER_UPSTREAM = process.env.EXPLORER_UPSTREAM || 'testnet-explorer.usernodelabs.org';
const EXPLORER_UPSTREAM_BASE = process.env.EXPLORER_UPSTREAM_BASE || '/api';
const EXPLORER_USE_HTTP = process.env.EXPLORER_USE_HTTP === 'true';

// Cadence — fast during boot so the dashboard sees the
// Connecting → Connected → Syncing → Synced transitions, slow once
// Synced so we don't spam the sidecar in steady state.
const BOOT_INTERVAL_MS = 500;
const STEADY_INTERVAL_MS = 2000;

const startedAtMs = Date.now();

let nodeSnapshot = {
  status: 'unknown',
  peers: 0,
  bestTipHeight: null,
  peerBestTipHeight: null,
  hasBeenSynced: false,
  hasFullUtxoDb: null,
  error: null,
  at: Date.now(),
};

let explorerSnapshot = {
  status: 'unknown',
  host: EXPLORER_UPSTREAM,
  chainId: null,
  latencyMs: null,
  error: null,
  hasBeenOk: false,
  // How many probes in a row have failed, and when the streak began. The
  // status pages render these as "unreachable for 2h" — without them a
  // one-off blip and a day-long outage look identical.
  consecutiveFailures: 0,
  downSince: null,
  at: Date.now(),
};

// Streak accounting for the explorer probe. Mirrors the same two fields
// chain-poller and genesis-accounts now expose, so all three read the same
// way on /status and /node-status.
function explorerFailure() {
  const failures = explorerSnapshot.consecutiveFailures + 1;
  return {
    consecutiveFailures: failures,
    downSince: explorerSnapshot.downSince || Date.now(),
  };
}

let nodeRpcUrl = null;
let timer = null;
let started = false;
let lastLoggedNodeStatus = 'unknown';
let lastLoggedExplorerStatus = 'unknown';

function explorerBase() {
  const isPrivate = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01]))/.test(EXPLORER_UPSTREAM);
  const proto = EXPLORER_USE_HTTP || isPrivate ? 'http' : 'https';
  return `${proto}://${EXPLORER_UPSTREAM}${EXPLORER_UPSTREAM_BASE}`;
}

function httpJson(method, urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method,
      // Hard timeout — the sidecar's /status is normally <50ms; if it
      // takes >5s something is genuinely wrong and we want to surface
      // that as `unreachable` instead of stalling the polling loop.
      timeout: 5000,
      headers: { accept: 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('request timeout (5000ms)'));
    });
    req.end();
  });
}

function logNodeStatusChange(newStatus, errMsg) {
  if (newStatus === lastLoggedNodeStatus) return;
  lastLoggedNodeStatus = newStatus;
  if (errMsg) log.info('node-status', `node -> ${newStatus} (${errMsg})`);
  else log.info('node-status', `node -> ${newStatus}`);
}

function logExplorerStatusChange(newStatus, errMsg) {
  if (newStatus === lastLoggedExplorerStatus) return;
  lastLoggedExplorerStatus = newStatus;
  if (errMsg) log.info('node-status', `explorer -> ${newStatus} (${errMsg})`);
  else log.info('node-status', `explorer -> ${newStatus}`);
}

async function tickNode() {
  if (!nodeRpcUrl) return;

  try {
    const data = await httpJson('GET', `${nodeRpcUrl}/status`);
    const status = (data && typeof data.node_sync_status === 'string')
      ? data.node_sync_status
      : 'unknown';

    const peerInfos = (data && Array.isArray(data.peers)) ? data.peers : [];
    const connectedPeers = peerInfos.filter(
      (p) => p && p.connection_status === 'Connected',
    );

    let peerBestTipHeight = null;
    for (const p of connectedPeers) {
      const h = p && p.best_tip_height;
      if (typeof h === 'number' && (peerBestTipHeight == null || h > peerBestTipHeight)) {
        peerBestTipHeight = h;
      }
    }

    const ourTipHeight = (data && data.blockchain && data.blockchain.best_tip
      && typeof data.blockchain.best_tip.height === 'number')
      ? data.blockchain.best_tip.height
      : null;

    // Parse `node.flags` (e.g. "HAS_FULL_UTXO_DB | HAS_FULL_IDENTITY_DB")
    // for the partial-ledger downgrade signal. Absence means the sidecar
    // is operating in partial mode — see the upstream comment in
    // dapp-server.js for the full failure mode.
    const flagsStr = (data && data.node && typeof data.node.flags === 'string')
      ? data.node.flags
      : '';
    const hasFullUtxoDb = flagsStr ? flagsStr.includes('HAS_FULL_UTXO_DB') : null;

    const hasBeenSynced = nodeSnapshot.hasBeenSynced || status === 'Synced';

    nodeSnapshot = {
      status,
      peers: connectedPeers.length,
      bestTipHeight: ourTipHeight,
      peerBestTipHeight,
      hasBeenSynced,
      hasFullUtxoDb,
      error: null,
      at: Date.now(),
    };
    logNodeStatusChange(status, null);
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    nodeSnapshot = {
      status: 'unreachable',
      peers: 0,
      bestTipHeight: null,
      peerBestTipHeight: null,
      hasBeenSynced: nodeSnapshot.hasBeenSynced,
      hasFullUtxoDb: nodeSnapshot.hasFullUtxoDb,
      error: errMsg,
      at: Date.now(),
    };
    logNodeStatusChange('unreachable', errMsg);
  }
}

// Independent of node probe — the explorer is a separate service (different
// host, different failure mode) and the dashboard surfaces it as its own
// card. Latches `hasBeenOk` so the loader/UI can apply
// trust-after-first-ok semantics if it wants.
async function tickExplorer() {
  const url = `${explorerBase()}/active_chain`;
  const startedAt = Date.now();
  try {
    const data = await httpJson('GET', url);
    const chainId = (data && typeof data.chain_id === 'string') ? data.chain_id : null;
    if (!chainId) {
      explorerSnapshot = {
        status: 'bad_response',
        host: EXPLORER_UPSTREAM,
        chainId: null,
        latencyMs: Date.now() - startedAt,
        error: 'missing chain_id in /active_chain response',
        hasBeenOk: explorerSnapshot.hasBeenOk,
        ...explorerFailure(),
        at: Date.now(),
      };
      logExplorerStatusChange('bad_response', explorerSnapshot.error);
      return;
    }
    explorerSnapshot = {
      status: 'ok',
      host: EXPLORER_UPSTREAM,
      chainId,
      latencyMs: Date.now() - startedAt,
      error: null,
      hasBeenOk: true,
      consecutiveFailures: 0,
      downSince: null,
      at: Date.now(),
    };
    logExplorerStatusChange('ok', null);
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    explorerSnapshot = {
      status: 'unreachable',
      host: EXPLORER_UPSTREAM,
      chainId: null,
      latencyMs: null,
      error: errMsg,
      hasBeenOk: explorerSnapshot.hasBeenOk,
      ...explorerFailure(),
      at: Date.now(),
    };
    logExplorerStatusChange('unreachable', errMsg);
  }
}

async function tick() {
  // Settle both probes in parallel — each has its own try/catch and never
  // throws, but Promise.allSettled is the conservative call.
  await Promise.allSettled([tickNode(), tickExplorer()]);
}

function scheduleNext() {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  // Boot cadence until we ever see Synced — same logic as dapps-starter.
  // Once latched, stay slow even if the node briefly drops to Syncing
  // (it's just applying new tip blocks).
  const inBoot = !nodeSnapshot.hasBeenSynced;
  const delay = inBoot ? BOOT_INTERVAL_MS : STEADY_INTERVAL_MS;
  timer = setTimeout(() => {
    tick().then(scheduleNext, scheduleNext);
  }, delay);
  if (timer.unref) timer.unref();
}

function start(opts = {}) {
  if (started) return;
  started = true;
  nodeRpcUrl = opts.nodeRpcUrl || DEFAULT_NODE_RPC_URL;

  if (!nodeRpcUrl) {
    log.info('node-status', 'NODE_RPC_URL not set — node probe disabled (status stays "unknown"); explorer probe still active');
  } else {
    log.info('node-status', `polling sidecar at ${nodeRpcUrl}`);
  }
  log.info('node-status', `polling explorer at ${explorerBase()}`);
  tick().then(scheduleNext, scheduleNext);
}

function stop() {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  started = false;
}

function get() {
  // Hand callers a fresh shallow copy so they can't accidentally mutate
  // the cached snapshot in the dashboard's render path.
  return { ...nodeSnapshot };
}

// Dapp-server-shaped snapshot for the full /node-status viewer. Gathers the
// node + explorer snapshots, plus a `services` block with platform-specific
// state (chain-poller and genesis-accounts) so operators can see whether
// the things that depend on the chain are actually keeping up.
//
// `services` is computed lazily via the optional `services` callback so we
// don't introduce a require cycle (chain-poller logs through `logger`,
// which doesn't import this file but the indirection keeps things tidy).
function getFull(opts = {}) {
  const services = typeof opts.services === 'function'
    ? safe(opts.services, {})
    : {};

  return {
    server: {
      name: opts.name || 'usernode-social-vibecoding',
      mode: opts.mode || 'production',
      version: process.env.GIT_SHA || 'dev',
      uptimeMs: Date.now() - startedAtMs,
      startedAt: startedAtMs,
      nodeRpcUrl,
      explorerHost: EXPLORER_UPSTREAM,
    },
    node: { ...nodeSnapshot },
    explorer: { ...explorerSnapshot },
    services,
    at: Date.now(),
  };
}

function safe(fn, fallback) {
  try { return fn(); } catch (_) { return fallback; }
}

// Explorer-only snapshot, for the main /status dashboard's explorer card
// (the full /node-status viewer reads the same block out of getFull()).
function getExplorer() {
  return { ...explorerSnapshot };
}

module.exports = { start, stop, get, getFull, getExplorer };
