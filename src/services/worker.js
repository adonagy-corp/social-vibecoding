'use strict';

const { spawn } = require('child_process');
const log = require('./logger');
const platformJwt = require('./platform-jwt');
const docker = require('./docker');
const kubernetes = require('./kubernetes');
const github = require('./github');
const models = require('./models');
const inLoopBrowser = require('./in-loop-browser');
const registry = require('../agents/registry');
const turnLifecycle = require('./turn-lifecycle');
const llmTelemetry = require('./llm-telemetry');

const WORKER_IMAGE = 'usernode-worker:latest';
// Per-session worker container resource limits. Read from env (mirrored
// into src/config.js as workerMemory/workerCpus for logging) so prod can
// shrink the footprint to fit more concurrent warm workers on one box
// without a code deploy. Defaults preserve historical 2g/2-CPU behavior.
const WORKER_MEMORY = process.env.WORKER_MEMORY || '2g';
const WORKER_CPUS = process.env.WORKER_CPUS || '2';
const WARM_READY_TIMEOUT_MS = 5 * 60 * 1000;

function usesKubernetesWorkers() {
  const mode = process.env.WORKER_RUNTIME || process.env.APP_RUNTIME || 'docker';
  if (!['docker', 'kubernetes'].includes(mode)) {
    throw new Error(`Unsupported WORKER_RUNTIME=${mode}`);
  }
  return mode === 'kubernetes';
}

function kubernetesWorkerConfig() {
  return {
    workerMemory: WORKER_MEMORY,
    workerCpus: WORKER_CPUS,
    kubernetes: {
      workerNamespace: process.env.WORKER_NAMESPACE || 'social-workers',
      workerServiceAccount: process.env.WORKER_SERVICE_ACCOUNT || 'social-worker',
      workerImage: process.env.KUBERNETES_WORKER_IMAGE || '',
      workerStorageClass: process.env.WORKER_STORAGE_CLASS || '',
      workerStorageSize: process.env.WORKER_STORAGE_SIZE || '5Gi',
    },
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function execWorkerCommand(runtimeName, command, stdinText = null) {
  if (usesKubernetesWorkers()) {
    return kubernetes.execInWorker(kubernetesWorkerConfig(), runtimeName, command, stdinText);
  }
  if (stdinText !== null) {
    return docker.execShellStdin(runtimeName, stdinText, { timeoutMs: 20000, label: 'worker exec' });
  }
  return docker.execFileAsync('docker', ['exec', runtimeName, ...command], { timeout: 30000 });
}

// URL the worker container uses to reach the platform's internal API
// (push proxy, PR creation, etc.). Both containers run on the same
// docker network (compose service name `usernode`). Override via env
// for self-hosted deployments that put the platform on a different
// hostname / port.
const PLATFORM_INTERNAL_URL = process.env.PLATFORM_INTERNAL_URL || 'http://usernode:3000';

// Worker JWTs are short-lived but cover the entire chat session; 24h is
// the cap any single session is allowed to run before re-auth becomes
// the chat handler's problem. Re-minted on every warm bootstrap and on
// every per-turn `docker exec`. The TTL itself lives with the signer in
// services/platform-jwt.js; kept here as the name the comments below use.
const WORKER_JWT_TTL = platformJwt.WORKER_TTL;
const WORKER_JWT_TTL_MS = platformJwt.WORKER_TTL_S * 1000;

// Version of the warm-container runtime contract. Bump whenever either the
// bootstrap environment OR an installed runner changes incompatibly with the
// host (e.g. token requirements, journal markers, retry behavior). ensureWorker
// compares this label on warm-path hits and evicts + re-bootstraps containers
// running an older contract. v4 introduces capability-scoped runner envs and
// the host-managed Codex resume classifier, so a v3 image cannot serve it.
// v5 replaces the unsafe Codex config writer and removes any v4-generated
// config from the persistent session volume before the next turn.
// v6 disables Codex's incompatible nested Linux sandbox and adds per-model
// OpenRouter metadata; every v5 warm container must be replaced to pick up
// both runner changes.
const WORKER_BOOTSTRAP_ENV_VERSION = 'v6';

// Mint the auth token the worker container uses to call back into the
// platform's internal API. Scoped to a single session id; the
// internal-auth middleware rejects anything whose purpose isn't
// worker:session.
//
// Signed with WORKER_JWT_SECRET — an authority of its own, independent
// of the key that signs app identities. The signing key is never put in
// a worker (or app, or staging) container; workers receive only the
// minted capability token. platform-jwt reads the key from env at call
// time, which also preserves the old laziness here: module import can
// precede config.load().
function mintWorkerJwt(sessionId) {
  return platformJwt.signWorkerToken({ sessionId });
}

// Narrow, purpose-bound capabilities. worker:push is used by Codex build's
// usernode-push; worker:issues-read by usernode-issues / attachments on both
// backends; worker:anthropic-proxy authenticates Claude itself without also
// granting the shell every worker:session mutation.
function mintWorkerPushJwt(sessionId) {
  return platformJwt.signWorkerPushToken({ sessionId });
}
function mintIssuesReadJwt(sessionId) {
  return platformJwt.signIssuesReadToken({ sessionId });
}
function mintAnthropicProxyJwt(sessionId) {
  return platformJwt.signAnthropicProxyToken({ sessionId });
}

// #616: purpose-bound read-only diagnostic token carrying the `prod_debug`
// claim that the internal prod-debug routes require. Minted ONLY for turns whose
// session passed debug-access.isEligible (admin-owned session on the
// self-edit app). It is deliberately not worker:session: a scout may inspect
// this env value through Bash without gaining push or draft authority.
function mintProdDebugJwt(sessionId) {
  return platformJwt.signProdDebugToken({ sessionId });
}

// One backend decision, used everywhere in a turn's dispatch so the
// runner, tokens, env, and active-turn record can never disagree (review
// Commit 1 / plan 3.1). Rejects unknown backends instead of silently
// falling through to Claude.
function resolveTurnBackend(agentBackend) {
  const backend = registry.resolveBackend(agentBackend || 'claude_code');
  return {
    backend,
    isCodex: backend === 'codex_openrouter',
    isClaude: backend === 'claude_code',
  };
}

function requireNonEmptySecret(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`buildTurnSecretEnv: ${name} required`);
  }
  return value;
}

// Pure builder for a turn's secret env (exported for unit tests).
// Scout mode omits every general worker:session alias, not merely the
// WORKER_JWT name: unrestricted Bash can inspect and reuse any env value.
// PROD_DEBUG_JWT rides along on build + scout turns only — never sync
// (bookkeeping, no free-form agent).
function buildTurnSecretEnv({
  mode, agentBackend, workerSessionJwt, workerPushJwt, issuesReadJwt,
  anthropicProxyJwt, anthropicApiKey, prodDebugJwt, openrouterApiKey,
}) {
  const { backend, isCodex, isClaude } = resolveTurnBackend(agentBackend);
  if (!isClaude && !isCodex) {
    throw new Error(`buildTurnSecretEnv: unsupported backend ${agentBackend}`);
  }
  if (mode !== 'scout' && mode !== 'build' && mode !== 'sync') {
    throw new Error(`buildTurnSecretEnv: unsupported mode ${mode}`);
  }
  if (isCodex && mode === 'sync') {
    throw new Error('buildTurnSecretEnv: Codex sync mode is not supported');
  }

  if (isCodex) {
    // Codex receives ONLY its own credential plus narrow capability tokens
    // (review Commit 1 / plan 3.3). It must never receive a general
    // worker:session token, an Anthropic key/base, or a relay token.
    const env = {
      OPENROUTER_API_KEY: requireNonEmptySecret(openrouterApiKey, 'openrouterApiKey'),
      ISSUES_JWT: requireNonEmptySecret(issuesReadJwt, 'issuesReadJwt'),
    };
    if (mode === 'build') {
      env.WORKER_JWT = requireNonEmptySecret(workerPushJwt, 'workerPushJwt');
    }
    return env;
  }

  // Claude uses a narrow proxy credential when no BYOK key is provided and a
  // narrow issues-read credential in every mode. Only build/sync receive the
  // general callback token. In particular, scout has no worker:session token
  // hidden under ANTHROPIC_API_KEY, ISSUES_JWT, or PROD_DEBUG_JWT.
  const useProxy = !anthropicApiKey;
  const env = {
    ANTHROPIC_API_KEY: useProxy
      ? requireNonEmptySecret(anthropicProxyJwt, 'anthropicProxyJwt')
      : requireNonEmptySecret(anthropicApiKey, 'anthropicApiKey'),
    ISSUES_JWT: requireNonEmptySecret(issuesReadJwt, 'issuesReadJwt'),
  };
  if (mode !== 'scout') {
    env.WORKER_JWT = requireNonEmptySecret(workerSessionJwt, 'workerSessionJwt');
  }
  if (prodDebugJwt && mode !== 'sync') {
    env.PROD_DEBUG_JWT = prodDebugJwt;
  }
  return env;
}
// ──────────────────────────────────────────────────────────────────────
// Stream-json / marker parsing
// ──────────────────────────────────────────────────────────────────────
//
// Claude Code emits one JSON object per stdout line (`--output-format
// stream-json --verbose`). The worker entrypoint additionally emits a
// handful of sentinel lines the host relies on:
//
//   __USERNODE_PHASE__  <phase>                                                  status transitions
//   __USERNODE_RESULT__ cc_exit=N ahead=N behind=N sha=… push_ok=N [sync_result=…]   final summary
//   __USERNODE_WARN__   <msg>                                                    non-fatal issue
//   __USERNODE_ERROR__  <msg>                                                    fatal, bail out
//
// Everything else is treated as a plain progress line (git output, etc.).
//
// Two transports drive this parser:
//   1) `docker logs -f <container>` — used for legacy single-shot
//      workers and for the warm-ready wait during bootstrap.
//   2) Turn journal files in the CC volume — per-turn output for the
//      long-lived worker path. run-cc.sh runs as a DETACHED exec whose
//      output is redirected to the journal (plus a trailing
//      __USERNODE_EXIT__ <code> line from the wrapper); the host tails
//      the file. Same line format, but restart-proof: the journal and
//      the exec both outlive the platform process.

function parseClaudeResponse(stdout) {
  // Keep for back-compat with callers that still pass a full stdout blob.
  const lines = (stdout || '').split('\n').filter(Boolean);
  let resultText = '';
  let costUsd = 0;
  let sessionId = null;
  let isError = false;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'result') {
        resultText = event.result || resultText;
        costUsd = event.cost_usd || event.total_cost_usd || costUsd;
        sessionId = event.session_id || sessionId;
        if (event.is_error) isError = true;
      }
    } catch {
      // Not JSON — skip.
    }
  }

  return { text: resultText, costUsd, numTurns: 0, sessionId, isError };
}

// Best-effort one-line summary of a tool_result payload. The content is
// either a string (typical for Read/Bash) or an array of content blocks
// (image + text for tools like Playwright). We don't want to spam the
// progress log with the entire file, so just surface length/lines and
// trim hard.
function summarizeToolResult(block) {
  if (block.is_error) return 'error';
  const raw = block.content;
  let text = '';
  if (typeof raw === 'string') {
    text = raw;
  } else if (Array.isArray(raw)) {
    text = raw
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  }
  if (!text) return 'ok';
  const lines = text.split('\n');
  if (lines.length > 3) return `${lines.length} lines`;
  // Short payloads (e.g. bash exit, quick grep) — show the last
  // non-empty line so the user sees the actual outcome.
  const lastNonEmpty = [...lines].reverse().find((l) => l.trim()) || '';
  const trimmed = lastNonEmpty.trim().replace(/\s+/g, ' ');
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

function usageToken(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function applyClaudeResultUsage(usage, state) {
  if (!usage || typeof usage !== 'object') return;
  const values = {
    inputTokens: usageToken(usage.input_tokens),
    cachedInputTokens: usageToken(usage.cache_read_input_tokens),
    cacheWriteInputTokens: usageToken(
      usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens,
    ),
    outputTokens: usageToken(usage.output_tokens),
    reasoningOutputTokens: usageToken(
      usage.reasoning_output_tokens ?? usage.output_tokens_details?.thinking_tokens,
    ),
  };
  if (!Object.values(values).some((value) => value != null)) return;
  state.usageSeen = true;
  for (const [key, value] of Object.entries(values)) {
    if (value != null) state[key] = value;
  }
}

function safeResultSubtype(value) {
  if (typeof value !== 'string') return null;
  const subtype = value.trim();
  return /^[a-z][a-z0-9_]{0,63}$/.test(subtype) ? subtype : null;
}

function applyStreamEvent(event, onProgress, state) {
  // Capture the CC session id on the very first event so the caller can
  // persist it even if CC aborts before emitting a `result` event.
  if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
    state.initSessionId = event.session_id;
    state.sessionId = state.sessionId || event.session_id;
  }
  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'text' && block.text) {
        state.lastResultText = block.text;
        onProgress(block.text.substring(0, 300));
      } else if (block.type === 'thinking' && block.thinking) {
        // Extended thinking blocks. Without surfacing these the UI can
        // sit on "Reading foo.html" for 30+ seconds while the model
        // thinks about what to do next — misleading. Prefix with `…`
        // so it's visually distinct from tool / text lines.
        const firstLine = block.thinking.split('\n').find((l) => l.trim()) || '';
        const clipped = firstLine.trim().slice(0, 200);
        if (clipped) onProgress(`… ${clipped}`);
      } else if (block.type === 'tool_use') {
        const input = block.input || {};
        // Track id → label mapping so the matching tool_result can
        // display "⎿ <label>: <summary>" instead of just "⎿ done".
        let label;
        if (block.name === 'Read' && input.file_path) {
          label = `Reading ${input.file_path}`;
        } else if (block.name === 'Write' && input.file_path) {
          label = `Writing ${input.file_path}`;
        } else if (block.name === 'Edit' && input.file_path) {
          label = `Editing ${input.file_path}`;
        } else if (block.name === 'MultiEdit' && input.file_path) {
          label = `Editing ${input.file_path}`;
        } else if (block.name === 'Bash' && input.command) {
          label = `$ ${input.command.substring(0, 150)}`;
        } else {
          label = `Using ${block.name}`;
        }
        onProgress(label);
        if (block.id) state.toolUses.set(block.id, { name: block.name, label });
      }
    }
  } else if (event.type === 'user' && event.message?.content) {
    // tool_result arrives inside a `user` event after CC executes the
    // tool call. Surfacing it breaks the "Reading X" dead-air and lets
    // the user see CC is progressing through its plan.
    for (const block of event.message.content) {
      if (block.type !== 'tool_result') continue;
      const summary = summarizeToolResult(block);
      const prior = block.tool_use_id ? state.toolUses.get(block.tool_use_id) : null;
      if (prior) {
        onProgress(`  ⎿ ${prior.name}: ${summary}`);
        state.toolUses.delete(block.tool_use_id);
      } else {
        onProgress(`  ⎿ ${summary}`);
      }
    }
  } else if (event.type === 'result') {
    state.lastResultText = event.result || state.lastResultText;
    applyClaudeResultUsage(event.usage, state);
    state.resultSubtype = safeResultSubtype(event.subtype) || state.resultSubtype;
    if (event.cost_usd != null || event.total_cost_usd != null) {
      state.providerCostSeen = true;
    }
    // Keep the pre-telemetry billing precedence exactly unchanged. The
    // separate flag above is enough to distinguish an explicitly reported
    // zero from this state's legacy zero default.
    state.costUsd = event.cost_usd || event.total_cost_usd || state.costUsd;
    state.sessionId = event.session_id || state.sessionId;
    if (event.is_error) state.ccIsError = true;
  }
}

