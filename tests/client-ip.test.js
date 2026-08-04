'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clientIp,
  trustedProxyClientIp,
} = require('../src/services/client-ip');

function runMiddleware(middleware, req) {
  return new Promise((resolve, reject) => {
    Promise.resolve(middleware(req, {}, resolve)).catch(reject);
  });
}

test('trusted Caddy peer supplies the single forwarded client address', async () => {
  const middleware = trustedProxyClientIp({
    hostname: 'caddy',
    refreshMs: 60_000,
    lookup: async () => [{ address: '172.20.0.2', family: 4 }],
  });
  const req = {
    socket: { remoteAddress: '::ffff:172.20.0.2' },
    headers: { 'x-forwarded-for': '203.0.113.8' },
  };
  await runMiddleware(middleware, req);
  assert.equal(req.clientIp, '203.0.113.8');
  assert.equal(clientIp(req), '203.0.113.8');
});

test('direct child cannot spoof X-Forwarded-For', async () => {
  const middleware = trustedProxyClientIp({
    hostname: 'caddy',
    refreshMs: 60_000,
    lookup: async () => [{ address: '172.20.0.2', family: 4 }],
  });
  const req = {
    socket: { remoteAddress: '172.20.0.44' },
    headers: { 'x-forwarded-for': '198.51.100.9' },
  };
  await runMiddleware(middleware, req);
  assert.equal(req.clientIp, '172.20.0.44');
});

test('ambiguous forwarding data fails closed to the trusted peer address', async () => {
  const middleware = trustedProxyClientIp({
    hostname: 'caddy',
    refreshMs: 60_000,
    lookup: async () => [{ address: '172.20.0.2', family: 4 }],
  });
  const req = {
    socket: { remoteAddress: '172.20.0.2' },
    headers: { 'x-forwarded-for': '198.51.100.9, 203.0.113.8' },
  };
  await runMiddleware(middleware, req);
  assert.equal(req.clientIp, '172.20.0.2');
});

test('proxy resolution failure ignores forwarded data and uses the socket peer', async () => {
  const middleware = trustedProxyClientIp({
    hostname: 'caddy',
    lookup: async () => {
      throw new Error('dns unavailable');
    },
  });
  const req = {
    socket: { remoteAddress: '172.20.0.2' },
    headers: { 'x-forwarded-for': '203.0.113.8' },
  };
  await runMiddleware(middleware, req);
  assert.equal(req.clientIp, '172.20.0.2');
});

test('Kubernetes ingress peer supplies the single forwarded client address without DNS', async () => {
  const middleware = trustedProxyClientIp({ trustDirectPeer: true });
  const req = {
    socket: { remoteAddress: '10.244.1.18' },
    headers: { 'x-forwarded-for': '203.0.113.8' },
  };
  await runMiddleware(middleware, req);
  assert.equal(req.clientIp, '203.0.113.8');
});

test('Kubernetes ingress rejects ambiguous forwarding data', async () => {
  const middleware = trustedProxyClientIp({ trustDirectPeer: true });
  const req = {
    socket: { remoteAddress: '10.244.1.18' },
    headers: { 'x-forwarded-for': '203.0.113.8, 198.51.100.9' },
  };
  await runMiddleware(middleware, req);
  assert.equal(req.clientIp, '10.244.1.18');
});
