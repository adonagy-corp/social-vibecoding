'use strict';

const dns = require('node:dns');
const net = require('node:net');
const log = require('./logger');

const DEFAULT_REFRESH_MS = 60_000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 1_000;

function normalizeIp(value) {
  if (typeof value !== 'string') return '';
  const unwrapped = value.startsWith('[') && value.endsWith(']')
    ? value.slice(1, -1)
    : value;
  const normalized = unwrapped.replace(/^::ffff:/, '');
  return net.isIP(normalized) ? normalized : '';
}

function socketIp(req) {
  return normalizeIp(req.socket?.remoteAddress || '');
}

function clientIp(req) {
  return normalizeIp(req.clientIp || '') || socketIp(req);
}

function forwardedClientIp(req) {
  const value = req.headers['x-forwarded-for'];
  // Caddy replaces untrusted incoming X-Forwarded-For and sends one client
  // address. Reject ambiguous/malformed values rather than choosing one.
  if (typeof value !== 'string' || value.includes(',')) return '';
  return normalizeIp(value.trim());
}

function trustedProxyClientIp({
  hostname = '',
  trustDirectPeer = false,
  lookup = dns.promises.lookup,
  refreshMs = DEFAULT_REFRESH_MS,
  lookupTimeoutMs = DEFAULT_LOOKUP_TIMEOUT_MS,
} = {}) {
  let trustedAddresses = new Set();
  let refreshAfter = 0;
  let refreshPromise = null;

  async function refresh() {
    if (!hostname) return;
    if (!refreshPromise) {
      let timeout;
      const lookupPromise = Promise.resolve()
        .then(() => lookup(hostname, { all: true }));
      const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('trusted proxy lookup timed out')),
          lookupTimeoutMs
        );
        timeout.unref?.();
      });
      refreshPromise = Promise.race([lookupPromise, timeoutPromise])
        .then((records) => {
          trustedAddresses = new Set(
            (Array.isArray(records) ? records : [records])
              .map((record) => normalizeIp(record?.address || ''))
              .filter(Boolean)
          );
        })
        .catch((err) => {
          // Fail closed to the socket peer. This can temporarily group
          // external callers under Caddy's address, but never trusts a
          // child-provided forwarding header.
          trustedAddresses = new Set();
          log.warn('client-ip', 'Trusted proxy resolution failed', {
            hostname,
            message: err.message,
          });
        })
        .finally(() => {
          clearTimeout(timeout);
          refreshAfter = Date.now() + refreshMs;
          refreshPromise = null;
        });
    }
    await refreshPromise;
  }

  return async (req, _res, next) => {
    if (hostname && Date.now() >= refreshAfter) await refresh();
    const peer = socketIp(req);
    // In Kubernetes this enables the ingress controller's forwarded address
    // without resolving a proxy hostname (and without a Caddy sidecar).
    // NetworkPolicy limits other direct peers to the app/worker namespaces;
    // their normal internal calls carry no forwarding header.
    // TODO: before opening the platform to untrusted app authors, split the
    // ingress and internal listeners (or authenticate the proxy hop) so a
    // generated app cannot deliberately forge a single forwarding header.
    const trustedPeer = trustedAddresses.has(peer) || (trustDirectPeer && Boolean(peer));
    const forwarded = trustedPeer ? forwardedClientIp(req) : '';
    req.clientIp = forwarded || peer;
    next();
  };
}

module.exports = {
  normalizeIp,
  socketIp,
  clientIp,
  forwardedClientIp,
  trustedProxyClientIp,
};