function parseLine(line, onProgress, state) {
  if (!line || !line.trim()) return;
  if (line.startsWith('__USERNODE_PHASE__')) {
    state.phase = line.replace('__USERNODE_PHASE__', '').trim();
    onProgress(`[${state.phase}]`);
    return;
  }
  if (line.startsWith('__USERNODE_RESULT__')) {
    const body = line.replace('__USERNODE_RESULT__', '').trim();
    for (const kv of body.split(/\s+/)) {
      const [k, v] = kv.split('=');
      if (k === 'cc_exit') state.ccExit = parseInt(v, 10);
      else if (k === 'ahead') state.ahead = parseInt(v, 10) || 0;
      else if (k === 'behind') state.behind = parseInt(v, 10) || 0;
      else if (k === 'sha') state.sha = v || null;
      else if (k === 'push_ok') state.pushOk = v === '1';
      else if (k === 'sync_result') state.syncResult = v || null;
      // Backend-neutral antelope (plan.md §4-PR1): Codex/OpenRouter turns
      // (PR5+) emit these fields in __USERNODE_RESULT__ alongside the
      // legacy cc_* fields. Parsing them here keeps worker.js the single
      // place that understands the terminal result line, with the legacy
      // cc_exit alias still honored during the migration window.
      else if (k === 'agent_backend') state.agentBackend = v || null;
      else if (k === 'agent_provider') state.agentProvider = v || null;
      else if (k === 'agent_model') state.agentModel = v || null;
      else if (k === 'agent_thread_id') state.agentThreadId = v || null;
      else if (k === 'agent_exit') state.agentExit = parseInt(v, 10);
      else if (k === 'agent_retry_fresh') state.agentRetryFresh = v === '1';
      // #361: comma-delimited conflicted file paths (MODE=sync). Empty
      // string → no conflicts. Threaded out as result.conflictFiles so
      // sync-main.js can persist the merge-conflict snapshot.
      else if (k === 'conflict_files') state.conflictFiles = v ? v.split(',').filter(Boolean) : [];
    }
    state.resultSeen = true;
    return;
  }
  if (line.startsWith('__USERNODE_ERROR__')) {
    state.fatalError = line.replace('__USERNODE_ERROR__', '').trim();
    return;
  }
  if (line.startsWith('__USERNODE_EXIT__')) {
    // Appended by the detached-exec wrapper after run-cc.sh exits — the
    // journal-file analog of the docker-exec child's exit code. Seeing
    // this line is how the journal tailer knows the turn is over.
    const code = parseInt(line.replace('__USERNODE_EXIT__', '').trim(), 10);
    state.exitCode = Number.isFinite(code) ? code : -1;
    state.execExitSeen = true;
    return;
  }
  if (line.startsWith('__USERNODE_WARN__')) {
    const msg = line.replace('__USERNODE_WARN__', '').trim();
    log.warn('worker', msg);
    // Surface runner warnings ("resume failed (exit N); retrying fresh",
    // "push failed", …) in the session's progress log too — both the
    // interactive and headless paths persist onProgress lines, so a
    // reviewer reading a failed auto session can see what happened
    // without server-log access.
    onProgress(`⚠ ${msg}`);
    return;
  }
  try {
    const event = JSON.parse(line);
    // Backend-aware event routing (plan.md review F3): Codex turns emit
    // JSONL with a different event schema than Claude's stream-json. The
    // Codex adapter (src/agents/codex-openrouter.js) normalizes them to
    // the same progress vocabulary. Claude turns keep the legacy parser.
    if (state.agentBackend === 'codex_openrouter') {
      const codex = require('../agents/codex-openrouter');
      // The normalizer returns an ARRAY of normalized events (a single
      // file_change can emit several changed paths), and it now uses the
      // pinned Codex 0.146.0 JSONL fields exactly. Parsing and state
      // mutation are kept separate so each normalization branch is
      // independently testable.
      const events = codex.normalizeCodexLine(line, state);
      for (const ev of events) {
        if (ev.threadId) state.agentThreadId = ev.threadId;
        // Store the final agent message as the turn result (review P4):
        // scout persists this as the spec, and `[done]` (turn.completed)
        // must never overwrite it.
        if (ev.kind === 'agent_message' && ev.fullText != null) {
          state.lastResultText = ev.fullText;
        } else if (ev.kind === 'usage') {
          // Retain token counts so the Codex turn can be attributed directly
          // to agent_turns (review #3) instead of the Anthropic ledger.
          // Nullish-safe: a missing usage field stays null (absent usage is
          // NOT a genuine zero-token event).
          const u = ev.usage || {};
          if (u.inputTokens != null) state.inputTokens = u.inputTokens;
          if (u.cachedInputTokens != null) state.cachedInputTokens = u.cachedInputTokens;
          if (u.cacheWriteInputTokens != null) state.cacheWriteInputTokens = u.cacheWriteInputTokens;
          if (u.outputTokens != null) state.outputTokens = u.outputTokens;
          if (u.reasoningOutputTokens != null) state.reasoningOutputTokens = u.reasoningOutputTokens;
        }
        if (ev.kind === 'error' && ev.errorMessage != null) {
          state.ccIsError = true;
          state.agentError = ev.errorMessage;
        }
        // Progress line: use the short display form (or any event text).
        if (ev.text) onProgress(ev.text);
      }
    } else {
      applyStreamEvent(event, onProgress, state);
    }
  } catch {
    // Plain log line (git output, shell echo, etc.).
    if (line.length < 500) onProgress(line);
  }
}

function newWatchState() {
  return {
    // Stable logical turn identity used by cleanup/spend idempotency. This is
    // host-owned and never parsed from untrusted runner output.
    turnId: null,
    lastResultText: '',
    costUsd: 0,
    // Claude's result event is the evidence that a zero cost is known rather
    // than the legacy state default. Telemetry reads this flag only; billing
    // continues to consume costUsd exactly as before.
    providerCostSeen: false,
    // Set only after docker accepted the detached provider process. Codex's
    // ledger intent exists before that boundary, so the aggregate report
    // needs this evidence to exclude a stop/failure during spin-up.
    providerDispatched: false,
    // Retained terminal-result usage. Codex persists these values to
    // agent_turns; Claude telemetry records the same nullable fields from its
    // final result event. Missing provider usage remains null.
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    sessionId: null,
    initSessionId: null,
    ccIsError: false,
    agentError: null,
    usageSeen: false,
    resultSubtype: null,
    // plan.md 5.6: missing usage stays null, never a false zero.
    cacheWriteInputTokens: null,
    ccExit: null,
    // Backend-neutral terminal-result fields (plan.md §4-PR1). PR5's
    // codex_openrouter runner emits these; claude_code leaves them null
    // and callers keep using ccExit/cc_session_id during migration.
    agentBackend: null,
    agentProvider: null,
    agentModel: null,
    agentThreadId: null,
    agentExit: null,
    // Runner-to-host control signal: a stale/missing resume thread needs
    // one fresh physical dispatch, accounted as a separate attempt.
    agentRetryFresh: false,
    ahead: 0,
    // #8: how many commits the branch is behind origin/main, parsed from
    // run-cc.sh's __USERNODE_RESULT__ line. Persisted to
    // chat_sessions.behind_main on every turn so the dev-chat banner
    // and merge-time block always reflect the latest state.
    behind: 0,
    sha: null,
    pushOk: false,
    // #8: clean|resolved|conflict|already_synced (MODE=sync only). The
    // route handler routes the chat message off this.
    syncResult: null,
    // #361: conflicted file paths from a MODE=sync turn's
    // __USERNODE_RESULT__ line. Defaults empty.
    conflictFiles: [],
    phase: null,
    fatalError: null,
    resultSeen: false,
    // True once the detached-exec wrapper's __USERNODE_EXIT__ line has
    // been parsed from the turn journal (detached transport only).
    execExitSeen: false,
    // Why a markerless turn (exitCode -1, no __USERNODE_EXIT__ line) was
    // declared dead: 'container_gone' | 'oom_killed' |
    // 'probe_unobservable' | 'turn_process_gone'. Null for turns that
    // ended with a marker. Routes use this for cause-specific failure
    // messages instead of a bare "-1".
    markerlessCause: null,
    rawStdout: '',
    rawStderr: '',
    exitCode: null,
    // id → { name, label } for pending tool_use calls, so the matching
    // tool_result can be annotated with the same label.
    toolUses: new Map(),
  };
}

function codingRunOutcome(state) {
  if (state && (state.exitCode === 143 || state.agentExit === 143 || state.ccExit === 143)) {
    return { outcome: 'cancelled', stopReason: 'cancelled' };
  }
  const failed = !state || !!(state.fatalError || state.ccIsError
    || (state.agentExit != null && state.agentExit !== 0)
    || (state.ccExit != null && state.ccExit !== 0)
    || (state.exitCode != null && state.exitCode !== 0));
  if (!failed) return { outcome: 'success', stopReason: 'end_turn' };
  if (state && state.markerlessCause) {
    return { outcome: 'error', stopReason: `markerless_${state.markerlessCause}` };
  }
  if (state && state.resultSubtype && state.resultSubtype !== 'success') {
    return { outcome: 'error', stopReason: state.resultSubtype };
  }
  if (state && state.agentRetryFresh) {
    return { outcome: 'error', stopReason: 'resume_thread_missing' };
  }
  if (state && state.agentExit != null && state.agentExit !== 0) {
    return { outcome: 'error', stopReason: 'agent_exit_nonzero' };
  }
  if (state && state.ccExit != null && state.ccExit !== 0) {
    return { outcome: 'error', stopReason: 'claude_exit_nonzero' };
  }
  if (state && state.exitCode != null && state.exitCode !== 0) {
    return { outcome: 'error', stopReason: 'worker_exit_nonzero' };
  }
  return { outcome: 'error', stopReason: 'agent_error' };
}

function claudeBillingPath({ directByok, byokCents, costUsd }) {
  if (directByok) return 'anthropic_byok';
  const observedByok = Number(byokCents || 0);
  if (observedByok <= 0) return 'platform';
  const totalCents = Number(costUsd) * 100;
  if (Number.isFinite(totalCents) && totalCents > 0
      && observedByok >= totalCents - 0.5) return 'anthropic_byok';
  if (Number.isFinite(totalCents) && totalCents > 0) {
    // A proxy-routed run can cross the allowance boundary mid-turn. Keep the
    // provider-reported total intact while naming the two-payer path instead
    // of presenting a known mixed run as missing attribution.
    return 'anthropic_mixed';
  }
  return 'unknown';
}

function recordClaudeCodingRun({
  sessionId, turnId, result, requestedModel, component, startedAt, durationMs,
  directByok = false, byokCents = 0, attemptNumber = 1, correlationId = null,
}) {
  if (!component || !turnId) return;
  const { outcome, stopReason } = codingRunOutcome(result);
  const knownCost = Number(result && result.costUsd);
  const costWasReported = !!(result && result.providerCostSeen)
    || (Number.isFinite(knownCost) && knownCost > 0);
  const costUsd = costWasReported && Number.isFinite(knownCost) && knownCost >= 0
    ? knownCost
    : null;
  void llmTelemetry.record(_getPoolSafe(), {
    invocationKey: `claude_code:${turnId}`,
    timestamp: startedAt,
    sessionId,
    provider: 'anthropic',
    backend: 'coding_agent',
    component,
    requestedModel,
    servedModel: (result && result.agentModel) || requestedModel || null,
    billingPath: claudeBillingPath({ directByok, byokCents, costUsd }),
    // Current Claude result events expose aggregate run usage. Older or
    // partial result shapes keep these fields null; no values are inferred
    // from cost or duration.
    inputTokens: result && result.inputTokens,
    cacheReadInputTokens: result && result.cachedInputTokens,
    cacheWriteInputTokens: result && result.cacheWriteInputTokens,
    outputTokens: result && result.outputTokens,
    reasoningOutputTokens: result && result.reasoningOutputTokens,
    costUsd,
    costSource: costUsd == null ? 'unavailable' : 'provider_reported',
    durationMs,
    outcome,
    stopReason,
    attemptNumber,
    correlationId: correlationId || String(turnId),
  });
}

// ──────────────────────────────────────────────────────────────────────
// Image build
// ──────────────────────────────────────────────────────────────────────

async function ensureWorkerImage() {
  if (usesKubernetesWorkers()) {
    if (!(process.env.KUBERNETES_WORKER_IMAGE || '').includes('@sha256:')) {
      throw new Error('KUBERNETES_WORKER_IMAGE must be configured with an immutable digest');
    }
    return;
  }
  // Always build; Docker's layer cache makes this fast when nothing's
  // changed, and crucially picks up edits to worker-run.sh / run-cc.sh
  // without requiring a manual `docker rmi`.
  //
  // CLAUDE_CODE_CACHE_BUST (today's UTC date) busts the
  // `npm install -g @anthropic-ai/claude-code` layer once per calendar
  // day so the worker tracks the latest CLI. Without this, that layer is
  // cached indefinitely and the worker freezes at a stale CLI version —
  // newer models (Sonnet 5 / Opus 4.8) then 400 with
  // "thinking.type.enabled is not supported for this model" because the
  // old CLI emits the legacy thinking shape. Day-granular so steady-state
  // session bootstraps stay cache-fast (no per-session npm reinstall).
  const path = require('path');
  const workerDir = path.join(__dirname, '../../worker');
  const cacheBust = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  log.info('worker', 'Building worker image', { dir: workerDir, cacheBust });
  await docker.buildImage(workerDir, WORKER_IMAGE, {
    CLAUDE_CODE_CACHE_BUST: cacheBust,
  });
}

// Docker-volume name used to persist Claude Code's on-disk session
// memory (~/.claude) for a given chat session. Reused across every
// turn — and across container churn (eviction + re-warm) — of the
// same chat so `--resume <cc_session_id>` can replay context from disk.
function ccVolumeName(sessionId) {
  return `usernode-cc-${sessionId}`;
}

function workerContainerName(sessionId) {
  return `usernode-worker-${sessionId}`;
}

// Runtime object name for a session worker. Keep the Docker name stable for
// single-server installs, while Kubernetes callers address the Deployment /
// Pod through the name used by kubernetes.ensureWorker().
function workerRuntimeName(sessionId) {
  return usesKubernetesWorkers()
    ? kubernetes.dnsName(`sv-worker-s${sessionId}`)
    : workerContainerName(sessionId);
}

