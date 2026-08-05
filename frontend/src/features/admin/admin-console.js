// Admin & moderation console (#818) — the full-page SPA screen behind the
// header shield icon. #588 shipped the icon plus a "Coming soon"
// placeholder; this module is the real console. Hash route
// #admin[/section], hosted in #admin-screen / #admin-root and
// mounted/unmounted by App.navigateToAdminConsole / App._exitAdminConsole
// (public/js/app.js), the same shape as the Challenges / Profile screens.
//
// ── #1082 chunk E: this file used to be public/js/admin-console.js ──────
// The screen root and the console CHASSIS are a React island now
// (./index.tsx): #admin-screen, #admin-root, the md:flex column pair, the
// desktop nav host, the view-only banner, #admin-section-content and the
// temporary-password dialog are all rendered by React and ship in
// public/index.html. This module was MOVED into that bundle rather than
// rewritten — the change here is the three lines that seam it to React:
//
//   * the AdminUI registry is an `export` (plus the same window publication
//     it always had), so the ten section modules import it instead of
//     depending on <script> order;
//   * _renderShell() no longer writes root.innerHTML — the chassis is
//     React's, and writing over it is the one thing the island rule
//     forbids. It repaints the nav host and the banner instead, which is
//     exactly what setSection() already did on every switch;
//   * window.AdminConsole is published behind a `typeof window` guard,
//     because the SSG prerender pass evaluates this module in Node.
//
// Everything below that is unchanged: #admin-section-content is still an
// innerHTML host that this file and the section modules own outright, so
// every render()/destroy() lifecycle, every id and every declared #admin/*
// dapp test sees the DOM it saw before.
//
// It reorganizes the standalone /admin page's sections (public/admin.html:
// Operations overview, Maintenance campaigns, LLM spend limits, Activation
// codes, Users) plus the /admin-features viewer into one page with a
// navigation menu — a fixed sidebar on md+ viewports. Every data endpoint
// is enforced server-side by adminMiddleware (reads) and requireAdminWrite
// (mutations); the client-side visibility gates are only presentation.
//
// MOBILE HIERARCHY: below md the sidebar has no room, and the horizontally
// scrolling tab strip that used to stand in for it (the Dev board's
// kanban-tabs pattern, #814) made sixteen ungrouped sections a thumb-swipe
// scavenger hunt. Phones now get a real two-level nav instead:
//
//   level 1 (#admin)        the grouped section menu, one tappable row per
//                           section under the same Operations / People /
//                           Insights / Platform headings as the sidebar;
//   level 2 (#admin/<key>)  that one section, full width, with the platform
//                           header's back button flipped to an arrow and
//                           its title set to the section label.
//
// The hash stays the single source of truth for WHICH section shows; the
// level is derived from it (bare #admin on mobile = the menu). A menu tap
// is a REAL hash navigation, so it pushes a history entry and the device /
// WebView back gesture pops back to the menu through exactly the same code
// path as the on-screen arrow (see _openSection / handleBack / route).
// Desktop is untouched: same sidebar, same instant switching, same URLs.
//
// #860 completed the consolidation: /status, /node-status, /dashboard,
// /debug and /gallery are sections here too, and all seven old URLs are
// now client-side redirect stubs into the matching #admin/<key>. Nothing
// in the admin experience opens a new browser tab any more, which is why
// the old TOOLS external-link block is gone.
//
// Permissions: the page itself is reachable for anyone with
// App.user.isAdmin (full AND view-only admins — the navigation gate lives
// in app.js). Write controls render only when App.user.canAdminWrite is
// true; view-only admins get read-only labels plus the amber banner,
// mirroring public/admin.html's CAN_WRITE behaviour (issue #311). The
// "View as non-admin" preview masks both flags before this module can read
// them (see the boot masking in app.js), so no extra handling is needed
// here. Never gated on USERNODE_ENV — identical in staging and production.
//
// PUBLIC MODE (#860): the two sections carrying a `public: true` flag —
// Health & status and Node & chain — were publicly reachable as /status
// and /node-status before the fold, so they stay reachable for a
// signed-in NON-admin who follows an old link. app.js mounts the console
// in public mode for those, and _publicMode() below filters the menu down
// to just them and suppresses the view-only banner. The DATA boundary is
// entirely server-side: GET /api/status runs the payload through
// src/services/status.js redact(), which withholds worker progress, model
// names, spend, host load, stuck sessions and the event log from
// non-admins.

// ── AdminUI: shared class recipes, topochain admin vocabulary (see
// docs/superpowers/specs/2026-08-10-admin-topochain-skin-design.md) ──────
// Data-only class-string constants used by this file and every admin-*.js
// section module. They used to depend on <script> ORDER for this object to
// exist — this file loaded first, the section modules read the global. Now
// that the console lives in the React bundle (#1082 chunk E) the dependency
// is a real `import { AdminUI } from './admin-console.js'` in each of them,
// which is also what makes the SSG prerender pass work: admin-topochain.js
// reads AdminUI.card at module-evaluation time, and in Node there is no
// `window` to have published it.
//
// Light mode matches ../topochain's admin verbatim (gray neutrals, indigo
// accent); dark: variants are the fixed translation documented in the spec.
// Every value is a COMPLETE class literal: Tailwind's extractor is a regex
// over the content globs (which now include frontend/src/**/*.js), and
// tests/admin-ui-registry.test.js + tests/tailwind-build.test.js enforce
// the discipline. Never index this registry dynamically.
export const AdminUI = Object.freeze({
  // Surfaces — topochain card: white, rounded-xl, gray-200 hairline, soft shadow.
  card: 'bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm',
  cardHeader: 'flex items-center justify-between gap-2 mb-4',
  cardTitle: 'text-lg font-semibold text-gray-900 dark:text-gray-100',
  cardDescription: 'text-sm text-gray-500 dark:text-gray-400',
  // Tables — topochain data-table. NOTE: deliberately no sideways-scroll
  // utility on the wrapper — nothing in the console scrolls horizontally
  // (#860, pinned by admin-console-page.test.js, which regexes this file's
  // raw source).
  tableWrap: 'w-full rounded-lg border border-gray-200 dark:border-gray-800',
  table: 'w-full text-sm',
  thead: 'border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50',
  th: 'px-6 py-3 text-left align-middle text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400',
  td: 'px-6 py-4 align-middle',
  trHover: 'border-b border-gray-100 dark:border-gray-800/60 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50',
  // Buttons — topochain's canonical button strings.
  btn: Object.freeze({
    primary: 'bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg transition-colors text-sm font-medium',
    outline: 'inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors',
    destructive: 'bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg transition-colors text-sm font-medium',
    ghost: 'font-medium transition-colors text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200',
    link: 'font-medium transition-colors text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300',
    primarySm: 'bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg transition-colors text-xs font-medium',
    outlineSm: 'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors',
    destructiveSm: 'bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded-lg transition-colors text-xs font-medium',
  }),
  // Form controls — topochain's canonical input string (+ dark translation).
  input: 'w-full border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500',
  select: 'w-full border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500',
  textarea: 'w-full min-h-[80px] border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500',
  label: 'text-sm font-medium text-gray-700 dark:text-gray-300',
  // Badges — topochain's ring-tinted rounded-full pills.
  badge: Object.freeze({
    default: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-gray-50 text-gray-600 ring-1 ring-inset ring-gray-500/10 dark:bg-gray-500/10 dark:text-gray-300 dark:ring-gray-400/20',
    secondary: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-700/10 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-400/20',
    outline: 'inline-flex items-center rounded-full border border-gray-300 dark:border-gray-700 px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-300',
    destructive: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-red-50 text-red-700 ring-1 ring-inset ring-red-700/10 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/20',
    success: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-700/10 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20',
    warn: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-700/10 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20',
  }),
  // Overlay — topochain modal: black/50 backdrop, xl-rounded white panel.
  dialogOverlay: 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4',
  dialogPanel: 'w-full max-w-md bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6 shadow-xl',
  // Typography / misc.
  sectionTitle: 'text-lg font-semibold text-gray-900 dark:text-gray-100',
  muted: 'text-sm text-gray-500 dark:text-gray-400',
  separator: 'border-t border-gray-200 dark:border-gray-800',
  kbd: 'rounded border border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:text-gray-300',
});

// Still published on the global: admin-topochain.js's sub-modules and a few
// section modules read `AdminUI` as a bare identifier inside functions, and
// the standalone /admin page's remaining scripts have never imported it.
// Guarded because the prerender pass evaluates this module in Node.
if (typeof window !== 'undefined') window.AdminUI = AdminUI;

// Which menu groups (Operations, Programme, People, Insights, Platform) the
// viewer has COLLAPSED, persisted per browser (#1152). Versioned key, same
// shape as Notifications' notif_expanded_groups_v1.
//
// The set stores the COLLAPSED names, not the expanded ones, and that
// inversion is load-bearing: SECTIONS has grown repeatedly (Push delivery,
// Email delivery, Estimator accuracy, Seasons), so "absent means expanded" is
// what keeps every future section visible to someone whose store predates it.
// It also makes "all four expanded on a first visit" the empty-store default.
const NAV_COLLAPSED_KEY = 'admin_nav_collapsed_groups_v1';

