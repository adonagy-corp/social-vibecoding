// Polls the Usernode block explorer for wallet-linking transactions
// sent to the platform's APP_PUBKEY. When a tx with memo
// { app: "vibecode", type: "link_wallet", token: "..." } is found,
// the sender's pubkey is stored against the user who generated that token.

const https = require('https');
const http = require('http');
const log = require('./logger');
const genesisAccounts = require('./genesis-accounts');

const EXPLORER_UPSTREAM = process.env.EXPLORER_UPSTREAM || 'testnet-explorer.usernodelabs.org';
const EXPLORER_UPSTREAM_BASE = process.env.EXPLORER_UPSTREAM_BASE || '/api';
const EXPLORER_USE_HTTP = process.env.EXPLORER_USE_HTTP === 'true';

const POLL_INTERVAL_MS = 4000;
// Ceiling for the failure backoff. When the explorer is down (it answers
// `HTTP 503: no available server` for hours at a time), a flat 4s retry
// produced ~900 warn lines an hour and buried every other log line in the
// platform's output. Backing off to a minute keeps the recovery latency
// acceptable while making the log readable again.
const MAX_POLL_INTERVAL_MS = 60000;
const MAX_PAGES = 5;
const MAX_SEEN = 5000;

let chainId = null;
let seenTxIds = new Set();
let lastBlockHeight = 0;
let timerHandle = null;
let running = false;
// Surfaced on /node-status (the dapp-server-style full viewer) so operators
// can confirm the wallet-linker is actually keeping up with the chain.
let lastPolledAt = null;
let lastError = null;
let walletLinkCount = 0;
// Failure-streak state. `consecutiveFailures` drives the backoff and the
// log level; `downSince` is what the status pages render as "unreachable
// for 14 minutes" so an operator can tell a blip from an outage.
let consecutiveFailures = 0;
let downSince = null;
let currentIntervalMs = POLL_INTERVAL_MS;

// Current retry delay: 4s while healthy, doubling per consecutive failure
// up to the ceiling.
function backoffMs() {
  if (consecutiveFailures <= 0) return POLL_INTERVAL_MS;
  const grown = POLL_INTERVAL_MS * Math.pow(2, consecutiveFailures - 1);
  return Math.min(grown, MAX_POLL_INTERVAL_MS);
}

// One place to record a failed poll. The FIRST failure of a streak logs at
// warn (an operator should see the transition); every repeat drops to debug
// so a long outage costs one line, not one per retry.
function noteFailure(what, message) {
  lastError = message;
  consecutiveFailures += 1;
  if (consecutiveFailures === 1) {
    downSince = Date.now();
    log.warn('chain-poller', `${what} — retrying with backoff`, { err: message });
  } else {
    log.debug('chain-poller', `${what} (failure #${consecutiveFailures})`, {
      err: message,
      nextRetryMs: backoffMs(),
    });
  }
}

// Closing the streak is worth exactly one warn line: it is the event an
// operator scanning the log actually wants to find.
function noteSuccess() {
  if (consecutiveFailures > 0) {
    const downMs = downSince ? Date.now() - downSince : 0;
    log.warn('chain-poller', 'explorer recovered', {
      afterFailures: consecutiveFailures,
      downSeconds: Math.round(downMs / 1000),
    });
  }
  consecutiveFailures = 0;
  downSince = null;
  lastError = null;
}

function httpJson(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = mod.request(url, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(bodyBuf ? { 'content-length': bodyBuf.length } : {}),
      },
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
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function baseUrl() {
  const isPrivate = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01]))/.test(EXPLORER_UPSTREAM);
  const proto = EXPLORER_USE_HTTP || isPrivate ? 'http' : 'https';
  return `${proto}://${EXPLORER_UPSTREAM}${EXPLORER_UPSTREAM_BASE}`;
}

async function discoverChainId() {
  const data = await httpJson('GET', `${baseUrl()}/active_chain`);
  if (data && data.chain_id) chainId = data.chain_id;
}

