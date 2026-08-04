// Tests for the journal liveness watchdog's strike accounting and the
// __USERNODE_WARN__ → onProgress forwarding (spurious "exited with code
// -1" fix). The strike policy is exercised through the pure helpers
// worker.js exports (newWatchdogCounters / recordWatchdogProbe), so no
// docker is involved.
//
// Run with: node --test tests/worker-watchdog.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../src/services/worker');
const log = require('../src/services/logger');

test('Kubernetes journal deadline uses a finite numeric worker TTL', () => {
  assert.equal(worker.WORKER_JWT_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(Number.isFinite(Date.now() + worker.WORKER_JWT_TTL_MS), true);
});

// ── Watchdog strike accounting ──────────────────────────────────────────

test('watchdog: three consecutive probe FAILURES (null) do not abandon', () => {
  const c = worker.newWatchdogCounters();
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(worker.recordWatchdogProbe(c, null), { abandon: false, cause: null });
  }
  // This is exactly the sequence that used to kill healthy turns: the
  // old code counted nulls as idle strikes and gave up after two.
  assert.equal(c.probeFailures, 3);
  assert.equal(c.idleStrikes, 0);
});

test('watchdog: two consecutive definite idles abandon with turn_process_gone', () => {
  const c = worker.newWatchdogCounters();
  assert.deepEqual(worker.recordWatchdogProbe(c, false), { abandon: false, cause: null });
  assert.deepEqual(worker.recordWatchdogProbe(c, false), { abandon: true, cause: 'turn_process_gone' });
});

test('watchdog: twelve consecutive probe failures abandon with probe_unobservable', () => {
  const c = worker.newWatchdogCounters();
  let verdict;
  for (let i = 0; i < 11; i++) {
    verdict = worker.recordWatchdogProbe(c, null);
    assert.equal(verdict.abandon, false, `failure ${i + 1} must not abandon yet`);
  }
  verdict = worker.recordWatchdogProbe(c, null);
  assert.deepEqual(verdict, { abandon: true, cause: 'probe_unobservable' });
});

test('watchdog: a busy probe resets both counters', () => {
  const c = worker.newWatchdogCounters();
  worker.recordWatchdogProbe(c, false);
  for (let i = 0; i < 11; i++) worker.recordWatchdogProbe(c, null);
  assert.deepEqual(worker.recordWatchdogProbe(c, true), { abandon: false, cause: null });
  assert.equal(c.idleStrikes, 0);
  assert.equal(c.probeFailures, 0);
  // Fresh budget afterwards: a single idle is one strike, not two.
  assert.deepEqual(worker.recordWatchdogProbe(c, false), { abandon: false, cause: null });
});

test('watchdog: a definite idle ends the consecutive-failure run', () => {
  const c = worker.newWatchdogCounters();
  for (let i = 0; i < 11; i++) worker.recordWatchdogProbe(c, null);
  // The probe itself succeeded (it just saw idle) — failures reset.
  worker.recordWatchdogProbe(c, false);
  assert.equal(c.probeFailures, 0);
  assert.equal(c.idleStrikes, 1);
  // Interleaved idle/null never reaches either limit.
  assert.deepEqual(worker.recordWatchdogProbe(c, null), { abandon: false, cause: null });
});

// ── Stop-aware idle budget (#889) ───────────────────────────────────────
//
// The two-strike default exists to give the wrapper's final
// `echo "__USERNODE_EXIT__ $?" >> journal` one interval to flush. On the
// stop path that echo can never come — stopTurn's kill takes out the
// wrapper shell along with claude — so waiting a second interval buys
// nothing and costs the user ~10s of dead air.

test('watchdog: with idleLimit 1, the first definite idle abandons', () => {
  const c = worker.newWatchdogCounters();
  assert.deepEqual(
    worker.recordWatchdogProbe(c, false, { idleLimit: 1 }),
    { abandon: true, cause: 'turn_process_gone' }
  );
});

test('watchdog: idleLimit does NOT tighten the probe-failure budget', () => {
  // A null still says nothing about the turn, stop requested or not —
  // docker-daemon contention must not be read as "the agent is gone".
  const c = worker.newWatchdogCounters();
  for (let i = 0; i < 11; i++) {
    assert.deepEqual(
      worker.recordWatchdogProbe(c, null, { idleLimit: 1 }),
      { abandon: false, cause: null }
    );
  }
  assert.deepEqual(
    worker.recordWatchdogProbe(c, null, { idleLimit: 1 }),
    { abandon: true, cause: 'probe_unobservable' }
  );
});

