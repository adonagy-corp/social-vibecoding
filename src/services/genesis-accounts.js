const https = require('https');
const http = require('http');
const log = require('./logger');

const EXPLORER_UPSTREAM = process.env.EXPLORER_UPSTREAM || 'testnet-explorer.usernodelabs.org';
const EXPLORER_UPSTREAM_BASE = process.env.EXPLORER_UPSTREAM_BASE || '/api';
const EXPLORER_USE_HTTP = process.env.EXPLORER_USE_HTTP === 'true';

let genesisAddresses = new Set();
let loaded = false;
// Failure-streak state, mirroring chain-poller's: the same explorer is
// upstream for both, so an outage should read the same way on the status
// pages and cost the same one log line rather than one per retry.
let consecutiveFailures = 0;
let downSince = null;
let lastError = null;
let retryHandle = null;

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 300_000;

function retryMs() {
  if (consecutiveFailures <= 0) return RETRY_BASE_MS;
  return Math.min(RETRY_BASE_MS * Math.pow(2, consecutiveFailures - 1), RETRY_MAX_MS);
}

function noteFailure(message) {
  lastError = message;
  consecutiveFailures += 1;
  if (consecutiveFailures === 1) {
    downSince = Date.now();
    log.warn('genesis', 'Fetch failed — retrying with backoff', {
      err: message, nextRetryMs: retryMs(),
    });
  } else {
    log.debug('genesis', `Fetch failed (failure #${consecutiveFailures})`, {
      err: message, nextRetryMs: retryMs(),
    });
  }
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

function explorerBase() {
  const isPrivate = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01]))/.test(EXPLORER_UPSTREAM);
  const proto = EXPLORER_USE_HTTP || isPrivate ? 'http' : 'https';
  return `${proto}://${EXPLORER_UPSTREAM}${EXPLORER_UPSTREAM_BASE}`;
}

async function fetchGenesisAccounts() {
  let chainId;
  try {
    const data = await httpJson('GET', `${explorerBase()}/active_chain`);
    chainId = data && data.chain_id;
  } catch (e) {
    // Rethrow so start()'s retry loop owns the streak accounting — this
    // used to swallow the error and silently never retry.
    throw new Error(`Could not discover chain: ${e.message}`);
  }
  if (!chainId) throw new Error('Explorer returned no chain_id');

  const base = `${explorerBase()}/${chainId}`;
  const accounts = new Set();

  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const body = { to_height: 1, limit: 200 };
    if (cursor) body.cursor = cursor;
    const resp = await httpJson('POST', `${base}/transactions`, body);

    const items = (resp && Array.isArray(resp.items)) ? resp.items
      : (resp && Array.isArray(resp.transactions)) ? resp.transactions
      : [];

    for (const tx of items) {
      const dest = tx.destination || tx.to || tx.destination_pubkey;
      if (dest) accounts.add(dest);
    }

    if (!resp.has_more || !resp.next_cursor) break;
    cursor = resp.next_cursor;
  }

  genesisAddresses = accounts;
  loaded = true;
  if (consecutiveFailures > 0) {
    const downMs = downSince ? Date.now() - downSince : 0;
    log.warn('genesis', 'explorer recovered', {
      afterFailures: consecutiveFailures,
      downSeconds: Math.round(downMs / 1000),
    });
  }
  consecutiveFailures = 0;
  downSince = null;
  lastError = null;
  log.info('genesis', `Loaded ${accounts.size} genesis account(s)`);
}

function start() {
  // Keep retrying with backoff instead of the old one-shot 30s retry: with
  // the explorer down for hours, a single retry meant the genesis set never
  // loaded at all and nothing said so.
  const attempt = () => {
    fetchGenesisAccounts().catch((e) => {
      noteFailure(e.message);
      retryHandle = setTimeout(attempt, retryMs());
      retryHandle.unref?.();
    });
  };
  attempt();
}

function stop() {
  if (retryHandle) {
    clearTimeout(retryHandle);
    retryHandle = null;
  }
}

// Outage shape for /status and /node-status, same keys as chain-poller's.
function getStatus() {
  return {
    loaded,
    count: genesisAddresses.size,
    consecutiveFailures,
    downSince,
    lastError,
  };
}

function isGenesisAddress(address) {
  if (!loaded || genesisAddresses.size === 0) return true;
  return genesisAddresses.has(address);
}

function isLoaded() { return loaded; }
function count() { return genesisAddresses.size; }

module.exports = { start, stop, isGenesisAddress, isLoaded, count, getStatus };