// Per-turn journal file inside the CC volume (/home/node/.claude). The
// detached `docker exec` wrapper redirects run-cc.sh's combined output
// here so the turn's progress stream survives a platform restart: the
// volume outlives both the exec and the platform process, and the boot
// adoption path can replay the file from line 0 to pick the turn back
// up. One turn per session is in flight at a time (enforced via the
// warm registry), so the timestamp suffix only disambiguates the
// current turn from stale leftovers (which the wrapper rm's first).
function turnJournalPath(turnId) {
  return turnLifecycle.journalPathForAttempt(turnId);
}

// Per-turn prompt file inside the CC volume. The dispatch prompt used to
// travel as a `docker exec -e PROMPT=<value>` argument, but Linux caps a
// single argv/env string at 128 KiB (MAX_ARG_STRLEN) — a session with a
// large spec doc pushed the build prompt past the cap and every dispatch
// died with `spawn E2BIG` before the exec existed (prod session 2538).
// The prompt is now materialized here via stdin (base64-inlined, so it
// never rides argv/env) and run-cc.sh pipes it to the claude CLI from
// disk. Lives outside the repo checkout, so `git add -A` can't commit
// it; the detached wrapper rm's it when the turn ends.
const TURN_PROMPT_PATH = '/home/node/.claude/turn-prompt.txt';

// Shell script that writes `prompt` to TURN_PROMPT_PATH. The base64
// payload is split into bounded chunks appended by `printf` (a shell
// builtin — no exec, so no MAX_ARG_STRLEN exposure) so the script works
// for prompts of any size regardless of the container shell's line
// handling. Pure — exported for unit tests.
const PROMPT_B64_CHUNK = 64 * 1024;
function buildTurnPromptScript(prompt) {
  const b64 = Buffer.from(String(prompt), 'utf8').toString('base64');
  const lines = [
    'set -e',
    'mkdir -p /home/node/.claude',
    `: > ${TURN_PROMPT_PATH}.b64`,
  ];
  for (let i = 0; i < b64.length; i += PROMPT_B64_CHUNK) {
    lines.push(`printf '%s' '${b64.slice(i, i + PROMPT_B64_CHUNK)}' >> ${TURN_PROMPT_PATH}.b64`);
  }
  lines.push(`base64 -d < ${TURN_PROMPT_PATH}.b64 > ${TURN_PROMPT_PATH}`);
  lines.push(`rm -f ${TURN_PROMPT_PATH}.b64`);
  return lines.join('\n') + '\n';
}

// Materialize the dispatch prompt into the warm worker's CC volume ahead
// of the detached exec. Unlike syncUserAgentFiles this file is required:
// a failure here fails the turn (before active_turn is persisted, so
// there is nothing to clean up).
async function writeTurnPrompt(sessionId, prompt) {
  const meta = _registryGet(sessionId);
  if (!meta) {
    throw new Error(`writeTurnPrompt: no warm worker registered for session ${sessionId}`);
  }
  if (usesKubernetesWorkers()) {
    await execWorkerCommand(meta.containerName, ['sh', '-s'], buildTurnPromptScript(prompt));
  } else {
    await docker.execShellStdin(meta.containerName, buildTurnPromptScript(prompt), {
      timeoutMs: 20000, label: 'writeTurnPrompt',
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Durable turn records (chat_sessions.active_turn)
// ──────────────────────────────────────────────────────────────────────
//
// Written before the detached dispatch and cleared when the journal has
// been consumed to completion. If the platform dies mid-turn the record
// survives, and server.js's adoption path resumes the turn from its
// journal instead of killing the in-container claude.
//
// The pool singleton is created by server.js at boot, long before any
// turn can run, so the bare getPool() here never constructs.
function _getPoolSafe() {
  try {
    return require('../db/pool').getPool();
  } catch {
    return null;
  }
}

async function _persistActiveTurn(sessionId, turn) {
  const pool = _getPoolSafe();
  if (!pool) return false;
  try {
    const current = await turnLifecycle.loadActiveTurn(pool, sessionId);
    if (current) {
      // Codex registers the ledger row and dispatch intent atomically before
      // entering execInWorker. Accept only that exact physical attempt; this
      // function is not allowed to replace an earlier attempt merely because
      // it shares a logical turn id.
      const isRegisteredAttempt = !!(
        turn.backend === 'codex_openrouter'
        && current.backend === 'codex_openrouter'
        && turn.turnUuid
        && String(current.turnUuid || '') === String(turn.turnUuid)
        && String(turnLifecycle.turnIdentity(current) || '') === String(turn.turnId || '')
        && current.phase === turnLifecycle.PHASE_DISPATCH_PENDING
        && String(current.journal || '') === String(turn.journal || '')
      );
      if (isRegisteredAttempt) return true;
      const err = new Error('turn-lifecycle: session already owns a different turn');
      err.code = 'session_busy';
      throw err;
    }
    await turnLifecycle.persistNewTurn(pool, sessionId, turn);
    return true;
  } catch (err) {
    log.warn('worker', 'Failed to persist active_turn', { sessionId, err: err.message });
    return false;
  }
}

async function clearActiveTurn(sessionId, { turnId = null, journal = null } = {}) {
  const pool = _getPoolSafe();
  if (!pool) return false;
  try {
    if (!turnId && !journal) {
      const err = new Error('clearActiveTurn: durable turn identity required');
      err.code = 'turn_identity_required';
      throw err;
    }
    await turnLifecycle.markCleanupPending(pool, { sessionId, turnId, journal });
    await turnLifecycle.clearCleanupPending(pool, { sessionId, turnId, journal });
    return true;
  } catch (err) {
    log.warn('worker', 'Failed to clear active_turn', { sessionId, err: err.message });
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Post-agent TAIL: keeping the turn record alive past the exec
// ──────────────────────────────────────────────────────────────────────
//
// A dispatch turn has TWO halves and only the first one used to be
// durable:
//
//   1. the exec — `claude` running in the worker, journalled to disk;
//   2. the TAIL — everything the platform does afterwards: heal the
//      push, open/update the PR, build the staging preview, capture
//      visuals, post the "Claude Code finished" card, and re-issue the
//      Mayor's wrap-up.
//
// The tail is minutes long (a self-app staging build alone spends ~4:45
// cloning the platform DB) and ran with `active_turn` ALREADY cleared,
// so a restart inside it was invisible to boot adoption: the container
// had no live exec, adoptOrphanWorker took its warm-idle branch, and the
// chat froze on "Building staging preview..." forever (session 2954).
//
// So callers that own a tail pass `holdTurnRecord: true` to
// execInWorker. Instead of clearing the record when the journal is
// consumed, it stamps `phase: 'tail_pending'` and KEEPS the journal file — which
// is exactly what resumeDetachedTurn needs to replay the turn and run
// finalizeRecoveredTurn on the next boot. The owner calls finishTurn() only
// at its explicit completion boundary; a thrown tail deliberately keeps it.
//
// `tail` on the record is the milestone map: which tail steps already
// landed, so a resumed tail redoes none of them (see noteTailMilestone).
const TURN_PHASE_TAIL = turnLifecycle.PHASE_TAIL_PENDING;

async function markTurnTail(sessionId, milestones = {}, { turnId = null, journal = null } = {}) {
  const pool = _getPoolSafe();
  if (!pool) throw new Error('markTurnTail: database pool unavailable');
  const meta = _registryGet(sessionId);
  let identity = turnId || meta?.finishedTurnId || null;
  let recoveryJournal = journal || meta?.finishedJournal || null;
  try {
    if (!identity && !recoveryJournal) {
      const err = new Error('markTurnTail: durable turn identity required');
      err.code = 'turn_identity_required';
      throw err;
    }
    await turnLifecycle.markTailPending(pool, {
      sessionId,
      turnId: identity,
      journal: recoveryJournal,
      patch: { tail: milestones || {} },
    });
    return true;
  } catch (err) {
    log.warn('worker', 'Failed to mark active_turn tail', { sessionId, err: err.message });
    throw err;
  }
}

// Record ONE tail milestone on the held record (merge, never replace).
// No-op when the record is already gone — a stamp arriving after finishTurn
// must not resurrect it. Every live/recovered caller supplies either its
// explicit identity or the identity remembered by execInWorker; there is no
// session-only mutation fallback.
async function noteTailMilestone(sessionId, milestones, { turnId = null, journal = null } = {}) {
  if (!milestones || typeof milestones !== 'object') return false;
  const pool = _getPoolSafe();
  if (!pool) throw new Error('noteTailMilestone: database pool unavailable');
  const meta = _registryGet(sessionId);
  const identity = turnId || meta?.finishedTurnId || null;
  const recoveryJournal = journal || meta?.finishedJournal || null;
  try {
    if (!identity && !recoveryJournal) {
      const err = new Error('noteTailMilestone: durable turn identity required');
      err.code = 'turn_identity_required';
      throw err;
    }
    const result = await turnLifecycle.mergeTailMilestones(pool, {
      sessionId,
      turnId: identity,
      journal: identity ? null : recoveryJournal,
      milestones,
    });
    return result.updated;
  } catch (err) {
    log.warn('worker', 'Failed to note tail milestone', { sessionId, err: err.message });
    throw err;
  }
}

// Mark a completed missing-thread attempt as prepared for the one allowed
// live retry. Preparation remains a tail_pending state: only the atomic
// startCodexAttempt transaction may advance the durable record back to
// dispatch_pending with attempt two's ledger identity.
async function markTurnRetryPending(sessionId, {
  turnUuid, logicalTurnId, attemptNumber = 1,
} = {}) {
  const pool = _getPoolSafe();
  if (!pool) throw new Error('markTurnRetryPending: database pool unavailable');
  await turnLifecycle.transitionTurn(pool, {
    sessionId,
    turnId: logicalTurnId,
    turnUuid,
    from: [turnLifecycle.PHASE_TAIL_PENDING, 'tail', 'retry_pending'],
    to: turnLifecycle.PHASE_TAIL_PENDING,
    patch: {
      retryFresh: true,
      logicalTurnId,
      attemptNumber,
      retryPreparedAt: new Date().toISOString(),
    },
  });
  return true;
}

// End of the whole turn (exec + tail): drop the durable record and the
// journal it pointed at. This is what execInWorker's `finally` does for
// callers that DON'T hold the record; holders call it themselves when
// their tail finishes (or dies). Idempotent — safe to call twice, and
// safe to call for a turn that never held a record.
// Is this active_turn record a held TAIL (the exec is over, the platform
// side is not)? Pure so server.js's adoption branches and their tests can
// classify a row without a pool. Tolerates a string-encoded jsonb column.
function isTailPhase(activeTurn) {
  if (!activeTurn) return false;
  let rec = activeTurn;
  if (typeof rec === 'string') {
    try { rec = JSON.parse(rec); } catch { return false; }
  }
  return !!rec && (rec.phase === TURN_PHASE_TAIL || rec.phase === 'tail');
}

async function finishTurn(sessionId, { journal = null, turnId = null } = {}) {
  const meta = _registryGet(sessionId);
  const rememberedJournal = meta?.finishedJournal || null;
  const rememberedTurnId = meta?.finishedTurnId || null;
  const journalPaths = new Set([journal, rememberedJournal].filter(Boolean));
  const pool = _getPoolSafe();
  if (!pool) return false;
  let ownsCleanup = false;
  let cleanupTurnId = null;
  let cleanupJournal = null;
  try {
    const current = await turnLifecycle.loadActiveTurn(pool, sessionId);
    if (current) {
      // Never infer ownership from the record currently occupying the
      // session. A stale caller may be looking at a replacement turn; only
      // the identity it carried (or execInWorker remembered for it) can clear.
      if (turnId) cleanupTurnId = turnId;
      else if (journal) cleanupJournal = journal;
      else if (rememberedTurnId) cleanupTurnId = rememberedTurnId;
      else if (rememberedJournal) cleanupJournal = rememberedJournal;
      if (!cleanupTurnId && !cleanupJournal) {
        const err = new Error('finishTurn: durable turn identity required');
        err.code = 'turn_identity_required';
        throw err;
      }
      const cleanup = await turnLifecycle.markCleanupPending(pool, {
        sessionId,
        turnId: cleanupTurnId,
        journal: cleanupJournal,
      });
      ownsCleanup = !cleanup.alreadyCleared;
      if (ownsCleanup && current.journal) journalPaths.add(current.journal);
    }
  } catch (err) {
    log.warn('worker', 'Turn cleanup deferred because active_turn could not be cleared', {
      sessionId, journalCount: journalPaths.size, err: err.message,
    });
    return false;
  }

  // Keep cleanup_pending durable while removing the shared prompt. If the
  // row were cleared first, a replacement dispatch could write its prompt
  // in the gap and this stale cleanup would delete the new turn's input.
  // An idempotent call after the row is already gone may remove only UUID-
  // unique journals; it never owns the shared prompt path.
  const filesToRemove = [...journalPaths];
  if (ownsCleanup) filesToRemove.push(TURN_PROMPT_PATH);
  if (filesToRemove.length) {
    const containerName = _registryGet(sessionId)?.containerName
      || workerContainerName(sessionId);
    await docker.execFileAsync('docker', [
      'exec', containerName, 'rm', '-f', ...filesToRemove,
    ], { timeout: 5000 }).catch(() => {});
  }

  if (ownsCleanup) {
    try {
      await turnLifecycle.clearCleanupPending(pool, {
        sessionId,
        turnId: cleanupTurnId,
        journal: cleanupJournal,
      });
    } catch (err) {
      log.warn('worker', 'Turn cleanup deferred because active_turn could not be cleared', {
        sessionId, journalCount: journalPaths.size, err: err.message,
      });
      return false;
    }
  }
  _registryUpsert(sessionId, { finishedJournal: null, finishedTurnId: null });
  return true;
}

// ──────────────────────────────────────────────────────────────────────
// Warm-worker registry
// ──────────────────────────────────────────────────────────────────────
//
// Long-lived per-session worker containers are tracked here so the host
// knows which sessions have a warm container ready to take execs, when
// each was last used (for idle eviction), and whether one is currently
// running a `docker exec` (for stop semantics + drain).
//
// Shape: Map<sessionId:number, {
//   containerName: string,
//   lastUsedMs:    number,    // updated when an exec completes / on adopt
//   inFlight:      boolean,   // true while a docker-exec child is running
//   bootstrap:     Promise|null,   // present while ensureWorker is racing
//   adopted:       boolean,   // true if registered via adoptWarmWorker
// }>
//
// Lifecycle:
//   - ensureWorker()    → creates entry on first use, awaits bootstrap.
//   - execInWorker()    → toggles inFlight + bumps lastUsedMs on finish.
//   - evictWorker()     → docker stop+rm, deletes entry. Volume kept.
//   - destroyWorker()   → also deletes the entry (compat path used by
//                         legacy adoption + session archive).
//   - adoptWarmWorker() → server restart picked up an existing warm
//                         container; register it so the next exec
//                         doesn't try to re-bootstrap on top.
const _warmRegistry = new Map();

function _registryGet(sessionId) {
  return _warmRegistry.get(sessionId) || null;
}

function _registryUpsert(sessionId, patch) {
  const existing = _warmRegistry.get(sessionId);
  const prev = existing || {
    containerName: workerContainerName(sessionId),
    lastUsedMs: Date.now(),
    inFlight: false,
    bootstrap: null,
    adopted: false,
  };
  const next = { ...prev, ...patch };
  _warmRegistry.set(sessionId, next);
  // #1038: the inner docker-exec window is one of the two signals
  // isSessionBusy() ORs together, so a change here can flip a session's
  // working state for every client. Only the actual transition notifies —
  // lastUsedMs bumps and bootstrap bookkeeping are invisible to clients.
  if (!!prev.inFlight !== !!next.inFlight) {
    try {
      require('./active-workers').notifySessionState(sessionId);
    } catch { /* notifier is best-effort */ }
  }
  return next;
}

// Cheap "is this session's worker actively running CC right now?" check.
// Mirrors the in-process `inFlight` flag set by execInWorker. A warm-but-
// idle container (sleep wrapper alive, no `docker exec` running)  → false.
// Returns false when no warm registry entry exists at all (no worker
// ever started, or the entry was evicted).
//
// Use this — NOT `containerStatus === 'running'` — anywhere you need to
// gate logic on "a CC turn is in progress for this session". The
// container-status check predates `keep cc warm between calls` and now
// over-reports busy for the entire warm-idle window (~10 min until the
// sweeper evicts), which strands the dev-chat UI in stop-sign mode if
// the POST SSE drops before delivering its `done` event.
function isInFlight(sessionId) {
  return _warmRegistry.get(sessionId)?.inFlight === true;
}

// Read-only snapshot of the warm registry. Safe to expose to the idle-
// eviction sweeper and the /api/status admin page.
function warmRegistrySnapshot() {
  const out = [];
  for (const [sessionId, meta] of _warmRegistry.entries()) {
    out.push({
      sessionId,
      containerName: meta.containerName,
      lastUsedMs: meta.lastUsedMs,
      inFlight: meta.inFlight,
      bootstrapping: !!meta.bootstrap,
      adopted: !!meta.adopted,
      // #889: a stop has been signalled for this worker's turn but the turn
      // hasn't unwound yet. Additive diagnostics — same spirit as inFlight —
      // and it's what makes the flag observable without exporting internals.
      stopRequestedAt: meta.stopRequestedAt || null,
    });
  }
  return out;
}

// Register a warm container that already exists (either spawned by us
// earlier in this process, or adopted from a previous server run).
function adoptWarmWorker(sessionId, containerName = null) {
  _registryUpsert(sessionId, {
    containerName: containerName || workerContainerName(sessionId),
    lastUsedMs: Date.now(),
    inFlight: false,
    bootstrap: null,
    adopted: true,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Bootstrap (cold start) + warm-ready wait
// ──────────────────────────────────────────────────────────────────────

// Spawn a brand-new warm worker container. Internal to this module —
// callers should use `ensureWorker` which handles the "already warm"
// case and concurrency.
async function _bootstrapWarmContainer(sessionId, {
  repoOwner, repoName, branchName, onProgress,
}) {
  let containerName = workerContainerName(sessionId);

  // Defensive: scrub any leftover container at this name. ensureWorker
  // already checks for `running` and returns early; anything else (exited,
  // restarting, dead) gets reaped here so `docker run --name` can succeed.
  if (!usesKubernetesWorkers()) await docker.stopAndRemove(containerName).catch(() => {});

  // Public-only invariant: the worker carries no GitHub credentials in
  // its env — it relies on the unauthenticated git protocol for clones
  // and fetches. Refuse to spawn against a repo that has gone private
  // since import. Verified at import time too (verifyBotAccess), but
  // a user could flip the repo to private on GitHub after import; this
  // catches that case before we waste a container slot. Imports that
  // pre-date the public-only enforcement are caught here as well.
  const privacy = await github.checkRepoPublic(repoOwner, repoName);
  if (!privacy.ok) {
    throw new Error(
      `Cannot bootstrap worker for ${repoOwner}/${repoName}: ${privacy.message}`
    );
  }
  if (privacy.private) {
    throw new Error(
      `Cannot bootstrap worker for ${repoOwner}/${repoName}: repo is private. Usernode requires public repositories — make it public on GitHub or delete this app and re-import.`
    );
  }

  // Plain HTTPS clone URL with no embedded token. Public repos clone
  // anonymously; the credential helper in worker-run.sh is skipped when
  // PAT is unset, so the worker container ends up with no auth wired
  // into git at all.
  const cloneUrl = await github.getCloneUrl(repoOwner, repoName);

  // Commit 1 (plan 3.4): the warm container's bootstrap environment MUST
  // contain no provider keys and no worker capability tokens. The long-
  // lived container is now created with ONLY operational configuration;
  // every credential/capability is injected on the individual per-turn
  // `docker exec` instead. worker-run.sh in warm mode only clones,
  // checks out, initializes files, and sleeps.
  const ccVolume = ccVolumeName(sessionId);
  if (!usesKubernetesWorkers()) await docker.ensureVolume(ccVolume);

  const safeEnv = {
    GIT_AUTHOR_NAME: 'usernode-bot',
    GIT_AUTHOR_EMAIL: 'usernode-bot@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'usernode-bot',
    GIT_COMMITTER_EMAIL: 'usernode-bot@users.noreply.github.com',
    BRANCH: branchName,
    // MODE=warm tells worker-run.sh to clone + checkout + sleep
    // infinity, so subsequent `docker exec` calls drive per-turn work.
    MODE: 'warm',
    // CLONE_URL has no token in it now; safe to pass inline.
    CLONE_URL: cloneUrl,
    // Used by /usr/local/bin/usernode-push to identify the calling
    // session and reach the platform's internal API.
    SESSION_ID: String(sessionId),
    PLATFORM_URL: PLATFORM_INTERNAL_URL,
  };
  if (usesKubernetesWorkers()) {
    const result = await kubernetes.ensureWorker(kubernetesWorkerConfig(), {
      sessionId,
      env: safeEnv,
    });
    containerName = result.runtimeName;
    log.info('worker', 'Warm worker Pod ready', { runtimeName: containerName, pvc: result.pvcName });
    return containerName;
  }
  const safeEnvArgs = Object.entries(safeEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  const network = process.env.DOCKER_NETWORK || 'shared-web';

  // No --rm — we want the container to stick around so the host can
  // re-attach to it on restart (orphan adoption) and so eviction is
  // an explicit policy decision, not a side effect of the wrapper exiting.
  const args = [
    'run', '-d',
    '--name', containerName,
    '--hostname', containerName,
    '--network', network,
    '--memory', WORKER_MEMORY,
    '--cpus', WORKER_CPUS,
    '--security-opt', 'no-new-privileges:true',
    // Warm-runtime migration marker. No secrets are injected at bootstrap,
    // and ensureWorker evicts any container whose label differs from the
    // current host/runner contract (including old images with obsolete token
    // requirements or retry behavior).
    '--label', `usernode.proxy=${WORKER_BOOTSTRAP_ENV_VERSION}`,
    '-v', `${ccVolume}:/home/node/.claude`,
    ...safeEnvArgs,
    WORKER_IMAGE,
  ];

  await docker.execFileAsync('docker', args, {
    timeout: 30000,
  });
  log.info('worker', 'Warm worker spawned', { containerName, ccVolume });

  // Wait for the wrapper to reach `__USERNODE_PHASE__ warm-ready`.
  // Bootstrap progress (clone/checkout) flows through onProgress so the
  // dev-chat UI sees [clone] / [checkout] phase ticks just like the
  // legacy single-shot path used to surface them.
  await _awaitWarmReady(containerName, { onProgress });

  return containerName;
}

// Tail `docker logs -f` until the warm-ready phase marker shows up, or
// the container dies, or we hit a timeout. SIGKILL the tail before
// returning so we don't leak children.
async function _awaitWarmReady(containerName, { onProgress, timeoutMs = WARM_READY_TIMEOUT_MS } = {}) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  return await new Promise((resolve, reject) => {
    const proc = spawn('docker', ['logs', '-f', containerName]);
    let buf = '';
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      try { proc.kill('SIGKILL'); } catch {}
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`warm-ready timeout for ${containerName}`)),
      timeoutMs
    );
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith('__USERNODE_ERROR__')) {
          return finish(new Error(line.replace('__USERNODE_ERROR__', '').trim()));
        }
        if (line.startsWith('__USERNODE_PHASE__')) {
          const phase = line.replace('__USERNODE_PHASE__', '').trim();
          progress(`[${phase}]`);
          if (phase === 'warm-ready') return finish();
          continue;
        }
        if (line.length < 500) progress(line);
      }
    });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.trim() && line.length < 500) progress(line);
      }
    });
    proc.on('close', (code) => {
      // The warm wrapper does `exec sleep infinity`, so logs -f only
      // exits if the container died (or we SIGKILLed the tail). If we
      // hit close before warm-ready, bootstrap failed mid-flight.
      finish(new Error(`warm wrapper exited before warm-ready (code=${code})`));
    });
    proc.on('error', (err) => finish(err));
  });
}