const AdminConsole = {
  _open: false,
  _section: 'overview',
  _menusWired: false,
  // Set by app.js when the console is mounted for a non-admin who
  // deep-linked one of the `public` sections. Never true for an admin.
  _public: false,
  // The section module (if any) currently rendered — used to call its
  // destroy() before swapping in the next one. See _renderSection.
  _activeModule: null,

  // ── Mobile two-level state ───────────────────────────────────────────
  // Which level the phone layout is showing: 1 = the section menu,
  // 2 = one section. Kept in sync on desktop too (it is ignored there)
  // so a viewport crossing resolves without guessing.
  _level: 1,
  // True while the level-2 entry we're sitting on was PUSHED by a menu
  // tap during this mount — the only case where history.back() is
  // guaranteed to land on our own menu entry. A deep link (bookmark, one
  // of the retired-page redirect stubs) leaves it false, and back
  // replaces the entry instead of creating a forward one. Per-mount
  // state: open() resets it, because the stack below the console stops
  // being ours to reason about the moment we leave.
  _pushedFromMenu: false,
  // #admin-screen scrollTop saved on drill-in, restored on the way back.
  _menuScrollTop: 0,
  _mediaBound: false,
  // True between an open({ chrome: false }) and the syncChrome() app.js
  // runs inside the screen transition (#979) — _syncChrome is a no-op
  // while it is set, so the platform header is never rewritten before the
  // View Transition has captured the page the viewer is leaving.
  _chromeSuspended: false,

  // The single source of truth in JS for where the sidebar layout starts.
  // Must stay in step with the `md:` classes in _renderShell (Tailwind's
  // md breakpoint IS 768px) — same discipline as AppView's
  // KANBAN_MULTICOL_MEDIA / _STAGING_DOCK_MEDIA.
  DESKTOP_MEDIA: '(min-width: 768px)',

  // In-SPA sections. Keys are the #admin/<key> hash segments; `group` is
  // the heading they sit under — in the desktop sidebar AND in the mobile
  // level-1 menu, which share _groupedSections(). Order here IS menu order.
  SECTIONS: [
    { key: 'overview', label: 'Overview', group: 'Operations' },
    // Health & status and Node & chain are the two `public` sections —
    // see the PUBLIC MODE note above.
    { key: 'status', label: 'Health & status', group: 'Operations', public: true },
    { key: 'node', label: 'Node & chain', group: 'Operations', public: true },
    { key: 'push', label: 'Push delivery', group: 'Operations' },
    { key: 'merges', label: 'Merge debug', group: 'Operations' },
    { key: 'rollover', label: 'Container rollover', group: 'Operations' },
    { key: 'staging-reap', label: 'Stale previews', group: 'Operations' },

    // Programme (#1179): what the programme IS — the seasons, the events
    // inside them, and the template library challenges are stamped out of.
    // These screens (and the People/Platform ones below marked #1179)
    // used to hide behind a single "Seasons, Events & Challenges" entry
    // with its own horizontal sub-nav; each is a first-class section now,
    // all still rendered by admin-topochain.js via SECTION_MODULES. The
    // module file name, the AdminTopochain global, the `topochain_`
    // settings-key prefix and the /api/v4/admin/* routes are historical
    // and deliberately unchanged. Season events still owns the tail
    // segments below its section (#admin/season-events/<eventId>
    // [/new-challenge[/<templateId>]]) — mirroring leaderboard.js's
    // _setSub/_syncHash pattern — so this file still needs no multi-level
    // routing. Maintenance campaigns does the same for
    // #admin/campaigns/<id>.
    { key: 'seasons', label: 'Seasons', group: 'Programme' },
    { key: 'season-events', label: 'Season events', group: 'Programme' },
    { key: 'challenge-templates', label: 'Challenge templates', group: 'Programme' },

    // The Users section carries BOTH user surfaces since #1179: the
    // platform accounts card (roles, quotas, caps) and the programme
    // users card (enrolment, podium/log settings, CSV import/export) —
    // one menu entry, merged. See renderUsersSection.
    { key: 'users', label: 'Users', group: 'People' },
    { key: 'codes', label: 'Activation codes', group: 'People' },
    { key: 'limits', label: 'Spend limits', group: 'People' },
    // Programme people screens, promoted by the same #1179 reshuffle.
    { key: 'waitlist', label: 'Waitlist', group: 'People' },
    { key: 'onchain-accounts', label: 'Onchain accounts', group: 'People' },
    { key: 'user-activities', label: 'User activities', group: 'People' },
    // Read-only view over the testnet accounts' staking delegation
    // periods (the mobile app is the delegation actor; admins only look).
    { key: 'delegations', label: 'Delegations', group: 'People' },

    { key: 'analytics', label: 'Analytics', group: 'Insights' },
    // Estimator accuracy (#898): platform analytics, split out of the
    // Analytics section, which is otherwise entirely USER analytics.
    { key: 'estimator', label: 'Estimator accuracy', group: 'Insights' },
    { key: 'gallery', label: 'Screenshot gallery', group: 'Insights' },
    { key: 'features', label: 'Submitted features', group: 'Insights' },

    { key: 'campaigns', label: 'Maintenance campaigns', group: 'Platform' },
    // The home screen's "Featured apps" row. NOT the `features` key
    // above — that one is "Submitted features" (user feature requests).
    { key: 'featured-apps', label: 'Featured apps', group: 'Platform' },
    { key: 'db-export', label: 'Database export', group: 'Platform' },
    // Platform outbound mail: configuration, a test send, and the
    // delivery ledger. Separate from the programme's Settings section
    // (which keeps its own read-only status/activity card) because the
    // audience is every mail flow, not just the programme's.
    { key: 'mail', label: 'Email delivery', group: 'Platform' },
    // Programme operator tooling, promoted by #1179 — deliberately last:
    // these are the sharp ones (raw SQL, arbitrary API calls, the
    // settings that change how the mobile app behaves).
    { key: 'settings', label: 'Settings', group: 'Platform' },
    { key: 'app-version', label: 'App version', group: 'Platform' },
    { key: 'sql-console', label: 'SQL console', group: 'Platform' },
    { key: 'api-tester', label: 'API tester', group: 'Platform' },
  ],

  // Retired section keys that must keep resolving forever, so links and
  // bookmarks minted before a rename don't 404 into the fallback section.
  // Resolved at the two entry points (open/setSection) BEFORE visibility,
  // module lookup, nav highlighting or hash writing see the key, so the
  // rest of the file only ever deals in canonical keys. app.js rewrites
  // the address bar itself so the bookmark self-heals.
  LEGACY_SECTION_KEYS: {
    topochain: 'seasons',
  },

  // Heroicons v2 outline, one per section — same icon treatment as
  // ../topochain's admin sidebar (w-5 h-5, stroke-width 1.5). Path data is
  // copied from topochain's blade views where an equivalent icon exists.
  // Complete inline literals; the shell loads no cross-origin assets.
  NAV_ICONS: Object.freeze({
    'overview': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z"/></svg>',
    'status': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    'node': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9"/></svg>',
    'push': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.08 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"/></svg>',
    'merges': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"/></svg>',
    'rollover': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12a7.5 7.5 0 0015 0m-15 0a7.5 7.5 0 1115 0m-15 0H3m16.5 0H21m-1.5 0H12m-8.457 3.077l1.41-.513m14.095-5.13l1.41-.513M5.106 17.785l1.15-.964m11.49-9.642l1.149-.964M7.501 19.795l.75-1.3m7.5-12.99l.75-1.3m-6.063 16.658l.26-1.477m2.605-14.772l.26-1.477m0 17.726l-.26-1.477M10.698 4.614l-.26-1.477M16.5 19.794l-.75-1.299M7.5 4.205L12 12m6.894 5.785l-1.149-.964M6.256 7.794l-1.15-.964"/></svg>',
    'staging-reap': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>',
    'users': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"/></svg>',
    'codes': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/></svg>',
    'limits': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    'analytics': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"/></svg>',
    'estimator': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75"/></svg>',
    'gallery': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"/></svg>',
    'features': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18"/></svg>',
    'campaigns': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 110-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.26.117-1.527-.461a20.845 20.845 0 01-1.44-4.282m3.102.069a18.03 18.03 0 01-.59-4.59c0-1.586.205-3.124.59-4.59m0 9.18a23.848 23.848 0 018.835 2.535M10.34 6.66a23.847 23.847 0 008.835-2.535m0 0A23.74 23.74 0 0018.795 3m.38 1.125a23.91 23.91 0 011.014 5.395m-1.014 8.855c-.118.38-.245.754-.38 1.125m.38-1.125a23.91 23.91 0 001.014-5.395m0-3.46c.495.413.811 1.035.811 1.73 0 .695-.316 1.317-.811 1.73m0-3.46a24.347 24.347 0 010 3.46"/></svg>',
    'featured-apps': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"/></svg>',
    'db-export': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125"/></svg>',
    'mail': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75"/></svg>',
    'seasons': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 002.748 1.35m8.272-6.842V4.5c0 2.108-.966 3.99-2.48 5.228m2.48-5.492a46.32 46.32 0 012.916.52 6.003 6.003 0 01-5.395 4.972m0 0a6.726 6.726 0 01-2.749 1.35m0 0a6.772 6.772 0 01-3.044 0"/></svg>',
    'season-events': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5"/></svg>',
    'challenge-templates': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 01-.657.643 48.39 48.39 0 01-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 01-.658.663v0c-.355 0-.676-.186-.959-.401a1.647 1.647 0 00-1.003-.349c-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.039 48.039 0 01-.642 5.056c1.518.19 3.058.309 4.616.354a.64.64 0 00.657-.643v0c0-.355-.186-.676-.401-.959a1.647 1.647 0 01-.349-1.003c0-1.035 1.008-1.875 2.25-1.875 1.243 0 2.25.84 2.25 1.875 0 .369-.128.713-.349 1.003-.215.283-.4.604-.4.959v0c0 .333.277.599.61.58a48.1 48.1 0 005.427-.63 48.05 48.05 0 00.582-4.717.532.532 0 00-.533-.57v0c-.355 0-.676.186-.959.401-.29.221-.634.349-1.003.349-1.035 0-1.875-1.007-1.875-2.25s.84-2.25 1.875-2.25c.37 0 .713.128 1.003.349.283.215.604.401.96.401v0a.656.656 0 00.658-.663 48.422 48.422 0 00-.37-5.36c-1.886.342-3.81.574-5.766.689a.578.578 0 01-.61-.58v0z"/></svg>',
    'waitlist': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    'onchain-accounts': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z"/></svg>',
    'user-activities': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"/></svg>',
    'delegations': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"/></svg>',
    'settings': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>',
    'app-version': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3"/></svg>',
    'sql-console': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z"/></svg>',
    'api-tester': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/></svg>',
  }),

  _canonicalSection(key) {
    return (key && AdminConsole.LEGACY_SECTION_KEYS[key]) || key;
  },

  isOpen() { return AdminConsole._open; },

  // Below the sidebar breakpoint — i.e. the two-level layout is live.
  // Anything that can't answer (no matchMedia) is treated as desktop, so
  // a browser without it keeps today's behaviour rather than a phone
  // layout it never asked for.
  _isMobile() {
    try { return !window.matchMedia(AdminConsole.DESKTOP_MEDIA).matches; }
    catch { return false; }
  },

  // One-time viewport listener: crossing the breakpoint re-resolves the
  // layout in place. Crossing UP renders the active section in the
  // sidebar shell; crossing DOWN keeps that section as level 2 (no menu
  // flash) and writes its explicit hash so the address matches what's on
  // screen. Lazy-bound like AppView._ensureStagingDockListeners.
  _ensureMediaListener() {
    if (AdminConsole._mediaBound || !window.matchMedia) return;
    try {
      const mql = window.matchMedia(AdminConsole.DESKTOP_MEDIA);
      const onChange = () => {
        if (!AdminConsole._open) return;
        // A real section is showing (or was, on desktop) → keep it as
        // level 2 on the way down. Only a menu-level mobile view, or a
        // desktop view sitting on the bare #admin overview, lands on 1.
        if (!mql.matches && AdminConsole._level !== 1) {
          AdminConsole._writeHash(AdminConsole._section);
        }
        AdminConsole._renderShell();
        AdminConsole._renderContent();
        AdminConsole._syncChrome();
      };
      if (mql.addEventListener) mql.addEventListener('change', onChange);
      else if (mql.addListener) mql.addListener(onChange);
      AdminConsole._mediaBound = true;
    } catch { /* no matchMedia — desktop path stands */ }
  },

  // True while the console is mounted for a non-admin on a `public`
  // section. Belt-and-braces: also require the absence of isAdmin, so a
  // stale flag can never narrow an admin's own menu.
  _publicMode() {
    return !!AdminConsole._public && !(window.App && App.user && App.user.isAdmin);
  },

  // The sections the current viewer may navigate to.
  _visibleSections() {
    return AdminConsole._publicMode()
      ? AdminConsole.SECTIONS.filter((s) => s.public)
      : AdminConsole.SECTIONS;
  },

  // Single write gate for every mutating control on the page. View-only
  // admins (is_admin && admin_readonly) carry isAdmin but not
  // canAdminWrite — they see everything read-only.
  canWrite() { return !!(window.App && App.user && App.user.canAdminWrite); },

  // `opts.public` is set by app.js when a non-admin deep-linked one of the
  // `public` sections; it must be resolved BEFORE the first _renderShell so
  // the menu is filtered on the very first paint.
  //
  // `opts.chrome === false` renders WITHOUT touching the platform header
  // (#979): the console renders into a still-hidden #admin-screen, which
  // is invisible, but the header title / back icon are not — writing them
  // before the screen transition starts bakes the incoming console's
  // chrome into the snapshot of the page being left. app.js calls
  // AdminConsole.syncChrome() inside the transition callback instead.
  open(section, opts) {
    AdminConsole._open = true;
    AdminConsole._public = !!(opts && opts.public);
    AdminConsole._pushedFromMenu = false;
    AdminConsole._chromeSuspended = !!(opts && opts.chrome === false);
    AdminConsole._menuScrollTop = 0;
    AdminConsole._ensureMediaListener();
    section = AdminConsole._canonicalSection(section);
    const visible = AdminConsole._visibleSections();
    const valid = visible.some((s) => s.key === section);
    // In public mode, fall back to the first PUBLIC section rather than
    // Overview (which the viewer can't see) — and never resurrect a
    // last-visited admin section from an earlier admin login in this tab.
    const fallback = AdminConsole._publicMode()
      ? (visible.some((s) => s.key === AdminConsole._section) ? AdminConsole._section : visible[0]?.key)
      : (AdminConsole._section || 'overview');
    // On mobile, a bare #admin means the MENU — never a last-visited
    // section resurrected from earlier in this tab. On desktop it keeps
    // meaning Overview (or the last section), exactly as before.
    if (AdminConsole._isMobile() && !valid) {
      AdminConsole._level = 1;
      AdminConsole._section = fallback;
      // This branch repaints without going through setSection, so the
      // arrival rule has to be applied here too (#1152).
      AdminConsole._ensureActiveGroupExpanded();
      AdminConsole._renderShell();
      AdminConsole._renderContent();
      AdminConsole._syncChrome();
      return;
    }
    AdminConsole._level = 2;
    AdminConsole._renderShell();
    // Deep-linked section wins; otherwise keep the last-visited section
    // (instant repaint on re-entry), defaulting to Overview.
    AdminConsole.setSection(valid ? section : fallback, { writeHash: false });
    // Runs after app.js's own setHeaderTitle, so on a mobile deep link the
    // header ends up showing the section's name rather than the console's.
    AdminConsole._syncChrome();
  },

  close() {
    AdminConsole._open = false;
    AdminConsole._public = false;
    AdminConsole._pushedFromMenu = false;
    // Tear the active section's timers/listeners down: leaving the console
    // must not leave a 5s /api/status or 2s /api/node-status poll running
    // for the life of the tab (see _teardownActiveSection).
    AdminConsole._teardownActiveSection();
  },

  // Re-entry while the console is ALREADY mounted (app.js routes here
  // instead of re-running the whole screen swap — see
  // navigateToAdminConsole). Resolves the target level from the requested
  // section, picks the transition direction by comparing it to the level
  // we're on, and repaints. On desktop this is just setSection.
  //
  // IDEMPOTENT (#1102), for the same reason Settings.route is — this is a
  // copy of the same two-level router, over an already-VISIBLE screen root.
  // One history traversal fires popstate AND hashchange, so restoreFromHash
  // runs twice in one tick and this is called twice with the same section;
  // the second call resolves the same level, asks for 'none', and the kit
  // runs 'none' SYNCHRONOUSLY — landing the level swap before the first
  // call's pending View Transition captured the outgoing page, so the
  // animation played two copies of the incoming page. Resolve the target
  // first and bail out when it is already on screen.
  route(section, opts) {
    // Applied before the comparison: _visibleSections() reads it, so the
    // public-mode flag decides what "the same target" even means.
    if (opts && typeof opts.public === 'boolean') AdminConsole._public = !!opts.public;
    const visible = AdminConsole._visibleSections();
    const valid = !!section && visible.some((s) => s.key === section);
    const mobile = AdminConsole._isMobile();
    // The level and section this call WOULD end on. Level 1 keeps whatever
    // section sits behind the menu, so there the level is the whole target.
    const targetLevel = (!mobile || valid) ? 2 : 1;
    const targetSection = valid
      ? section
      : (mobile
        ? AdminConsole._section
        : (AdminConsole._publicMode() ? (visible[0]?.key || 'status') : 'overview'));
    if (targetLevel === AdminConsole._level && targetSection === AdminConsole._section) {
      AdminConsole._reapplySectionHash();
      return;
    }
    if (!mobile) {
      // Desktop: bare #admin is Overview, as it has always been.
      AdminConsole.setSection(targetSection, { writeHash: false });
      AdminConsole._level = 2;
      AdminConsole._syncChrome();
      return;
    }
    // 1→2 push, 2→1 pop, same level (section→section deep link) instant:
    // the kit's fidelity rule is no animation on same-level repaints.
    const type = targetLevel === AdminConsole._level
      ? 'none'
      : (targetLevel === 2 ? 'push' : 'pop');
    if (targetLevel === 2) {
      AdminConsole._menuScrollTop = AdminConsole._level === 1
        ? AdminConsole._scrollTop()
        : AdminConsole._menuScrollTop;
      AdminConsole._section = section;
    } else {
      AdminConsole._pushedFromMenu = false;
    }
    AdminConsole._level = targetLevel;
    AdminConsole._transition(() => {
      // Mobile drill-in / pop repaints without setSection — same arrival
      // rule, applied before the menu and sidebar are rebuilt (#1152).
      AdminConsole._ensureActiveGroupExpanded();
      AdminConsole._renderShell();
      AdminConsole._renderContent();
      AdminConsole._syncChrome();
      AdminConsole._restoreScroll();
    }, type);
  },

  // The address this console last rendered itself from, recorded AFTER the
  // render so it holds whatever the section module healed the hash to (both
  // AdminTopochain and AdminCampaigns own a second level below the section
  // segment and replaceState it back themselves). Compared, not merely
  // remembered — see _reapplySectionHash.
  _routedHash: null,

  _markRouted() {
    AdminConsole._routedHash = location.hash;
  },

  // #1146: the level+section bail-out above is a guard against ONE dispatch
  // arriving twice, not a statement that the address hasn't moved. Sections
  // that own a second hash level are addressed by a tail the comparison
  // above cannot see — #admin/season-events, #admin/season-events/12 and
  // #admin/season-events/12/new-challenge/3 all resolve to level 2,
  // section 'season-events' — so a switch BETWEEN two of those siblings
  // used to return here without repainting, leaving the previous tail's
  // screen up.
  // Cold loading hid it (the module reads the address in render()); a
  // sibling-fragment hash switch, which is how the grouped capture runner
  // reaches every cohort of a document, does not.
  //
  // Re-running _renderSection() is exactly the cold-load path: it tears the
  // section down and calls the module's render(), which re-reads the hash
  // and resets whatever the tail no longer names. Gated on the address
  // having actually CHANGED since the last render, which is what preserves
  // the #1102 guard — a traversal's popstate and hashchange carry the same
  // hash, so the second of the pair still bails out.
  _reapplySectionHash() {
    if (AdminConsole._routedHash === location.hash) return;
    // Mark before as well as after: the render below replaceStates the
    // healed address, and a mark-only-after would leave a window in which a
    // re-entrant call saw the stale value.
    AdminConsole._markRouted();
    // Level 1 on mobile is the menu, not a section — nothing below the
    // #admin segment is addressing anything there.
    if (AdminConsole._isMobile() && AdminConsole._level === 1) return;
    AdminConsole._renderSection();
    AdminConsole._markRouted();
  },

  // The on-screen back arrow AND the platform header's back button both
  // land here (app.js:back-btn). Returns true when the press was consumed
  // — i.e. mobile, inside a section — so the header falls through to
  // navigateHome() everywhere else (all of desktop included).
  handleBack() {
    if (!AdminConsole._open) return false;
    if (!AdminConsole._isMobile() || AdminConsole._level !== 2) return false;
    if (AdminConsole._pushedFromMenu) {
      // We pushed that entry ourselves, so the one below it IS our menu:
      // popping routes back through popstate → restoreFromHash → route(),
      // the same path the device back gesture takes.
      history.back();
      return true;
    }
    // Deep link / redirect stub: nothing of ours below. REPLACE the entry
    // with the menu rather than pushing one, so back can't bounce the
    // viewer between the section and the menu forever.
    try { history.replaceState(null, '', '#admin'); } catch { /* non-fatal */ }
    AdminConsole._level = 1;
    AdminConsole._transition(() => {
      AdminConsole._renderShell();
      AdminConsole._renderContent();
      AdminConsole._syncChrome();
      AdminConsole._restoreScroll();
    }, 'pop');
    return true;
  },

  // Drill-in from a level-1 menu row. A REAL hash navigation (the
  // leaderboard profile drill-in precedent) so the pushed entry makes the
  // browser / WebView back gesture work for free; restoreFromHash routes
  // it back into route() a tick later. Assigning location.hash preserves
  // the query string, so ?demo=1 survives the drill-in.
  _openSection(key) {
    AdminConsole._menuScrollTop = AdminConsole._scrollTop();
    AdminConsole._pushedFromMenu = true;
    const target = `#admin/${key}`;
    if (location.hash === target) {
      // Same-value assignment fires no hashchange — route by hand.
      AdminConsole.route(key);
      return;
    }
    location.hash = target;
  },

  _transition(fn, type) {
    if (window.PlatformUI?.transition) PlatformUI.transition(fn, { type: type || 'none' });
    else fn();
  },

  _scrollTop() {
    const el = document.getElementById('admin-screen');
    return el ? el.scrollTop : 0;
  },

  // A pushed screen starts at the top; a pop restores where the menu was.
  _restoreScroll() {
    const el = document.getElementById('admin-screen');
    if (!el) return;
    el.scrollTop = (AdminConsole._isMobile() && AdminConsole._level === 1)
      ? AdminConsole._menuScrollTop
      : 0;
  },

  // Platform-header chrome for the current level: inside a mobile section
  // the header becomes that section's nav bar (arrow + section name),
  // everywhere else it stays the console's own title and the home icon.
  // setHeaderTitle mirrors into document.title, so the native shell's
  // AppBar picks the section name up too.
  // The public half of _syncChrome: clears the suspension a
  // `chrome: false` open() set and applies the chrome for real. app.js
  // calls this INSIDE the screen transition's callback (#979).
  syncChrome() {
    AdminConsole._chromeSuspended = false;
    AdminConsole._syncChrome();
  },

  _syncChrome() {
    if (!window.App || AdminConsole._chromeSuspended) return;
    const inSection = AdminConsole._isMobile() && AdminConsole._level === 2;
    // #1036: the header control is a real anchor — inside a section the
    // chevron pops to the console's own menu, so that is its href.
    if (App.setBackIcon) App.setBackIcon(inSection ? 'arrow' : 'home', inSection ? '#admin' : undefined);
    if (!App.setHeaderTitle) return;
    if (inSection) {
      const s = AdminConsole._visibleSections().find((x) => x.key === AdminConsole._section);
      App.setHeaderTitle(s ? s.label : 'Admin & moderation');
    } else {
      App.setHeaderTitle(AdminConsole._publicMode() ? 'Platform status' : 'Admin & moderation');
    }
  },

  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  // Safe fetch+parse for the admin endpoints (ported from
  // public/admin.html). Returns { status, ok, data } and NEVER throws: a
  // non-OK response, a non-JSON content-type, or a body that fails to
  // parse all yield data === null. This matters when an /api/* route
  // falls through to the SPA shell on auth loss and returns 200 + HTML —
  // res.json() on that throws "Unexpected token '<'".
  async fetchJson(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return { status: res.status, ok: false, data: null };
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        return { status: res.status, ok: true, data: null };
      }
      try {
        return { status: res.status, ok: true, data: await res.json() };
      } catch {
        return { status: res.status, ok: true, data: null };
      }
    } catch {
      return { status: 0, ok: false, data: null };
    }
  },

  // The DB and API are cents-native; the UI presents dollars. Convert at
  // the edge only (ported from public/admin.html).
  centsToDollars(c) {
    return (Number(c) / 100).toFixed(2);
  },
  parseDollarsToCents(label, raw) {
    if (raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`${label} must be a non-negative dollar amount or blank.`);
    }
    return Math.round(n * 100);
  },

  _alert(message) {
    if (window.PlatformUI?.alert) {
      PlatformUI.alert({ title: 'Admin', message: String(message) });
    } else {
      try { window.alert(message); } catch {}
    }
  },

  async _confirm(opts) {
    if (window.PlatformUI?.confirm) return PlatformUI.confirm(opts);
    try {
      return window.confirm([opts.title, opts.message].filter(Boolean).join('\n\n'));
    } catch { return false; }
  },

  // ── Menu group collapse state (#1152) ─────────────────────────────────

  // The COLLAPSED group names, lazily loaded from localStorage on first
  // read. Both menu builders regenerate their markup from THIS on every
  // repaint and neither derives anything from the DOM, so a toggle survives
  // a section switch, a viewport crossing and a reload identically.
  _collapsedGroups: null,

  _collapsed() {
    if (!AdminConsole._collapsedGroups) AdminConsole._loadCollapsedGroups();
    return AdminConsole._collapsedGroups;
  },

  // Corrupt, foreign or unavailable storage all resolve to "nothing
  // collapsed": this runs inside a render path, so it must never throw.
  _loadCollapsedGroups() {
    AdminConsole._collapsedGroups = new Set();
    // Only render/toggle paths reach here, but the guard sits next to the
    // storage read regardless — the prerender pass evaluates this module in
    // Node, where there is no localStorage (see the window.AdminUI guard).
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(NAV_COLLAPSED_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return;
      // Prune names no SECTIONS entry carries any more, so the store can't
      // grow unbounded and a RENAMED group resets to expanded — the safe
      // direction, since a stale entry would hide live rows.
      const live = new Set(AdminConsole.SECTIONS.map((s) => s.group || 'Other'));
      let changed = false;
      for (const name of arr) {
        const key = String(name);
        if (live.has(key)) AdminConsole._collapsedGroups.add(key);
        else changed = true;
      }
      if (changed) AdminConsole._saveCollapsedGroups();
    } catch {
      AdminConsole._collapsedGroups = new Set();
    }
  },

  _saveCollapsedGroups() {
    try {
      localStorage.setItem(
        NAV_COLLAPSED_KEY,
        JSON.stringify([...AdminConsole._collapsed()])
      );
    } catch { /* storage may be unavailable; non-fatal, in-memory for the session */ }
  },

  _isGroupCollapsed(name) {
    return AdminConsole._collapsed().has(String(name));
  },

  _setGroupCollapsed(name, collapsed) {
    const set = AdminConsole._collapsed();
    const key = String(name);
    if (collapsed) set.add(key);
    else set.delete(key);
    AdminConsole._saveCollapsedGroups();
  },

  // "Never hide where I am": arriving at a section reveals its group, so a
  // deep link into a collapsed group (a bookmark, one of the retired-page
  // redirect stubs) can't leave the highlighted row invisible. Called
  // BEFORE the repaint that follows it, and only on ARRIVAL — deliberately
  // not enforced continuously, or the group you are using would be the one
  // group you cannot collapse.
  _ensureActiveGroupExpanded() {
    const s = AdminConsole._visibleSections().find((x) => x.key === AdminConsole._section);
    if (!s) return;
    const name = String(s.group || 'Other');
    const set = AdminConsole._collapsed();
    if (!set.has(name)) return;
    set.delete(name);
    AdminConsole._saveCollapsedGroups();
  },

  // aria-controls targets have to be unique, and at phone width the hidden
  // desktop sidebar and the level-1 menu are BOTH in the document — hence
  // one id prefix per surface ('admin-nav-group', 'admin-menu-group').
  _groupDomId(prefix, name) {
    return `${prefix}-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  },

  // The heading affordance both menus share: a real <button>, so Tab plus
  // Enter/Space come for free and no keydown handler is needed, with the
  // aria-expanded/aria-controls pair and the platform's chevron idiom
  // (down when open, right when closed — home-panels.js's rotation trick).
  _groupToggleHtml(name, domId, collapsed, cls) {
    const label = `${collapsed ? 'Expand' : 'Collapse'} ${name}`;
    const chevron = `<svg data-admin-group-chevron aria-hidden="true"
        class="w-3 h-3 shrink-0 transition-transform${collapsed ? ' -rotate-90' : ''}"
        fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>`;
    return `<button type="button" data-admin-group-toggle="${AdminConsole.esc(name)}"
        aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="${domId}"
        title="${AdminConsole.esc(label)}" aria-label="${AdminConsole.esc(label)}"
        class="${cls}">${chevron}<span class="flex-1 min-w-0 truncate">${AdminConsole.esc(name)}</span></button>`;
  },

  // ── Shell: menu (sidebar / mobile list) + content host ────────────────

  // The visible sections bucketed by `group`, in first-appearance order.
  // Shared by the desktop sidebar and the mobile level-1 menu so the two
  // can never drift into different groupings.
  _groupedSections() {
    const groups = [];
    for (const s of AdminConsole._visibleSections()) {
      const name = s.group || 'Other';
      let g = groups.find((x) => x.name === name);
      if (!g) { g = { name, items: [] }; groups.push(g); }
      g.items.push(s);
    }
    return groups;
  },

  // Desktop sidebar rows, grouped under headings. Nineteen flat rows is a
  // lot to scan; the headings are the mitigation, and since #1152 each one
  // is a collapse/expand button whose state persists per browser.
  _navItemsHtml() {
    const active = AdminConsole._section;
    const itemHtml = (s) => {
      const isActive = s.key === active;
      const cls = 'admin-nav-item flex items-center gap-3 w-full text-left rounded-md px-3 py-2.5 text-sm font-medium transition-colors '
        + (isActive
          ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100'
          : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/60');
      return `<button type="button" role="tab" aria-selected="${isActive ? 'true' : 'false'}"
        data-admin-section="${s.key}" class="${cls}">${AdminConsole.NAV_ICONS[s.key] || ''}<span class="flex-1 min-w-0 truncate">${AdminConsole.esc(s.label)}</span></button>`;
    };
    return AdminConsole._groupedSections().map((g, i) => {
      // Rendered from the persisted set, never from the DOM — so this
      // wholesale repaint (it runs on every section switch) reproduces
      // whatever the viewer collapsed.
      const collapsed = AdminConsole._isGroupCollapsed(g.name);
      const domId = AdminConsole._groupDomId('admin-nav-group', g.name);
      // No spacing utility on the items wrapper: the rows were adjacent
      // before this became a wrapped group, and they stay adjacent.
      return `
      <div class="${i === 0 ? '' : 'mt-6'}">
        ${AdminConsole._groupToggleHtml(g.name, domId, collapsed,
          'flex items-center gap-1.5 w-full text-left px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors')}
        <div id="${domId}" data-admin-group="${AdminConsole.esc(g.name)}"${collapsed ? ' class="hidden"' : ''}>
          ${g.items.map(itemHtml).join('')}
        </div>
      </div>`;
    }).join('');
  },

  // Mobile level 1: the section menu. A list, not a tab set — so plain
  // buttons in a <nav>, no role="tab"/aria-selected, and the drawer-row
  // idiom from index.html (44px minimum, hairline between rows, chevron
  // on the right) rather than the kit's inset-grouped card, which would
  // read as a foreign surface next to the rest of the platform.
  _mobileMenuHtml() {
    const chevron = `<svg class="w-4 h-4 shrink-0 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>`;
    const rowHtml = (s) => `
      <button type="button" data-admin-section="${s.key}"
              class="admin-menu-row flex items-center gap-3 w-full text-left min-h-[44px] px-4 py-2
                     border-b border-gray-100 dark:border-gray-800
                     text-gray-700 dark:text-gray-200
                     hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors">
        <span class="text-gray-400 dark:text-gray-500">${AdminConsole.NAV_ICONS[s.key] || ''}</span>
        <span class="flex-1 min-w-0 text-sm font-medium truncate">${AdminConsole.esc(s.label)}</span>
        ${chevron}
      </button>`;
    // The toggle stays OUTSIDE the card, so [&>button:last-child] keeps
    // meaning "the last section row" rather than picking up a heading.
    const groups = AdminConsole._groupedSections().map((g) => {
      const collapsed = AdminConsole._isGroupCollapsed(g.name);
      const domId = AdminConsole._groupDomId('admin-menu-group', g.name);
      return `
      <div class="mb-5">
        ${AdminConsole._groupToggleHtml(g.name, domId, collapsed,
          'flex items-center gap-1.5 w-full text-left px-4 pb-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500')}
        <div id="${domId}" data-admin-group="${AdminConsole.esc(g.name)}"
             class="${AdminUI.card} overflow-hidden
                    [&>button:last-child]:border-b-0${collapsed ? ' hidden' : ''}">
          ${g.items.map(rowHtml).join('')}
        </div>
      </div>`;
    }).join('');
    return `<nav id="admin-mobile-menu" aria-label="Admin sections" class="-mx-4">${groups}</nav>`;
  },

  // Repaint the chassis's two variable parts. React owns the chassis MARKUP
  // (./index.tsx), which is why this no longer touches root.innerHTML: the
  // nav host and the banner are the only things about it that depend on who
  // is looking, and both were already repainted in place on every section
  // switch (see setSection). The name is kept because eight call sites and
  // the mobile transition callbacks read as "repaint the shell".
  //
  // #admin-nav-desktop ships EMPTY, exactly as #settings-nav-desktop does:
  // React hydrates an empty host and never looks inside it again, so the
  // innerHTML write below is not a write into React-owned DOM.
  _renderShell() {
    const sideHost = document.getElementById('admin-nav-desktop');
    if (sideHost) {
      sideHost.innerHTML = AdminConsole._navItemsHtml();
      // Scoped to the sidebar, where the old whole-root wire was scoped to a
      // subtree this function had just emptied. It has to be: #admin-root is
      // no longer wiped here, so wiring the whole root would ALSO re-bind the
      // level-1 menu buttons still sitting in #admin-section-content, one
      // extra click handler per repaint. The other two [data-admin-section]
      // producers wire their own output — _renderMobileMenu right after its
      // innerHTML write, and each section module for its own controls.
      AdminConsole._wireSectionButtons(sideHost);
      AdminConsole._wireGroupToggles(sideHost);
    }
    // In public mode the viewer isn't an admin at all, so the view-only
    // ADMIN banner would be nonsense — suppress it rather than showing an
    // amber "you can't make changes" strip to a regular member.
    const viewOnly = !AdminConsole.canWrite() && !AdminConsole._publicMode();
    const banner = document.getElementById('admin-view-only-banner');
    // classList, not a rendered className: the banner is a static React node
    // and its class attribute must be written once at hydration and then
    // only ever toggled from here (the useHiddenClass contract).
    if (banner) banner.classList.toggle('hidden', !viewOnly);
  },

  // Every [data-admin-section] control routes through here. On mobile a
  // press is a DRILL-IN (a real hash navigation that pushes history); on
  // desktop it's the same in-place sidebar switch it has always been.
  _wireSectionButtons(root) {
    if (!root) return;
    root.querySelectorAll('[data-admin-section]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.adminSection;
        if (AdminConsole._isMobile()) AdminConsole._openSection(key);
        else AdminConsole.setSection(key);
      });
    });
  },

  // Menu-group headings (#1152). A press is a MENU-ONLY action: it mutates
  // the persisted set and then the DOM IN PLACE — never setSection,
  // _renderShell, _renderContent, _writeHash or location.hash. Three
  // reasons: the section on screen keeps rendering untouched, a phone
  // repaint would tear the menu's own rows down mid-gesture, and focus
  // stays on the heading you just pressed so several can be collapsed in a
  // row. Scoped to the host just written, exactly like _wireSectionButtons,
  // so repaints can't accumulate handlers.
  _wireGroupToggles(root) {
    if (!root) return;
    root.querySelectorAll('[data-admin-group-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.adminGroupToggle;
        const next = !AdminConsole._isGroupCollapsed(name);
        AdminConsole._setGroupCollapsed(name, next);
        btn.setAttribute('aria-expanded', next ? 'false' : 'true');
        const label = `${next ? 'Expand' : 'Collapse'} ${name}`;
        btn.setAttribute('title', label);
        btn.setAttribute('aria-label', label);
        const chevron = btn.querySelector('[data-admin-group-chevron]');
        if (chevron) chevron.classList.toggle('-rotate-90', next);
        // `hidden` takes the rows out of tab order too, so tabbing skips a
        // collapsed group rather than walking invisible buttons.
        const id = btn.getAttribute('aria-controls');
        const items = id && document.getElementById(id);
        if (items) items.classList.toggle('hidden', next);
      });
    });
  },

  setSection(key, opts) {
    key = AdminConsole._canonicalSection(key);
    const visible = AdminConsole._visibleSections();
    if (!visible.some((s) => s.key === key)) {
      key = AdminConsole._publicMode() ? (visible[0]?.key || 'status') : 'overview';
    }
    AdminConsole._section = key;
    // Arrival at a section reveals its group, before the repaint that would
    // otherwise draw the active row inside a collapsed one (#1152).
    AdminConsole._ensureActiveGroupExpanded();
    // Repaint the sidebar's active state. This used to be the "the shell is
    // already built" half of a branch whose other half rebuilt #admin-root
    // from scratch; the chassis is React's now, so it always exists and
    // _renderShell IS this repaint.
    AdminConsole._renderShell();
    if (!opts || opts.writeHash !== false) AdminConsole._writeHash(key);
    AdminConsole._renderSection();
    // Recorded after the render, so it holds whatever the section module
    // healed the address to. See _reapplySectionHash.
    AdminConsole._markRouted();
  },

  // Section switches update the address without polluting history —
  // replaceState, and only while we're actually on the #admin route (the
  // Leaderboard._setSub pattern). Entering/leaving the page still gets a
  // real history entry via normal hash navigation.
  //
  // Sections that own a second hash level (seasons, campaigns) are left
  // alone once we're already inside them, so their own replaceState isn't
  // fought over on every repaint.
  //
  // Mobile writes #admin/overview rather than bare #admin: down here a
  // bare #admin means the MENU, so Overview needs an explicit segment to
  // stay distinguishable (and deep-linkable) from level 1. Desktop keeps
  // the historical overview → #admin mapping.
  _writeHash(key) {
    const target = (key === 'overview' && !AdminConsole._isMobile())
      ? '#admin'
      : `#admin/${key}`;
    if (location.hash.startsWith(`${target}/`)) return;
    if (location.hash.startsWith('#admin') && location.hash !== target) {
      history.replaceState(null, '', target);
    }
  },

  // Sections whose content is owned by a separate module (#860). Each
  // exposes render(host) / destroy(); destroy() is what stops their
  // polling when you navigate away. Resolved lazily by name so a module
  // that failed to load degrades to a message instead of a crash.
  SECTION_MODULES: {
    status: 'AdminStatus',
    node: 'AdminNode',
    analytics: 'AdminAnalytics',
    estimator: 'AdminEstimator',
    merges: 'AdminMerges',
    gallery: 'AdminGallery',
    campaigns: 'AdminCampaigns',
    mail: 'AdminMail',
    push: 'AdminPush',
    // The ten promoted programme screens (#1179) all render through
    // admin-topochain.js — the section key names the screen, and the
    // module reads it back in its render(). The programme's Users screen
    // is the one exception: it is merged into renderUsersSection below.
    seasons: 'AdminTopochain',
    'season-events': 'AdminTopochain',
    'challenge-templates': 'AdminTopochain',
    waitlist: 'AdminTopochain',
    'onchain-accounts': 'AdminTopochain',
    'user-activities': 'AdminTopochain',
    delegations: 'AdminTopochain',
    settings: 'AdminTopochain',
    'app-version': 'AdminTopochain',
    'sql-console': 'AdminTopochain',
    'api-tester': 'AdminTopochain',
  },

  // Stop the outgoing section's background work before its DOM is replaced.
  // Without this, Health & status keeps polling /api/status every 5s (which
  // shells out to `docker stats` server-side) and Node & chain keeps polling
  // every 2s, for the rest of the tab's life.
  _teardownActiveSection() {
    const mod = AdminConsole._activeModule;
    AdminConsole._activeModule = null;
    if (mod && typeof mod.destroy === 'function') {
      try { mod.destroy(); } catch (err) { console.error('admin section destroy failed', err); }
    }
  },

  // The single dispatcher for what goes in the content host: the mobile
  // level-1 menu, or a section. Everything that changes level goes through
  // here so the teardown below can't be skipped.
  _renderContent() {
    if (AdminConsole._isMobile() && AdminConsole._level === 1) {
      const host = document.getElementById('admin-section-content');
      if (!host) return;
      // Leaving a section for the menu MUST tear it down: otherwise a back
      // press out of Health & status leaves its 5s /api/status poll (which
      // shells out to `docker stats` server-side) running for the life of
      // the tab — exactly the leak #860's lifecycle work fixed.
      AdminConsole._teardownActiveSection();
      AdminConsole._renderMobileMenu(host);
      AdminConsole._markRouted();
      return;
    }
    AdminConsole._renderSection();
    AdminConsole._markRouted();
  },

  _renderMobileMenu(host) {
    host.innerHTML = AdminConsole._mobileMenuHtml();
    AdminConsole._wireSectionButtons(host);
    AdminConsole._wireGroupToggles(host);
  },

  _renderSection() {
    const host = document.getElementById('admin-section-content');
    if (!host) return;
    // Always tear the previous section down first — this is the single
    // choke point every section switch passes through.
    AdminConsole._teardownActiveSection();

    const key = AdminConsole._section;
    const modName = AdminConsole.SECTION_MODULES[key];
    if (modName) {
      const mod = window[modName];
      if (!mod || typeof mod.render !== 'function') {
        host.innerHTML = `<p class="${AdminUI.muted} p-4">The ${AdminConsole.esc(key)} console module failed to load.</p>`;
        return;
      }
      AdminConsole._activeModule = mod;
      mod.render(host);
      return;
    }
    switch (key) {
      case 'users': return AdminConsole.renderUsersSection(host);
      case 'codes': return AdminConsole.renderCodesSection(host);
      case 'limits': return AdminConsole.renderLimitsSection(host);
      case 'features': return AdminConsole.renderFeaturesSection(host);
      case 'featured-apps': return AdminConsole.renderFeaturedAppsSection(host);
      case 'rollover': return AdminConsole.renderRolloverSection(host);
      case 'staging-reap': return AdminConsole.renderStalePreviewsSection(host);
      case 'db-export': return AdminConsole.renderDbExportSection(host);
      default: return AdminConsole.renderOverviewSection(host);
    }
  },

  // ── Delegated sections ──────────────────────────────────────────────
  //
  // Topochain (Task 15), Health & status / Node & chain / Analytics /
  // Merge debug / Screenshot gallery / Maintenance campaigns (#860) and
  // Estimator accuracy (#898) all
  // live in their own modules, dispatched by SECTION_MODULES above rather
  // than by a render*Section method here. Two of them own tail segments
  // below the section entirely on their own — AdminTopochain under
  // #admin/season-events/<eventId> and AdminCampaigns under
  // #admin/campaigns/<id> — reading location.hash directly and writing it
  // back with replaceState, the same pattern leaderboard.js uses for its
  // own tab state, so this file never needs general multi-level routing.

  // ── Featured apps ─────────────────────────────────────────────────────
  //
  // The admin-curated row under "Featured apps" on every user's home
  // screen (frontend/src/features/home/home.js renderFindMore). One global ordered list:
  // GET /api/admin/featured-apps returns it plus everything still
  // available to add, and PUT rewrites it wholesale from an ordered slug
  // array — so the ↑/↓/Remove controls only ever reorder a local array
  // and Save persists it in one request.
  //
  // Featuring a view-private app is safe: the home row is derived from
  // GET /api/apps, which is visibility-filtered per viewer, so people who
  // can't see the app simply don't get the tile.
  //
  // View-only admins get the list read-only (the controls are omitted);
  // requireAdminWrite on the PUT is the real boundary.
  _featured: null,   // ordered slugs pending save
  _featuredMeta: {}, // slug -> { name, status, icon_emoji, icon_url }
  _featuredAvailable: [],
  _featuredDirty: false,
  FEATURED_MAX: 12,

  renderFeaturedAppsSection(host) {
    const canWrite = AdminConsole.canWrite();
    host.innerHTML = `
      <div class="${AdminUI.card} p-4">
        <div class="flex items-center justify-between mb-3">
          <h2 class="${AdminUI.cardTitle}">Featured apps</h2>
          <button id="admin-featured-refresh" class="${AdminUI.btn.link} text-xs">Refresh</button>
        </div>
        <p class="text-sm text-gray-600 dark:text-gray-400 mb-3">
          These apps appear in the &ldquo;Featured apps&rdquo; row on everyone&rsquo;s
          home screen, in this order. Apps a user has already added are left
          out of their row, and an app someone can&rsquo;t see never shows up
          for them. Up to ${AdminConsole.FEATURED_MAX} apps.
        </p>
        <div id="admin-featured-list" class="space-y-2 mb-3">
          <p class="text-sm text-gray-500">Loading&hellip;</p>
        </div>
        ${canWrite ? `
        <div class="flex flex-wrap items-center gap-2 pt-3 border-t border-gray-200 dark:border-gray-800">
          <select id="admin-featured-picker" class="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm max-w-[16rem]">
            <option value="">Add an app…</option>
          </select>
          <button id="admin-featured-add" class="px-3 py-1.5 rounded-md bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 text-sm">Add</button>
          <span class="flex-1"></span>
          <button id="admin-featured-save" class="${AdminUI.btn.primary} disabled:opacity-50" disabled>Save</button>
        </div>
        <p id="admin-featured-status" class="mt-2 text-xs text-gray-500"></p>
        ` : `
        <p class="pt-3 border-t border-gray-200 dark:border-gray-800 text-xs text-gray-500">
          View-only admin — the list is read-only here.
        </p>`}
      </div>`;

    host.querySelector('#admin-featured-refresh')
      ?.addEventListener('click', () => AdminConsole._loadFeaturedApps());
    host.querySelector('#admin-featured-add')
      ?.addEventListener('click', () => {
        const sel = document.getElementById('admin-featured-picker');
        const slug = sel && sel.value;
        if (!slug) return;
        if (AdminConsole._featured.length >= AdminConsole.FEATURED_MAX) {
          AdminConsole._setFeaturedStatus(`At most ${AdminConsole.FEATURED_MAX} apps.`);
          return;
        }
        AdminConsole._featured.push(slug);
        AdminConsole._featuredDirty = true;
        AdminConsole._renderFeaturedList();
      });
    host.querySelector('#admin-featured-save')
      ?.addEventListener('click', () => AdminConsole._saveFeaturedApps());

    AdminConsole._loadFeaturedApps();
  },

  async _loadFeaturedApps() {
    const listEl = document.getElementById('admin-featured-list');
    try {
      const res = await fetch('/api/admin/featured-apps');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      AdminConsole._featured = (data.featured || []).map((a) => a.slug);
      AdminConsole._featuredAvailable = data.available || [];
      AdminConsole._featuredMeta = {};
      for (const a of [...(data.featured || []), ...(data.available || [])]) {
        AdminConsole._featuredMeta[a.slug] = a;
      }
      AdminConsole._featuredDirty = false;
      AdminConsole._renderFeaturedList();
    } catch (err) {
      if (listEl) {
        listEl.innerHTML = `<p class="text-sm text-red-400">Failed to load featured apps (${AdminConsole.esc(err.message)})</p>`;
      }
    }
  },

  // Tiny icon preview so a row is recognisable at a glance: the same
  // priority as the home tile (custom image > emoji > first letter).
  _featuredIconHtml(meta) {
    if (meta && meta.icon_url) {
      return `<img src="${AdminConsole.esc(meta.icon_url)}" alt="" class="w-7 h-7 rounded-md object-cover shrink-0">`;
    }
    if (meta && meta.icon_emoji) {
      return `<span class="w-7 h-7 rounded-md bg-indigo-500/10 flex items-center justify-center text-base shrink-0" aria-hidden="true">${AdminConsole.esc(meta.icon_emoji)}</span>`;
    }
    const letter = ((meta && meta.name) || '?').charAt(0).toUpperCase();
    return `<span class="w-7 h-7 rounded-md bg-indigo-500/10 flex items-center justify-center text-xs font-bold shrink-0">${AdminConsole.esc(letter)}</span>`;
  },

  _renderFeaturedList() {
    const listEl = document.getElementById('admin-featured-list');
    if (!listEl) return;
    const canWrite = AdminConsole.canWrite();
    const slugs = AdminConsole._featured || [];
    if (!slugs.length) {
      listEl.innerHTML = '<p class="text-sm text-gray-500">No featured apps — the home row is hidden for everyone.</p>';
    } else {
      listEl.innerHTML = slugs.map((slug, i) => {
        const meta = AdminConsole._featuredMeta[slug] || { name: slug };
        return `
        <div class="flex items-center gap-2 rounded-md bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 px-2 py-1.5" data-featured-row="${AdminConsole.esc(slug)}">
          <span class="w-5 text-xs text-gray-400 tabular-nums">${i + 1}</span>
          ${AdminConsole._featuredIconHtml(meta)}
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium truncate">${AdminConsole.esc(meta.name || slug)}</span>
            <span class="block text-[11px] text-gray-400 truncate">${AdminConsole.esc(slug)}</span>
          </span>
          ${canWrite ? `
          <button data-featured-up="${AdminConsole.esc(slug)}" class="px-1.5 py-0.5 text-xs rounded text-gray-500 hover:text-indigo-800 dark:hover:text-indigo-300 disabled:opacity-30" title="Move up" aria-label="Move ${AdminConsole.esc(meta.name || slug)} up"${i === 0 ? ' disabled' : ''}>&uarr;</button>
          <button data-featured-down="${AdminConsole.esc(slug)}" class="px-1.5 py-0.5 text-xs rounded text-gray-500 hover:text-indigo-800 dark:hover:text-indigo-300 disabled:opacity-30" title="Move down" aria-label="Move ${AdminConsole.esc(meta.name || slug)} down"${i === slugs.length - 1 ? ' disabled' : ''}>&darr;</button>
          <button data-featured-remove="${AdminConsole.esc(slug)}" class="px-1.5 py-0.5 text-xs rounded text-gray-500 hover:text-red-400" title="Remove" aria-label="Remove ${AdminConsole.esc(meta.name || slug)}">&times;</button>
          ` : ''}
        </div>`;
      }).join('');
    }

    if (canWrite) {
      listEl.querySelectorAll('[data-featured-up]').forEach((b) => {
        b.addEventListener('click', () => AdminConsole._moveFeatured(b.dataset.featuredUp, -1));
      });
      listEl.querySelectorAll('[data-featured-down]').forEach((b) => {
        b.addEventListener('click', () => AdminConsole._moveFeatured(b.dataset.featuredDown, 1));
      });
      listEl.querySelectorAll('[data-featured-remove]').forEach((b) => {
        b.addEventListener('click', () => {
          AdminConsole._featured = AdminConsole._featured.filter((s) => s !== b.dataset.featuredRemove);
          AdminConsole._featuredDirty = true;
          AdminConsole._renderFeaturedList();
        });
      });
      // Picker holds everything not currently in the list — including
      // rows the admin just removed but hasn't saved yet, so an
      // accidental removal is undoable without a reload.
      const picker = document.getElementById('admin-featured-picker');
      if (picker) {
        const chosen = new Set(slugs);
        const pool = Object.values(AdminConsole._featuredMeta)
          .filter((a) => !chosen.has(a.slug))
          .sort((x, y) => String(x.name || x.slug).toLowerCase()
            .localeCompare(String(y.name || y.slug).toLowerCase()));
        picker.innerHTML = '<option value="">Add an app…</option>'
          + pool.map((a) => `<option value="${AdminConsole.esc(a.slug)}">${AdminConsole.esc(a.name || a.slug)}</option>`).join('');
      }
      const save = document.getElementById('admin-featured-save');
      if (save) save.disabled = !AdminConsole._featuredDirty;
    }
  },

  _moveFeatured(slug, delta) {
    const arr = AdminConsole._featured || [];
    const i = arr.indexOf(slug);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= arr.length) return;
    arr.splice(j, 0, arr.splice(i, 1)[0]);
    AdminConsole._featuredDirty = true;
    AdminConsole._renderFeaturedList();
  },

  _setFeaturedStatus(msg) {
    const el = document.getElementById('admin-featured-status');
    if (el) el.textContent = msg || '';
  },

  async _saveFeaturedApps() {
    const btn = document.getElementById('admin-featured-save');
    if (btn) btn.disabled = true;
    AdminConsole._setFeaturedStatus('Saving…');
    try {
      const res = await fetch('/api/admin/featured-apps', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slugs: AdminConsole._featured || [] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      AdminConsole._featuredDirty = false;
      AdminConsole._setFeaturedStatus('Saved — live on every home screen.');
      AdminConsole._loadFeaturedApps();
    } catch (err) {
      AdminConsole._setFeaturedStatus(`Save failed: ${err.message}`);
      if (btn) btn.disabled = false;
    }
  },

  // ── Container rollover ────────────────────────────────────────────────
  //
  // One press recreates every running child-app container with freshly
  // assembled env. Progress arrives on the shell's existing /ws/events
  // socket as `admin_rollover_status` (admin-only broadcast) and is routed
  // here by App's onmessage; GET /api/admin/rollover covers first paint and
  // WS reconnect. See src/services/app-rollover.js for why an env change
  // needs a container recreate at all.

  // Per-app outcome → chip. Mirrors the outcome vocabulary in
  // src/services/app-rollover.js; an unknown state falls back to the raw
  // string so a new outcome shows up rather than disappearing.
  ROLLOVER_STATES: {
    pending: { label: 'Queued', cls: 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300' },
    running: { label: 'Rolling over…', cls: 'bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300' },
    rolled: { label: 'Done', cls: 'bg-green-100 dark:bg-green-950/60 text-green-700 dark:text-green-400' },
    rebuilt: { label: 'Rebuilt', cls: 'bg-green-100 dark:bg-green-950/60 text-green-700 dark:text-green-400' },
    skipped_deploying: { label: 'Skipped — deploying', cls: 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300' },
    skipped_missing_secrets: { label: 'Skipped — missing secrets', cls: 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300' },
    skipped_no_db_password: { label: 'Skipped — no DB role', cls: 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300' },
    skipped_deleted: { label: 'Skipped — app gone', cls: 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300' },
    failed: { label: 'Failed', cls: 'bg-red-100 dark:bg-red-950/60 text-red-700 dark:text-red-400' },
  },

  renderRolloverSection(host) {
    const canWrite = AdminConsole.canWrite();
    host.innerHTML = `
      <div class="${AdminUI.card} p-4">
        <div class="flex items-center justify-between mb-3">
          <h2 class="${AdminUI.cardTitle}">Container rollover</h2>
          <button id="admin-refresh-rollover" class="${AdminUI.btn.link} text-xs">Refresh</button>
        </div>
        <p class="text-sm text-gray-600 dark:text-gray-400 mb-2">
          Recreates every running app container so it picks up the environment
          this platform build hands out. Needed after a platform change to what
          gets injected into containers — a restart is not enough, because a
          restarted container keeps the environment it was created with.
        </p>
        <p class="text-xs text-gray-500 mb-4">
          This re-runs each app's existing build: it changes the environment and
          nothing else — no new code is shipped, unlike a per-app redeploy. Each
          app blinks offline for a few seconds as its turn comes up. The platform
          app itself is never touched.
        </p>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
          <div class="rounded-lg bg-gray-100 dark:bg-gray-800 p-3">
            <div class="text-xs uppercase tracking-wide text-gray-500">Eligible apps</div>
            <div id="admin-rollover-eligible" class="text-2xl font-bold mt-1">—</div>
          </div>
          <div class="rounded-lg bg-gray-100 dark:bg-gray-800 p-3">
            <div class="text-xs uppercase tracking-wide text-gray-500">At a time</div>
            <div id="admin-rollover-concurrency" class="text-2xl font-bold mt-1">—</div>
          </div>
          <div class="rounded-lg bg-gray-100 dark:bg-gray-800 p-3">
            <div class="text-xs uppercase tracking-wide text-gray-500">Failed</div>
            <div id="admin-rollover-failed" class="text-2xl font-bold mt-1">—</div>
          </div>
        </div>
        ${canWrite ? `
        <button id="admin-rollover-btn"
          class="${AdminUI.btn.primary} disabled:opacity-50 disabled:hover:bg-indigo-600">
          Roll over all app containers
        </button>` : `
        <p class="text-xs text-gray-500">View-only admin — you can watch a rollover, but not start one.</p>`}
        <p id="admin-rollover-summary" class="text-sm text-gray-500 mt-3">Loading…</p>
        <div id="admin-rollover-list" class="space-y-2 mt-3"></div>
      </div>`;

    document.getElementById('admin-refresh-rollover')
      ?.addEventListener('click', () => AdminConsole.loadRollover());
    document.getElementById('admin-rollover-btn')
      ?.addEventListener('click', () => AdminConsole._startRollover());

    AdminConsole.loadRollover();
  },

  async loadRollover() {
    // The page's ?demo=1 rides along on the status read so a staging
    // preview renders the demo job (routes/admin.js serves it only behind
    // IS_STAGING && ?demo=1) — same pass-through home.js and settings.js
    // use for their own demo-injected endpoints.
    const demoQS = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
    const { data } = await AdminConsole.fetchJson(`/api/admin/rollover${demoQS}`);
    if (!data || typeof data !== 'object') return;
    if (AdminConsole._section !== 'rollover') return; // navigated away mid-fetch
    AdminConsole._rolloverEligible = typeof data.eligible === 'number' ? data.eligible : null;
    AdminConsole._rolloverConcurrency = data.concurrency || null;
    AdminConsole._rolloverDemo = !!data.demo;
    AdminConsole._paintRollover(data.job || null);
  },

  // Routed here from App's /ws/events onmessage. The section may not be
  // mounted (an admin can be anywhere in the shell while a sweep runs) —
  // in that case there is nothing to repaint and the next mount picks the
  // state up from the GET.
  handleRolloverStatus(data) {
    if (!data || !AdminConsole._open) return;
    if (AdminConsole._section !== 'rollover') return;
    if (!document.getElementById('admin-rollover-list')) return;
    AdminConsole._paintRollover(data.job || null);
  },

  async _startRollover() {
    const btn = document.getElementById('admin-rollover-btn');
    const count = AdminConsole._rolloverEligible;
    const many = typeof count === 'number' ? `${count} app container${count === 1 ? '' : 's'}` : 'every running app container';
    const ok = await AdminConsole._confirm({
      title: 'Roll over all app containers?',
      message: `This recreates ${many} with the environment this platform build injects. `
        + 'Each app is briefly unavailable (a few seconds) as its turn comes up, '
        + 'and only the environment changes — no new code is shipped. '
        + 'The platform app itself is not touched.',
      confirmLabel: 'Roll over',
    });
    if (!ok) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
    try {
      const res = await fetch('/api/admin/rollover', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        // Singleton job: a second press is a no-op, not an error.
        window.PlatformUI?.toast?.('A rollover is already in progress.');
        if (data && data.job) AdminConsole._paintRollover(data.job);
        return;
      }
      if (!res.ok) {
        AdminConsole._alert((data && data.error) || `Rollover failed to start (HTTP ${res.status})`);
        return;
      }
      window.PlatformUI?.toast?.('Rollover started.');
      if (data && data.job) AdminConsole._paintRollover(data.job);
    } catch (err) {
      AdminConsole._alert(`Rollover failed to start: ${err.message}`);
    } finally {
      AdminConsole.loadRollover();
    }
  },

  _paintRollover(job) {
    const esc = AdminConsole.esc;
    const eligibleEl = document.getElementById('admin-rollover-eligible');
    const concEl = document.getElementById('admin-rollover-concurrency');
    const failedEl = document.getElementById('admin-rollover-failed');
    const summary = document.getElementById('admin-rollover-summary');
    const list = document.getElementById('admin-rollover-list');
    if (!summary || !list) return;

    const running = !!(job && !job.finishedAt && !job.stale);

    if (eligibleEl) {
      eligibleEl.textContent = AdminConsole._rolloverEligible == null
        ? '—' : String(AdminConsole._rolloverEligible);
    }
    if (concEl) {
      concEl.textContent = job ? String(job.concurrency)
        : (AdminConsole._rolloverConcurrency ? String(AdminConsole._rolloverConcurrency) : '—');
    }
    if (failedEl) failedEl.textContent = job ? String(job.failed) : '—';

    const btn = document.getElementById('admin-rollover-btn');
    if (btn) {
      // A staging preview has no production containers to recreate, and the
      // route refuses the POST there — say so on the button rather than
      // letting a reviewer press it into a 400.
      const demo = !!AdminConsole._rolloverDemo;
      btn.disabled = running || demo;
      btn.textContent = demo
        ? 'Unavailable in previews'
        : (running ? 'Rollover in progress…' : 'Roll over all app containers');
    }
    const summaryPrefix = AdminConsole._rolloverDemo
      ? '<span class="text-indigo-500">Staging demo data</span> — ' : '';

    if (!job) {
      summary.textContent = 'No rollover has run since this platform process started.';
      list.innerHTML = '';
      return;
    }
    if (!job.total) {
      summary.textContent = job.finishedAt
        ? 'Finished — no eligible app containers were found.'
        : 'Starting…';
      list.innerHTML = '';
      return;
    }

    const parts = [`${job.done} of ${job.total} done`];
    if (job.failed) parts.push(`${job.failed} failed`);
    const when = job.finishedAt ? 'Finished' : (job.stale ? 'Stalled' : 'Running');
    const by = job.startedBy ? ` · started by ${esc(job.startedBy)}` : '';
    summary.innerHTML = `${summaryPrefix}<span class="font-medium">${when}</span> — ${esc(parts.join(', '))}${by}`;

    list.innerHTML = '';
    for (const app of job.apps || []) {
      const chip = AdminConsole.ROLLOVER_STATES[app.state]
        || { label: app.state, cls: 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300' };
      const el = document.createElement('div');
      el.className = 'flex flex-wrap items-center justify-between gap-x-3 gap-y-1 p-2.5 rounded-lg bg-gray-100 dark:bg-gray-800';
      el.setAttribute('data-rollover-slug', app.slug);
      el.setAttribute('data-rollover-state', app.state);
      const secs = app.ms == null ? '' : `${(app.ms / 1000).toFixed(1)}s`;
      el.innerHTML = `
        <span class="flex-1 min-w-0">
          <code class="font-mono text-sm">${esc(app.slug)}</code>
          ${app.error ? `<span class="block text-xs text-red-500 mt-0.5">${esc(app.error)}</span>` : ''}
        </span>
        <span class="flex items-center gap-2 shrink-0">
          ${secs ? `<span class="text-xs text-gray-500">${esc(secs)}</span>` : ''}
          <span class="text-xs px-2 py-0.5 rounded-full ${chip.cls}">${esc(chip.label)}</span>
        </span>`;
      list.appendChild(el);
    }
  },

  // ── Stale previews ────────────────────────────────────────────────────
  //
  // The preview half of the rollover above. A staging preview's environment
  // is fixed when it is BUILT, and previews live for weeks — so a platform
  // env change leaves them running happily with stale env, which the
  // existing staging-heal sweep cannot see (it only rebuilds previews whose
  // container has STOPPED). This shuts them down; the next Preview click
  // rebuilds any that someone actually wants. Progress arrives on the
  // shell's /ws/events socket as `admin_staging_reap_status` (admin-only
  // broadcast) and is routed here by App's onmessage; GET
  // /api/admin/staging-reap covers first paint and WS reconnect. See
  // src/services/staging-reap.js.

  // Per-preview outcome → chip. Mirrors the outcome vocabulary in
  // src/services/staging-reap.js; an unknown state falls back to the raw
  // string so a new outcome shows up rather than disappearing.
  REAP_STATES: {
    pending: { label: 'Queued', cls: 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300' },
    running: { label: 'Shutting down…', cls: 'bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300' },
    torn_down: { label: 'Shut down', cls: 'bg-green-100 dark:bg-green-950/60 text-green-700 dark:text-green-400' },
    torn_down_no_db: { label: 'Shut down — database kept', cls: 'bg-green-100 dark:bg-green-950/60 text-green-700 dark:text-green-400' },
    skipped_gone: { label: 'Skipped — already gone', cls: 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300' },
    failed: { label: 'Failed', cls: 'bg-red-100 dark:bg-red-950/60 text-red-700 dark:text-red-400' },
  },

  // Why each preview was picked up. Presentational only — the sweep tears
  // down everything it enumerates; this just explains what the admin is
  // looking at, and distinguishes "expected leftover of a merged proposal"
  // from "the session row is gone entirely".
  REAP_CLASSIFICATIONS: {
    merged: 'proposal merged',
    archived: 'proposal abandoned',
    promoted: 'up for a vote',
    merging: 'merging now',
    active: 'session open',
    paused: 'session paused',
    merged_unlinked: 'merged — leaked past teardown',
    archived_unlinked: 'abandoned — leaked past teardown',
    promoted_unlinked: 'up for a vote — link lost',
    no_session_row: 'session no longer exists',
  },

  renderStalePreviewsSection(host) {
    const canWrite = AdminConsole.canWrite();
    host.innerHTML = `
      <div class="${AdminUI.card} p-4">
        <div class="flex items-center justify-between mb-3">
          <h2 class="${AdminUI.cardTitle}">Stale previews</h2>
          <button id="admin-refresh-reap" class="${AdminUI.btn.link} text-xs">Refresh</button>
        </div>
        <p class="text-sm text-gray-600 dark:text-gray-400 mb-2">
          Shuts down every proposal preview that is still running. A preview's
          settings are fixed when it is built, so after a platform change to
          what gets injected into containers, old previews keep running with
          the old settings — typically showing a login screen instead of the
          app. Out-of-date previews are now found and cleaned up
          automatically in the background; this button is the immediate
          version, and takes every preview rather than only the stale ones.
        </p>
        <p class="text-xs text-gray-500 mb-4">
          Nothing is lost that matters: clicking Preview on a proposal rebuilds
          it automatically with current settings, the same way a preview that
          went to sleep does. A preview's throwaway test data is discarded, and
          rebuilding re-runs that proposal's automated checks.
        </p>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div class="rounded-lg bg-gray-100 dark:bg-gray-800 p-3">
            <div class="text-xs uppercase tracking-wide text-gray-500">Open previews</div>
            <div id="admin-reap-stale" class="text-2xl font-bold mt-1">—</div>
          </div>
          <div class="rounded-lg bg-gray-100 dark:bg-gray-800 p-3">
            <div class="text-xs uppercase tracking-wide text-gray-500">Out of date</div>
            <div id="admin-reap-outdated" class="text-2xl font-bold mt-1">—</div>
          </div>
          <div class="rounded-lg bg-gray-100 dark:bg-gray-800 p-3">
            <div class="text-xs uppercase tracking-wide text-gray-500">At a time</div>
            <div id="admin-reap-concurrency" class="text-2xl font-bold mt-1">—</div>
          </div>
          <div class="rounded-lg bg-gray-100 dark:bg-gray-800 p-3">
            <div class="text-xs uppercase tracking-wide text-gray-500">Failed</div>
            <div id="admin-reap-failed" class="text-2xl font-bold mt-1">—</div>
          </div>
        </div>
        <p id="admin-reap-automatic" class="text-xs text-gray-500 mb-4"></p>
        ${canWrite ? `
        <button id="admin-reap-btn"
          class="${AdminUI.btn.primary} disabled:opacity-50 disabled:hover:bg-indigo-600">
          Shut down stale previews
        </button>` : `
        <p class="text-xs text-gray-500">View-only admin — you can watch a sweep, but not start one.</p>`}
        <p id="admin-reap-summary" class="text-sm text-gray-500 mt-3">Loading…</p>
        <div id="admin-reap-list" class="space-y-2 mt-3"></div>
      </div>`;

    document.getElementById('admin-refresh-reap')
      ?.addEventListener('click', () => AdminConsole.loadStagingReap());
    document.getElementById('admin-reap-btn')
      ?.addEventListener('click', () => AdminConsole._startStagingReap());

    AdminConsole.loadStagingReap();
  },

  async loadStagingReap() {
    // The page's ?demo=1 rides along on the status read so a staging preview
    // renders the demo job (routes/admin.js serves it only behind
    // IS_STAGING && ?demo=1) — a preview has no docker socket, so there is
    // nothing real for this section to show there. Same pass-through
    // loadRollover uses.
    const demoQS = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
    const { data } = await AdminConsole.fetchJson(`/api/admin/staging-reap${demoQS}`);
    if (!data || typeof data !== 'object') return;
    if (AdminConsole._section !== 'staging-reap') return; // navigated away mid-fetch
    // `open` is every preview (what the button shuts down); `stale` is the
    // out-of-date subset the automatic pass acts on. Older payloads carried
    // only `stale` meaning "all previews", so fall back to it for `open`.
    AdminConsole._reapOpen = typeof data.open === 'number' ? data.open
      : (typeof data.stale === 'number' ? data.stale : null);
    AdminConsole._reapOutdated = typeof data.stale === 'number' ? data.stale : null;
    AdminConsole._reapAutomatic = data.automatic || null;
    AdminConsole._reapConcurrency = data.concurrency || null;
    AdminConsole._reapDemo = !!data.demo;
    // Tracked separately from _reapDemo: the POST is refused in a preview
    // whether or not the reviewer arrived with ?demo=1.
    AdminConsole._reapStaging = !!data.staging;
    AdminConsole._reapAvailable = data.available !== false;
    AdminConsole._reapUnavailableReason = data.unavailableReason || null;
    AdminConsole._paintStagingReap(data.job || null);
  },

  // Routed here from App's /ws/events onmessage. The section may not be
  // mounted (an admin can be anywhere in the shell while a sweep runs) — in
  // that case there is nothing to repaint and the next mount picks the state
  // up from the GET.
  handleStagingReapStatus(data) {
    if (!data || !AdminConsole._open) return;
    if (AdminConsole._section !== 'staging-reap') return;
    if (!document.getElementById('admin-reap-list')) return;
    AdminConsole._paintStagingReap(data.job || null);
  },

  async _startStagingReap() {
    const btn = document.getElementById('admin-reap-btn');
    // The button takes EVERY open preview, not just the out-of-date ones, so
    // the confirmation counts `open` — saying "4 previews" when it will shut
    // down 6 would be a lie about a fleet-wide action.
    const count = AdminConsole._reapOpen;
    const many = typeof count === 'number'
      ? `${count} preview${count === 1 ? '' : 's'}`
      : 'every open preview';
    const ok = await AdminConsole._confirm({
      title: 'Shut down stale previews?',
      message: `This shuts down ${many}. Anyone who wants one back gets it `
        + 'rebuilt automatically on their next Preview click, with current '
        + "settings. Each preview's throwaway test data is discarded, and "
        + "rebuilding re-runs that proposal's automated checks.",
      confirmLabel: 'Shut down',
    });
    if (!ok) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
    try {
      const res = await fetch('/api/admin/staging-reap', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        // Singleton job: a second press is a no-op, not an error.
        window.PlatformUI?.toast?.('A sweep is already in progress.');
        if (data && data.job) AdminConsole._paintStagingReap(data.job);
        return;
      }
      if (!res.ok) {
        AdminConsole._alert((data && data.error) || `Sweep failed to start (HTTP ${res.status})`);
        return;
      }
      window.PlatformUI?.toast?.('Sweep started.');
      if (data && data.job) AdminConsole._paintStagingReap(data.job);
    } catch (err) {
      AdminConsole._alert(`Sweep failed to start: ${err.message}`);
    } finally {
      AdminConsole.loadStagingReap();
    }
  },

  // "3 minutes ago" for the automatic pass's last run. Kept local and tiny:
  // the only consumer is the one line below.
  _reapAgo(iso) {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return null;
    const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  },

  _paintStagingReap(job) {
    const esc = AdminConsole.esc;
    const staleEl = document.getElementById('admin-reap-stale');
    const outdatedEl = document.getElementById('admin-reap-outdated');
    const autoEl = document.getElementById('admin-reap-automatic');
    const concEl = document.getElementById('admin-reap-concurrency');
    const failedEl = document.getElementById('admin-reap-failed');
    const summary = document.getElementById('admin-reap-summary');
    const list = document.getElementById('admin-reap-list');
    if (!summary || !list) return;

    const running = !!(job && !job.finishedAt && !job.stale);

    if (staleEl) {
      staleEl.textContent = AdminConsole._reapOpen == null
        ? '—' : String(AdminConsole._reapOpen);
    }
    if (outdatedEl) {
      outdatedEl.textContent = AdminConsole._reapOutdated == null
        ? '—' : String(AdminConsole._reapOutdated);
    }
    if (autoEl) {
      const auto = AdminConsole._reapAutomatic;
      if (AdminConsole._reapUnavailableReason === 'kubernetes') {
        autoEl.textContent = 'Kubernetes stale-preview administration is not implemented yet; normal per-session idle cleanup still applies.';
      } else if (!auto || !auto.intervalMs) {
        autoEl.textContent = 'The automatic background sweep is switched off.';
      } else if (!auto.lastRunAt) {
        const every = Math.round(auto.intervalMs / 60000);
        autoEl.textContent = `Automatic sweep runs every ${every} minutes — it hasn't run yet since this platform process started.`;
      } else {
        const ago = AdminConsole._reapAgo(auto.lastRunAt) || 'recently';
        const bits = [`Automatic sweep last ran ${ago}`];
        bits.push(`${auto.tornDown || 0} shut down`);
        if (auto.failed) bits.push(`${auto.failed} failed`);
        autoEl.textContent = `${bits.join(' · ')}.`;
      }
    }
    if (concEl) {
      concEl.textContent = job ? String(job.concurrency)
        : (AdminConsole._reapConcurrency ? String(AdminConsole._reapConcurrency) : '—');
    }
    if (failedEl) failedEl.textContent = job ? String(job.failed) : '—';

    const btn = document.getElementById('admin-reap-btn');
    if (btn) {
      // A preview has no docker socket, so it cannot manage other previews,
      // and the route refuses the POST there — say so on the button rather
      // than letting a reviewer press it into a 400. Gate on `staging`, not
      // on `demo`: the refusal applies with or without ?demo=1.
      const preview = !!AdminConsole._reapStaging || !!AdminConsole._reapDemo;
      const runtimeUnavailable = AdminConsole._reapAvailable === false;
      btn.disabled = running || preview || runtimeUnavailable;
      btn.textContent = preview
        ? 'Unavailable in previews'
        : (AdminConsole._reapUnavailableReason === 'kubernetes'
          ? 'Not yet supported in Kubernetes'
          : (running ? 'Sweep in progress…' : 'Shut down stale previews'));
    }
    const summaryPrefix = AdminConsole._reapDemo
      ? '<span class="text-indigo-500">Staging demo data</span> — ' : '';

    if (!job) {
      summary.textContent = 'No sweep has run since this platform process started.';
      list.innerHTML = '';
      return;
    }
    if (!job.total) {
      summary.textContent = job.finishedAt
        ? 'Finished — no open previews were found.'
        : 'Starting…';
      list.innerHTML = '';
      return;
    }

    const parts = [`${job.done} of ${job.total} done`];
    if (job.failed) parts.push(`${job.failed} failed`);
    const when = job.finishedAt ? 'Finished' : (job.stale ? 'Stalled' : 'Running');
    const by = job.startedBy ? ` · started by ${esc(job.startedBy)}` : '';
    summary.innerHTML = `${summaryPrefix}<span class="font-medium">${when}</span> — ${esc(parts.join(', '))}${by}`;

    list.innerHTML = '';
    for (const preview of job.previews || []) {
      const chip = AdminConsole.REAP_STATES[preview.state]
        || { label: preview.state, cls: 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300' };
      const why = AdminConsole.REAP_CLASSIFICATIONS[preview.classification]
        || preview.classification;
      const el = document.createElement('div');
      el.className = 'flex flex-wrap items-center justify-between gap-x-3 gap-y-1 p-2.5 rounded-lg bg-gray-100 dark:bg-gray-800';
      el.setAttribute('data-reap-name', preview.name);
      el.setAttribute('data-reap-state', preview.state);
      const secs = preview.ms == null ? '' : `${(preview.ms / 1000).toFixed(1)}s`;
      el.innerHTML = `
        <span class="flex-1 min-w-0">
          <code class="font-mono text-sm">${esc(preview.slug)}</code>
          <span class="text-xs text-gray-500 ml-1">#${esc(String(preview.sessionId))}</span>
          <span class="block text-xs text-gray-500 mt-0.5">${esc(why)}</span>
          ${preview.error ? `<span class="block text-xs text-red-500 mt-0.5">${esc(preview.error)}</span>` : ''}
        </span>
        <span class="flex items-center gap-2 shrink-0">
          ${secs ? `<span class="text-xs text-gray-500">${esc(secs)}</span>` : ''}
          <span class="text-xs px-2 py-0.5 rounded-full ${chip.cls}">${esc(chip.label)}</span>
        </span>`;
      list.appendChild(el);
    }
  },

  // ── Overview (operations snapshot) ─────────────────────────────────────

  renderOverviewSection(host) {
    host.innerHTML = `
      <div class="${AdminUI.card} p-4">
        <div class="flex items-center justify-between mb-3">
          <h2 class="${AdminUI.cardTitle}">Operations</h2>
          <button id="admin-refresh-overview" class="${AdminUI.btn.link} text-xs">Refresh</button>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
          <div class="rounded-lg bg-gray-100 dark:bg-gray-800 p-3">
            <div class="text-xs uppercase tracking-wide text-gray-500">Stuck apps</div>
            <div id="admin-overview-stuck" class="text-2xl font-bold mt-1">—</div>
          </div>
          <div class="rounded-lg bg-gray-100 dark:bg-gray-800 p-3">
            <div class="text-xs uppercase tracking-wide text-gray-500">LLM spend today</div>
            <div id="admin-overview-llm" class="text-2xl font-bold mt-1">—</div>
          </div>
          <div class="rounded-lg bg-gray-100 dark:bg-gray-800 p-3">
            <div class="text-xs uppercase tracking-wide text-gray-500">Orphan workers</div>
            <div id="admin-overview-orphan" class="text-2xl font-bold mt-1">—</div>
          </div>
        </div>
        <div id="admin-overview-details" class="space-y-3 text-sm">
          <p class="text-xs text-gray-500">Loading…</p>
        </div>
      </div>`;
    document.getElementById('admin-refresh-overview')
      .addEventListener('click', () => AdminConsole.loadOverview());
    AdminConsole.loadOverview();
  },

  async loadOverview() {
    // status.gather can take a moment; the tiles show em-dashes until it
    // lands, and only this section blocks — never the whole page.
    const { data } = await AdminConsole.fetchJson('/api/admin/overview');
    if (!data || typeof data !== 'object') return;
    if (AdminConsole._section !== 'overview') return; // navigated away mid-fetch
    AdminConsole._paintOverview(data);
  },

  _paintOverview(data) {
    const esc = AdminConsole.esc;
    const stuck = data.stuckApps || [];
    const orphans = data.orphanWorkers || [];
    const llm = data.llmToday || { totalSpendCents: 0, users: [] };

    const stuckEl = document.getElementById('admin-overview-stuck');
    const orphanEl = document.getElementById('admin-overview-orphan');
    const llmEl = document.getElementById('admin-overview-llm');
    const detail = document.getElementById('admin-overview-details');
    if (!stuckEl || !detail) return;
    stuckEl.textContent = String(stuck.length);
    orphanEl.textContent = String(orphans.length);
    llmEl.textContent = `$${(llm.totalSpendCents / 100).toFixed(2)}`;

    detail.innerHTML = '';
    if (stuck.length) {
      const sec = document.createElement('div');
      sec.innerHTML = `
        <div class="text-xs uppercase tracking-wide text-gray-500 mb-1">Stuck apps</div>
        <ul class="space-y-1">
          ${stuck.map((a) => `
            <li class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 p-2 rounded bg-gray-100 dark:bg-gray-800">
              <span>
                <span class="font-mono">${esc(a.slug)}</span>
                <span class="text-xs text-gray-500">(${esc(a.dbStatus)}, by ${esc(a.createdBy || '—')})</span>
              </span>
              <span class="text-xs text-gray-500">${new Date(a.createdAt).toLocaleString()}</span>
            </li>`).join('')}
        </ul>`;
      detail.appendChild(sec);
    }
    if (orphans.length) {
      const sec = document.createElement('div');
      sec.innerHTML = `
        <div class="text-xs uppercase tracking-wide text-gray-500 mb-1">Orphan workers</div>
        <ul class="space-y-1">
          ${orphans.map((w) => `
            <li class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 p-2 rounded bg-gray-100 dark:bg-gray-800">
              <span>
                <span class="font-mono">${esc(w.name)}</span>
                <span class="text-xs text-gray-500">
                  ${w.appSlug ? `app ${esc(w.appSlug)}` : 'no app'}
                  · up ${Math.round((w.uptimeSeconds || 0) / 60)}m
                  ${w.sessionArchived ? '· session archived' : ''}
                </span>
              </span>
            </li>`).join('')}
        </ul>`;
      detail.appendChild(sec);
    }
    if (llm.users?.length) {
      const sec = document.createElement('div');
      const rows = llm.users.slice(0, 5).map((u) =>
        `<li class="flex items-center justify-between gap-3 p-2 rounded bg-gray-100 dark:bg-gray-800">
          <span>${esc(u.username)}</span>
          <span class="text-xs font-mono text-gray-400">$${(u.costCents / 100).toFixed(2)}</span>
        </li>`).join('');
      sec.innerHTML = `
        <div class="text-xs uppercase tracking-wide text-gray-500 mb-1">Top LLM spenders today</div>
        <ul class="space-y-1">${rows}</ul>`;
      detail.appendChild(sec);
    }
    if (!detail.children.length) {
      detail.innerHTML = '<p class="text-xs text-gray-500">All clear — no stuck apps, no orphan workers, no LLM spend recorded today.</p>';
    }
  },

  // ── Spend limits ────────────────────────────────────────────────────────

  renderLimitsSection(host) {
    const canWrite = AdminConsole.canWrite();
    const dis = canWrite ? '' : 'disabled';
    host.innerHTML = `
      <div class="${AdminUI.card} p-4">
        <div class="flex items-center justify-between mb-3">
          <h2 class="${AdminUI.cardTitle}">LLM Spend Limits</h2>
          <span class="text-xs text-gray-500">USD · resets midnight UTC</span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <label class="block">
            <span class="text-xs uppercase tracking-wide text-gray-500">Default per-user daily cap</span>
            <div class="relative mt-1">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500 pointer-events-none">$</span>
              <input id="admin-limit-user" type="number" min="0" step="0.01" inputmode="decimal" ${dis}
                class="${AdminUI.input} pl-6 font-mono disabled:opacity-60"
                placeholder="25.00">
            </div>
          </label>
          <label class="block">
            <span class="text-xs uppercase tracking-wide text-gray-500">Global daily cap</span>
            <div class="relative mt-1">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500 pointer-events-none">$</span>
              <input id="admin-limit-global" type="number" min="0" step="0.01" inputmode="decimal" ${dis}
                class="${AdminUI.input} pl-6 font-mono disabled:opacity-60"
                placeholder="200.00">
            </div>
          </label>
          <label class="block">
            <span class="text-xs uppercase tracking-wide text-gray-500" title="Funds platform-driven merge-conflict / sync-with-main resolution turns">System tokens daily cap</span>
            <div class="relative mt-1">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500 pointer-events-none">$</span>
              <input id="admin-limit-system" type="number" min="0" step="0.01" inputmode="decimal" ${dis}
                class="${AdminUI.input} pl-6 font-mono disabled:opacity-60"
                placeholder="25.00">
            </div>
          </label>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-xs text-gray-500">Per-user overrides live in the Users section; these are the platform defaults.</p>
          ${canWrite ? `<button id="admin-save-limits-btn" class="${AdminUI.btn.primary}">Save</button>` : ''}
        </div>
        <p id="admin-limits-status" class="text-xs mt-2 hidden"></p>
      </div>

      <!-- Anthropic credits (#555). Anthropic's API publishes billed
           spend, never a balance, so the remaining figure is derived:
           the balance recorded here minus cost_report spend since the
           as-of date. Re-record both after every top-up. View-only
           admins see the values, disabled.

           This is the ONLY surface for the figure — the drawer's status
           pane carried a matching row until it was removed for reading
           "Not set up" indefinitely. -->
      <div class="${AdminUI.card} p-4 mt-4">
        <div class="flex items-center justify-between mb-3">
          <h2 class="${AdminUI.cardTitle}">Anthropic credits</h2>
        </div>
        <p class="${AdminUI.muted} mb-3">
          Anthropic doesn’t publish a remaining-credit figure, only what it has
          billed. Record the balance and the date it was correct, and the platform
          subtracts billed spend since then. Re-record both after every top-up.
        </p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <label class="block">
            <span class="text-xs uppercase tracking-wide text-gray-500">Credit balance</span>
            <div class="relative mt-1">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500 pointer-events-none">$</span>
              <input id="admin-credit-balance" type="number" min="0" step="0.01" inputmode="decimal" ${dis}
                class="${AdminUI.input} pl-6 font-mono disabled:opacity-60"
                placeholder="5000.00">
            </div>
          </label>
          <label class="block">
            <span class="text-xs uppercase tracking-wide text-gray-500" title="The date that balance was correct">As of</span>
            <input id="admin-credit-as-of" type="date" ${dis}
              class="${AdminUI.input} mt-1 font-mono disabled:opacity-60">
          </label>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p id="admin-credit-derived" class="text-xs text-gray-500"></p>
          ${canWrite ? `<button id="admin-save-credits-btn" class="${AdminUI.btn.primary}">Save</button>` : ''}
        </div>
        <p id="admin-credits-status" class="text-xs mt-2 hidden"></p>
      </div>`;
    document.getElementById('admin-save-limits-btn')
      ?.addEventListener('click', () => AdminConsole.saveLimits());
    document.getElementById('admin-save-credits-btn')
      ?.addEventListener('click', () => AdminConsole.saveAnthropicCredits());
    AdminConsole.loadLimits();
    AdminConsole.loadAnthropicCredits();
  },

  async loadAnthropicCredits() {
    const { data } = await AdminConsole.fetchJson('/api/admin/anthropic-credits');
    if (!data || typeof data !== 'object') return;
    AdminConsole._fillAnthropicCredits(data);
  },

  _fillAnthropicCredits(data) {
    const bal = document.getElementById('admin-credit-balance');
    const asOf = document.getElementById('admin-credit-as-of');
    const derived = document.getElementById('admin-credit-derived');
    if (!bal) return;
    if (data.configured) {
      bal.value = AdminConsole.centsToDollars(data.balanceCents);
      asOf.value = data.asOf || '';
    }
    if (!derived) return;
    // Echo the derived figure back here, so an admin can confirm the
    // admin key is actually working. This is the only place it shows.
    if (!data.configured) {
      derived.textContent = 'Nothing recorded yet — no remaining-credit figure is being tracked.';
    } else if (typeof data.remainingCents !== 'number') {
      derived.textContent = 'Couldn’t reach Anthropic to compute the remaining credit'
        + (data.error ? ` (${data.error})` : '') + '.';
    } else {
      const src = data.source === 'anthropic'
        ? 'from Anthropic’s billed cost report'
        : 'estimated from platform spend records (no ANTHROPIC_ADMIN_KEY configured)';
      derived.textContent = `$${AdminConsole.centsToDollars(data.remainingCents)} remaining — `
        + `$${AdminConsole.centsToDollars(data.spentCents)} spent since ${data.asOf}, ${src}.`
        + (data.stale ? ' Showing a cached figure; the last refresh failed.' : '');
    }
  },

  async saveAnthropicCredits() {
    const status = document.getElementById('admin-credits-status');
    status.classList.add('hidden');
    let body;
    try {
      const cents = AdminConsole.parseDollarsToCents('Credit balance',
        document.getElementById('admin-credit-balance').value.trim());
      const asOf = document.getElementById('admin-credit-as-of').value.trim();
      if (cents === null) throw new Error('Enter the credit balance.');
      if (!asOf) throw new Error('Enter the date that balance was correct.');
      body = { balanceCents: cents, asOf };
    } catch (err) {
      status.textContent = err.message;
      status.className = 'text-xs mt-2 text-red-400';
      status.classList.remove('hidden');
      return;
    }
    try {
      const res = await fetch('/api/admin/anthropic-credits', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`);
      AdminConsole._fillAnthropicCredits(data);
      status.textContent = 'Saved.';
      status.className = 'text-xs mt-2 text-emerald-400';
      status.classList.remove('hidden');
    } catch (err) {
      status.textContent = err.message;
      status.className = 'text-xs mt-2 text-red-400';
      status.classList.remove('hidden');
    }
  },

  async loadLimits() {
    const { data } = await AdminConsole.fetchJson('/api/admin/limits');
    if (!data || typeof data !== 'object') return;
    AdminConsole._fillLimits(data);
  },

  _fillLimits(data) {
    const u = document.getElementById('admin-limit-user');
    const g = document.getElementById('admin-limit-global');
    const s = document.getElementById('admin-limit-system');
    if (!u) return;
    u.value = AdminConsole.centsToDollars(data.user_daily_limit_cents);
    g.value = AdminConsole.centsToDollars(data.global_daily_limit_cents);
    s.value = AdminConsole.centsToDollars(data.system_tokens_daily_limit_cents);
  },

  async saveLimits() {
    const status = document.getElementById('admin-limits-status');
    status.classList.add('hidden');
    const body = {};
    try {
      const u = AdminConsole.parseDollarsToCents('Default per-user',
        document.getElementById('admin-limit-user').value.trim());
      const g = AdminConsole.parseDollarsToCents('Global',
        document.getElementById('admin-limit-global').value.trim());
      const s = AdminConsole.parseDollarsToCents('System tokens',
        document.getElementById('admin-limit-system').value.trim());
      if (u !== null) body.user = u;
      if (g !== null) body.global = g;
      if (s !== null) body.system = s;
      if (!Object.keys(body).length) throw new Error('Provide at least one value.');
    } catch (err) {
      status.textContent = err.message;
      status.className = 'text-xs mt-2 text-red-400';
      status.classList.remove('hidden');
      return;
    }
    try {
      const res = await fetch('/api/admin/limits', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      AdminConsole._fillLimits(await res.json());
      status.textContent = 'Saved.';
      status.className = 'text-xs mt-2 text-green-500';
      status.classList.remove('hidden');
      setTimeout(() => status.classList.add('hidden'), 2000);
    } catch (err) {
      status.textContent = `Save failed: ${err.message}`;
      status.className = 'text-xs mt-2 text-red-400';
      status.classList.remove('hidden');
    }
  },

  // ── Activation codes ────────────────────────────────────────────────────

  renderCodesSection(host) {
    const canWrite = AdminConsole.canWrite();
    host.innerHTML = `
      <div class="${AdminUI.card} p-4">
        <div class="flex items-center justify-between mb-3">
          <h2 class="${AdminUI.cardTitle}">Activation Codes</h2>
          ${canWrite ? `<button id="admin-generate-code-btn" class="${AdminUI.btn.primary}">Generate Code</button>` : ''}
        </div>
        <div id="admin-code-list" class="space-y-2"></div>
        <p id="admin-code-empty" class="text-sm text-gray-500 hidden">No activation codes yet.</p>
      </div>`;
    document.getElementById('admin-generate-code-btn')
      ?.addEventListener('click', async () => {
        await fetch('/api/admin/codes', { method: 'POST' });
        AdminConsole.loadCodes();
      });
    AdminConsole.loadCodes();
  },

  async loadCodes() {
    const { data } = await AdminConsole.fetchJson('/api/admin/codes');
    if (!Array.isArray(data)) return;
    if (AdminConsole._section !== 'codes') return;
    AdminConsole._paintCodes(data);
  },

  _paintCodes(codes) {
    const esc = AdminConsole.esc;
    const list = document.getElementById('admin-code-list');
    const empty = document.getElementById('admin-code-empty');
    if (!list) return;
    list.innerHTML = '';
    if (!codes.length) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    const canWrite = AdminConsole.canWrite();

    for (const code of codes) {
      const el = document.createElement('div');
      el.className = 'flex flex-wrap items-center justify-between gap-3 p-2.5 rounded-lg bg-gray-100 dark:bg-gray-800';
      const used = !!code.used_by_username;
      let statusHtml;
      if (used) {
        const date = new Date(code.used_at).toLocaleDateString();
        statusHtml = `<span class="text-xs text-gray-500">Used by <strong class="text-gray-400">${esc(code.used_by_username)}</strong> on ${date}</span>`;
      } else {
        statusHtml = `<span class="${AdminUI.badge.success}">Available</span>`;
      }
      el.innerHTML = `
        <div class="flex-1 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1">
          <code class="font-mono text-sm ${used ? 'text-gray-400 line-through' : 'text-indigo-400'}">${esc(code.code)}</code>
          ${statusHtml}
        </div>
        <div class="flex items-center gap-2 shrink-0">
          ${!used ? `<button class="admin-copy-code-btn text-xs text-gray-400 hover:text-indigo-800 dark:hover:text-indigo-300 transition-colors" data-code="${esc(code.code)}">Copy</button>` : ''}
          ${!used ? `<button class="admin-share-code-btn text-xs text-gray-400 hover:text-green-400 transition-colors" data-code="${esc(code.code)}">Share link</button>` : ''}
          ${!used && canWrite ? `<button class="admin-delete-code-btn text-xs text-gray-400 hover:text-red-400 transition-colors" data-id="${code.id}" aria-label="Delete code">&times;</button>` : ''}
        </div>`;
      list.appendChild(el);
    }

    list.querySelectorAll('.admin-copy-code-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.code);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      });
    });
    list.querySelectorAll('.admin-share-code-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        // In-SPA register route (fold-auth-pages-into-SPA); the old
        // /register.html?code=… form still works via the redirect stub.
        const url = `${location.origin}/#register/${encodeURIComponent(btn.dataset.code)}`;
        navigator.clipboard.writeText(url);
        btn.textContent = 'Link copied!';
        setTimeout(() => { btn.textContent = 'Share link'; }, 1500);
      });
    });
    list.querySelectorAll('.admin-delete-code-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await fetch(`/api/admin/codes/${btn.dataset.id}`, { method: 'DELETE' });
        AdminConsole.loadCodes();
      });
    });
  },

  // ── Users ───────────────────────────────────────────────────────────────

  renderUsersSection(host) {
    const canWrite = AdminConsole.canWrite();
    host.innerHTML = `
      <div class="${AdminUI.card}">
        <div class="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-gray-200 dark:border-gray-800">
          <h2 class="${AdminUI.cardTitle}">Users</h2>
          ${canWrite ? `
          <div id="admin-bulk-quota-control" class="flex items-center gap-2" title="Set every user's app quota to this number.">
            <span class="text-xs text-gray-400">Set all quotas to</span>
            <input id="admin-bulk-quota-input" type="number" min="0" step="1" inputmode="numeric"
              class="w-16 rounded bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs font-mono"
              placeholder="0">
            <button id="admin-bulk-quota-btn" class="${AdminUI.btn.primarySm}">Set all</button>
          </div>` : ''}
        </div>
        <div id="admin-user-list" class="divide-y divide-gray-200 dark:divide-gray-800">
          <p class="p-4 text-xs text-gray-500">Loading…</p>
        </div>
      </div>
      <div id="admin-users-programme" class="mt-6"></div>`;
    document.getElementById('admin-bulk-quota-btn')
      ?.addEventListener('click', () => AdminConsole._bulkQuota());
    AdminConsole.loadUsers();
    // #1179: the programme's own users screen (event enrolment, podium and
    // log settings, CSV import/export) is merged into this section — one
    // Users menu entry, both feature sets. admin-topochain.js owns that
    // card's markup and handlers; its _sub must name the screen because
    // its loaders use it as their stale-response guard.
    if (window.AdminTopochain) {
      window.AdminTopochain._sub = 'users';
      window.AdminTopochain.renderUsers(document.getElementById('admin-users-programme'));
    }
  },

  async _bulkQuota() {
    const input = document.getElementById('admin-bulk-quota-input');
    const raw = input.value.trim();
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n) || n < 0) {
      AdminConsole._alert('Enter a non-negative whole number.');
      return;
    }
    const ok = await AdminConsole._confirm({
      title: 'Set all quotas?',
      message: `Set EVERY user's app quota to ${n}? This overwrites all current quotas.`,
      confirmLabel: 'Set all',
    });
    if (!ok) return;
    const btn = document.getElementById('admin-bulk-quota-btn');
    btn.disabled = true;
    try {
      const res = await fetch('/api/admin/users/app-quota', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quota: n }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        AdminConsole._alert(data.error || `Set all failed (HTTP ${res.status})`);
        return;
      }
      input.value = '';
      await AdminConsole.loadUsers();
    } catch (err) {
      AdminConsole._alert(`Set all failed: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  },

  async loadUsers() {
    const { status, data } = await AdminConsole.fetchJson('/api/admin/users');
    if (AdminConsole._section !== 'users') return;
    const list = document.getElementById('admin-user-list');
    if (!list) return;
    if (status === 403) {
      list.innerHTML = '<p class="p-4 text-sm text-gray-500">Admin access required.</p>';
      return;
    }
    if (!Array.isArray(data)) return;
    AdminConsole._paintUsers(data);
  },

  _paintUsers(users) {
    const esc = AdminConsole.esc;
    const canWrite = AdminConsole.canWrite();
    const list = document.getElementById('admin-user-list');
    if (!list) return;
    list.innerHTML = '';

    // Disable the role selector for the sole remaining FULL admin — the
    // server enforces the same rule (last-full-admin guard); this is the
    // matching UX affordance. View-only admins don't count (issue #311).
    const fullAdminCount = users.filter((u) => u.is_admin && !u.admin_readonly).length;

    for (const user of users) {
      const el = document.createElement('div');
      el.className = 'p-4 flex items-start gap-3';

      const codeInfo = user.activation_code
        ? `<span class="text-xs text-gray-500">code: <code class="text-gray-400">${esc(user.activation_code)}</code></span>`
        : '';
      const costToday = (parseFloat(user.cost_today_cents || 0) / 100).toFixed(2);

      const isAdmin = !!user.is_admin;
      const isReadonlyAdmin = isAdmin && !!user.admin_readonly;
      const role = !isAdmin ? 'user' : (isReadonlyAdmin ? 'view_admin' : 'admin');
      const isSelf = !!user.is_self;
      const isLastFullAdmin = isAdmin && !isReadonlyAdmin && fullAdminCount <= 1;
      const roleSelectDisabled = isSelf || isLastFullAdmin;
      let roleTitle;
      if (isSelf) {
        roleTitle = "You can't change your own role.";
      } else if (isLastFullAdmin) {
        roleTitle = "Can't drop the last full admin.";
      } else {
        roleTitle = "Set this user's role.";
      }
      const roleLabel = { user: 'User', view_admin: 'View-only admin', admin: 'Admin' }[role];
      const roleControlHtml = canWrite
        ? `
        <div class="flex items-center gap-2 shrink-0" title="${roleTitle}">
          <span class="text-xs text-gray-400">Role</span>
          <select class="admin-role-select rounded bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs"
            data-user-id="${user.id}" data-original="${role}" ${roleSelectDisabled ? 'disabled' : ''}>
            <option value="user" ${role === 'user' ? 'selected' : ''}>User</option>
            <option value="view_admin" ${role === 'view_admin' ? 'selected' : ''}>View-only admin</option>
            <option value="admin" ${role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
        </div>`
        : `
        <div class="flex items-center gap-2 shrink-0">
          <span class="text-xs text-gray-400">Role</span>
          <span class="text-xs font-medium text-gray-500 dark:text-gray-300">${roleLabel}</span>
        </div>`;

      const appQuota = user.app_quota == null ? 0 : user.app_quota;
      const appsCreated = user.apps_created == null ? 0 : user.apps_created;
      const quotaHtml = `
        <div class="flex items-center gap-1 shrink-0" title="Max apps this user may create. 0 = cannot create. Admins bypass this.">
          <span class="text-xs text-gray-400">App quota</span>
          <input type="number" min="0" step="1" inputmode="numeric"
            class="admin-quota-input w-16 rounded bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs font-mono disabled:opacity-60"
            data-user-id="${user.id}"
            data-original="${appQuota}"
            value="${appQuota}" ${canWrite ? '' : 'disabled'}>
          <span class="text-xs text-gray-500 whitespace-nowrap">${appsCreated} used</span>
        </div>`;

      const overrideCents = user.daily_limit_cents;
      const overrideDollars = overrideCents == null ? '' : AdminConsole.centsToDollars(overrideCents);
      const limitHtml = `
        <div class="flex items-center gap-1 shrink-0" title="Per-user daily cap in dollars. Blank = use platform default.">
          <span class="text-xs text-gray-400">Cap $</span>
          <input type="number" min="0" step="0.01" inputmode="decimal"
            class="admin-user-limit-input w-20 rounded bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs font-mono disabled:opacity-60"
            data-user-id="${user.id}"
            data-original="${overrideDollars}"
            value="${overrideDollars}"
            placeholder="default" ${canWrite ? '' : 'disabled'}>
        </div>`;

      const walletAddr = user.usernode_pubkey == null ? '' : user.usernode_pubkey;
      const walletHtml = `
        <div class="flex items-center gap-1 shrink-0" title="Linked Usernode wallet (ut1…). Blank = no wallet linked.">
          <span class="text-xs text-gray-400">Wallet</span>
          <input type="text" autocomplete="off" spellcheck="false"
            class="admin-wallet-input w-44 max-w-full rounded bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs font-mono disabled:opacity-60"
            data-user-id="${user.id}"
            data-original="${esc(walletAddr)}"
            value="${esc(walletAddr)}"
            placeholder="none" ${canWrite ? '' : 'disabled'}>
        </div>`;

      // Per-row actions in a "…" overflow menu; only full admins get one
      // (view-only admins have no actions). Delete stays hidden for admins.
      const deleteItem = !user.is_admin
        ? `<button data-delete-id="${user.id}" class="admin-delete-user-btn block w-full text-left px-3 py-2 text-sm text-red-500 hover:bg-gray-100 dark:hover:bg-gray-700">Delete</button>`
        : '';
      const kebabHtml = canWrite ? `
        <div class="relative shrink-0 admin-user-actions">
          <button type="button" class="admin-kebab-btn rounded px-2 py-1 text-lg leading-none text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" aria-label="User actions" aria-haspopup="true" aria-expanded="false">&#8943;</button>
          <div class="admin-kebab-menu hidden absolute right-0 mt-1 z-20 min-w-[11rem] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-1 shadow-lg">
            <button data-reset-id="${user.id}" data-username="${esc(user.username)}" class="admin-reset-pw-btn block w-full text-left px-3 py-2 text-sm text-indigo-500 hover:bg-gray-100 dark:hover:bg-gray-700">Reset password</button>
            ${deleteItem}
          </div>
        </div>` : '';

      el.innerHTML = `
        <div class="flex-1 min-w-0 flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between xl:gap-6">
          <div class="min-w-0">
            <div class="font-medium break-words">${esc(user.username)}</div>
            <div class="text-sm text-gray-500 truncate">$${costToday} spent today ${codeInfo}</div>
          </div>
          <!-- Stacked under the name on narrow screens; from xl the console
               is full width, so the controls sit on the same line, pushed
               right, instead of leaving half the row empty. -->
          <div class="flex flex-wrap items-center gap-3 xl:justify-end xl:shrink-0">
            ${walletHtml}
            ${limitHtml}
            ${roleControlHtml}
            ${quotaHtml}
          </div>
        </div>
        ${kebabHtml}`;
      list.appendChild(el);
    }

    AdminConsole._wireUserRows(list);
  },

  _wireUserRows(list) {
    const esc = AdminConsole.esc;

    list.querySelectorAll('.admin-user-limit-input').forEach((inp) => {
      // Save on blur or Enter. Empty string clears the override. Input is
      // dollars; the API speaks integer cents.
      const commit = async () => {
        const next = inp.value.trim();
        const orig = inp.dataset.original || '';
        if (next === orig) return;
        const userId = inp.dataset.userId;
        inp.disabled = true;
        let body;
        if (next === '') {
          body = { cents: null };
        } else {
          try {
            body = { cents: AdminConsole.parseDollarsToCents('Cap', next) };
          } catch (err) {
            AdminConsole._alert(err.message);
            inp.value = orig;
            inp.disabled = false;
            return;
          }
        }
        try {
          const res = await fetch(`/api/admin/users/${userId}/daily-limit`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            AdminConsole._alert(data.error || `Save failed (HTTP ${res.status})`);
            inp.value = orig;
          } else {
            const data = await res.json();
            const v = data.daily_limit_cents == null ? '' : AdminConsole.centsToDollars(data.daily_limit_cents);
            inp.value = v;
            inp.dataset.original = v;
          }
        } catch (err) {
          AdminConsole._alert(`Save failed: ${err.message}`);
          inp.value = orig;
        } finally {
          inp.disabled = false;
        }
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      });
    });

    list.querySelectorAll('.admin-wallet-input').forEach((inp) => {
      // Save on blur or Enter. Empty = clear the wallet. On a 409 the
      // address already belongs to another user; offer to reassign (move)
      // it, which the backend does atomically.
      const commit = async () => {
        const next = inp.value.trim();
        const orig = inp.dataset.original || '';
        if (next === orig) return;
        const userId = inp.dataset.userId;
        if (next !== '' && !/^ut1\S{5,252}$/.test(next)) {
          AdminConsole._alert('Wallet address must start with "ut1" and contain no spaces.');
          inp.value = orig;
          return;
        }
        inp.disabled = true;
        const send = async (reassign) => {
          const body = { pubkey: next === '' ? null : next };
          if (reassign) body.reassign = true;
          return fetch(`/api/admin/users/${userId}/wallet`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        };
        try {
          let res = await send(false);
          if (res.status === 409) {
            const data = await res.json().catch(() => ({}));
            const other = data.conflictUser?.username || 'another user';
            const move = await AdminConsole._confirm({
              title: 'Wallet already linked',
              message: `${next} is currently linked to "${other}". Move it to this user? This clears it from "${other}".`,
              confirmLabel: 'Move it',
            });
            if (move) {
              res = await send(true);
            } else {
              inp.value = orig;
              return;
            }
          }
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            AdminConsole._alert(data.error || `Save failed (HTTP ${res.status})`);
            inp.value = orig;
          } else {
            // A reassign empties the previous holder's row too; reload so
            // both affected rows reflect the new state.
            await AdminConsole.loadUsers();
            return;
          }
        } catch (err) {
          AdminConsole._alert(`Save failed: ${err.message}`);
          inp.value = orig;
        } finally {
          inp.disabled = false;
        }
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      });
    });

    list.querySelectorAll('.admin-role-select').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const userId = sel.dataset.userId;
        const orig = sel.dataset.original;
        const next = sel.value;
        if (next === orig) return;
        sel.disabled = true;
        try {
          const res = await fetch(`/api/admin/users/${userId}/is-admin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: next }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            sel.value = orig;
            AdminConsole._alert(data.error || `Role change failed (HTTP ${res.status})`);
            return;
          }
          // Re-render so the last-full-admin disabling and the Delete
          // visibility (hidden for admins) all refresh.
          await AdminConsole.loadUsers();
        } catch (err) {
          sel.value = orig;
          AdminConsole._alert(`Role change failed: ${err.message}`);
        } finally {
          sel.disabled = false;
        }
      });
    });

    list.querySelectorAll('.admin-quota-input').forEach((inp) => {
      const commit = async () => {
        const next = inp.value.trim();
        const orig = inp.dataset.original || '';
        if (next === orig) return;
        const userId = inp.dataset.userId;
        const n = Number(next);
        if (next === '' || !Number.isInteger(n) || n < 0) {
          AdminConsole._alert('Quota must be a non-negative whole number.');
          inp.value = orig;
          return;
        }
        inp.disabled = true;
        try {
          const res = await fetch(`/api/admin/users/${userId}/app-quota`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quota: n }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            AdminConsole._alert(data.error || `Save failed (HTTP ${res.status})`);
            inp.value = orig;
          } else {
            const data = await res.json();
            const v = String(data.app_quota);
            inp.value = v;
            inp.dataset.original = v;
          }
        } catch (err) {
          AdminConsole._alert(`Save failed: ${err.message}`);
          inp.value = orig;
        } finally {
          inp.disabled = false;
        }
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      });
    });

    list.querySelectorAll('.admin-delete-user-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        AdminConsole._closeUserMenus();
        const ok = await AdminConsole._confirm({
          title: 'Delete user?',
          message: 'This will remove all their data.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        const res = await fetch(`/api/admin/users/${btn.dataset.deleteId}`, { method: 'DELETE' });
        if (res.ok) AdminConsole.loadUsers();
      });
    });

    list.querySelectorAll('.admin-reset-pw-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        AdminConsole._closeUserMenus();
        const username = btn.dataset.username;
        const ok = await AdminConsole._confirm({
          title: `Reset ${username}'s password?`,
          message: 'This signs them out everywhere and issues a one-time temporary password.',
          confirmLabel: 'Reset',
        });
        if (!ok) return;
        btn.disabled = true;
        try {
          const res = await fetch(`/api/admin/users/${btn.dataset.resetId}/reset-password`, { method: 'POST' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            AdminConsole._alert(data.error || `Reset failed (HTTP ${res.status})`);
            return;
          }
          AdminConsole._showTempPasswordModal(data.username || username, data.tempPassword);
        } catch (err) {
          AdminConsole._alert(`Reset failed: ${err.message}`);
        } finally {
          btn.disabled = false;
        }
      });
    });

    // Kebab overflow menus: one open at a time; the document-level
    // outside-click/Escape close handler binds once for the module's
    // lifetime (rows re-render on every reload).
    list.querySelectorAll('.admin-kebab-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = btn.parentElement.querySelector('.admin-kebab-menu');
        const isOpen = !menu.classList.contains('hidden');
        AdminConsole._closeUserMenus();
        if (!isOpen) {
          menu.classList.remove('hidden');
          btn.setAttribute('aria-expanded', 'true');
        }
      });
    });
    if (!AdminConsole._menusWired) {
      AdminConsole._menusWired = true;
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.admin-user-actions')) AdminConsole._closeUserMenus();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') AdminConsole._closeUserMenus();
      });
    }
  },

  _closeUserMenus() {
    document.querySelectorAll('.admin-kebab-menu').forEach((m) => m.classList.add('hidden'));
    document.querySelectorAll('.admin-kebab-btn').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  },

  // Temporary-password modal — shows the one-time plaintext exactly once.
  _showTempPasswordModal(username, tempPassword) {
    const modal = document.getElementById('admin-temp-pw-modal');
    if (!modal) return;
    document.getElementById('admin-temp-pw-username').textContent = username;
    const valueEl = document.getElementById('admin-temp-pw-value');
    valueEl.textContent = tempPassword;
    const copyBtn = document.getElementById('admin-temp-pw-copy');
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(tempPassword);
        copyBtn.textContent = 'Copied';
      } catch {
        // Clipboard API can be blocked (insecure context); select instead.
        const range = document.createRange();
        range.selectNodeContents(valueEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        copyBtn.textContent = 'Select & copy';
      }
    };
    document.getElementById('admin-temp-pw-close').onclick = () => {
      modal.classList.add('hidden');
      valueEl.textContent = '';
    };
    modal.classList.remove('hidden');
  },

  // ── Submitted features (cross-app, ported from admin-features.js) ──────

  // The endpoint caps limit at 200; also the CSV paging page size.
  FEATURES_PAGE: 200,
  FEATURES_CSV_FIELDS: [
    'id', 'app_id', 'app_slug', 'app_name', 'title', 'description',
    'kind', 'status', 'github_issue_number', 'created_at',
    'created_by', 'created_by_username', 'up_count', 'down_count',
  ],
  FEATURES_STATUS_BADGE: {
    open:      { label: 'Open',    cls: 'bg-green-500/20 text-green-600 dark:text-green-300' },
    closed:    { label: 'Closed',  cls: 'bg-gray-500/20 text-gray-600 dark:text-gray-300' },
    completed: { label: 'Shipped', cls: 'bg-indigo-500/20 text-indigo-600 dark:text-indigo-300' },
  },

  renderFeaturesSection(host) {
    host.innerHTML = `
      <div class="${AdminUI.card} p-4">
        <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 class="${AdminUI.cardTitle}">Submitted features</h2>
          <div class="flex items-center gap-2">
            <select id="admin-features-status" class="rounded bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs">
              <option value="all" selected>All</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="completed">Shipped</option>
            </select>
            <button id="admin-features-refresh" class="${AdminUI.btn.link} text-xs px-1 py-1">Refresh</button>
            <button id="admin-features-csv" class="${AdminUI.btn.primarySm}">Download CSV</button>
          </div>
        </div>
        <p id="admin-features-summary" class="text-xs text-gray-500 mb-3"></p>
        <div id="admin-features-list" class="space-y-3"></div>
        <p id="admin-features-empty" class="text-sm text-gray-500 hidden"></p>
      </div>`;
    document.getElementById('admin-features-status')
      .addEventListener('change', () => AdminConsole.loadFeatures());
    document.getElementById('admin-features-refresh')
      .addEventListener('click', () => AdminConsole.loadFeatures());
    document.getElementById('admin-features-csv')
      .addEventListener('click', () => AdminConsole.downloadFeaturesCsv());
    AdminConsole.loadFeatures();
  },

  _featuresStatus() {
    // Default 'all' so an admin lands on the full cross-app list — shipped
    // features carry status='completed', invisible under open/closed (#565).
    return document.getElementById('admin-features-status')?.value || 'all';
  },

  _fmtTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  },

  _featureCard(f, rank) {
    const esc = AdminConsole.esc;
    const b = AdminConsole.FEATURES_STATUS_BADGE[f.status]
      || { label: f.status || '—', cls: 'bg-gray-500/20 text-gray-600 dark:text-gray-300' };
    const el = document.createElement('div');
    el.className = 'border border-gray-200 dark:border-gray-800 rounded-lg bg-gray-100 dark:bg-gray-800/60 p-4';
    const gh = f.github_issue_number
      ? `<span class="text-xs text-gray-500">GitHub #${esc(f.github_issue_number)}</span>` : '';
    const submitter = f.created_by_username ? esc(f.created_by_username) : '—';
    el.innerHTML = `
      <div class="flex items-start gap-3">
        <div class="text-gray-400 font-mono text-sm pt-0.5 w-8 shrink-0">#${rank}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-semibold">${esc(f.title)}</span>
            <span class="text-[11px] font-semibold px-2 py-0.5 rounded ${b.cls}">${esc(b.label)}</span>
          </div>
          ${f.description ? `<div class="text-sm text-gray-500 mt-1 whitespace-pre-wrap break-words">${esc(f.description)}</div>` : ''}
          <div class="text-xs text-gray-500 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="text-indigo-500 dark:text-indigo-400">${esc(f.app_name)}</span>
            <span class="text-gray-500">${esc(f.app_slug)}</span>
            <span>by ${submitter}</span>
            <span>${esc(AdminConsole._fmtTime(f.created_at))}</span>
            ${gh}
          </div>
        </div>
        <div class="text-right text-sm shrink-0">
          <div class="text-green-500 dark:text-green-400 font-semibold">▲ ${esc(f.up_count)}</div>
          <div class="text-gray-400">▼ ${esc(f.down_count)}</div>
        </div>
      </div>`;
    return el;
  },

  async loadFeatures() {
    const status = AdminConsole._featuresStatus();
    const container = document.getElementById('admin-features-list');
    const empty = document.getElementById('admin-features-empty');
    const summary = document.getElementById('admin-features-summary');
    if (!container) return;
    container.innerHTML = '';
    empty.classList.add('hidden');
    summary.textContent = 'Loading…';

    const { status: httpStatus, data } = await AdminConsole.fetchJson(
      `/api/admin/submitted-features?status=${encodeURIComponent(status)}&limit=${AdminConsole.FEATURES_PAGE}&offset=0`);
    if (AdminConsole._section !== 'features') return;
    if (httpStatus === 403) {
      summary.textContent = 'Admin access required.';
      return;
    }
    if (!data || typeof data !== 'object') {
      summary.textContent = 'Couldn’t load submitted features — try Refresh.';
      return;
    }

    const features = data.features || [];
    const total = typeof data.total === 'number' ? data.total : features.length;
    if (!features.length) {
      summary.textContent = '';
      empty.textContent = status === 'all'
        ? 'No submitted features yet.'
        : 'No submitted features match this filter — try the “All” status.';
      empty.classList.remove('hidden');
      return;
    }
    features.forEach((f, i) => container.appendChild(AdminConsole._featureCard(f, i + 1)));
    summary.textContent = total > features.length
      ? `Showing the top ${features.length} of ${total} — use Download CSV for the full list.`
      : `${total} feature${total === 1 ? '' : 's'}.`;
  },

  _csvCell(v) {
    return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  },

  async downloadFeaturesCsv() {
    const btn = document.getElementById('admin-features-csv');
    const status = AdminConsole._featuresStatus();
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    try {
      // Pull the ENTIRE filtered set (looping the offset param), not just
      // the visible page. Hard iteration cap guards a non-advancing page.
      const all = [];
      let offset = 0;
      let total = Infinity;
      for (let guard = 0; guard < 10000 && all.length < total; guard++) {
        const { ok, data } = await AdminConsole.fetchJson(
          `/api/admin/submitted-features?status=${encodeURIComponent(status)}&limit=${AdminConsole.FEATURES_PAGE}&offset=${offset}`);
        if (!ok || !data) throw new Error('export failed');
        const batch = data.features || [];
        if (typeof data.total === 'number') total = data.total;
        if (!batch.length) break;
        all.push(...batch);
        offset += AdminConsole.FEATURES_PAGE;
        if (batch.length < AdminConsole.FEATURES_PAGE) break;
      }
      const lines = [AdminConsole.FEATURES_CSV_FIELDS.map(AdminConsole._csvCell).join(',')];
      for (const r of all) {
        lines.push(AdminConsole.FEATURES_CSV_FIELDS.map((k) => AdminConsole._csvCell(r[k])).join(','));
      }
      const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `submitted-features-${status}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      const summary = document.getElementById('admin-features-summary');
      if (summary) summary.textContent = 'CSV export failed — try again.';
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  },

  // ── Database export ────────────────────────────────────────────────────
  //
  // Downloads an unredacted pg_dump of durable platform data as a
  // gzip-compressed plain-SQL file (`.sql.gz`, restored with gunzip + psql).
  // The file is a live credential bundle — every password hash, every valid
  // session token, every app credential — so this section is deliberately sober:
  // a permanent red warning panel, a typed confirmation plus password
  // re-entry on every run, and an append-only history nobody can clear.
  //
  // WHY THE BUTTON'S ENABLED STATE COMES FROM THE SERVER: availability is
  // decided by GET /api/admin/db-export/status, which returns a `reason`
  // code this module maps to copy. The client contains no environment
  // check of its own — the server owns that decision (and enforces it on
  // both the ticket and the stream route), which is also what keeps this
  // file identical across environments as tests/admin-console-page.test.js
  // requires.
  //
  // The download itself is a two-step ticket, not a fetch: POST the
  // confirmation, then NAVIGATE to the returned single-use URL. A Blob
  // (the pattern downloadFeaturesCsv uses above) would hold a
  // multi-hundred-megabyte dump in page memory; navigating gives a real
  // streamed download with the browser's own progress UI — and lets the
  // browser save the gzip bytes verbatim instead of trying to decode them.

  DB_EXPORT_REASONS: {
    staging: 'Database export is disabled in staging previews.',
    unavailable: 'Database export is unavailable on this deployment.',
    in_progress: 'An export is already in progress — try again shortly.',
    rate_limited: 'Daily export limit reached — try again later.',
  },

  DB_EXPORT_STATUS_BADGE: {
    completed:   { label: 'Completed',   cls: 'bg-green-500/20 text-green-600 dark:text-green-400' },
    streaming:   { label: 'Streaming',   cls: 'bg-indigo-500/20 text-indigo-600 dark:text-indigo-400' },
    requested:   { label: 'Requested',   cls: 'bg-indigo-500/20 text-indigo-600 dark:text-indigo-400' },
    failed:      { label: 'Failed',      cls: 'bg-red-500/20 text-red-600 dark:text-red-400' },
    cancelled:   { label: 'Cancelled',   cls: 'bg-amber-500/20 text-amber-700 dark:text-amber-400' },
    interrupted: { label: 'Interrupted', cls: 'bg-amber-500/20 text-amber-700 dark:text-amber-400' },
    denied:      { label: 'Denied',      cls: 'bg-red-500/20 text-red-600 dark:text-red-400' },
  },

  _fmtBytes(n) {
    const b = Number(n);
    if (!Number.isFinite(b) || b <= 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = b;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  },

  _fmtDuration(startIso, endIso) {
    if (!startIso || !endIso) return '—';
    const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return `${ms} ms`;
    const s = ms / 1000;
    if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
    return `${Math.round(s / 60)} min`;
  },

  renderDbExportSection(host) {
    const canWrite = AdminConsole.canWrite();
    host.innerHTML = `
      <div id="admin-db-export-panel" class="space-y-4">
        <div class="rounded-lg border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-4">
          <h2 class="text-lg font-semibold text-red-700 dark:text-red-300">Database export — handle as a credential</h2>
          <p class="text-sm text-red-800 dark:text-red-200 mt-2">
            This downloads an unredacted copy of durable platform data. Ephemeral mobile push registrations and delivery rows are excluded.
            Anyone holding the file can take over accounts and reach every app's data.
            It contains:
          </p>
          <ul class="text-sm text-red-800 dark:text-red-200 mt-2 list-disc pl-5 space-y-1">
            <li>every user's password hash and every currently-valid login session token</li>
            <li>every activation code, used and unused</li>
            <li>every app's database password, LLM proxy token and file-storage token</li>
            <li>the encrypted blobs for users' own Anthropic API keys and every app's stored secrets</li>
            <li>every chat message, spec, dev-session transcript, uploaded attachment and screenshot</li>
            <li>all analytics, votes, kudos, bounties and moderation history</li>
          </ul>
          <p class="text-sm text-red-800 dark:text-red-200 mt-3">
            It does <span class="font-semibold">not</span> contain the individual apps' own databases,
            uploaded app-file bytes (those live in object storage), the chain node's data,
            or the platform's environment file — which matters, because the key that
            decrypts the API-key and app-secret blobs lives only there.
          </p>
        </div>

        <div class="${AdminUI.card} p-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <p id="admin-db-export-target" class="text-sm text-gray-500">Loading…</p>
            <button id="admin-db-export-refresh" class="${AdminUI.btn.link} text-xs px-1 py-1">Refresh</button>
          </div>
          <div class="mt-3">
            ${canWrite
              ? `<button id="admin-db-export-btn" disabled
                   class="rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:hover:bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors">
                   Export database</button>`
              : `<span class="inline-block rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-500">
                   Exporting the database requires full admin.</span>`}
            <p id="admin-db-export-reason" class="text-xs text-gray-500 mt-2"></p>
          </div>

          <!-- Inline confirm panel. Both fields are required on every export;
               there is no remember-me and no session-scoped bypass. -->
          <div id="admin-db-export-confirm" class="hidden mt-4 rounded-lg border border-red-300 dark:border-red-900 bg-white dark:bg-gray-950 p-4">
            <p class="text-sm font-semibold text-gray-900 dark:text-gray-100">Confirm the export</p>
            <p class="text-xs text-gray-500 mt-1">
              Type <code class="font-mono text-red-600 dark:text-red-400">EXPORT</code> and re-enter your own account password.
            </p>
            <div class="mt-3 space-y-2">
              <input id="admin-db-export-phrase" type="text" autocomplete="off" spellcheck="false"
                placeholder="EXPORT"
                class="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm font-mono">
              <input id="admin-db-export-password" type="password" autocomplete="current-password"
                placeholder="Your password"
                class="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm">
            </div>
            <p id="admin-db-export-error" class="hidden text-xs text-red-600 dark:text-red-400 mt-2"></p>
            <div class="flex items-center gap-2 mt-3">
              <button id="admin-db-export-go"
                class="rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-50 px-4 py-2 text-sm font-medium text-white transition-colors">
                Download the .sql.gz</button>
              <button id="admin-db-export-cancel"
                class="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                Cancel</button>
            </div>
          </div>

          <p class="text-xs text-gray-500 mt-4">
            The file is a gzip-compressed plain-SQL dump (<code class="font-mono">.sql.gz</code>),
            taken with <code class="font-mono">--no-owner --no-privileges</code>. Restore it with:<br>
            <code class="font-mono text-gray-600 dark:text-gray-300 break-all">gunzip -c &lt;file&gt;.sql.gz | psql -v ON_ERROR_STOP=1 -d &lt;target-db&gt;</code><br>
            Read it without unpacking with <code class="font-mono">zless</code> / <code class="font-mono">zgrep</code>.
          </p>
        </div>

        <details id="admin-db-export-guidance" class="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4">
          <summary class="text-sm font-semibold text-amber-800 dark:text-amber-200 cursor-pointer">After you download it — and what to do if it leaks</summary>
          <ul class="text-sm text-amber-800 dark:text-amber-200 mt-3 list-disc pl-5 space-y-1">
            <li>Treat the file as a live credential: keep it encrypted, never on shared storage, and delete it when you're done.</li>
            <li>It is unencrypted in your Downloads folder — gzip is compression, not protection; cloud backup may sync it and anyone can read it with <code class="font-mono">zless</code>.</li>
            <li>If it may have been exposed, deletion is not enough — rotate:</li>
            <li class="list-none pl-4">— the platform JWT secret (invalidates every session; stored API keys and app secrets must be re-entered afterwards)</li>
            <li class="list-none pl-4">— the platform database password</li>
            <li class="list-none pl-4">— every per-app database password, LLM proxy token and storage token</li>
            <li class="list-none pl-4">— invalidate all activation codes, and force a password reset for all users</li>
            <li>Everything in the file stays valid until those rotations happen.</li>
          </ul>
        </details>

        <div class="${AdminUI.card} p-4">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-1">
            <h3 class="text-base font-semibold">Export history</h3>
            <span class="text-xs text-gray-500">Append-only — cannot be cleared</span>
          </div>
          <p class="text-xs text-gray-500 mb-3">Every attempt, including refused ones, is recorded here permanently.</p>
          <div id="admin-db-export-history" class="space-y-2"></div>
          <p id="admin-db-export-history-empty" class="text-sm text-gray-500 hidden">No exports recorded yet.</p>
        </div>
      </div>`;

    document.getElementById('admin-db-export-refresh')
      .addEventListener('click', () => {
        AdminConsole.loadDbExportStatus();
        AdminConsole.loadDbExportHistory();
      });

    const btn = document.getElementById('admin-db-export-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        document.getElementById('admin-db-export-confirm').classList.remove('hidden');
        btn.disabled = true;
        const phrase = document.getElementById('admin-db-export-phrase');
        if (phrase) phrase.focus();
      });
      document.getElementById('admin-db-export-cancel')
        .addEventListener('click', () => AdminConsole._resetDbExportConfirm());
      document.getElementById('admin-db-export-go')
        .addEventListener('click', () => AdminConsole.startDbExport());
    }

    AdminConsole.loadDbExportStatus();
    AdminConsole.loadDbExportHistory();
  },

  _resetDbExportConfirm() {
    const panel = document.getElementById('admin-db-export-confirm');
    if (panel) panel.classList.add('hidden');
    const phrase = document.getElementById('admin-db-export-phrase');
    const pw = document.getElementById('admin-db-export-password');
    if (phrase) phrase.value = '';
    if (pw) pw.value = '';
    const err = document.getElementById('admin-db-export-error');
    if (err) err.classList.add('hidden');
    AdminConsole.loadDbExportStatus();
  },

  _dbExportError(message) {
    const err = document.getElementById('admin-db-export-error');
    if (!err) return;
    err.textContent = message;
    err.classList.remove('hidden');
  },

  async loadDbExportStatus() {
    const target = document.getElementById('admin-db-export-target');
    const reasonEl = document.getElementById('admin-db-export-reason');
    const btn = document.getElementById('admin-db-export-btn');
    if (!target) return;

    const { status: httpStatus, data } = await AdminConsole.fetchJson('/api/admin/db-export/status');
    if (AdminConsole._section !== 'db-export') return;
    if (httpStatus === 403) { target.textContent = 'Admin access required.'; return; }
    if (!data || typeof data !== 'object') {
      target.textContent = 'Couldn’t read the export status — try Refresh.';
      return;
    }

    const esc = AdminConsole.esc;
    target.innerHTML = `Target database <code class="font-mono text-gray-700 dark:text-gray-200">${esc(data.dbName || 'unknown')}</code>`
      + ` · current size <span class="font-medium">${esc(AdminConsole._fmtBytes(data.dbSizeBytes))}</span>`
      + ` <span class="text-gray-500">(the .sql.gz download is smaller)</span>`
      + ` · <span class="text-gray-500">${esc(data.remainingToday)} of ${esc(data.maxPerDay)} exports left today</span>`;

    if (btn) {
      btn.disabled = !data.available;
      // Don't re-enable the button out from under an open confirm panel.
      const confirming = !document.getElementById('admin-db-export-confirm')?.classList.contains('hidden');
      if (confirming) btn.disabled = true;
    }
    if (reasonEl) {
      reasonEl.textContent = data.available
        ? ''
        : (AdminConsole.DB_EXPORT_REASONS[data.reason] || 'Database export is currently unavailable.');
    }
  },

  async startDbExport() {
    const go = document.getElementById('admin-db-export-go');
    const phrase = document.getElementById('admin-db-export-phrase');
    const pw = document.getElementById('admin-db-export-password');
    if (!go || !phrase || !pw) return;
    const err = document.getElementById('admin-db-export-error');
    if (err) err.classList.add('hidden');

    if (phrase.value.trim() !== 'EXPORT') {
      AdminConsole._dbExportError('Type EXPORT exactly to confirm.');
      return;
    }
    if (!pw.value) {
      AdminConsole._dbExportError('Your password is required.');
      return;
    }

    const original = go.textContent;
    go.disabled = true;
    go.textContent = 'Exporting…';
    try {
      const res = await fetch('/api/admin/db-export/ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'EXPORT', password: pw.value }),
      });
      let data = null;
      try { data = await res.json(); } catch { /* non-JSON error page */ }
      if (!res.ok || !data || !data.url) {
        AdminConsole._dbExportError((data && data.error) || 'Export could not be started.');
        go.disabled = false;
        go.textContent = original;
        AdminConsole.loadDbExportHistory();
        return;
      }
      pw.value = '';
      // Navigate — do NOT fetch. The response is a streamed attachment and
      // must go straight to the browser's download machinery.
      window.location.href = data.url;
      AdminConsole._resetDbExportConfirm();
      const guidance = document.getElementById('admin-db-export-guidance');
      if (guidance) guidance.open = true;
      // The navigation doesn't repaint the page, so poll the history a
      // couple of times to pick up the row as it moves to its final state.
      setTimeout(() => AdminConsole.loadDbExportHistory(), 3000);
      setTimeout(() => AdminConsole.loadDbExportHistory(), 12000);
    } catch {
      AdminConsole._dbExportError('Network error — the export was not started.');
      go.disabled = false;
      go.textContent = original;
    }
  },

  _dbExportRow(r) {
    const esc = AdminConsole.esc;
    const b = AdminConsole.DB_EXPORT_STATUS_BADGE[r.status]
      || { label: r.status || '—', cls: 'bg-gray-500/20 text-gray-600 dark:text-gray-300' };
    const el = document.createElement('div');
    el.className = 'border border-gray-200 dark:border-gray-800 rounded-lg bg-gray-100 dark:bg-gray-800/60 p-3';
    const denied = r.denied_reason
      ? `<span class="text-gray-500">reason: ${esc(String(r.denied_reason).replace(/_/g, ' '))}</span>` : '';
    const errLine = r.error
      ? `<div class="text-xs text-red-600 dark:text-red-400 mt-1 break-words">${esc(r.error)}</div>` : '';
    el.innerHTML = `
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-medium">${esc(r.username)}</span>
            <span class="text-[11px] font-semibold px-2 py-0.5 rounded ${b.cls}">${esc(b.label)}</span>
          </div>
          <div class="text-xs text-gray-500 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>${esc(AdminConsole._fmtTime(r.requested_at))}</span>
            <span class="font-mono">${esc(r.db_name)}</span>
            <span title="compressed size downloaded">${esc(AdminConsole._fmtBytes(r.bytes_sent))}</span>
            <span>${esc(AdminConsole._fmtDuration(r.started_at, r.finished_at))}</span>
            <span>from ${esc(r.ip || '—')}</span>
            ${denied}
          </div>
          ${errLine}
        </div>
      </div>`;
    return el;
  },

  async loadDbExportHistory() {
    const container = document.getElementById('admin-db-export-history');
    const empty = document.getElementById('admin-db-export-history-empty');
    if (!container) return;
    const { status: httpStatus, data } = await AdminConsole.fetchJson(
      '/api/admin/db-export/history?limit=25&offset=0');
    if (AdminConsole._section !== 'db-export') return;
    if (httpStatus === 403 || !data || typeof data !== 'object') return;
    container.innerHTML = '';
    const rows = data.exports || [];
    if (!rows.length) {
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');
    rows.forEach((r) => container.appendChild(AdminConsole._dbExportRow(r)));
  },
};

// app.js reaches for window.AdminConsole (route / open / syncChrome / the
// rollover + stale-preview WS handlers), and _renderSection dispatches the
// section modules through window[modName], so the global publication stays.
// Guarded: the prerender pass evaluates this module in Node.
if (typeof window !== 'undefined') window.AdminConsole = AdminConsole;
