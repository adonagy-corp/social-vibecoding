// #767: the SIGTERM→SIGKILL grace handed to `docker stop -t`, and the
// forceKilled diagnostic.
//
// The grace is a CEILING, not a cost — a container that exits on its own
// returns `docker stop` immediately. Two values are in play:
//   - STOP_GRACE_SEC (5s) for live app containers, sized ABOVE the 3s drain
//     deadline the app conventions prescribe so a correctly-draining app is
//     never SIGKILLed mid-drain.
//   - STAGING_STOP_GRACE_SEC (2s) for throwaway previews, which have
//     nothing to drain.
// restartContainer keeps the long 10s grace: it stops a nominally-live
// container on the heal path and isn't latency-sensitive.
//
// `forceKilled` is the diagnostic that finds apps still lacking a shutdown
// handler without inspecting their repos, so it gets pinned too.
//
// Run with: node --test tests/docker-stop-grace.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// `stopDelayMs` models how long `docker stop` blocks: a container that
// handles SIGTERM returns fast; one that ignores it burns the whole grace.
//
// `rmFails` models the failure that leaked ten production previews (#851):
// `docker rm -f` does not make the container go away. The fake tracks
// EXISTENCE and answers `docker inspect` accordingly — a removed container
// makes real docker exit non-zero, which is what stopAndRemove's verification
// step reads as 'not_found'. Modelling that is the difference between testing
// the verification and vacuously passing it.
// `inspectError` models a daemon that cannot answer at all (as opposed to
// answering "no such container"), which is the case inspectContainer must
// report as null rather than as a verdict.
function loadDocker({ stopDelayMs = 0, rmFails = false, inspectError = null } = {}) {
  const ids = {
    childProcess: require.resolve('child_process'),
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/docker'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const logs = [];
  const calls = [];
  let exists = true;             // the container is there until an rm removes it
  const fakeExecFile = async (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === 'stop' && stopDelayMs > 0) {
      await new Promise((r) => setTimeout(r, stopDelayMs));
    }
    if (args[0] === 'rm') {
      if (rmFails) {
        const err = new Error('Command failed: docker rm -f');
        err.stderr = 'Error response from daemon: device or resource busy';
        throw err;
      }
      exists = false;
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'inspect') {
      if (inspectError) {
        const err = new Error('Command failed: docker inspect');
        err.stderr = inspectError;      // e.g. daemon unreachable
        throw err;
      }
      if (!exists) {
        const err = new Error('Command failed: docker inspect');
        err.stderr = 'Error: No such object: x';
        throw err;      // → 'not_found', the container is definitely gone
      }
      return { stdout: 'running\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  fakeExecFile[require('util').promisify.custom] = fakeExecFile;

  stub(ids.childProcess, { execFile: fakeExecFile, spawn: () => { throw new Error('unused'); } });
  stub(ids.logger, {
    info: (cat, msg, data) => logs.push({ level: 'info', cat, msg, data }),
    warn: (cat, msg, data) => logs.push({ level: 'warn', cat, msg, data }),
    error: (cat, msg, data) => logs.push({ level: 'error', cat, msg, data }),
    debug() {},
  });
  delete require.cache[ids.subject];
  const docker = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { docker, calls, logs, restore };
}

function stopArgs(calls) {
  return calls.find((c) => c.args[0] === 'stop').args;
}

test('stopAndRemove defaults to the 5s app grace', async () => {
  const { docker, calls, restore } = loadDocker();
  try {
    assert.equal(docker.STOP_GRACE_SEC, 5,
      'app grace must sit above the 3s drain deadline the conventions prescribe');
    await docker.stopAndRemove('usernode-app-demo');
    assert.deepEqual(stopArgs(calls), ['stop', '-t', '5', 'usernode-app-demo']);
  } finally {
    restore();
  }
});

test('stopAndRemove honours an explicit short grace for throwaway containers', async () => {
  const { docker, calls, restore } = loadDocker();
  try {
    assert.equal(docker.STAGING_STOP_GRACE_SEC, 2);
    await docker.stopAndRemove('usernode-staging-demo--1', {
      stopTimeoutSec: docker.STAGING_STOP_GRACE_SEC,
    });
    assert.deepEqual(stopArgs(calls), ['stop', '-t', '2', 'usernode-staging-demo--1']);
  } finally {
    restore();
  }
});

test('restartContainer keeps the long 10s grace', async () => {
  const { docker, calls, restore } = loadDocker();
  try {
    await docker.restartContainer('usernode-app-demo');
    assert.deepEqual(calls[0].args, ['restart', '-t', '10', 'usernode-app-demo']);
  } finally {
    restore();
  }
});

test('a fast exit reports forceKilled=false with a measured stopMs', async () => {
  const { docker, logs, restore } = loadDocker({ stopDelayMs: 0 });
  try {
    const result = await docker.stopAndRemove('usernode-app-demo');
    assert.equal(result.forceKilled, false);
    assert.equal(typeof result.stopMs, 'number');
    assert.ok(result.stopMs >= 0);
    assert.equal(typeof result.rmMs, 'number');

    const line = logs.find((l) => l.msg === 'Container removed');
    assert.ok(line, 'the stop must be logged');
    assert.equal(line.data.forceKilled, false);
    assert.equal(line.data.stopTimeoutSec, 5);
    assert.equal(typeof line.data.stopMs, 'number');
  } finally {
    restore();
  }
});

test('a stop that burns the whole grace reports forceKilled=true', async () => {
  // A 1s ceiling with a stop that takes the full second models a container
  // whose SIGTERM went nowhere: Docker had to SIGKILL it at the deadline.
  const { docker, logs, restore } = loadDocker({ stopDelayMs: 1000 });
  try {
    const result = await docker.stopAndRemove('usernode-app-legacy', { stopTimeoutSec: 1 });
    assert.equal(result.forceKilled, true,
      'burning the full grace means the process never handled SIGTERM');
    const line = logs.find((l) => l.msg === 'Container removed');
    assert.equal(line.data.forceKilled, true);
  } finally {
    restore();
  }
});

test('staging call sites pass the short grace', () => {
  // Cross-file consistency: the constant existing is useless if the three
  // throwaway-container call sites don't actually use it.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'staging.js'), 'utf8'
  );
  const shortGraceOptions = src.match(/stopTimeoutSec: docker\.STAGING_STOP_GRACE_SEC/g) || [];
  assert.ok(shortGraceOptions.length >= 3,
    'expected all staging removal paths to retain the short grace');
});

// ── #851: stopAndRemove must report whether the container is actually gone ──
//
// Until this landed, both inner calls swallowed their own errors and the
// return value carried only timings — so a caller could not tell a removal
// from a failure. staging.teardownStaging then nulled
// chat_sessions.staging_container_id regardless, and ten merged sessions in
// production ended up with a running container nothing pointed at.
//
// The contract stays NON-THROWING (a dozen best-effort callers depend on
// that). What is new is that the result tells the truth.

test('stopAndRemove verifies the removal and reports removed=true', async () => {
  const { docker, calls, restore } = loadDocker();
  try {
    const result = await docker.stopAndRemove('usernode-app-demo');
    assert.equal(result.removed, true);
    assert.equal(result.error, null);
    // The verification is a real inspect, not an assumption.
    assert.ok(calls.some((c) => c.args[0] === 'inspect'),
      'removal must be confirmed against docker, not inferred from a zero exit');
  } finally {
    restore();
  }
});

test('stopAndRemove reports removed=false when the container survives', async () => {
  const { docker, logs, restore } = loadDocker({ rmFails: true });
  try {
    const result = await docker.stopAndRemove('usernode-staging-leaky--1', {
      stopTimeoutSec: 2,
    });
    assert.equal(result.removed, false,
      'a caller about to forget this container must be able to see it is still there');
    assert.ok(result.error, 'and why');
    assert.match(result.error, /busy/, "docker's own reason is preserved");

    // It must be findable in the logs — both inner failures used to be silent.
    const warned = logs.find((l) => l.level === 'warn' && /SURVIVED/.test(l.msg));
    assert.ok(warned, 'a surviving container is a warn-level event');
    assert.equal(logs.some((l) => l.msg === 'Container removed'), false,
      'and must never be logged as removed');
  } finally {
    restore();
  }
});

test('stopAndRemove retries rm exactly once before declaring a leak', async () => {
  // Transient shapes (a device-busy unmount, a daemon mid-restart) heal on a
  // second attempt; anything surviving that is a genuine leak. One retry, not
  // a loop — a stuck container must not hold a merge open.
  const { docker, calls, restore } = loadDocker({ rmFails: true });
  try {
    await docker.stopAndRemove('usernode-staging-leaky--1', { stopTimeoutSec: 2 });
    const rmCalls = calls.filter((c) => c.args[0] === 'rm');
    assert.equal(rmCalls.length, 2, 'one initial rm plus exactly one retry');
  } finally {
    restore();
  }
});

test('stopAndRemove treats an already-gone container as removed', async () => {
  // The idempotency the sweeper relies on: a container that vanished between
  // listing and teardown is success, not failure. "No such container" is the
  // goal state, so it must not surface as an error.
  const { docker, restore } = loadDocker();
  try {
    await docker.stopAndRemove('usernode-app-demo');          // removes it
    const second = await docker.stopAndRemove('usernode-app-demo');
    assert.equal(second.removed, true);
    assert.equal(second.error, null, '"No such container" is not an error here');
  } finally {
    restore();
  }
});

// ── inspectContainer: status + labels in one call ────────────────────────

test('inspectContainer returns status and labels together', async () => {
  const { docker, calls, restore } = loadDocker();
  try {
    // The fixture answers inspect with a bare status; assert the shape and
    // that exactly ONE docker call was made (the point of the helper: the
    // staleness check runs on every Preview click and every heal sweep).
    const state = await docker.inspectContainer('usernode-staging-demo--1');
    assert.ok(state, 'a live container inspects fine');
    assert.equal(typeof state.status, 'string');
    assert.deepEqual(state.labels, {}, 'no labels is an empty object, not null');
    assert.equal(calls.filter((c) => c.args[0] === 'inspect').length, 1);
  } finally {
    restore();
  }
});

test('inspectContainer reports a removed container as not_found, not null', async () => {
  // "Gone" and "cannot see" must not collapse into one answer. A gone
  // container means REBUILD the preview (staging-recovery shape 2); a daemon
  // we cannot reach means leave it alone. Returning null for both would have
  // silently stopped rebuilding previews whose container vanished.
  const { docker, restore } = loadDocker();
  try {
    await docker.stopAndRemove('usernode-staging-demo--1');   // now gone
    const state = await docker.inspectContainer('usernode-staging-demo--1');
    assert.ok(state, 'a missing container is a definite answer, not an unknown');
    assert.equal(state.status, 'not_found');
    assert.deepEqual(state.labels, {});
  } finally {
    restore();
  }
});

test('inspectContainer returns null when the inspect cannot be performed', async () => {
  // An unreachable daemon: no verdict is available, so callers must not act.
  const { docker, restore } = loadDocker({ inspectError: 'Cannot connect to the Docker daemon' });
  try {
    assert.equal(await docker.inspectContainer('usernode-staging-demo--1'), null);
    // getContainerStatus cannot make this distinction — it says 'not_found'
    // for both — which is exactly why inspectContainer exists.
    assert.equal(await docker.getContainerStatus('usernode-staging-demo--1'), 'not_found');
  } finally {
    restore();
  }
});

// ── runContainer labels ─────────────────────────────────────────────────

test('runContainer passes labels through as --label pairs', async () => {
  const { docker, calls, restore } = loadDocker();
  try {
    await docker.runContainer('usernode-staging-demo--1', {
      image: 'img:abc123',
      env: { PORT: '3000' },
      port: 3000,
      labels: { 'usernode.env.fp': 'c0ffee00c0ffee00' },
    });
    const run = calls.find((c) => c.args[0] === 'run');
    assert.ok(run, 'docker run must have been reached');
    const i = run.args.indexOf('--label');
    assert.ok(i > 0, 'the label must be handed to docker run');
    assert.equal(run.args[i + 1], 'usernode.env.fp=c0ffee00c0ffee00');
    // The label has to precede the image, or docker reads it as a CMD arg.
    assert.ok(i < run.args.indexOf('img:abc123'));
  } finally {
    restore();
  }
});

test('runContainer with no labels adds no --label flag', async () => {
  const { docker, calls, restore } = loadDocker();
  try {
    await docker.runContainer('usernode-app-demo', {
      image: 'img:latest', env: {}, port: 3000,
    });
    const run = calls.find((c) => c.args[0] === 'run');
    assert.equal(run.args.includes('--label'), false,
      'the option is additive — existing callers are untouched');
  } finally {
    restore();
  }
});