// ──────────────────────────────────────────────────────────────────────
// Public API: ensureWorker, execInWorker, evictWorker
// ──────────────────────────────────────────────────────────────────────

// Idempotently get a warm worker container ready for `execInWorker`.
//
// Cold path: spins up the container (~5-10s docker run + clone +
// checkout + warm-ready ~5-30s). Warm path: cheap no-op once the
// container is running, even across multiple concurrent callers (the
// in-flight bootstrap promise is shared via `_warmRegistry[i].bootstrap`).
//
// Returns the container name. Throws if bootstrap fails — in which case
// the registry entry is cleared so the next caller retries from scratch.
async function ensureWorker(sessionId, {
  repoOwner, repoName, branchName,
  onProgress,
} = {}) {
  const containerName = workerRuntimeName(sessionId);

  // Coalesce concurrent ensures — if one's already racing, await it.
  const existing = _registryGet(sessionId);
  if (existing?.bootstrap) {
    await existing.bootstrap;
    return containerName;
  }

  // Already warm? Confirm with Docker before trusting the registry —
  // an external `docker rm` would otherwise leave stale state.
  const status = usesKubernetesWorkers()
    ? await kubernetes.getWorkerStatus(kubernetesWorkerConfig(), containerName)
    : await docker.getContainerStatus(containerName);
  if (status === 'running') {
    // Runtime-contract migration gate: earlier warm containers may have
    // stale bootstrap credentials, token requirements, or runner semantics
    // that the current host no longer supports. Detect them via the persisted
    // usernode.proxy label and force a re-bootstrap. Cheap — one Docker
    // inspect on the warm-path hot path.
    const labels = usesKubernetesWorkers()
      ? { 'usernode.proxy': WORKER_BOOTSTRAP_ENV_VERSION }
      : await docker.getContainerLabels(containerName);
    if (labels['usernode.proxy'] !== WORKER_BOOTSTRAP_ENV_VERSION) {
      log.info('worker', 'Evicting stale-label warm container', { containerName });
      await evictWorker(sessionId).catch((err) => {
        log.warn('worker', 'Eviction failed; falling through to bootstrap', {
          containerName, err: err.message,
        });
      });
      // fall through to the bootstrap branch below
    } else {
      if (!existing) {
        _registryUpsert(sessionId, { containerName, lastUsedMs: Date.now(), inFlight: false });
      }
      return containerName;
    }
  }

  // Anything else (exited, dead, restarting, or not_found): re-bootstrap.
  // _bootstrapWarmContainer reaps any stale container before docker run.
  const bootstrap = (async () => {
    try {
      const runtimeName = await _bootstrapWarmContainer(sessionId, {
        repoOwner, repoName, branchName, onProgress,
      });
      _registryUpsert(sessionId, {
        containerName: runtimeName,
        bootstrap: null,
        lastUsedMs: Date.now(),
        inFlight: false,
        adopted: false,
      });
    } catch (err) {
      _warmRegistry.delete(sessionId);
      throw err;
    }
  })();
  _registryUpsert(sessionId, { bootstrap });
  await bootstrap;
  return containerName;
}

