'use strict';

const CLIENT_ID = 'social-vibecoding-cli';
const CLIENT_NAME = 'Social Vibecoding CLI';
const IDENTITY_SCOPE = 'rpc:identity:read';
const API_SCOPE = 'api:access';
// #907: the local coding agent. Deliberately its own scope rather than a
// reuse of api:access — the agent protocol lets a machine claim a session's
// coding turn and stream its result back, which is a materially larger grant
// than "read and write the user-facing JSON API". Credentials issued before
// this scope existed keep working for everything else and get a plain
// 403 insufficient_scope on /api/cli/agent/*, which the CLI turns into a
// re-login prompt.
const AGENT_SCOPE = 'agent:local';
const REQUIRED_SCOPES = Object.freeze([IDENTITY_SCOPE, API_SCOPE, AGENT_SCOPE]);
const REQUIRED_SCOPE_TEXT = REQUIRED_SCOPES.join(' ');
// A self-hosted deployment uses USERNODE_DOMAIN as its canonical origin.
// Keeping the existing default preserves the current single-server install
// while allowing the Kubernetes lab to use its own operator-selected domain.
const PRODUCTION_ORIGIN = process.env.USERNODE_DOMAIN
  ? `https://${process.env.USERNODE_DOMAIN}`
  : 'https://social-vibecoding.usernodelabs.org';
const LOCAL_ORIGIN = 'http://localhost:3000';
const DEVICE_TTL_SECONDS = 600;
const ACCESS_TTL_SECONDS = 30 * 24 * 60 * 60;
const POLL_INTERVAL_SECONDS = 5;

module.exports = {
  CLIENT_ID,
  CLIENT_NAME,
  IDENTITY_SCOPE,
  API_SCOPE,
  AGENT_SCOPE,
  REQUIRED_SCOPES,
  REQUIRED_SCOPE_TEXT,
  PRODUCTION_ORIGIN,
  LOCAL_ORIGIN,
  DEVICE_TTL_SECONDS,
  ACCESS_TTL_SECONDS,
  POLL_INTERVAL_SECONDS,
};