function parseMemo(raw) {
  if (!raw) return null;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

function boundSeenSet() {
  if (seenTxIds.size > MAX_SEEN) {
    const arr = [...seenTxIds];
    seenTxIds = new Set(arr.slice(arr.length - MAX_SEEN));
  }
}

async function poll(appPubkey, pool) {
  lastPolledAt = Date.now();
  if (!chainId) {
    try { await discoverChainId(); } catch (e) {
      noteFailure('chain ID discovery failed', e.message);
      return;
    }
    // Discovery succeeded but the explorer answered without a chain_id.
    // This is an outage too — without recording it the streak stays at 0,
    // the poller is pinned at the healthy 4s interval forever, and the
    // status pages report the explorer as fine while nothing is polled.
    if (!chainId) {
      noteFailure('chain ID missing', 'Explorer returned no chain_id');
      return;
    }
  }

  const txUrl = `${baseUrl()}/${chainId}/transactions`;
  let cursor;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = { recipient: appPubkey, limit: 50 };
    if (cursor) body.cursor = cursor;
    if (lastBlockHeight > 0) body.from_height = lastBlockHeight;

    let data;
    try { data = await httpJson('POST', txUrl, body); }
    catch (e) {
      noteFailure('poll failed', e.message);
      return;
    }
    noteSuccess();

    const items = data.items || [];
    if (!items.length) break;

    let allSeen = true;
    for (const tx of items) {
      const txId = tx.tx_id || tx.id;
      if (!txId || seenTxIds.has(txId)) continue;
      allSeen = false;
      seenTxIds.add(txId);

      if (tx.block_height && tx.block_height > lastBlockHeight) {
        lastBlockHeight = tx.block_height;
      }

      const memo = parseMemo(tx.memo);
      if (!memo || memo.app !== 'vibecode' || memo.type !== 'link_wallet' || !memo.token) continue;

      const sender = tx.source || tx.from_pubkey || tx.from;
      if (!sender) continue;

      if (!genesisAccounts.isGenesisAddress(sender)) {
        log.info('chain-poller', 'Ignoring link from non-genesis address', { pubkey: sender.slice(0, 10) + '...' });
        continue;
      }

      try {
        const { rowCount } = await pool.query(
          `UPDATE users
             SET usernode_pubkey = $1,
                 wallet_link_token = NULL,
                 wallet_link_expires_at = NULL
           WHERE wallet_link_token = $2
             AND wallet_link_expires_at > NOW()`,
          [sender, memo.token]
        );
        if (rowCount > 0) {
          walletLinkCount += 1;
          log.info('chain-poller', 'Wallet linked', { pubkey: sender, token: memo.token.slice(0, 8) + '...' });
        }
      } catch (e) {
        log.warn('chain-poller', 'DB update failed', { err: e.message });
      }
    }

    boundSeenSet();
    if (allSeen || !data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
}

function start(config) {
  const appPubkey = config.usernodeAppPubkey;
  if (!appPubkey) {
    log.info('chain-poller', 'USERNODE_APP_PUBKEY not set — wallet linking disabled');
    return;
  }

  const { getPool } = require('../db/pool');
  const pool = getPool(config);

  log.info('chain-poller', 'Starting', { appPubkey: appPubkey.slice(0, 10) + '...' });

  running = true;
  // The boot-time discovery is a real probe of the same upstream, so its
  // failure belongs in the streak: swallowing it left the first ~4s of an
  // outage reported as healthy, and a successful-but-empty response
  // uncounted entirely.
  discoverChainId()
    .then(() => {
      if (!chainId) noteFailure('chain ID missing', 'Explorer returned no chain_id');
    })
    .catch((e) => noteFailure('chain ID discovery failed', e.message));

  // Self-rescheduling timer rather than setInterval: the delay has to
  // change as the failure streak grows, and a fixed interval would also
  // stack overlapping polls once the upstream starts timing out.
  const tick = async () => {
    if (!running) return;
    try { await poll(appPubkey, pool); }
    catch (e) { log.debug('chain-poller', 'unexpected poll error', { err: e.message }); }
    if (!running) return;
    currentIntervalMs = backoffMs();
    timerHandle = setTimeout(tick, currentIntervalMs);
    timerHandle.unref?.();
  };
  timerHandle = setTimeout(tick, POLL_INTERVAL_MS);
  timerHandle.unref?.();
}

function stop() {
  running = false;
  if (timerHandle) {
    clearTimeout(timerHandle);
    timerHandle = null;
  }
}

function getStatus() {
  return {
    chainId,
    lastBlockHeight,
    seenTxCount: seenTxIds.size,
    walletLinkCount,
    lastPolledAt,
    lastError,
    // Outage shape for the status pages: how many retries have failed in a
    // row, when the streak began, and how long we are currently waiting.
    consecutiveFailures,
    downSince,
    pollIntervalMs: currentIntervalMs,
    enabled: running,
  };
}

module.exports = { start, stop, getStatus };