// Run one CC turn inside an already-warm container, detached: the exec
// is dispatched with `docker exec -d`, its output lands in a journal
// file in the CC volume, and we follow the journal through the shared
// `parseLine` state machine. The dev-chat UI sees identical progress
// markers to the old attached transport — but the turn itself survives
// a platform restart (boot adoption resumes it via the
// chat_sessions.active_turn record + resumeTurnFromJournal).
//
// Returns the same shape watchWorker produces, so route callers can swap
// `spawnWorker + watchWorker` for `ensureWorker + execInWorker` without
// touching the post-processing logic (PR creation, staging build, etc.).
async function execInWorker(sessionId, {
  mode = 'build',
  prompt,
  // Restart recovery can reuse the prompt file deliberately retained by a
  // runner that emitted agent_retry_fresh=1. Live calls keep writing the
  // supplied prompt exactly as before.
  reusePromptFile = false,
  model,
  commitMsg,
  resumeSessionId,
  branchName,
  anthropicApiKey,
  // Backend selection (plan.md): when 'codex_openrouter', the turn is
  // dispatched to the Codex runner with the user's per-exec OpenRouter key
  // (direct transport) instead of the Claude runner + Anthropic proxy.
  // Defaults to claude_code (unchanged behavior).
  agentBackend = 'claude_code',
  // Codex/OpenRouter-specific turn context (direct transport, review P0):
  // the user's OpenRouter key is passed in ONLY for this specific docker
  // exec (injected as OPENROUTER_API_KEY into the per-turn environment),
  // plus the session-pinned model and reasoning effort.
  agentModel = null,
  agentReasoningEffort = null,
  agentModelMetadata = null,
  openrouterApiKey = null,
  openrouterApiBase = null,
  turnUuid = null,
  logicalTurnId = null,
  attemptNumber = null,
  // Content-free component attribution for #717. Persisted in active_turn
  // so restart recovery records the same physical invocation exactly once.
  telemetryComponent = null,
  telemetryCorrelationId = null,
  telemetryAttemptNumber = null,
  // Optional preselected journal path. Codex attempt registration can supply
  // a deterministic path once attempt creation moves into the same DB
  // transaction; ordinary callers leave it null.
  journalPath = null,
  onProgress,
  // #616: when true (admin-owned session on the self-edit app — the
  // caller checks via debug-access.isEligible), the turn env gains
  // PROD_DEBUG_JWT so the usernode-debug CLI can call the platform's
  // read-only prod-debug internal API. Build/scout only, never sync.
  prodDebug = false,
  // When true the caller owns a post-agent TAIL (PR → staging → cards →
  // wrap-up) and takes over the turn record's lifetime: this function
  // stamps `phase: 'tail_pending'` instead of clearing it, and leaves the journal
  // on disk so a restart mid-tail can replay the turn. The caller MUST
  // call finishTurn(sessionId, { turnId }) at its explicit completion
  // boundary. Interactive callers may defer that boundary through the Mayor
  // wrap-up; headless callers finish in their own tool-side finally. See the
  // "Post-agent TAIL" note above. Default false — the sync path and any
  // future tail-less caller keep the original clear-on-exit behaviour.
  holdTurnRecord = false,
  // Kept as a compatibility option for older call sites. Persistence is now
  // required for every dispatch, not only recovered retries.
  requireActiveTurnPersistence = false,
  // Legacy callback: the attached transport used to hand the host-side
  // `docker exec` child to the route handler for SIGTERM-based stops.
  // The detached transport has no such child — stops go through
  // stopTurn() — so this is invoked with null purely for back-compat.
  onChild,
} = {}) {
  const meta = _registryGet(sessionId);
  if (!meta) {
    throw new Error(`execInWorker: no warm worker registered for session ${sessionId}`);
  }
  if (meta.inFlight) {
    throw new Error(`execInWorker: a turn is already in flight for session ${sessionId}`);
  }
  if (!prompt && !reusePromptFile) {
    throw new Error('execInWorker: prompt required');
  }
  const containerName = meta.containerName;
  const durableTurnId = logicalTurnId || turnUuid || turnLifecycle.newTurnId();
  // Only caller-supplied identities can already own a durable row at this
  // point. A legacy Claude dispatch gets its active_turn below, after the
  // stop gate, so its freshly generated fallback id must not be returned as
  // though it had been registered when the gate prevents that write.
  const preRegisteredTurnId = logicalTurnId || turnUuid || null;

  // #937: honour a stop that was requested while this turn was still
  // spinning up. Historically the dispatch upsert below cleared
  // `stopRequestedAt` — it could not tell a previous turn's leftover from
  // a stop aimed at THIS turn seconds ago — so a stop clicked during
  // ensureWorker/syncUserAgentFiles was erased by the very dispatch it was
  // meant to prevent, and the agent ran to completion (production session
  // 2974: 17m51s of agent time after the click). The flag is now cleared
  // only at a real new-turn boundary via clearPendingStop(), so reading it
  // here is authoritative.
  //
  // Checked FIRST, ahead of the JWT mint and the prompt-file write, so a
  // stop that has already landed costs nothing at all — and returns the
  // shape a genuinely killed turn produces, so every downstream consumer
  // (the caller's stopped branch, the tail, the watchdog) behaves exactly
  // as it does for a real in-flight kill.
  if (getPendingStop(sessionId)) {
    log.info('worker', 'Dispatch skipped — stop requested during spin-up', {
      sessionId, containerName, mode,
    });
    const stopped = newWatchState();
    // Codex registers its ledger row + durable active_turn atomically before
    // entering this function. Preserve that already-owned logical identity
    // even though no paid dispatch occurred, so the caller can terminalize
    // the attempt and release the dispatch_pending record immediately.
    stopped.turnId = preRegisteredTurnId;
    stopped.agentBackend = agentBackend;
    stopped.execExitSeen = true;
    stopped.exitCode = 143;
    return stopped;
  }

  // Re-mint the JWT on every turn so the worker's auth always has at
  // least WORKER_JWT_TTL left, regardless of how long the warm
  // container has been alive. This avoids edge cases where a session
  // outlives its bootstrap-time token (24h is the cap today; could be
  // shorter later) and the next push fails with 401 from the proxy.
  // One backend decision for this whole dispatch (review Commit 1 /
  // plan 3.1): all runner/token/env/active-turn choices derive from it.
  const { backend: resolvedBackend, isCodex, isClaude } = resolveTurnBackend(agentBackend);
  const useAnthropicProxy = isClaude && !anthropicApiKey;
  const measuredTelemetryComponent = llmTelemetry.collectionComponent(telemetryComponent);
  const measuredTelemetryCorrelationId = isClaude && measuredTelemetryComponent
    ? (telemetryCorrelationId || durableTurnId)
    : null;
  const measuredTelemetryAttemptNumber = isClaude && measuredTelemetryComponent
    ? (Number(telemetryAttemptNumber) || Number(attemptNumber) || 1)
    : null;

  // Backend-specific capability minting (plan 3.2). Crucially,
  // mintWorkerJwt() (general worker:session) NEVER runs for a Codex turn —
  // the property is structural, not "hide the already-minted token".
  let workerSessionJwt = null;
  let workerPushJwt = null;
  let issuesReadJwt = null;
  let anthropicProxyJwt = null;
  let prodDebugJwt = null;
  issuesReadJwt = mintIssuesReadJwt(sessionId);
  if (isCodex) {
    if (mode === 'build') {
      workerPushJwt = mintWorkerPushJwt(sessionId);
    }
  } else {
    // A scout must never mint a general token at all. Hiding WORKER_JWT while
    // placing the same capability in ISSUES_JWT/ANTHROPIC_API_KEY is not an
    // isolation boundary when the agent has Bash.
    if (mode !== 'scout') workerSessionJwt = mintWorkerJwt(sessionId);
    if (useAnthropicProxy) anthropicProxyJwt = mintAnthropicProxyJwt(sessionId);
    if (prodDebug && mode !== 'sync') {
      prodDebugJwt = mintProdDebugJwt(sessionId);
    }
  }

  const persistedModel = isCodex ? (agentModel || '') : models.resolve(model);

  // The prompt travels as a file, never as exec argv/env — a single
  // argv/env string is capped at 128 KiB on Linux, and build prompts
  // (conventions block + spec doc) legitimately exceed it. See
  // TURN_PROMPT_PATH. Written before active_turn is persisted so a
  // failure here surfaces as a plain turn error with nothing to reap.
  if (!reusePromptFile) {
    await writeTurnPrompt(sessionId, prompt);
  }

  // Anthropic-proxy: when the caller provides a BYOK key (anthropicApiKey
  // truthy), the worker hits api.anthropic.com directly with that key
  // — same flow as before. When no BYOK key is provided we route the
  // SDK's traffic through the platform's in-process proxy at
  // /api/internal/anthropic. The `claude` CLI honors ANTHROPIC_BASE_URL
  // for endpoint retargeting and ANTHROPIC_API_KEY as the x-api-key
  // header, so we put a purpose-bound worker:anthropic-proxy token in
  // ANTHROPIC_API_KEY: the proxy verifies it, swaps in the real
  // platform key, and forwards. The real key never enters the worker
  // container, so a malicious prompt like "echo $ANTHROPIC_API_KEY"
  // exfiltrates only a short-lived JWT that's useless against
  // api.anthropic.com directly.
  const secretEnv = buildTurnSecretEnv({
    mode,
    agentBackend: resolvedBackend,
    workerSessionJwt,
    workerPushJwt,
    issuesReadJwt,
    anthropicProxyJwt,
    anthropicApiKey,
    prodDebugJwt,
    openrouterApiKey,
  });
  const safeEnv = {
    PROMPT_FILE: TURN_PROMPT_PATH,
    MODE: mode,
    BRANCH: branchName || '',
    COMMIT_MSG: commitMsg || 'Changes via Usernode',
    SESSION_ID: String(sessionId),
    PLATFORM_URL: PLATFORM_INTERNAL_URL,
    ...(isClaude ? {
      MODEL: models.resolve(model),
      CLAUDE_RESUME_SESSION_ID: resumeSessionId || '',
      // Retarget the Anthropic SDK through the proxy only for Claude when
      // not BYOK. Never set for Codex.
      ...(useAnthropicProxy
        ? { ANTHROPIC_BASE_URL: `${PLATFORM_INTERNAL_URL}/api/internal/anthropic` }
        : {}),
    } : {}),
    // Optional in-loop browser: build-only INLOOP_* env (port,
    // USERNODE_ENV=staging, throwaway DB pointer) the agent uses to boot
    // the edited app locally for a headless visual check. Empty for
    // scout/sync.
   ...inLoopBrowser.browserEnvForMode(mode),
 };
  if (isCodex) {
    safeEnv.AGENT_BACKEND = 'codex_openrouter';
    safeEnv.AGENT_MODEL = agentModel || '';
    safeEnv.AGENT_REASONING_EFFORT = agentReasoningEffort || '';
    safeEnv.AGENT_MODEL_NAME = agentModelMetadata?.name || agentModel || '';
    safeEnv.AGENT_MODEL_CONTEXT_WINDOW = agentModelMetadata?.contextWindow != null
      ? String(agentModelMetadata.contextWindow)
      : '';
    safeEnv.AGENT_MODEL_MAX_OUTPUT_TOKENS = agentModelMetadata?.maxOutputTokens != null
      ? String(agentModelMetadata.maxOutputTokens)
      : '';
    safeEnv.AGENT_MODEL_SUPPORTS_REASONING = agentModelMetadata?.supportsReasoning == null
      ? ''
      : (agentModelMetadata.supportsReasoning ? '1' : '0');
    safeEnv.AGENT_MODEL_REASONING_EFFORTS = Array.isArray(agentModelMetadata?.reasoningEfforts)
      ? agentModelMetadata.reasoningEfforts.join(',')
      : '';
    safeEnv.AGENT_MODEL_SUPPORTS_TOOLS = agentModelMetadata?.supportsTools == null
      ? ''
      : (agentModelMetadata.supportsTools ? '1' : '0');
    safeEnv.AGENT_THREAD_ID = resumeSessionId || '';
    safeEnv.TURN_UUID = turnUuid || '';
    // The operator-configured OpenRouter endpoint (plan 4): always forward
    // the (already-validated) base so generation and catalog agree.
    safeEnv.OPENROUTER_API_BASE = openrouterApiBase || '';
  }
  const runner = isCodex ? '/usr/local/bin/run-codex-agent.sh' : '/usr/local/bin/run-cc.sh';
 // Journal transport: the turn runs DETACHED from this process. The
  // wrapper below redirects run-cc.sh's combined output to a journal
  // file in the CC volume and appends __USERNODE_EXIT__ <code> when it
  // finishes. We then tail the journal from line 0. If the platform
  // restarts mid-turn, the exec keeps running, the journal keeps
  // filling, and the boot adoption path resumes via the same consumer
  // (resumeTurnFromJournal) using the chat_sessions.active_turn record.
  const journal = journalPath || turnJournalPath(durableTurnId);
  safeEnv.TURN_JOURNAL = journal;

  const secretEnvArgs = Object.keys(secretEnv).flatMap((k) => ['-e', k]);
  const safeEnvArgs = Object.entries(safeEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  const args = [
    'exec', '-d',
    ...secretEnvArgs,
    ...safeEnvArgs,
    containerName,
    'sh', '-c',
    // rm stale journals first so the tailer's existence-wait can't latch
    // onto a leftover file from a previous turn. After the run, decide
    // whether attempt two needs the prompt BEFORE publishing the exit marker:
    // the marker releases the host to start attempt two, so no shared prompt
    // mutation may happen after it becomes observable.
    'rm -f /home/node/.claude/turn-*.log 2>/dev/null; '
      + runner + ' > "$TURN_JOURNAL" 2>&1; '
      + 'TURN_EXIT=$?; '
      // A missing-thread result is a durable hand-off to attempt two. Keep
      // the prompt in the private worker volume until the host (or restart
      // recovery) has launched that attempt. Every other terminal path
      // removes it immediately as before.
      + 'if ! grep -qE "^__USERNODE_RESULT__ .*agent_retry_fresh=1([[:space:]]|$)" "$TURN_JOURNAL"; then '
      + 'rm -f "$PROMPT_FILE" 2>/dev/null; fi; '
      + 'echo "__USERNODE_EXIT__ $TURN_EXIT" >> "$TURN_JOURNAL"; exit "$TURN_EXIT"',
  ];

  // #361: record the in-flight turn's mode in the warm registry so the
  // Anthropic proxy can synchronously tell a sync turn from a build turn
  // and gate it against the system-token budget instead of the owner's.
  // #664: fresh per-turn BYOK spillover counters — see noteTurnByokSpend.
  // `journal` is recorded so stopTurn() can append the exit marker to the
  // turn's own journal (#889) instead of leaving the consumer to discover
  // the kill via its 10s liveness watchdog.
  _registryUpsert(sessionId, {
    inFlight: true, activeTurnMode: mode, journal, activeTurnId: durableTurnId,
    turnByokCents: 0, turnByokSwitched: false,
  });
  const activeTurnPersisted = await _persistActiveTurn(sessionId, {
    turnId: durableTurnId,
    phase: turnLifecycle.PHASE_DISPATCH_PENDING,
    mode,
    journal,
    backend: resolvedBackend,
    turnUuid: turnUuid || undefined,
    // plan 7.4: persist the attempt identity so interactive/headless
    // recovery can terminalize the correct agent_turns row idempotently.
    logicalTurnId: logicalTurnId || undefined,
    attemptNumber: attemptNumber || undefined,
    telemetryComponent: measuredTelemetryComponent || undefined,
    telemetryCorrelationId: measuredTelemetryCorrelationId || undefined,
    telemetryAttemptNumber: measuredTelemetryAttemptNumber || undefined,
    model: persistedModel,
    startedAt: new Date().toISOString(),
    // #174: billing context for restart-resume — the resume paths debit
    // the recovered costUsd into the bucket the turn actually billed,
    // even if the user adds/removes their key while the turn is detached.
    byok: !!anthropicApiKey,
  });
  if (!activeTurnPersisted) {
    _registryUpsert(sessionId, {
      inFlight: false, lastUsedMs: Date.now(), activeTurnMode: null,
      journal: null, activeTurnId: null,
    });
    const err = new Error('execInWorker: durable active turn could not be persisted');
    err.code = requireActiveTurnPersistence
      ? 'durable_retry_persist_failed'
      : 'durable_turn_persist_failed';
    throw err;
  }

  // Visible to the `finally` below, which stamps the tail's seed
  // milestones (sha / pushOk) from whatever the exec established.
  let execState = null;
  let providerStartedAt = null;
  let providerStartedMs = null;
  let providerDispatched = false;
  let providerTerminalObserved = false;
  try {
    // Dispatch. `docker exec -d` returns as soon as the exec is created;
    // secrets travel via the docker CLI's env (bare `-e KEY`), same as
    // the attached transport did.
    providerStartedAt = new Date();
    providerStartedMs = Date.now();
    if (usesKubernetesWorkers()) {
      const exports = Object.entries({ ...secretEnv, ...safeEnv })
        .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
        .join('\n');
      const detached = `${exports}\nnohup sh -c ${shellQuote(args[args.length - 1])} >/dev/null 2>&1 &\n`;
      await execWorkerCommand(containerName, ['sh', '-s'], detached);
    } else {
      await docker.execFileAsync('docker', args, {
        timeout: 30000,
        env: { ...process.env, ...secretEnv },
      });
    }
    providerDispatched = true;
    // The durable dispatch record was committed before docker exec. Advancing
    // the phase is required for normal operation, but after the process has
    // started a transient DB error cannot safely be turned into a second
    // dispatch. Leave dispatch_pending in place; boot recovery treats both
    // dispatch_pending and executing as journal-resumable and never blindly
    // reissues the provider request.
    await turnLifecycle.markExecuting(_getPoolSafe(), {
      sessionId, turnId: durableTurnId,
    }).catch((err) => log.warn('worker', 'Failed to mark turn executing; durable dispatch remains recoverable', {
      sessionId, turnId: durableTurnId, err: err.message,
    }));
    // onChild is legacy: there is no host-side child that owns the turn
    // anymore. Stop semantics live in stopTurn() (in-container pkill).
    if (typeof onChild === 'function') {
      try { onChild(null); } catch {}
    }

    // #937: belt-and-braces re-arm. The pre-dispatch gate above closes the
    // spin-up window, but a stop can still land in the milliseconds while
    // `docker exec -d` is in flight — and that kill would have found no
    // turn process to match. Now that the registry knows THIS turn's
    // journal path, re-issuing the kill lands the TERM/KILL plus the
    // `__USERNODE_EXIT__ 143` marker, so the consumer below resolves on
    // its next journal read (~1s) instead of on the 10s watchdog.
    if (getPendingStop(sessionId)) {
      log.info('worker', 'Stop landed during dispatch — re-issuing kill', {
        sessionId, containerName, journal,
      });
      await stopTurn(sessionId).catch(() => {});
    }

    const state = newWatchState();
    state.turnId = durableTurnId;
    state.providerDispatched = true;
    // Seed the backend BEFORE consuming the journal (review P4): parseLine
    // routes JSON events to the Codex adapter only when
    // state.agentBackend === 'codex_openrouter'. The runner emits
    // agent_backend in __USERNODE_RESULT__ (too late for the events), so
    // we seed it from the dispatch param up front.
    state.agentBackend = agentBackend;
    execState = state;
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    await _consumeJournal(containerName, journal, progress, state, { sessionId });
    providerTerminalObserved = true;

    // Successful, complete turns don't need their journal anymore; failed
    // or markerless ones keep it on disk for debugging (the next turn's
    // wrapper rm's it).
    //
    // A tail-holding caller keeps it either way until finishTurn: it is
    // the only copy of what the turn did, and the boot-adoption resume
    // replays it to rebuild `result` before running the tail.
    if (!holdTurnRecord && state.execExitSeen && !state.fatalError) {
      execWorkerCommand(containerName, ['rm', '-f', journal]).catch(() => {});
    }
    return state;
  } finally {
    if (providerDispatched && providerTerminalObserved && isClaude && measuredTelemetryComponent) {
      recordClaudeCodingRun({
        sessionId,
        turnId: durableTurnId,
        result: execState,
        requestedModel: persistedModel,
        component: measuredTelemetryComponent,
        startedAt: providerStartedAt,
        durationMs: providerStartedMs == null ? null : Date.now() - providerStartedMs,
        directByok: !!anthropicApiKey,
        byokCents: getTurnByokCents(sessionId),
        attemptNumber: measuredTelemetryAttemptNumber,
        correlationId: measuredTelemetryCorrelationId,
      });
    }
    // #937: `stopRequestedAt` deliberately survives this teardown. The
    // turn's own tail (post-run stopped-check, force-stop bookkeeping)
    // still needs to know a stop was requested; clearPendingStop() at the
    // next turn's boundary is what resets it.
    _registryUpsert(sessionId, {
      inFlight: false, lastUsedMs: Date.now(), activeTurnMode: null,
      journal: null, activeTurnId: null,
      // Remembered for finishTurn so the caller's `finally` doesn't have
      // to thread the journal path back through its own scope.
      ...(holdTurnRecord ? { finishedJournal: journal, finishedTurnId: durableTurnId } : {}),
    });
    if (holdTurnRecord) {
      // Hand the record to the tail rather than dropping it. Seed the
      // milestone map with what the exec itself established, so a resume
      // knows whether the commit is already on GitHub without having to
      // re-derive it from a dead worker.
      await markTurnTail(sessionId, execState
        ? { sha: execState.sha || null, pushOk: execState.pushOk === true }
        : {}, { turnId: durableTurnId, journal });
    } else {
      await finishTurn(sessionId, { turnId: durableTurnId, journal });
    }
  }
}

// #361: synchronous read of the mode of the turn currently in flight for
// a session ('build' | 'sync' | 'scout' | …), or null when idle. Used by
// the Anthropic proxy to route sync turns onto the system-token cap.
function getActiveTurnMode(sessionId) {
  const meta = _warmRegistry.get(Number(sessionId));
  return (meta && meta.inFlight) ? (meta.activeTurnMode || null) : null;
}

// ──────────────────────────────────────────────────────────────────────
// #664: per-turn BYOK spillover accounting
// ──────────────────────────────────────────────────────────────────────
//
// The worker Anthropic proxy can switch a platform-dispatched turn onto
// the owner's own key per-call once the daily allowance runs out. The
// switched calls' observed costs accumulate here (registry, for the live
// turn-end settlement) AND in chat_sessions.active_turn.byokCents (for
// restart-resume — the SQL accumulate never clobbers pre-restart spend).
// execInWorker resets both fields at dispatch; resumeTurnFromJournal
// seeds them from the persisted record.

// Record `cents` of BYOK-billed spend against the session's in-flight
// turn. Fire-and-forget on the durable mirror: billing bookkeeping must
// never fail the API call that incurred it.
function noteTurnByokSpend(sessionId, cents) {
  const sid = Number(sessionId);
  if (!(cents > 0)) return;
  const meta = _warmRegistry.get(sid);
  _registryUpsert(sid, { turnByokCents: ((meta && meta.turnByokCents) || 0) + cents });
  const pool = _getPoolSafe();
  const activeTurnId = meta?.activeTurnId || null;
  if (pool && activeTurnId) {
    turnLifecycle.incrementByokCents(pool, {
      sessionId: sid,
      turnId: activeTurnId,
      cents,
    }).catch((err) => {
      log.warn('worker', 'Failed to persist turn byok spend', { sessionId: sid, err: err.message });
    });
  }
}

// BYOK-billed cents the proxy observed for the session's most recent
// turn. Read by the turn-end settlement (limits.settleTurnSpend) AFTER
// execInWorker/resumeTurnFromJournal resolves — the registry entry
// survives the turn's finally block, and the next dispatch resets it.
function getTurnByokCents(sessionId) {
  const meta = _warmRegistry.get(Number(sessionId));
  return (meta && meta.turnByokCents) || 0;
}

// Flip the turn's "payer switched to BYOK" marker. Returns true exactly
// once per turn (the false→true transition) so the proxy emits its
// one-time in-chat notice on the first switched call only.
function markTurnByokSwitched(sessionId) {
  const sid = Number(sessionId);
  const meta = _warmRegistry.get(sid);
  if (meta && meta.turnByokSwitched) return false;
  _registryUpsert(sid, { turnByokSwitched: true });
  return true;
}

// ──────────────────────────────────────────────────────────────────────
// Liveness-watchdog strike accounting
// ──────────────────────────────────────────────────────────────────────
//
// isWorkerExecuting is tri-state: true (turn process present), false
// (definite idle — the probe ran and found no turn process), null (the
// probe ITSELF failed: docker exec timed out, daemon contended, spawn
// error). A null says nothing about the turn — auto-solve workloads
// routinely contend the docker daemon for tens of seconds — so probe
// failures must NOT count toward the cheap 2-strike idle abandonment.
// They get their own, much larger consecutive budget before the turn is
// declared unobservable. Extracted as pure helpers so the policy is
// unit-testable without docker.
const WATCHDOG_INTERVAL_MS = 10000;
// #889: once a stop has been requested for this session the probe cadence
// tightens. The normal 10s/2-strike budget exists for crashes and OOM kills,
// where a fast cadence would only pile `docker exec` load onto a contended
// daemon; a stop is a known-imminent death, so we can afford to look often.
// This is the FALLBACK — stopTurn appends the exit marker itself, which
// resolves the consumer in milliseconds. It only matters when that append
// failed (unknown journal path, container hiccup).
const WATCHDOG_STOP_INTERVAL_MS = 1000;
const WATCHDOG_PROBE_TIMEOUT_MS = 15000;
const WATCHDOG_IDLE_STRIKE_LIMIT = 2;
// After a stop, ONE definite idle is enough: the two-strike default exists
// to give the wrapper's final `echo >> journal` an interval to flush, and
// on the stop path the wrapper is dead before it can ever run that echo.
const WATCHDOG_STOP_IDLE_STRIKE_LIMIT = 1;
const WATCHDOG_PROBE_FAILURE_LIMIT = 12;
// After the watchdog abandons a tail, a `docker inspect` showing the
// container still running buys the turn another tail cycle (a
// late-arriving __USERNODE_EXIT__ marker is then consumed normally).
// Bounded so a permanently unobservable turn still resolves.
const WATCHDOG_MAX_RETAILS = 3;

function newWatchdogCounters() {
  return { idleStrikes: 0, probeFailures: 0 };
}

// Fold one probe result into the counters. Returns { abandon, cause }:
// abandon=true with 'turn_process_gone' after two consecutive definite
// idles (the wrapper's final `echo >> journal` gets one interval to
// flush), or with 'probe_unobservable' once the consecutive
// probe-failure budget is exhausted.
//
// `idleLimit` overrides the definite-idle strike budget — the caller passes
// WATCHDOG_STOP_IDLE_STRIKE_LIMIT once a stop has been requested (#889).
// The probe-failure budget is deliberately NOT tightened: a null still says
// nothing about the turn, stop requested or not.
function recordWatchdogProbe(counters, busy, { idleLimit = WATCHDOG_IDLE_STRIKE_LIMIT } = {}) {
  if (busy === true) {
    counters.idleStrikes = 0;
    counters.probeFailures = 0;
    return { abandon: false, cause: null };
  }
  if (busy === false) {
    counters.idleStrikes += 1;
    // The probe itself succeeded, so the consecutive-failure run ends.
    counters.probeFailures = 0;
    return counters.idleStrikes >= idleLimit
      ? { abandon: true, cause: 'turn_process_gone' }
      : { abandon: false, cause: null };
  }
  counters.probeFailures += 1;
  return counters.probeFailures >= WATCHDOG_PROBE_FAILURE_LIMIT
    ? { abandon: true, cause: 'probe_unobservable' }
    : { abandon: false, cause: null };
}

// Positive evidence of container death for the markerless-turn path.
// Returns { status, oomKilled } — status 'gone' when docker says the
// container doesn't exist — or null when inspect itself failed (daemon
// contended), i.e. we still don't know.
async function inspectContainerState(containerName) {
  try {
    const { stdout } = await docker.execFileAsync('docker', [
      'inspect', '--format', '{{.State.Status}} {{.State.OOMKilled}}', containerName,
    ], { timeout: WATCHDOG_PROBE_TIMEOUT_MS });
    const [status, oom] = stdout.trim().split(/\s+/);
    return { status: status || 'unknown', oomKilled: oom === 'true' };
  } catch (err) {
    const msg = String((err && (err.stderr || err.message)) || '');
    if (/no such (object|container)/i.test(msg)) return { status: 'gone', oomKilled: false };
    return null;
  }
}

// Follow a turn journal until the __USERNODE_EXIT__ marker lands (turn
// finished) or the turn process is verifiably gone (killed / OOM — no
// marker will ever come). Feeds every line through the shared parseLine
// state machine, so the resolved `state` matches the attached
// transport's shape exactly.
//
// The tail itself is a disposable `docker exec`; if it drops while the
// turn is still running (docker hiccup, etc.) we restart it and skip
// the lines we already consumed.
async function _consumeJournal(containerName, journal, progress, state, { sessionId = null } = {}) {
  if (usesKubernetesWorkers()) {
    let linesConsumed = 0;
    // WORKER_JWT_TTL is the jsonwebtoken duration string "24h". Use its
    // numeric twin for arithmetic; coercing the string produces NaN and
    // makes this loop return probe_unobservable before its first poll.
    const deadline = Date.now() + WORKER_JWT_TTL_MS;
    while (Date.now() < deadline) {
      try {
        const { stdout } = await execWorkerCommand(containerName, ['cat', journal]);
        const lines = stdout.split('\n');
        for (let i = linesConsumed; i < lines.length; i++) {
          if (!lines[i]) continue;
          linesConsumed += 1;
          state.rawStdout += `${lines[i]}\n`;
          parseLine(lines[i], progress, state);
          if (state.execExitSeen) return state;
        }
      } catch (_) { /* journal may not exist yet */ }
      const busy = await isWorkerExecuting(containerName);
      if (busy === false && linesConsumed > 0) {
        state.exitCode = state.exitCode ?? -1;
        state.markerlessCause = 'turn_process_gone';
        return state;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    state.exitCode = -1;
    state.markerlessCause = 'probe_unobservable';
    return state;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let linesConsumed = 0;
  let retails = 0;
  // Why the watchdog killed the most recent tail, when it did.
  let watchdogCause = null;

  const consume = (line) => {
    state.rawStdout += `${line}\n`;
    parseLine(line, progress, state);
  };

  for (;;) {
    watchdogCause = null;
    const counters = newWatchdogCounters();
    await new Promise((resolve) => {
      // Wait for the wrapper to create the journal, then follow it from
      // the top. `exec tail` so the pid the shell reports is tail itself.
      const proc = spawn('docker', [
        'exec', containerName, 'sh', '-c',
        `n=0; while [ ! -f "${journal}" ]; do n=$((n+1)); [ "$n" -gt 300 ] && exit 86; sleep 0.1; done; exec tail -n +1 -f "${journal}"`,
      ]);

      let done = false;
      let buf = '';
      let skip = linesConsumed;
      let livenessTimer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (livenessTimer) clearTimeout(livenessTimer);
        try { proc.kill('SIGKILL'); } catch {}
        resolve();
      };

      proc.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (skip > 0) { skip -= 1; continue; }
          linesConsumed += 1;
          consume(line);
          if (state.execExitSeen) return finish();
        }
      });
      proc.stderr.on('data', () => {});
      proc.on('close', finish);
      proc.on('error', finish);

      // Watchdog: `tail -f` never exits on its own, so detect the case
      // where the turn died without writing the exit marker (stopTurn
      // pkill, OOM kill). The probe is purely a safety net — the journal
      // tail is the real-time channel — so the long timeout/interval is
      // harmless, and only DEFINITE idles use the cheap 2-strike
      // abandonment; probe failures get the larger budget above.
      //
      // #889: self-rescheduling rather than a fixed interval so the cadence
      // can tighten the moment a stop is requested (stopTurn stamps
      // `stopRequestedAt` on the registry entry). Re-read per tick — a stop
      // can land at any point during a long turn.
      const stopRequested = () =>
        sessionId != null && !!_registryGet(sessionId)?.stopRequestedAt;
      const armLiveness = () => {
        livenessTimer = setTimeout(tick, stopRequested()
          ? WATCHDOG_STOP_INTERVAL_MS
          : WATCHDOG_INTERVAL_MS);
        // Never hold the process open on a safety-net probe.
        livenessTimer.unref?.();
      };
      const tick = async () => {
        if (done) return;
        const busy = await isWorkerExecuting(containerName, { timeoutMs: WATCHDOG_PROBE_TIMEOUT_MS });
        if (done) return;
        const verdict = recordWatchdogProbe(counters, busy, {
          idleLimit: stopRequested()
            ? WATCHDOG_STOP_IDLE_STRIKE_LIMIT
            : WATCHDOG_IDLE_STRIKE_LIMIT,
        });
        if (busy === null) {
          log.warn('worker', 'Turn liveness probe failed', {
            containerName, sessionId, journal,
            consecutiveFailures: counters.probeFailures,
          });
        }
        if (verdict.abandon) {
          watchdogCause = verdict.cause;
          return finish();
        }
        armLiveness();
      };
      armLiveness();
    });

    if (state.execExitSeen) return state;

    // Tail ended without an exit marker. If the turn is still running
    // (transient tail/docker failure), restart the tail; otherwise we
    // need positive evidence of death before giving up.
    const busy = await isWorkerExecuting(containerName, { timeoutMs: WATCHDOG_PROBE_TIMEOUT_MS });
    if (busy === true) {
      await sleep(1000);
      continue;
    }

    // Verify against docker itself: if the container is still running
    // and no probe definitively saw the turn process gone, re-tail
    // (bounded) instead of abandoning a possibly-healthy turn. This also
    // lets a marker that lands seconds late be consumed normally instead
    // of racing the one-shot `cat` below.
    const inspected = await inspectContainerState(containerName);
    if (
      inspected && inspected.status === 'running' && !inspected.oomKilled
      && busy !== false && watchdogCause !== 'turn_process_gone'
      && retails < WATCHDOG_MAX_RETAILS
    ) {
      retails += 1;
      log.warn('worker', 'Turn unobservable but container still running — re-tailing journal', {
        containerName, sessionId, journal, retails, maxRetails: WATCHDOG_MAX_RETAILS,
      });
      await sleep(1000);
      continue;
    }

    // Final non-follow read to catch anything the tail missed, then
    // give up with whatever state we accumulated.
    try {
      const { stdout } = await docker.execFileAsync('docker', [
        'exec', containerName, 'cat', journal,
      ], { timeout: 10000 });
      const lines = stdout.split('\n');
      for (let i = linesConsumed; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        linesConsumed += 1;
        consume(line);
        if (state.execExitSeen) break;
      }
    } catch {
      // Container (or journal) gone — nothing more to read.
    }
    if (!state.execExitSeen && state.exitCode == null) {
      // Turn vanished without a marker: stopped, killed, or unobservable.
      state.exitCode = -1;
      if (inspected && inspected.oomKilled) {
        state.markerlessCause = 'oom_killed';
      } else if (inspected && inspected.status !== 'running') {
        // Covers 'gone' (no such container) and exited/dead containers.
        state.markerlessCause = 'container_gone';
      } else if (busy === false || watchdogCause === 'turn_process_gone') {
        // Definite idle — stopTurn kills and in-container OOM of the
        // wrapper both land here.
        state.markerlessCause = 'turn_process_gone';
      } else {
        state.markerlessCause = 'probe_unobservable';
      }
      log.warn('worker', 'Turn ended without an exit marker', {
        sessionId, containerName, journal, linesConsumed,
        cause: state.markerlessCause,
        inspect: inspected ? `${inspected.status} oom=${inspected.oomKilled}` : 'unavailable',
        retails,
      });
    }
    return state;
  }
}

