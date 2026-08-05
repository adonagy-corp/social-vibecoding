'use strict';

// The shared admin class-string registry. This was a bare global read that
// depended on <script> order (admin-console.js loaded first); inside the
// React bundle the dependency is explicit (#1082 chunk E).
import { AdminUI } from './admin-console.js';

// Health & status section of the admin console (#860) — the whole of the
// retired standalone /status page, ported into the console's
// #admin/status section. Same markup, same renderers, same 5s
// auto-refresh with the pause checkbox and manual refresh button; the
// only structural changes are:
//
//   - `render(host)` / `destroy()` instead of a page that boots on load,
//     so AdminConsole can tear the poll down when you leave the section
//     (the /api/status snapshot shells out to `docker stats`, so a
//     forgotten 5s interval is genuinely expensive — see
//     src/services/status.js's stale-while-revalidate cache);
//   - the `.admin-only` visibility flag moved from <body class="is-admin">
//     onto this section's own root element, so it can never hide
//     `.admin-only` markup elsewhere in the SPA (see #admin-status-root
//     in public/css/app.css);
//   - the "→ full status" link now switches to the in-console
//     #admin/node section instead of opening /node-status in a new tab.
//
// PERMISSIONS: this is one of the two `public` console sections. The
// server does the real work — GET /api/status runs the payload through
// src/services/status.js `redact()`, which strips live worker progress,
// model names, spend, host RAM/load, DB pool internals, stuck sessions
// and the event ring buffer for non-admins. This module only mirrors
// that with the `is-admin` class so the admin-only HEADINGS disappear
// too; it never gates on a client-side flag for data it wouldn't
// otherwise receive.