test('watchdog: a busy probe still resets under the tightened budget', () => {
  // A stop was requested but the turn is visibly still alive (the kill
  // hasn't landed yet) — that must not abandon on the next single idle
  // without the strike actually accumulating.
  const c = worker.newWatchdogCounters();
  assert.deepEqual(
    worker.recordWatchdogProbe(c, true, { idleLimit: 1 }),
    { abandon: false, cause: null }
  );
  assert.equal(c.idleStrikes, 0);
});

test('watchdog: the default budget is unchanged for non-stopped turns', () => {
  // Explicitly pinned: the 10s/2-strike policy is the safety net for OOM
  // kills and vanished containers, where a fast cadence would only pile
  // docker-exec load onto an already-contended daemon.
  const c = worker.newWatchdogCounters();
  assert.deepEqual(worker.recordWatchdogProbe(c, false), { abandon: false, cause: null });
  assert.deepEqual(worker.recordWatchdogProbe(c, false), { abandon: true, cause: 'turn_process_gone' });
});

test('newWatchState initializes markerlessCause to null', () => {
  const state = worker.newWatchState();
  assert.equal(state.markerlessCause, null);
  assert.equal(state.agentRetryFresh, false);
});

// ── __USERNODE_WARN__ forwarding ────────────────────────────────────────

test('parseLine: __USERNODE_WARN__ forwards to onProgress with ⚠ prefix and still logs', () => {
  const progressLines = [];
  const warns = [];
  const origWarn = log.warn;
  log.warn = (cat, msg, data) => warns.push({ cat, msg, data });
  try {
    const state = worker.newWatchState();
    worker.parseLine(
      '__USERNODE_WARN__ resume failed (exit 2); retrying fresh',
      (t) => progressLines.push(t),
      state
    );
  } finally {
    log.warn = origWarn;
  }
  assert.deepEqual(progressLines, ['⚠ resume failed (exit 2); retrying fresh']);
  assert.equal(warns.length, 1);
  assert.equal(warns[0].msg, 'resume failed (exit 2); retrying fresh');
});

test('parseLine: non-warn marker lines keep their existing behavior', () => {
  const progressLines = [];
  const state = worker.newWatchState();
  worker.parseLine('__USERNODE_EXIT__ 0', (t) => progressLines.push(t), state);
  assert.equal(state.execExitSeen, true);
  assert.equal(state.exitCode, 0);
  assert.deepEqual(progressLines, []);
});

test('parseLine: backend-neutral terminal result fields are captured (plan.md PR1)', () => {
  const progressLines = [];
  const state = worker.newWatchState();
  // A modern codex_openrouter runner (PR5+) emits agent_* fields alongside
  // the legacy cc_* alias during the migration window.
  worker.parseLine(
    '__USERNODE_RESULT__ agent_backend=codex_openrouter agent_provider=openrouter '
      + 'agent_model=openai/gpt-5.3-codex agent_thread_id=thr-0199 '
      + 'agent_exit=0 agent_retry_fresh=1 cc_exit=0 ahead=3 behind=0 sha=abc123 push_ok=1 mode=build',
    (t) => progressLines.push(t),
    state,
  );
  assert.equal(state.resultSeen, true);
  assert.equal(state.agentBackend, 'codex_openrouter');
  assert.equal(state.agentProvider, 'openrouter');
  assert.equal(state.agentModel, 'openai/gpt-5.3-codex');
  assert.equal(state.agentThreadId, 'thr-0199');
  assert.equal(state.agentExit, 0);
  assert.equal(state.agentRetryFresh, true);
  // Legacy fields still parsed for compatibility.
  assert.equal(state.ccExit, 0);
  assert.equal(state.ahead, 3);
  assert.equal(state.behind, 0);
  assert.equal(state.sha, 'abc123');
  assert.equal(state.pushOk, true);
  assert.deepEqual(progressLines, []);
});

test('parseLine: backend-neutral result tolerates missing legacy cc_exit', () => {
  const state = worker.newWatchState();
  worker.parseLine(
    '__USERNODE_RESULT__ agent_backend=codex_openrouter agent_exit=1 ahead=0 behind=2 push_ok=0 mode=build',
    () => {},
    state,
  );
  assert.equal(state.agentExit, 1);
  assert.equal(state.ccExit, null);
  assert.equal(state.agentBackend, 'codex_openrouter');
  assert.equal(state.behind, 2);
  assert.equal(state.pushOk, false);
});