// Stop the in-flight turn for a session by killing run-cc.sh + claude
// inside the container. The warm wrapper (sleep infinity) survives, so
// the container stays adoptable for the next dispatch.
//
// #889: the kill also takes out the detached wrapper shell (its cmdline
// contains `/usr/local/bin/run-cc.sh`, so it matches TURN_PROC_RE), which
// means the wrapper can never run its own `echo "__USERNODE_EXIT__ $?"`.
// Historically that left the journal consumer to discover the death via its
// 10s/2-strike liveness watchdog — a measured 18.8s of dead air between the
// click and the chat unwinding. So we write the marker ourselves: kill,
// wait (bounded) for the processes to actually go, SIGKILL any survivor,
// then append `__USERNODE_EXIT__ 143` to the turn journal. The consumer's
// `tail -f` picks it up on the next read and resolves in milliseconds.
//
// Killing BEFORE appending is what makes the append safe: the wrapper's
// `> "$TURN_JOURNAL"` fd is gone by then, so the marker can't interleave
// with a half-written agent line.
//
// `stopRequestedAt` on the registry entry tightens the watchdog cadence as
// a fallback for the case where this append doesn't land at all.
async function stopTurn(sessionId) {
  const meta = _registryGet(sessionId);
  const containerName = meta?.containerName || workerContainerName(sessionId);
  _registryUpsert(sessionId, { stopRequestedAt: Date.now() });
  await execWorkerCommand(containerName, ['sh', '-c',
    buildTurnStopScript(meta?.journal || null),
  ]).catch(() => {});
  log.info('worker', 'Stop signal sent (in-container kill + journal exit marker)', {
    containerName, sessionId, journal: meta?.journal || '(discovered in-container)',
  });
}