const AdminStatus = {
  REFRESH_MS: 5000,

  _refreshTimer: null,
  _countdownTimer: null,
  _host: null,

  esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  // Seconds → "45s" / "3m 20s" / "2h 5m" / "1d 3h".
  fmtDurationSeconds(seconds) {
    if (seconds == null) return '—';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
  },

  // Milliseconds → the compact inline form ("2h 5m" / "45s"). The old
  // page had TWO functions both called fmtDuration — a seconds one and a
  // later ms one that shadowed it — so every seconds-taking call site
  // was silently reading the ms version. Split into two explicit names
  // here; call sites below use whichever unit the field actually is.
  fmtDurationMs(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const hrs = Math.floor(m / 60);
    const remM = m % 60;
    if (hrs < 24) return remM ? `${hrs}h ${remM}m` : `${hrs}h`;
    const d = Math.floor(hrs / 24);
    return `${d}d ${hrs % 24}h`;
  },

  fmtDollars(cents) {
    return `$${(Number(cents || 0) / 100).toFixed(2)}`;
  },

  fmtBytes(bytes) {
    if (bytes == null) return '—';
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    return `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
  },

  // ── Renderers (ported verbatim from public/status.html) ───────────────

  meterRow(label, valueText, pct, tone = 'zinc') {
    const h = AdminStatus.esc;
    const barTone = { zinc: 'bg-gray-500', green: 'bg-green-500', yellow: 'bg-yellow-500', red: 'bg-red-500' }[tone] || 'bg-gray-500';
    const w = Math.max(0, Math.min(100, Math.round(pct || 0)));
    return `
      <div class="mb-2">
        <div class="flex justify-between text-xs mb-1">
          <span class="text-gray-600 dark:text-gray-400">${h(label)}</span>
          <span class="mono text-gray-700 dark:text-gray-300">${valueText}</span>
        </div>
        <div class="h-1.5 rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden">
          <div class="h-full ${barTone}" style="width:${w}%"></div>
        </div>
      </div>`;
  },

  // Capacity & host panel — the ramp dashboard. Leads with the two numbers
  // that decide whether the box is near its limit (sessions vs cap, active
  // turns) then host RAM/load and DB pool saturation, then the lifecycle
  // backlog (paused / stale-heading-to-archive / resumable archives).
  renderCapacity(data) {
    const c = data.capacity;
    if (!c) return '<div class="text-gray-500">No capacity data.</div>';
    const host = data.host;
    const db = data.db;
    const meterRow = AdminStatus.meterRow;
    const fmtBytes = AdminStatus.fmtBytes;

    const sessPct = c.globalCap ? (c.globalUsed / c.globalCap) * 100 : 0;
    const sessTone = sessPct >= 90 ? 'red' : sessPct >= 70 ? 'yellow' : 'green';
    let out = meterRow('Sessions (active + promoted)', `${c.globalUsed} / ${c.globalCap}`, sessPct, sessTone);

    out += `<div class="flex justify-between text-xs mb-3 text-gray-600 dark:text-gray-400">
      <span>Active turns <span class="mono text-gray-800 dark:text-gray-200">${c.activeTurns}</span> · warm idle <span class="mono text-gray-800 dark:text-gray-200">${c.warmIdleWorkers}</span></span>
      <span>per-user cap <span class="mono text-gray-800 dark:text-gray-200">${c.userCap}</span></span>
    </div>`;

    if (data.runtimeKind === 'kubernetes') {
      const namespaces = Array.isArray(c.namespaces) ? c.namespaces : [];
      if (!namespaces.length) {
        out += '<div class="text-xs text-zinc-500 mb-3">Namespace quota status is unavailable.</div>';
      }
      for (const item of namespaces) {
        const resources = item.resources;
        out += `<div class="mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-800">
          <div class="text-xs font-medium mono text-zinc-700 dark:text-zinc-300 mb-2">${AdminStatus.esc(item.namespace)}</div>`;
        if (!resources) {
          out += '<div class="text-xs text-zinc-500">No readable ResourceQuota.</div>';
        } else {
          const rows = [
            ['Pods', resources.pods],
            ['CPU requests', resources.requestsCpu],
            ['Memory requests', resources.requestsMemory],
          ];
          for (const [label, metric] of rows) {
            if (!metric) continue;
            const pct = metric.percent == null ? 0 : metric.percent;
            const tone = pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green';
            const headroom = metric.headroomPercent == null
              ? ''
              : ` · ${AdminStatus.esc(metric.headroomPercent)}% headroom`;
            out += meterRow(label, `${AdminStatus.esc(metric.used)} / ${AdminStatus.esc(metric.hard)}${headroom}`, pct, tone);
          }
        }
        out += '</div>';
      }
    } else if (host) {
      const memUsed = host.memTotalBytes - host.memFreeBytes;
      const memTone = host.memUsedPct >= 90 ? 'red' : host.memUsedPct >= 75 ? 'yellow' : 'green';
      out += meterRow('Host RAM', `${fmtBytes(memUsed)} / ${fmtBytes(host.memTotalBytes)} (${host.memUsedPct}%)`, host.memUsedPct, memTone);
      const loadPct = host.cpus ? (host.loadAvg1 / host.cpus) * 100 : 0;
      const loadTone = loadPct >= 100 ? 'red' : loadPct >= 70 ? 'yellow' : 'zinc';
      out += meterRow(`Load (1m) / ${host.cpus} cores`, `${host.loadAvg1}`, loadPct, loadTone);
    }

    if (db) {
      const poolPct = db.max ? (db.total / db.max) * 100 : 0;
      const poolTone = db.waiting > 0 ? 'red' : poolPct >= 80 ? 'yellow' : 'zinc';
      out += meterRow('DB pool (open / max)', `${db.total} / ${db.max}${db.waiting > 0 ? ` · ${db.waiting} waiting` : ''}`, poolPct, poolTone);
    }

    const bs = c.byStatus || {};
    out += `<div class="mt-3 pt-3 border-t border-gray-200 dark:border-gray-800 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
      <div class="flex justify-between"><span class="text-gray-500">active</span><span class="mono">${bs.active ?? 0}</span></div>
      <div class="flex justify-between"><span class="text-gray-500">promoted</span><span class="mono">${bs.promoted ?? 0}</span></div>
      <div class="flex justify-between"><span class="text-gray-500">paused</span><span class="mono">${bs.paused ?? 0}</span></div>
      <div class="flex justify-between"><span class="text-gray-500">archived</span><span class="mono">${bs.archived ?? 0}</span></div>
      <div class="flex justify-between"><span class="text-gray-500">stale → archive</span><span class="mono ${c.staleNotified > 0 ? 'text-yellow-600 dark:text-yellow-400' : ''}">${c.staleNotified}</span></div>
      <div class="flex justify-between"><span class="text-gray-500">resumable</span><span class="mono">${c.archivedResumable}</span></div>
    </div>`;

    return out;
  },

  statePill(state, label) {
    const map = {
      running: 'pill-running',
      exited: 'pill-stopped',
      stopped: 'pill-stopped',
      paused: 'pill-stopped',
      dead: 'pill-missing',
      missing: 'pill-missing',
      creating: 'pill-creating',
      restarting: 'pill-creating',
      unknown: 'pill-stopped',
    };
    const cls = map[state] || 'pill-stopped';
    return `<span class="pill ${cls}"><span class="dot"></span>${AdminStatus.esc(label || state)}</span>`;
  },

  summaryCard(label, value, tone = 'zinc') {
    const toneCls = {
      zinc: 'border-gray-200 dark:border-gray-800',
      green: 'border-green-300 dark:border-green-700/40',
      yellow: 'border-yellow-300 dark:border-yellow-700/40',
      red: 'border-red-300 dark:border-red-700/40',
    }[tone];
    return `
      <div class="rounded-lg border ${toneCls} bg-gray-50 dark:bg-gray-900/60 p-3">
        <div class="text-xs text-gray-500 uppercase tracking-wide">${AdminStatus.esc(label)}</div>
        <div class="text-xl font-semibold mt-0.5">${value}</div>
      </div>`;
  },

  // Maps the sidecar's `node_sync_status` (Synced / Syncing / Connected /
  // Connecting / unreachable / unknown) onto a human label, a status pill
  // class, and the summary-card tone. Centralized so renderNode() and
  // renderSummary() agree.
  nodeStatusMeta(node) {
    if (!node || !node.status) {
      return { label: 'unknown', pill: 'pill-stopped', tone: 'zinc' };
    }
    switch (node.status) {
      case 'Synced':      return { label: 'Synced',      pill: 'pill-running',  tone: 'green' };
      // Syncing after first sync is healthy ("just applying new tip blocks").
      // Before first sync it's a fresh boot still catching up — yellow there.
      case 'Syncing':     return {
        label: 'Syncing',
        pill: node.hasBeenSynced ? 'pill-running' : 'pill-creating',
        tone: node.hasBeenSynced ? 'green' : 'yellow',
      };
      case 'Connected':   return { label: 'Connected',   pill: 'pill-creating', tone: 'yellow' };
      case 'Connecting':  return { label: 'Connecting',  pill: 'pill-creating', tone: 'yellow' };
      case 'unreachable': return { label: 'Unreachable', pill: 'pill-missing',  tone: 'red' };
      case 'mock':        return { label: 'Mock',        pill: 'pill-stopped',  tone: 'zinc' };
      case 'unknown':
      default:            return { label: node.status,   pill: 'pill-stopped',  tone: 'zinc' };
    }
  },

  renderSummary(s, node, runtimeKind) {
    const summaryCard = AdminStatus.summaryCard;
    const fmtDollars = AdminStatus.fmtDollars;
    const prodTone = s.prodMissing > 0 ? 'red' : 'green';
    const workerTone = s.workersOrphaned > 0 ? 'red' : 'zinc';
    const stuckTone = s.stuckSessions > 0 ? 'yellow' : 'zinc';

    // Node summary card. Tone matches the dot color in renderNode() so the
    // top-of-page glance and the dedicated section agree at a glance.
    const nodeMeta = AdminStatus.nodeStatusMeta(node);
    const nodeValue = `${nodeMeta.label}${node && typeof node.peers === 'number' ? ` <span class="text-gray-500 text-xs">${node.peers}p</span>` : ''}`;

    // Long-lived worker breakdown: "in-flight" is what used to be the
    // only meaningful workersRunning figure; warm-idle is the new
    // background memory cost the operator pays for fast subsequent
    // dispatches.
    const inFlight = s.workersInFlight ?? s.workersRunning ?? 0;
    const warmIdle = s.workersWarmIdle ?? 0;
    const workerExtras = [];
    if (warmIdle > 0) workerExtras.push(`<span class="text-gray-500 text-xs">+${warmIdle} warm</span>`);
    if (s.workersOrphaned > 0) workerExtras.push(`<span class="text-red-600 dark:text-red-400 text-xs">+${s.workersOrphaned} orphan</span>`);
    const workerValue = runtimeKind === 'kubernetes'
      ? `${s.workersReady || 0}/${s.workersTotal || 0}${inFlight > 0 ? ` <span class="text-zinc-500 text-xs">${inFlight} active</span>` : ''}`
      : `${inFlight}${workerExtras.length ? ' ' + workerExtras.join(' ') : ''}`;
    const stagingValue = runtimeKind === 'kubernetes'
      ? `${s.stagingRunning || 0}/${s.stagingTotal || 0}`
      : `${s.stagingRunning}/${s.stagingCap}`;

    const cards = [
      summaryCard('Node', nodeValue, nodeMeta.tone),
      summaryCard('Apps', `${s.prodRunning}/${s.apps}`, prodTone),
      summaryCard('Staging', stagingValue),
      summaryCard('Workers', workerValue, workerTone),
      summaryCard('Stuck', `${s.stuckSessions}`, stuckTone),
      summaryCard('Prod missing', `${s.prodMissing}`, s.prodMissing > 0 ? 'red' : 'zinc'),
    ];

    // Ramp headlines. Sessions vs the global cap (what 429s/eviction gate
    // on) and active turns (the real RAM pressure) are the two numbers to
    // watch during a load ramp. Host RAM/load are admin-only (stripped for
    // non-admins server-side), so guard on presence.
    if (s.sessionsGlobalCap != null) {
      const sessPct = s.sessionsGlobalCap ? Math.round((s.sessionsGlobalUsed / s.sessionsGlobalCap) * 100) : 0;
      const sessTone = sessPct >= 90 ? 'red' : sessPct >= 70 ? 'yellow' : 'zinc';
      cards.push(summaryCard('Sessions', `${s.sessionsGlobalUsed}/${s.sessionsGlobalCap}`, sessTone));
    }
    if (s.activeTurns != null) {
      cards.push(summaryCard('Active turns', `${s.activeTurns}`, s.activeTurns > 0 ? 'green' : 'zinc'));
    }
    if (s.hostMemUsedPct != null) {
      const memTone = s.hostMemUsedPct >= 90 ? 'red' : s.hostMemUsedPct >= 75 ? 'yellow' : 'zinc';
      cards.push(summaryCard('Host RAM', `${s.hostMemUsedPct}%`, memTone));
    }
    if (s.dbPoolWaiting != null) {
      cards.push(summaryCard('DB queue', `${s.dbPoolWaiting}`, s.dbPoolWaiting > 0 ? 'red' : 'zinc'));
    }

    if (s.globalSpendCents != null) {
      const spendPct = Math.round((s.globalSpendCents / s.globalSpendCap) * 100);
      const spendTone = spendPct > 80 ? 'red' : spendPct > 50 ? 'yellow' : 'zinc';
      cards.splice(5, 0, summaryCard('LLM today', `${fmtDollars(s.globalSpendCents)} / ${fmtDollars(s.globalSpendCap)}`, spendTone));
    }

    return cards.join('');
  },

  // Block-explorer card. The explorer is external infrastructure — this
  // card reports, it does not repair. Its whole reason for existing is the
  // consequence line: when the explorer is unreachable the wallet-link
  // poller can't see incoming link transactions, so "Link wallet" silently
  // never completes and nothing else says so.
  renderExplorer(ex) {
    const h = AdminStatus.esc;
    if (!ex || ex.status === 'unknown') {
      return '<div class="text-gray-500">Explorer not probed yet.</div>';
    }

    const meta = {
      ok:            { label: 'Reachable',    pill: 'pill-running', tone: 'green' },
      unreachable:   { label: 'Unreachable',  pill: 'pill-missing', tone: 'red' },
      bad_response:  { label: 'Bad response', pill: 'pill-missing', tone: 'red' },
      mock:          { label: 'Mock',         pill: 'pill-stopped', tone: 'zinc' },
    }[ex.status] || { label: ex.status, pill: 'pill-stopped', tone: 'zinc' };

    const down = ex.status !== 'ok' && ex.downSince
      ? `<span class="text-red-700 dark:text-red-300/80"> — unreachable for ${h(AdminStatus.fmtDurationMs(Date.now() - ex.downSince))}${
          ex.consecutiveFailures ? ` (${h(ex.consecutiveFailures)} failed probes)` : ''
        }</span>`
      : '';

    const consequence = ex.status !== 'ok' ? `
      <div class="mt-3 rounded border border-red-300 dark:border-red-700/40 bg-red-50 dark:bg-red-900/20 p-2 text-xs">
        <span class="font-semibold text-red-700 dark:text-red-300">Wallet linking is paused</span>
        <span class="text-red-700 dark:text-red-300/80">— the chain poller reads incoming link transactions from this explorer, so "Link wallet" will not complete until it is reachable again. Retries are backing off; no action is needed here beyond restoring the upstream.</span>
      </div>` : '';

    const errorLine = ex.error ? `
      <div class="mt-2 text-xs text-red-600 dark:text-red-400 mono break-all">${h(ex.error)}</div>` : '';

    return `
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span class="pill ${meta.pill}">${h(meta.label)}</span>
        <span class="mono text-xs text-gray-500 break-all">${h(ex.host || '—')}</span>
        ${ex.chainId ? `<span class="text-xs text-gray-500">chain <span class="mono">${h(ex.chainId)}</span></span>` : ''}
        ${ex.latencyMs != null ? `<span class="text-xs text-gray-500">${h(ex.latencyMs)}ms</span>` : ''}
        ${down}
      </div>
      ${consequence}
      ${errorLine}`;
  },

  renderNode(node) {
    const h = AdminStatus.esc;
    if (!node || node.status === 'unknown') {
      return '<div class="text-gray-500">No NODE_RPC_URL configured — node status unavailable.</div>';
    }

    const meta = AdminStatus.nodeStatusMeta(node);
    const ourTip = node.bestTipHeight;
    const peerTip = node.peerBestTipHeight;
    // Sync progress is only meaningful when we have both numbers; otherwise
    // hide the bar rather than render a misleading 0%/100%.
    const showBar = ourTip != null && peerTip != null && peerTip > 0;
    const pct = showBar ? Math.max(0, Math.min(100, (ourTip / peerTip) * 100)) : 0;
    const behind = showBar ? Math.max(0, peerTip - ourTip) : null;

    // Fresh-boot Syncing bar is yellow ("we're behind"); steady-state catch-up
    // after first sync is green ("just applying new tip blocks").
    const barColor = node.status === 'Syncing' && !node.hasBeenSynced ? 'bg-yellow-500'
      : node.status === 'Syncing' ? 'bg-green-500'
      : 'bg-indigo-500';

    // PARTIAL_LEDGER_RECENT_TX_SOURCE_BUG warning. False here means the
    // sidecar booted without HAS_FULL_UTXO_DB, which causes the recent-tx
    // stream to silently drop tx from non-tracked senders.
    const partialLedgerWarning = node.hasFullUtxoDb === false ? `
      <div class="mt-3 rounded border border-red-300 dark:border-red-700/40 bg-red-50 dark:bg-red-900/20 p-2 text-xs">
        <span class="font-semibold text-red-700 dark:text-red-300">Partial ledger mode</span>
        <span class="text-red-700 dark:text-red-300/80">— sidecar booted without HAS_FULL_UTXO_DB. Incoming tx from non-tracked senders may be silently dropped. Restart with a fresh archive snapshot.</span>
      </div>` : '';

    const errorLine = node.error ? `
      <div class="mt-2 text-xs text-red-600 dark:text-red-400 mono break-all">${h(node.error)}</div>` : '';

    const tipLine = (ourTip != null || peerTip != null) ? `
      <div class="text-xs text-gray-500 mt-1">
        tip <span class="mono text-gray-700 dark:text-gray-300">${ourTip != null ? ourTip.toLocaleString() : '—'}</span>
        ${peerTip != null ? `/ <span class="mono text-gray-600 dark:text-gray-400">${peerTip.toLocaleString()}</span> on network` : ''}
        ${behind != null && behind > 0 ? `<span class="text-yellow-600 dark:text-yellow-400 ml-1">(${behind.toLocaleString()} blocks behind)</span>` : ''}
      </div>` : '';

    const ageSeconds = node.at ? Math.max(0, Math.floor((Date.now() - new Date(node.at).getTime()) / 1000)) : null;
    const lastUpdated = ageSeconds != null ? `<span class="text-xs text-gray-500 ml-auto">updated ${ageSeconds < 60 ? `${ageSeconds}s` : `${Math.floor(ageSeconds / 60)}m`} ago</span>` : '';

    const bar = showBar ? `
      <div class="mt-2">
        <div class="h-1.5 rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden">
          <div class="h-full ${barColor} transition-all duration-300" style="width:${pct.toFixed(1)}%"></div>
        </div>
      </div>` : '';

    return `
      <div class="flex items-center gap-3 flex-wrap">
        <span class="pill ${meta.pill}"><span class="dot"></span>${h(meta.label)}</span>
        <span class="text-gray-700 dark:text-gray-300">${node.peers} peer${node.peers === 1 ? '' : 's'}</span>
        ${node.hasFullUtxoDb === true ? '<span class="pill pill-running"><span class="dot"></span>full UTXO DB</span>' : ''}
        ${lastUpdated}
      </div>
      ${tipLine}
      ${bar}
      ${errorLine}
      ${partialLedgerWarning}`;
  },

  renderApps(apps) {
    const h = AdminStatus.esc;
    const statePill = AdminStatus.statePill;
    const fmtDuration = AdminStatus.fmtDurationSeconds;
    if (!apps.length) return '<div class="text-sm text-gray-500">No apps yet.</div>';
    return apps.map((a) => {
      const prodState = a.prod?.state || (a.dbStatus === 'creating' ? 'creating' : 'missing');
      const prodLabel = a.prod?.state || a.dbStatus || 'missing';
      const mem = a.prod?.stats?.mem ? `<span class="mono text-gray-500">${h(a.prod.stats.mem)}</span>` : '';
      const cpu = a.prod?.stats?.cpu ? `<span class="mono text-gray-500">${h(a.prod.stats.cpu)}</span>` : '';

      const sessions = a.sessions.map((s) => {
        const stagingState = s.staging?.state || (s.stagingDriftWarning ? 'missing' : 'creating');
        const stagingLabel = s.staging?.state || (s.stagingDriftWarning ? 'drift' : 'pending');
        const stagingStats = s.staging?.stats ? `<span class="mono text-gray-500 ml-2">${h(s.staging.stats.mem)} · ${h(s.staging.stats.cpu)}</span>` : '';
        const prLink = s.prUrl ? `<a href="${h(s.prUrl)}" target="_blank" rel="noopener" class="text-indigo-600 dark:text-indigo-400 hover:underline">PR #${s.prNumber}</a>` : '<span class="text-gray-500">no PR</span>';
        const prTitle = s.prTitle ? `<span class="text-gray-700 dark:text-gray-300 ml-2 truncate">${h(s.prTitle)}</span>` : '';
        const resolve = typeof window.resolveDevHost === 'function' ? window.resolveDevHost : ((u) => u);
        const stagingResolved = s.stagingUrl ? resolve(s.stagingUrl) : '';
        const stagingLink = s.stagingUrl ? `<a href="${h(stagingResolved)}" target="_blank" rel="noopener" class="text-indigo-600 dark:text-indigo-400 hover:underline mono text-xs break-all">${h(stagingResolved)}</a>` : '';

        let workerLine = '';
        if (s.worker) {
          const orphanTag = s.worker.orphan ? '<span class="text-red-600 dark:text-red-400 ml-1">(orphan)</span>' : '';
          workerLine = `
            <div class="mt-1.5 pl-3 border-l-2 border-indigo-300 dark:border-indigo-800 text-xs">
              <div class="flex items-center gap-2">
                ${statePill(s.worker.state || 'unknown', `worker: ${s.worker.state || 'unknown'}`)}
                <span class="text-gray-600 dark:text-gray-400">${fmtDuration(s.worker.uptimeSeconds)}${orphanTag}</span>
                ${s.worker.model ? `<span class="mono text-gray-500">${h(s.worker.model)}</span>` : ''}
              </div>
              ${s.worker.lastProgress ? `<div class="text-gray-600 dark:text-gray-400 mt-0.5 mono truncate">▸ ${h(s.worker.lastProgress)}</div>` : ''}
            </div>`;
        }

        return `
          <div class="pl-3 border-l-2 border-gray-200 dark:border-gray-800 py-2">
            <div class="flex items-center gap-2 flex-wrap">
              ${statePill(stagingState, `staging: ${stagingLabel}`)}
              <span class="text-gray-600 dark:text-gray-400 text-xs">#${s.id}</span>
              <span class="text-gray-700 dark:text-gray-300 text-xs">@${h(s.username)}</span>
              <span class="mono text-gray-500 text-xs">${h(s.branchName || '—')}</span>
              <span class="text-xs">${prLink}</span>
              ${prTitle}
              <span class="text-gray-500 text-xs ml-auto">${fmtDuration(s.ageSeconds)}</span>
            </div>
            <div class="mt-0.5 text-xs flex items-center gap-2 flex-wrap">
              ${stagingLink}
              ${stagingStats}
            </div>
            ${workerLine}
          </div>`;
      }).join('');

      let repoHost = '';
      if (a.repoUrl) {
        try { repoHost = new URL(a.repoUrl).pathname.replace(/^\//, ''); } catch { repoHost = a.repoUrl; }
      }

      return `
        <div class="${AdminUI.card}">
          <div class="p-3 flex items-start justify-between gap-3 flex-wrap">
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-semibold">${h(a.name)}</span>
                <span class="mono text-gray-500 text-xs">${h(a.slug)}</span>
                ${statePill(prodState, `prod: ${prodLabel}`)}
              </div>
              <div class="text-xs text-gray-500 mt-1 flex items-center gap-3 flex-wrap">
                ${a.repoUrl ? `<a href="${h(a.repoUrl)}" target="_blank" rel="noopener" class="hover:text-indigo-600 dark:hover:text-indigo-800 dark:hover:text-indigo-300 mono">${h(repoHost)}</a>` : ''}
                <span>by @${h(a.createdBy || 'unknown')}</span>
                <span>${a.openSessions} session${a.openSessions === 1 ? '' : 's'}</span>
                <span>${a.openIssues} issue${a.openIssues === 1 ? '' : 's'}</span>
                ${a.prod ? `<span>up ${fmtDuration(a.prod.uptimeSeconds)}</span>` : ''}
                ${mem} ${cpu}
              </div>
            </div>
          </div>
          ${a.sessions.length ? `<div class="border-t border-gray-200 dark:border-gray-800 px-3 pb-2">${sessions}</div>` : ''}
        </div>`;
    }).join('');
  },

  // Visual taxonomy for long-lived workers:
  //   in-flight    : currently running a docker exec — busy with a turn
  //   warm-idle    : waiting for the next dispatch (memory cost only)
  //   bootstrapping: clone + checkout + warm-ready in flight
  //   unregistered : container exists but isn't in the warm registry
  workerModePill(mode) {
    if (!mode) return '';
    const cls = {
      'in-flight': 'pill-running',
      'warm-idle': 'pill-creating',
      bootstrapping: 'pill-creating',
      unregistered: 'pill-stopped',
    }[mode] || 'pill-stopped';
    return `<span class="pill ${cls}"><span class="dot"></span>${AdminStatus.esc(mode)}</span>`;
  },

  renderWorkers(workers) {
    const h = AdminStatus.esc;
    const fmtDuration = AdminStatus.fmtDurationSeconds;
    if (!workers.length) return '<div class="text-gray-500">No workers running.</div>';
    return workers.map((w) => {
      const orphan = w.orphan ? '<span class="text-red-600 dark:text-red-400 ml-1">orphan</span>' : '';
      const idleLabel = w.workerMode === 'warm-idle' && w.idleMs != null
        ? `idle ${fmtDuration(Math.floor(w.idleMs / 1000))}`
        : '';
      return `
        <div class="rounded border ${w.orphan ? 'border-red-300 dark:border-red-700/40' : 'border-gray-200 dark:border-gray-800'} bg-gray-50 dark:bg-gray-900/40 p-2">
          <div class="flex items-center gap-2 flex-wrap">
            ${AdminStatus.statePill(w.state, w.state)}
            ${AdminStatus.workerModePill(w.workerMode)}
            <span class="text-xs text-gray-600 dark:text-gray-400">session #${w.sessionId}</span>
            ${w.appSlug ? `<span class="mono text-xs text-gray-500">${h(w.appSlug)}</span>` : ''}
            ${w.username ? `<span class="text-xs">@${h(w.username)}</span>` : ''}
            ${idleLabel ? `<span class="text-xs text-gray-500">${idleLabel}</span>` : ''}
            <span class="text-xs text-gray-500 ml-auto">${fmtDuration(w.uptimeSeconds)}${orphan}</span>
          </div>
          ${w.lastProgress ? `<div class="mt-1 mono text-xs text-gray-600 dark:text-gray-400 truncate">▸ ${h(w.lastProgress)}</div>` : ''}
        </div>`;
    }).join('');
  },

  renderStuck(stuck) {
    const h = AdminStatus.esc;
    if (!stuck.length) return '<div class="text-gray-500">None.</div>';
    return stuck.map((s) => `
      <div class="rounded border border-yellow-300 dark:border-yellow-700/40 bg-gray-50 dark:bg-gray-900/40 p-2">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="pill pill-stopped"><span class="dot"></span>stuck</span>
          <span class="text-xs text-gray-600 dark:text-gray-400">session #${s.id}</span>
          <span class="mono text-xs text-gray-500">${h(s.appSlug)}</span>
          <span class="text-xs">@${h(s.username || 'unknown')}</span>
          <span class="text-xs text-gray-500 ml-auto">${AdminStatus.fmtDurationSeconds(s.ageSeconds)}</span>
        </div>
        <div class="text-xs text-gray-500 mt-0.5 mono">${h(s.branchName)}</div>
      </div>`).join('');
  },

  renderLlm(data) {
    const h = AdminStatus.esc;
    const fmtDollars = AdminStatus.fmtDollars;
    const { llmUsage, stagingPerUser, summary, limits } = data;
    if (!summary || !limits) return '<div class="text-gray-500 text-xs">no data</div>';
    const pct = Math.min(100, Math.round((summary.globalSpendCents / summary.globalSpendCap) * 100));
    const bar = `
      <div class="mb-2">
        <div class="flex justify-between text-xs mb-1">
          <span class="text-gray-600 dark:text-gray-400">global</span>
          <span class="mono">${fmtDollars(summary.globalSpendCents)} / ${fmtDollars(summary.globalSpendCap)} (${pct}%)</span>
        </div>
        <div class="h-1.5 rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden">
          <div class="h-full bg-indigo-500" style="width:${pct}%"></div>
        </div>
      </div>`;

    const rows = (llmUsage || []).length ? llmUsage.map((u) => {
      const userPct = Math.min(100, Math.round((u.costCents / limits.userDailyCents) * 100));
      const atCap = u.costCents >= limits.userDailyCents;
      const stagingCt = (stagingPerUser || {})[u.username] || 0;
      return `
        <div class="flex items-center justify-between text-xs py-0.5">
          <div class="flex items-center gap-2 min-w-0">
            <span class="truncate">@${h(u.username)}</span>
            ${stagingCt >= limits.stagingPerUser ? `<span class="text-red-600 dark:text-red-400 text-[10px]">${stagingCt}/${limits.stagingPerUser} staging</span>` : stagingCt > 0 ? `<span class="text-gray-500 text-[10px]">${stagingCt} staging</span>` : ''}
          </div>
          <span class="mono ${atCap ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'}">${fmtDollars(u.costCents)} (${userPct}%)</span>
        </div>`;
    }).join('') : '<div class="text-gray-500 text-xs">no activity</div>';

    return bar + rows;
  },

  renderDrift(drift) {
    const h = AdminStatus.esc;
    if (!drift.length) return '<div class="text-gray-500">No drift detected.</div>';
    return drift.map((d) => `
      <div class="rounded border border-red-300 dark:border-red-700/40 bg-gray-50 dark:bg-gray-900/40 p-2 text-xs">
        <div class="flex items-center gap-2">
          <span class="pill pill-missing"><span class="dot"></span>${h(d.kind)} missing</span>
          <span class="mono text-gray-600 dark:text-gray-400">${h(d.expected)}</span>
        </div>
      </div>`).join('');
  },

  renderDeployBanner(deploy) {
    const banner = document.getElementById('admin-status-deploy-banner');
    if (!banner) return;
    if (!deploy?.deploying) {
      banner.classList.add('hidden');
      return;
    }
    banner.classList.remove('hidden');
    const meta = document.getElementById('admin-status-deploy-meta');
    if (!meta) return;
    const sha = deploy.sha ? deploy.sha.substring(0, 7) : '';
    const elapsed = deploy.startedAt
      ? AdminStatus.fmtDurationSeconds(Math.floor((Date.now() - new Date(deploy.startedAt).getTime()) / 1000))
      : '';
    meta.textContent = [sha, elapsed && `${elapsed} ago`].filter(Boolean).join(' · ');
  },

  renderEvents(events) {
    const h = AdminStatus.esc;
    if (!events.length) return '<div class="text-gray-500 text-xs">no events yet</div>';
    return events.map((e) => {
      const lvl = { ERROR: 'text-red-600 dark:text-red-400', WARN: 'text-yellow-600 dark:text-yellow-400', INFO: 'text-gray-600 dark:text-gray-400', DEBUG: 'text-gray-600' }[e.level] || 'text-gray-600 dark:text-gray-400';
      const time = new Date(e.ts).toLocaleTimeString();
      const data = e.data ? ' ' + (typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) : '';
      return `<div class="truncate"><span class="text-gray-600">${h(time)}</span> <span class="${lvl}">${h(e.level)}</span> <span class="text-gray-500">[${h(e.category)}]</span> ${h(e.message)}<span class="text-gray-600">${h(data.substring(0, 200))}</span></div>`;
    }).join('');
  },

  // ── Section lifecycle ────────────────────────────────────────────────

  render(host) {
    AdminStatus._host = host;
    host.innerHTML = `
      <div id="admin-status-root">
        <header class="flex items-center justify-between flex-wrap gap-2 mb-4">
          <div class="flex items-center gap-3">
            <h2 class="${AdminUI.cardTitle}">Health &amp; status</h2>
            <span id="admin-status-version" class="text-xs mono text-gray-500"></span>
            <span id="admin-status-badge" class="admin-only text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-700/30 text-indigo-700 dark:text-indigo-300">admin view</span>
          </div>
          <div class="flex items-center gap-4 text-xs text-gray-500">
            <label class="flex items-center gap-2">
              <input id="admin-status-autorefresh" type="checkbox" checked class="accent-indigo-500">
              auto-refresh <span id="admin-status-countdown" class="mono"></span>
            </label>
            <button id="admin-status-refresh-now" type="button" class="px-2 py-1 rounded bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200">refresh</button>
          </div>
        </header>

        <!-- Deploy-in-progress banner. Hidden by default. -->
        <div id="admin-status-deploy-banner" class="hidden mb-4 rounded-lg border border-indigo-300 dark:border-indigo-700/50 bg-indigo-50 dark:bg-indigo-900/20 px-4 py-3">
          <div class="flex items-center gap-3">
            <span class="relative flex h-2.5 w-2.5">
              <span class="absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75 animate-ping"></span>
              <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-indigo-500"></span>
            </span>
            <div class="text-sm">
              <span class="font-semibold text-indigo-800 dark:text-indigo-200">Deploy in progress</span>
              <span class="text-indigo-700 dark:text-indigo-300/80"> — your changes may take a minute to go live.</span>
            </div>
            <span id="admin-status-deploy-meta" class="ml-auto text-xs mono text-indigo-600 dark:text-indigo-400"></span>
          </div>
        </div>

        <!-- Summary bar -->
        <div id="admin-status-summary" class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-2 mb-6"></div>

        <!-- Usernode sidecar status. The cached snapshot is updated
             server-side every 500ms-2s by services/node-status.js, so this
             card stays fresh without each tab independently polling the
             sidecar. "→ full status" switches to the Node & chain section. -->
        <section class="mb-6">
          <div class="flex items-baseline justify-between mb-2">
            <h3 class="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">Usernode node</h3>
            <button type="button" data-admin-section="node" class="text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300">
              → full status
            </button>
          </div>
          <div id="admin-status-node" class="${AdminUI.card} p-4 text-sm"></div>
        </section>

        <!-- Block-explorer reachability. Separate card from the node above:
             different host, different failure mode, and when it's down the
             consequence (wallet linking stops completing) is invisible
             anywhere else. -->
        <section class="mb-6">
          <div class="flex items-baseline justify-between mb-2">
            <h3 class="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">Block explorer</h3>
          </div>
          <div id="admin-status-explorer" class="${AdminUI.card} p-4 text-sm"></div>
        </section>

        <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <!-- Left: Apps tree -->
          <div class="space-y-3 min-w-0">
            <h3 class="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">Apps</h3>
            <div id="admin-status-apps" class="space-y-3"></div>
          </div>

          <!-- Right: System lanes -->
          <div class="space-y-6 min-w-0">
            <section class="admin-only">
              <h3 id="admin-status-capacity-heading" class="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-2">Capacity &amp; host</h3>
              <div id="admin-status-capacity" class="${AdminUI.card} p-4 text-sm"></div>
            </section>

            <section>
              <h3 class="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-2">Workers</h3>
              <div id="admin-status-workers" class="space-y-2 text-sm"></div>
            </section>

            <section>
              <h3 class="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-2">Stuck sessions</h3>
              <div id="admin-status-stuck" class="space-y-2 text-sm"></div>
            </section>

            <section class="admin-only">
              <h3 class="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-2">LLM today</h3>
              <div id="admin-status-llm" class="space-y-1 text-sm"></div>
            </section>

            <section>
              <h3 class="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-2">Drift</h3>
              <div id="admin-status-drift" class="space-y-2 text-sm"></div>
            </section>

            <section class="admin-only">
              <h3 class="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-2">Recent events</h3>
              <div id="admin-status-events" class="space-y-0.5 text-xs mono max-h-80 overflow-y-auto"></div>
            </section>
          </div>
        </div>
      </div>`;

    // The "→ full status" button reuses the console's own
    // [data-admin-section] delegation contract, but that listener is bound
    // on the nav elements only — wire this one directly.
    const nodeLink = host.querySelector('[data-admin-section="node"]');
    if (nodeLink) {
      nodeLink.addEventListener('click', () => {
        if (window.AdminConsole?.setSection) AdminConsole.setSection('node');
      });
    }
    host.querySelector('#admin-status-refresh-now')
      ?.addEventListener('click', () => AdminStatus.refresh());
    host.querySelector('#admin-status-autorefresh')
      ?.addEventListener('change', () => AdminStatus._scheduleRefresh());

    AdminStatus.refresh();
    AdminStatus._scheduleRefresh();
  },

  async refresh() {
    // Bail if the section was swapped out while a fetch was in flight —
    // otherwise we'd write into a detached DOM (harmless) or, worse,
    // resurrect the poll after destroy().
    const rootId = 'admin-status-root';
    try {
      const res = await fetch('/api/status', { credentials: 'include' });
      if (!document.getElementById(rootId)) return;
      if (!res.ok) return;
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return;
      const data = await res.json();
      if (!document.getElementById(rootId)) return;

      const root = document.getElementById(rootId);
      // Scoped to this section's root, NOT <body> — see public/css/app.css.
      root.classList.toggle('is-admin', !!data.isAdmin);
      const set = (id, html) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
      };
      const version = document.getElementById('admin-status-version');
      if (version) version.textContent = data.version || '';
      const capacityHeading = document.getElementById('admin-status-capacity-heading');
      if (capacityHeading) {
        capacityHeading.textContent = data.runtimeKind === 'kubernetes' ? 'Capacity' : 'Capacity & host';
      }
      AdminStatus.renderDeployBanner(data.deployProgress);
      set('admin-status-summary', AdminStatus.renderSummary(data.summary || {}, data.node, data.runtimeKind));
      set('admin-status-node', AdminStatus.renderNode(data.node));
      set('admin-status-explorer', AdminStatus.renderExplorer(data.explorer));
      set('admin-status-apps', AdminStatus.renderApps(data.apps || []));
      set('admin-status-workers', AdminStatus.renderWorkers(data.workers || []));
      set('admin-status-stuck', AdminStatus.renderStuck(data.stuckSessions || []));
      set('admin-status-drift', AdminStatus.renderDrift(data.driftContainers || []));
      if (data.isAdmin) {
        set('admin-status-capacity', AdminStatus.renderCapacity(data));
        set('admin-status-llm', AdminStatus.renderLlm(data));
        set('admin-status-events', AdminStatus.renderEvents(data.events || []));
      }
    } catch (err) {
      console.error('status refresh failed', err);
    }
  },

  _scheduleRefresh() {
    clearInterval(AdminStatus._refreshTimer);
    clearInterval(AdminStatus._countdownTimer);
    AdminStatus._refreshTimer = null;
    AdminStatus._countdownTimer = null;
    const box = document.getElementById('admin-status-autorefresh');
    const label = document.getElementById('admin-status-countdown');
    if (!box || !box.checked) {
      if (label) label.textContent = '(paused)';
      return;
    }
    let remaining = AdminStatus.REFRESH_MS;
    if (label) label.textContent = `(${Math.ceil(remaining / 1000)}s)`;
    AdminStatus._countdownTimer = setInterval(() => {
      remaining -= 1000;
      if (remaining <= 0) remaining = AdminStatus.REFRESH_MS;
      const el = document.getElementById('admin-status-countdown');
      if (el) el.textContent = `(${Math.ceil(remaining / 1000)}s)`;
    }, 1000);
    AdminStatus._refreshTimer = setInterval(AdminStatus.refresh, AdminStatus.REFRESH_MS);
  },

  // Called by AdminConsole before it swaps this section out, and when the
  // console itself closes. /api/status performs runtime inventory calls,
  // so leaving the 5s poll running would keep paying for a screen nobody
  // is looking at.
  destroy() {
    clearInterval(AdminStatus._refreshTimer);
    clearInterval(AdminStatus._countdownTimer);
    AdminStatus._refreshTimer = null;
    AdminStatus._countdownTimer = null;
    AdminStatus._host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') window.AdminStatus = AdminStatus;