// #937: the pending-stop record. `stopRequestedAt` is stamped by
// stopTurn() and read by three consumers — the journal consumer's
// tightened liveness cadence, execInWorker's pre-dispatch gate, and its
// post-dispatch re-arm. It must therefore OUTLIVE the dispatch it guards,
// which is why neither execInWorker's upsert nor its finally touches it
// anymore.
//
// These two functions are the only places it is read/reset from outside,
// so the "when does a pending stop expire?" rule lives in exactly one
// place: a stop is pending until a genuinely NEW turn begins. Callers:
// the chat handler when it registers a fresh stop handle, and sync-main
// before its own dispatch (a stale flag must never block a sync turn).
function clearPendingStop(sessionId) {
  const sid = Number(sessionId);
  if (!_warmRegistry.has(sid)) return;
  _registryUpsert(sid, { stopRequestedAt: null });
}

// Epoch ms of the pending stop for this session, or null when none is
// pending. Synchronous by design — the dispatch gate reads it inline.
function getPendingStop(sessionId) {
  return _warmRegistry.get(Number(sessionId))?.stopRequestedAt || null;
}

// #460: materialize the dispatching user's personal agent files into the
// warm worker's CC volume before a build/scout turn. Wipe-and-rewrite of
// two managed paths — ~/.claude/CLAUDE.md (user-level memory Claude Code
// loads natively) and ~/.claude/skills/ (personal skills) — so deletions
// in Settings take effect on the next dispatch. Both live OUTSIDE the
// repo checkout, so run-cc.sh's `git add -A` can never commit them.
//
// The script travels on the exec child's STDIN (contents base64-inlined
// within it), never as a CLI arg, so user file contents don't show up in
// `ps` or `docker inspect`. Callers treat failures as non-fatal: the
// dispatch proceeds without personal files rather than failing the turn.
async function syncUserAgentFiles(sessionId, files) {
  const meta = _registryGet(sessionId);
  if (!meta) {
    throw new Error(`syncUserAgentFiles: no warm worker registered for session ${sessionId}`);
  }
  const { buildSyncShellScript } = require('./user-agent-files');
  if (usesKubernetesWorkers()) {
    await execWorkerCommand(meta.containerName, ['sh', '-s'], buildSyncShellScript(files || []));
  } else {
    await docker.execShellStdin(meta.containerName, buildSyncShellScript(files || []), {
      timeoutMs: 20000, label: 'syncUserAgentFiles',
    });
  }
  log.info('worker', 'Personal agent files synced', {
    sessionId, count: (files || []).length,
  });
}

// Boot-time resume: pick an in-flight (or finished-while-we-were-down)
// turn back up from its journal. The caller (server.js adoption) owns
// post-turn processing and clearing chat_sessions.active_turn; this
// just replays/follows the journal and returns the watch state, exactly
// as if execInWorker had stayed attached the whole time.
async function resumeTurnFromJournal(sessionId, {
  journal,
  turnId = null,
  onProgress,
  byokCentsSoFar = 0,
  agentBackend = 'claude_code',
  telemetryComponent = null,
  telemetryCorrelationId = null,
  telemetryAttemptNumber = null,
  requestedModel = null,
  startedAt = null,
  attemptNumber = 1,
  billingByok = false,
  providerWasDispatched = false,
} = {}) {
  if (!journal) throw new Error('resumeTurnFromJournal: journal path required');
  const meta = _registryGet(sessionId);
  const containerName = meta?.containerName || workerContainerName(sessionId);
  // #664: seed the per-turn BYOK counters from the persisted active_turn
  // record (callers pass active_turn.byokCents) so post-restart switched
  // calls accumulate on top instead of restarting from zero, and the
  // one-time switch notice doesn't re-fire for an already-switched turn.
  const seedCents = Number(byokCentsSoFar) > 0 ? Number(byokCentsSoFar) : 0;
  _registryUpsert(sessionId, {
    inFlight: true, adopted: true,
    // Recovered proxy calls must keep mirroring BYOK spillover onto the
    // exact durable owner. Without this identity a second restart discards
    // every cent observed after the first recovery.
    activeTurnId: turnId || null,
    turnByokCents: seedCents, turnByokSwitched: seedCents > 0,
  });
  const state = newWatchState();
  state.turnId = turnId || null;
  // An executing/tail phase proves dispatch. A legacy dispatch_pending row
  // is ambiguous after a crash; for that shape the consumed journal below
  // must provide evidence before telemetry may count an invocation.
  state.providerDispatched = providerWasDispatched === true;
  // Seed the backend so parseLine routes Codex JSONL correctly on
  // recovery too (review P4). The caller passes the persisted
  // session.agent_backend.
  state.agentBackend = agentBackend;
  const physicalStartedAt = new Date(startedAt || Date.now());
  const safeStartedAt = Number.isFinite(physicalStartedAt.getTime())
    ? physicalStartedAt
    : new Date();
  let providerTerminalObserved = false;
  try {
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    await _consumeJournal(containerName, journal, progress, state, { sessionId });
    if (state.rawStdout || state.execExitSeen) state.providerDispatched = true;
    providerTerminalObserved = true;
    // The recovery caller owns required persistence (thread id + ledger)
    // and calls finishTurn only after it succeeds. Deleting here used to
    // destroy the sole replay source before those writes had landed.
    return state;
  } finally {
    if (providerTerminalObserved && state.providerDispatched
        && resolveTurnBackend(agentBackend).isClaude && telemetryComponent && turnId) {
      recordClaudeCodingRun({
        sessionId,
        turnId,
        result: state,
        requestedModel,
        component: telemetryComponent,
        startedAt: safeStartedAt,
        durationMs: Math.max(0, Date.now() - safeStartedAt.getTime()),
        directByok: !!billingByok,
        byokCents: getTurnByokCents(sessionId),
        attemptNumber: Number(telemetryAttemptNumber) || Number(attemptNumber) || 1,
        correlationId: telemetryCorrelationId || String(turnId),
      });
    }
    _registryUpsert(sessionId, { inFlight: false, lastUsedMs: Date.now() });
  }
}

// Tear down a warm worker container (eviction). Volume is preserved so
// the next `ensureWorker` re-warms with CC's session memory intact.
async function evictWorker(sessionId) {
  const meta = _registryGet(sessionId);
  const containerName = meta?.containerName || workerContainerName(sessionId);
  if (usesKubernetesWorkers()) {
    await kubernetes.deleteWorker(kubernetesWorkerConfig(), sessionId, { deleteVolume: false }).catch(() => {});
  } else {
    await docker.stopAndRemove(containerName).catch(() => {});
  }
  _warmRegistry.delete(sessionId);
  log.info('worker', 'Worker evicted (volume preserved)', { containerName });
}

// ──────────────────────────────────────────────────────────────────────
// Legacy single-shot helpers (kept for orphan adoption + back-compat)
// ──────────────────────────────────────────────────────────────────────

// Tail a worker container's logs until the container exits, parsing
// stream-json + USERNODE markers along the way. Resolves with the
// accumulated state when the container is gone.
//
// Used today only by the orphan-adoption recovery path
// (recoverActiveWorkers in server.js). The live per-turn path uses
// execInWorker which streams the docker-exec child's stdout directly.
async function watchWorker(containerName, { onProgress, fromStart = true } = {}) {
  const state = newWatchState();
  const progress = typeof onProgress === 'function' ? onProgress : () => {};

  const args = ['logs', '-f'];
  if (!fromStart) args.push('--tail', '0');
  args.push(containerName);

  const proc = spawn('docker', args);

  let stdoutBuf = '';
  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    state.rawStdout += text;
    stdoutBuf += text;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() || '';
    for (const line of lines) parseLine(line, progress, state);
  });

  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    state.rawStderr += text;
    stderrBuf += text;
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() || '';
    for (const line of lines) {
      if (line.trim() && line.length < 500) progress(line);
    }
  });

  await new Promise((resolve) => {
    proc.on('close', resolve);
    proc.on('error', (err) => {
      log.warn('worker', 'docker logs -f errored', { containerName, err: err.message });
      resolve();
    });
  });

  if (stdoutBuf.trim()) parseLine(stdoutBuf, progress, state);

  // Grab the real exit code from docker itself; the __USERNODE_RESULT__
  // line is best-effort and could be absent (e.g. OOM kill).
  try {
    const { stdout } = await docker.execFileAsync('docker', [
      'inspect', '--format', '{{.State.ExitCode}}', containerName,
    ], { timeout: 5000 });
    state.exitCode = parseInt(stdout.trim(), 10);
  } catch {
    state.exitCode = -1;
  }

  return state;
}

// Return metadata for every container matching `usernode-worker-*`.
// Used on server startup to adopt any workers left over from a previous
// process. The state field comes straight from `docker ps`:
//   - "running"  : either a warm-idle wrapper (sleep infinity) or a
//                  legacy single-shot still in flight.
//   - "exited"   : single-shot finished; needs log scrape + cleanup.
//   - "created"/"restarting"/etc.: rare, treat as broken → reap.
async function listOrphanWorkers() {
  if (usesKubernetesWorkers()) return kubernetes.listWorkers(kubernetesWorkerConfig());
  try {
    const { stdout } = await docker.execFileAsync('docker', [
      'ps', '-a',
      '--filter', 'name=^/usernode-worker-',
      '--format', '{{.Names}}\t{{.State}}',
    ], { timeout: 5000 });
    const out = [];
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const [name, state] = line.split('\t');
      const m = name && name.match(/^usernode-worker-(\d+)$/);
      if (m) out.push({ name, sessionId: parseInt(m[1], 10), state });
    }
    return out;
  } catch {
    return [];
  }
}

// Match a turn process (run-cc.sh wrapper, run-cc.sh itself, or the
// claude CLI) by full cmdline. The anchors keep paths like
// /home/node/.claude/turn-X.log (our tail/cat execs) from matching —
// "claude" there is preceded by "." and followed by "/", neither of
// which the pattern accepts. The probe scripts below also exclude
// their own pid, and their script text can't self-match ("run-cc\.sh"
// in the text has a literal backslash; "claude" is preceded by "(").
//
// IMPORTANT: these walk /proc with sh + grep instead of pgrep/pkill —
// the worker image (node:22-bookworm-slim) does NOT ship procps, so
// pgrep/pkill exit 127 in there. The old `pgrep ... && busy || idle`
// one-liner silently reported "idle" for every container, busy or not.
// Match a turn process for EITHER backend (review F4): the Claude runner
// (run-cc.sh + claude) or the Codex runner (run-codex-agent.sh + codex).
// Without the codex terms, long Codex turns look idle (watchdog abandons)
// and Stop appends a fake marker without killing the process.
const TURN_PROC_RE = '(^|[ /])(claude|run-cc\\.sh|codex|run-codex-agent\\.sh)( |$)';
const TURN_PROC_PROBE_SCRIPT =
  'busy=0; for d in /proc/[0-9]*; do '
  + '[ "$d" = "/proc/$$" ] && continue; '
  + 'c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null) || continue; '
  + `printf "%s" "$c" | grep -qE '${TURN_PROC_RE}' && { busy=1; break; }; `
  + 'done; [ "$busy" = "1" ] && echo busy || echo idle';
// Signal every turn process in the container. Same /proc walk as the probe
// above (procps isn't in the worker image, so pgrep/pkill are unavailable).
// Skips its own shell so the script can't signal itself.
const turnProcSignalSnippet = (sig) =>
  'for d in /proc/[0-9]*; do '
  + '[ "$d" = "/proc/$$" ] && continue; '
  + 'c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null) || continue; '
  + `printf "%s" "$c" | grep -qE '${TURN_PROC_RE}' && kill -${sig} "\${d#/proc/}" 2>/dev/null; `
  + 'done';

// True (`alive=1`) while any turn process is still in the container — the
// SIGTERM grace loop polls this to find out when the last one is gone.
const turnProcAliveSnippet =
  'alive=0; for d in /proc/[0-9]*; do '
  + '[ "$d" = "/proc/$$" ] && continue; '
  + 'c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null) || continue; '
  + `printf "%s" "$c" | grep -qE '${TURN_PROC_RE}' && { alive=1; break; }; `
  + 'done';

// #889: how long the in-container stop waits for a SIGTERMed turn process
// to actually exit before escalating to SIGKILL. 20 × 100ms. Sized so a
// well-behaved `claude` gets a real chance to flush and exit cleanly while
// the whole stop still lands inside a couple of seconds.
const TURN_STOP_GRACE_TICKS = 20;

// The full in-container stop procedure, as ONE `sh -c` so a stop costs a
// single `docker exec`: SIGTERM the turn processes → poll /proc until they
// are gone (bounded) → SIGKILL the stragglers → append the exit marker to
// the turn journal so the host-side consumer resolves immediately.
//
// `journal` is the host's recorded path for the in-flight turn. When it is
// unknown (an adopted worker whose registry entry predates this dispatch)
// the script discovers the newest turn journal itself — the dispatch
// wrapper rm's stale ones first, so at most one exists. `exit 0` throughout:
// a stop must never fail loudly, the watchdog is behind it either way.
function buildTurnStopScript(journal) {
  const journalExpr = journal
    // Single-quoted: the path is platform-generated (/home/node/.claude/
    // turn-<ms>.log), never user input, and quoting keeps it one word.
    ? `J='${journal}'`
    : 'J=$(ls -t /home/node/.claude/turn-*.log 2>/dev/null | head -1)';
  return [
    turnProcSignalSnippet('TERM'),
    // Wait for the SIGTERMed processes to actually disappear. Breaks out on
    // the first clean scan, so the common case costs no wall-clock at all.
    `i=0; while [ "$i" -lt ${TURN_STOP_GRACE_TICKS} ]; do `
      + `${turnProcAliveSnippet}; `
      + '[ "$alive" = "0" ] && break; i=$((i+1)); sleep 0.1; done',
    // Anything still standing ignored SIGTERM — take it out hard, so the
    // marker below is written against a genuinely dead turn.
    turnProcSignalSnippet('KILL'),
    journalExpr,
    // 143 = 128 + SIGTERM, what a docker-stop-based kill would have produced.
    '[ -n "$J" ] && [ -f "$J" ] && echo "__USERNODE_EXIT__ 143" >> "$J" 2>/dev/null',
    'exit 0',
  ].join('; ');
}

// Best-effort check of whether a running warm container has an in-flight
// per-turn exec. We look for a turn process inside the container — the
// sleep wrapper is always there, but run-cc.sh/claude are only present
// while a turn is executing.
//
// Returns:
//   true   — claude (or its parent run-cc.sh) is currently executing
//   false  — only the sleep wrapper is alive
//   null   — couldn't determine (container not running, exec failed, etc.)
//
// `timeoutMs` is overridable because the journal watchdog deliberately
// runs the probe with a generous timeout (the probe is a safety net, not
// the real-time channel); other callers keep the snappy default.
async function isWorkerExecuting(containerName, { timeoutMs = 5000 } = {}) {
  try {
    const { stdout } = usesKubernetesWorkers()
      ? await execWorkerCommand(containerName, ['sh', '-c', TURN_PROC_PROBE_SCRIPT])
      : await docker.execFileAsync('docker', [
          'exec', containerName, 'sh', '-c', TURN_PROC_PROBE_SCRIPT,
        ], { timeout: timeoutMs });
    const out = stdout.trim();
    if (out === 'busy') return true;
    if (out === 'idle') return false;
    return null;
  } catch {
    return null;
  }
}

// Hard teardown of a worker container. Used for session archive, error
// recovery, and the orphan-adoption legacy path. Removes the registry
// entry too so a follow-up ensureWorker doesn't trust stale state.
//
// For ordinary idle eviction during a session, use `evictWorker`
// instead — same effect, but the function name signals intent better.
async function destroyWorker(containerName) {
  const m = containerName.match(/(?:usernode-worker-|sv-worker-s)(\d+)$/);
  if (usesKubernetesWorkers() && m) {
    await kubernetes.deleteWorker(kubernetesWorkerConfig(), parseInt(m[1], 10), { deleteVolume: false }).catch(() => {});
  } else {
    await docker.stopAndRemove(containerName).catch(() => {});
  }
  if (m) _warmRegistry.delete(parseInt(m[1], 10));
  log.info('worker', 'Worker destroyed', { containerName });
}

// Remove the named CC volume for a given chat session. Called when the
// session is archived (permanent teardown). Safe to call even if the
// volume was never created.
async function destroyCcVolume(sessionId) {
  if (usesKubernetesWorkers()) {
    await kubernetes.deleteWorker(kubernetesWorkerConfig(), sessionId, { deleteVolume: true });
  } else {
    await docker.removeVolume(ccVolumeName(sessionId));
  }
}

// #155: copy one session's CC memory volume (~/.claude) into another
// session's volume, so a dev chat cloned from a headless auto session can
// `--resume` the auto session's Claude Code conversation. Uses the worker
// image (always present locally — staging/CC builds keep it warm) for the
// one-shot copy container, so no registry pull is needed. Throws when the
// source volume doesn't exist or the copy fails; callers treat a clone
// failure as "start with fresh CC memory" (cc_session_id stays NULL).
async function cloneCcVolume(srcSessionId, destSessionId) {
  if (usesKubernetesWorkers()) {
    await kubernetes.cloneWorkerVolume(kubernetesWorkerConfig(), srcSessionId, destSessionId);
    log.info('worker', 'CC PVC cloned', { from: srcSessionId, to: destSessionId });
    return;
  }
  const src = ccVolumeName(srcSessionId);
  const dest = ccVolumeName(destSessionId);
  // Throws if the source volume was never created (e.g. the headless run
  // failed before its first worker bootstrap).
  await docker.execFileAsync('docker', ['volume', 'inspect', src], { timeout: 5000 });
  await docker.ensureVolume(dest);
  // Run the copy as root (`--user 0:0`). A freshly-created named volume is
  // owned root:root (0755), but the worker image's default user is non-root,
  // so a non-root copy container can't create entries under /to — the exact
  // failures seen cloning chat 735 ("cp: cannot create directory
  // '/to/./backups': Permission denied", "cp: preserving times for '/to/.':
  // Operation not permitted"), which left the clone with fresh CC memory.
  // `cp -a` still preserves each source entry's original uid/gid, so the
  // worker user can read its own ~/.claude files afterward.
  await docker.execFileAsync('docker', [
    'run', '--rm',
    '--user', '0:0',
    '-v', `${src}:/from:ro`,
    '-v', `${dest}:/to`,
    '--entrypoint', 'sh',
    WORKER_IMAGE,
    '-c', 'cp -a /from/. /to/',
  ], { timeout: 60000 });
  log.info('worker', 'CC volume cloned', { from: src, to: dest });
}

// ──────────────────────────────────────────────────────────────────────
// Platform-side git push proxy
// ──────────────────────────────────────────────────────────────────────
//
// The worker container carries no GitHub credentials. When CC commits
// and wants to push, the worker's `usernode-push` shell wrapper hits
// POST /api/internal/sessions/:id/push (see src/routes/internal.js),
// which calls this helper.
//
// We use the worker's existing clone (origin already points at GitHub)
// and inject `GITHUB_BOT_TOKEN` into a single one-shot `docker exec` via
// an inline credential helper. The bot token never enters the worker's
// persistent env or git config; it lives in the exec's environ for the
// duration of the push and disappears when the exec exits.
//
// Branch is supplied by the caller (the route handler) AFTER looking up
// the session's canonical `branch_name` from the DB. The worker doesn't
// get to pick. Branch is sanitized to a strict charset before being
// passed to bash so it can't break out of the shell expansion below.
const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/;

async function execPushFromWorker(sessionId, branchName) {
  const botToken = process.env.GITHUB_BOT_TOKEN || '';
  if (!botToken) {
    const err = new Error('GITHUB_BOT_TOKEN not configured on platform');
    err.code = 'no_token';
    throw err;
  }
  if (!branchName || !BRANCH_NAME_RE.test(branchName)) {
    const err = new Error(`Invalid branch name: ${branchName}`);
    err.code = 'bad_branch';
    throw err;
  }

  const containerName = _registryGet(sessionId)?.containerName || workerRuntimeName(sessionId);

  // Inline credential helper: prints `username=x-access-token` and
  // `password=$PAT` to stdout when git asks for credentials. `-c
  // credential.helper=…` is scoped to this single git invocation —
  // doesn't touch the worker's .git/config. The `bash -c` script
  // reads $PAT and $BRANCH from the exec env (passed via bare `-e`
  // so the values aren't in argv).
  //
  // Final `git rev-parse HEAD` prints the SHA we pushed, which the
  // caller surfaces back to the worker for logging and the
  // __USERNODE_RESULT__ accounting.
  const inlineScript =
    'set -e; cd /home/node/workspace && ' +
    'git -c credential.helper="!f() { echo username=x-access-token; echo password=$PAT; }; f" ' +
    'push -u origin "$BRANCH" >&2 && ' +
    'git rev-parse HEAD';

  const args = [
    'exec',
    '-e', 'PAT',              // bare -e: value taken from docker's own env
    '-e', 'BRANCH',
    containerName,
    'bash', '-c', inlineScript,
  ];

  try {
    let stdout;
    let stderr;
    if (usesKubernetesWorkers()) {
      const script = `export PAT=${shellQuote(botToken)}\nexport BRANCH=${shellQuote(branchName)}\n${inlineScript}\n`;
      ({ stdout, stderr } = await execWorkerCommand(containerName, ['bash', '-s'], script));
    } else {
      ({ stdout, stderr } = await docker.execFileAsync('docker', args, {
        timeout: 60000,
        env: { ...process.env, PAT: botToken, BRANCH: branchName },
      }));
    }
    const sha = (stdout || '').trim().split('\n').pop();
    log.info('worker', 'Push proxied to GitHub', {
      sessionId, branch: branchName, sha: (sha || '').slice(0, 8),
    });
    return { sha, stderr: (stderr || '').trim() };
  } catch (err) {
    // Don't leak the PAT into log lines if `docker exec` printed any
    // (it shouldn't — credential helpers don't echo creds — but defense
    // in depth). err.message + err.stderr come from execFileAsync.
    const cleanMsg = String(err.message || '').replace(botToken, '***');
    const cleanStderr = String(err.stderr || '').replace(botToken, '***');
    const wrapped = new Error(`push proxy failed: ${cleanMsg}`);
    wrapped.code = 'push_failed';
    wrapped.stderr = cleanStderr;
    log.warn('worker', 'Push proxy failed', {
      sessionId, branch: branchName, err: cleanMsg,
    });
    throw wrapped;
  }
}

module.exports = {
  ensureWorkerImage,
  // long-lived API
  ensureWorker,
  execInWorker,
  stopTurn,
  // #937: pending-stop record (survives the dispatch it guards)
  clearPendingStop,
  getPendingStop,
  syncUserAgentFiles,
  resumeTurnFromJournal,
  clearActiveTurn,
  // post-agent tail lifecycle (holdTurnRecord callers)
  TURN_PHASE_TAIL,
  markTurnTail,
  noteTailMilestone,
  markTurnRetryPending,
  finishTurn,
  isTailPhase,
  evictWorker,
  warmRegistrySnapshot,
  adoptWarmWorker,
  isInFlight,
  isWorkerExecuting,
  getActiveTurnMode,
  // #664: per-turn BYOK spillover accounting (worker Anthropic proxy +
  // turn-end settlement)
  noteTurnByokSpend,
  getTurnByokCents,
  markTurnByokSwitched,
  // legacy / shared helpers
  watchWorker,
  listOrphanWorkers,
  destroyWorker,
  destroyCcVolume,
  cloneCcVolume,
  parseClaudeResponse,
  // exposed for unit tests (watchdog strike policy + line parsing)
  newWatchState,
  _recordClaudeCodingRunForTests: recordClaudeCodingRun,
  parseLine,
  newWatchdogCounters,
  recordWatchdogProbe,
  WORKER_JWT_TTL_MS,
  // #889: in-container stop procedure (exported for tests)
  buildTurnStopScript,
  // exposed for the routes' container-name lookups
  workerContainerName,
  workerRuntimeName,
  // platform-side git push proxy (called from src/routes/internal.js)
  execPushFromWorker,
  mintWorkerJwt,
  mintAnthropicProxyJwt,
  // #616: prod-debug JWT + pure turn-env builder (exported for tests)
  mintProdDebugJwt,
  buildTurnSecretEnv,
  // file-based dispatch-prompt transport (E2BIG fix; exported for tests)
  TURN_PROMPT_PATH,
  buildTurnPromptScript,
  writeTurnPrompt,
};
