// herdr backend for the review-window plumbing: the same surface `tmux.mjs`
// implements, spoken to herdr's CLI (https://herdr.dev) instead of tmux's.
// `mux.mjs` picks between the two at startup; nothing else in the codebase
// should import this module directly.
//
// Vocabulary. orbit-diff says "window" for the unit that holds one worktree's
// four review panes. In tmux that's a window; in herdr it's a **tab** (herdr's
// "workspace" is the tmux session). So every `window` id handed out here is a
// herdr tab id, and `killWindow`/`focusWindow` are `tab close`/`tab focus`.
//
// Tagging. tmux let us set `@orbit_wt` once on the *window* and read it back
// from any pane, because pane formats resolve up the option chain. herdr's
// metadata lives on panes and workspaces — there's no tab-level store — so we
// stamp all four panes individually. Two tokens go on each:
//
//   orbit_wt     the worktree's absolute path
//   orbit_wtkey  a 16-hex-char hash of that path (see session.mjs)
//   orbit_role   status | setup | claude | diff
//
// The hash is belt-and-braces: herdr documents a 1-32 ASCII charset limit on
// token *names* and says nothing about values, but if long paths with slashes
// turn out to be rejected or truncated, `orbit_wtkey` still identifies the
// worktree and we resolve it back through the session registry. Review windows
// keep working either way; the only thing lost in that case is dedup for plain
// worktree tabs, which have no session record to resolve against.
//
// Everything fails soft, exactly as the tmux backend does: an unreachable or
// unparseable herdr answers as "nothing there" rather than throwing, so a dead
// server degrades the worktrees rail instead of taking down the TUI.

import { spawnSync } from "node:child_process";
import { sessionKey, listSessions } from "./session.mjs";

// Overridable so a non-PATH install (or a test) can point somewhere else.
const BIN = () => process.env.ORBIT_HERDR_BIN || "herdr";

// herdr namespaces reported metadata by source, so ours is stamped as ours.
const SOURCE = "orbit-diff";

const TOK_WT = "orbit_wt";
const TOK_WTKEY = "orbit_wtkey";
const TOK_ROLE = "orbit_role";

// herdr's semantic agent states → the three orbit-diff renders in the rail.
// `done` and `idle` both mean the turn is over and it's your move; `unknown`
// is deliberately absent so callers fall through to screen-scraping.
const AGENT_STATE = {
  working: "busy",
  blocked: "blocked",
  idle: "awaiting",
  done: "awaiting",
};

function defaultRun(args) {
  const res = spawnSync(BIN(), args, { encoding: "utf8" });
  return {
    status: res.error ? 1 : (res.status ?? 1),
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

// herdr speaks newline-delimited JSON over its socket and the CLI is a thin
// wrapper over it, but the CLI's exact envelope isn't pinned down in the docs.
// Accept the three shapes it could plausibly print — one JSON value, NDJSON, or
// a bare id — rather than guessing one and breaking on the others.
function parseJson(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    /* not a single value — try NDJSON below */
  }
  const rows = [];
  for (const line of t.split("\n")) {
    const s = line.trim();
    if (!s || (s[0] !== "{" && s[0] !== "[")) continue;
    try {
      rows.push(JSON.parse(s));
    } catch {
      /* skip a partial line */
    }
  }
  if (!rows.length) return null;
  return rows.length === 1 ? rows[0] : rows;
}

// Dig an array out of whatever wrapper came back: a bare array, `{panes:[…]}`,
// or either of those under a `result`/`data` envelope.
function pickArray(value, key) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value[key])) return value[key];
  for (const envelope of ["result", "data"]) {
    if (value[envelope]) {
      const inner = pickArray(value[envelope], key);
      if (inner.length) return inner;
    }
  }
  // A single row printed on its own — what NDJSON collapses to when there's
  // exactly one. An empty `{panes: []}` still returns [], because it carries the
  // key; only an object that looks like an item itself gets wrapped.
  if (!(key in value) && !("result" in value) && !("data" in value)) return [value];
  return [];
}

// First present value among `names`, searched through the same envelopes.
function pickField(value, names) {
  if (!value || typeof value !== "object") return null;
  for (const name of names) {
    const v = value[name];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  for (const envelope of ["result", "data", "pane", "tab", "workspace"]) {
    if (value[envelope]) {
      const inner = pickField(value[envelope], names);
      if (inner) return inner;
    }
  }
  return null;
}

// An id printed by a create/split call, read out of structured output.
//
// `bare` allows the fallback for a command that printed nothing but a single
// id, the way tmux's `-P -F` does. Only pass it when the id you're asking for is
// the command's *primary* subject — `tab create` printing a lone `t9` means the
// tab, so asking that same output for a pane id must come back empty rather
// than handing back the tab id.
function idFrom(stdout, names, { bare = false } = {}) {
  const parsed = parseJson(stdout);
  const found = parsed && pickField(parsed, names);
  if (found) return found;
  if (!bare) return null;
  const only = String(stdout || "").trim();
  if (only && !/\s/.test(only) && only.length <= 64) return only;
  return null;
}

// Reported tokens on a PaneInfo. The docs confirm tokens come back on
// `pane.list`/`pane.get` but don't name the field, so check the plausible
// spots. Values may be bare strings or `{ value, expires_at }` records.
function tokensOf(pane) {
  const bag =
    (pane && pane.tokens) ||
    (pane && pane.metadata && pane.metadata.tokens) ||
    (pane && pane.metadata) ||
    null;
  if (!bag || typeof bag !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(bag)) {
    if (typeof v === "string") out[k] = v;
    else if (v && typeof v === "object" && typeof v.value === "string") out[k] = v.value;
  }
  return out;
}

// hash → worktree path, over every worktree orbit-diff has a session for. Only
// consulted when `orbit_wt` didn't survive the round trip.
function sessionPathsByKey() {
  const map = new Map();
  for (const s of listSessions()) {
    if (s && s.worktreePath) map.set(s.key || sessionKey(s.worktreePath), s.worktreePath);
  }
  return map;
}

export function createHerdrBackend({ run = defaultRun, env = process.env, resolveKey = null } = {}) {
  const ok = (args) => run(args).status === 0;

  const inMux = () => !!env.HERDR_PANE_ID;

  // Every pane herdr knows about that orbit-diff has tagged, in ONE call —
  // the same contract `listTaggedPanes` has in the tmux backend:
  //   { pane, role, worktreePath, command, activity, window, agentStatus }
  //
  // `activity` is herdr's per-pane `revision` counter, which serves the same
  // purpose as tmux's `window_activity` timestamp: it changes when the pane
  // does, so an unchanged pane can be answered from cache without re-reading
  // its screen. It's a better signal than the tmux one — a counter on the pane
  // itself rather than a timestamp on its window.
  //
  // `command` has no direct herdr equivalent (PaneInfo carries no foreground
  // process name), so it reports "agent" whenever herdr has a live agent
  // session for the pane and "" when it doesn't. agent-state.mjs reads it only
  // to tell a running REPL from a pane that fell back to a bare shell, and an
  // absent agent session answers that question the same way.
  const listTaggedPanes = () => {
    const res = run(["pane", "list"]);
    if (res.status !== 0) return [];
    const panes = pickArray(parseJson(res.stdout), "panes");
    if (!panes.length) return [];

    let byKey = null; // built lazily — only if some pane lost its path token
    const out = [];
    for (const p of panes) {
      const tokens = tokensOf(p);
      const role = tokens[TOK_ROLE];
      if (!role) continue;

      let worktreePath = tokens[TOK_WT] || "";
      if (!worktreePath && tokens[TOK_WTKEY]) {
        if (resolveKey) worktreePath = resolveKey(tokens[TOK_WTKEY]) || "";
        else {
          if (!byKey) byKey = sessionPathsByKey();
          worktreePath = byKey.get(tokens[TOK_WTKEY]) || "";
        }
      }
      if (!worktreePath) continue;

      const pane = pickField(p, ["pane_id", "id"]);
      if (!pane) continue;
      const agentStatus = pickField(p, ["agent_status"]) || "";
      out.push({
        pane,
        role,
        worktreePath,
        command: p.agent_session ? "agent" : "",
        activity: pickField(p, ["revision"]) || "",
        window: pickField(p, ["tab_id"]) || "",
        agentStatus,
      });
    }
    return out;
  };

  // The tab id holding this worktree's panes, or null. Scans every workspace,
  // matching tmux's `list-windows -a`.
  const findWindowByWorktree = (path) => {
    for (const p of listTaggedPanes()) {
      if (p.worktreePath === path && p.window) return p.window;
    }
    return null;
  };

  const focusWindow = (id) => ok(["tab", "focus", id]);
  const killWindow = (id) => ok(["tab", "close", id]);

  // `pane run` hands the command to herdr rather than typing it, so unlike
  // tmux's send-keys there's no race with a shell that hasn't drawn its prompt.
  const runInPane = (pane, cmd) => ok(["pane", "run", pane, cmd]);

  // A line of input into whatever's already running in the pane. Text and the
  // Enter key are separate calls in herdr — `send-text` deliberately doesn't
  // interpret its argument, so the newline has to come through `send-keys`.
  //
  // (herdr also has `agent prompt`, which is purpose-built for handing a prompt
  // to a detected agent. It's the better call for the Claude pane specifically,
  // but it needs herdr to have recognized the agent; this path works on any
  // pane and mirrors what the tmux backend does.)
  const sendLine = (pane, text) => {
    if (!ok(["pane", "send-text", pane, text])) return false;
    return ok(["pane", "send-keys", pane, "enter"]);
  };

  // The pane's visible screen, or null if it's gone. `--source visible` is the
  // current viewport — the equivalent of `capture-pane -p`, and likewise the
  // right source for a full-screen TUI, where scrollback holds nothing useful.
  const capturePane = (pane) => {
    const res = run(["pane", "read", pane, "--source", "visible", "--format", "text"]);
    if (res.status !== 0) return null;
    return res.stdout || "";
  };

  const paneAlive = (pane) => ok(["pane", "get", pane]);

  // Stamp a pane so later scans can find it. Tokens are written without a TTL
  // so they live as long as the pane does.
  const tag = (pane, role, worktreePath) =>
    ok([
      "pane", "report-metadata", pane,
      "--source", SOURCE,
      "--token", `${TOK_ROLE}=${role}`,
      "--token", `${TOK_WT}=${worktreePath}`,
      "--token", `${TOK_WTKEY}=${sessionKey(worktreePath)}`,
    ]);

  // A bare single-pane tab rooted at `path` — no review panes, nothing run in
  // it. Focused on creation, matching tmux's `new-window` (which selects it),
  // and tagged so a later open re-focuses rather than duplicating.
  const openPlainWindow = (path, name) => {
    const created = run(["tab", "create", "--cwd", path, "--label", name || "worktree", "--focus"]);
    if (created.status !== 0) {
      return { ok: false, error: (created.stderr || "").trim() || "herdr tab create failed" };
    }
    const tab = idFrom(created.stdout, ["tab_id", "id"], { bare: true });
    const pane = idFrom(created.stdout, ["pane_id"]) || firstPaneOfTab(tab);
    if (pane) tag(pane, "plain", path);
    return { ok: true };
  };

  // The pane herdr put in a freshly created tab, when `tab create` reported the
  // tab but not its pane.
  function firstPaneOfTab(tabId) {
    if (!tabId) return null;
    const res = run(["pane", "list"]);
    if (res.status !== 0) return null;
    for (const p of pickArray(parseJson(res.stdout), "panes")) {
      if (pickField(p, ["tab_id"]) === tabId) return pickField(p, ["pane_id", "id"]);
    }
    return null;
  }

  // Build the four-pane review tab for a worktree, laid out as the tmux backend
  // does:
  //
  //   ┌ status ┬─────────── claude ────────────┐
  //   ├────────┤                                │
  //   │ setup  │                                │
  //   ├────────────────── orbit-diff ───────────┤
  //   └────────────────────────────────────────-┘
  //
  // Two things differ from tmux, both forced by herdr's split API:
  //
  //   * herdr splits only `right` and `down`, never `-b`. tmux built this by
  //     splitting *above* the original pane, so the original became the diff
  //     pane at the bottom; here the original stays on top and the diff pane is
  //     the one we create. Same geometry, opposite construction order.
  //   * herdr sizes splits by ratio only — there's no `-l 8` for an absolute
  //     row count. tmux pinned the status pane at 8 lines (exactly what
  //     pr-status.mjs prints); the closest herdr can do is a fraction of the
  //     top row, so on a short terminal that pane can clip where tmux's didn't.
  //
  // Created with `--no-focus` so it never steals the current view. The diff
  // pane's split is the one that carries `--focus`, which sets the *tab's*
  // active pane without pulling the tab forward — so focusing this tab later
  // lands on the review surface, as `select-pane` did under tmux.
  const buildReviewWindow = ({ worktreePath, name, statusCmd, setupCmd, claudeCmd, diffCmd }) => {
    if (!inMux()) return { error: "not inside herdr — start herdr to open a review window" };

    const created = run([
      "tab", "create", "--cwd", worktreePath, "--label", name || "review", "--no-focus",
    ]);
    if (created.status !== 0) {
      return { error: (created.stderr || "herdr tab create failed").trim() };
    }
    const window = idFrom(created.stdout, ["tab_id", "id"], { bare: true });
    const statusPane = idFrom(created.stdout, ["pane_id"]) || firstPaneOfTab(window);
    if (!window || !statusPane) return { error: "couldn't parse herdr tab/pane ids", window };

    // 1. Split the whole tab horizontally: the original pane keeps the top
    //    third, the new pane below it is the diff viewer. `--focus` makes the
    //    diff pane the tab's active one for when the user comes back to it.
    const bottom = run([
      "pane", "split", statusPane, "--direction", "down", "--ratio", "0.33",
      "--cwd", worktreePath, "--focus",
    ]);
    if (bottom.status !== 0) return { error: (bottom.stderr || "herdr pane split failed").trim(), window };
    const diffPane = idFrom(bottom.stdout, ["pane_id", "id"], { bare: true });
    if (!diffPane) return { error: "couldn't parse herdr pane id", window };

    // 2. Split the top row left|right — Claude takes 70% of it. The left 30% is
    //    short status text and a script runner, not code, so it needs no more.
    const right = run([
      "pane", "split", statusPane, "--direction", "right", "--ratio", "0.30",
      "--cwd", worktreePath, "--no-focus",
    ]);
    if (right.status !== 0) return { error: (right.stderr || "herdr pane split failed").trim(), window };
    const claudePane = idFrom(right.stdout, ["pane_id", "id"], { bare: true });
    if (!claudePane) return { error: "couldn't parse herdr pane id", window };

    // 3. Stack setup under status in that left column. tmux gave status a fixed
    //    8 rows; 45% of a third of the tab is the nearest ratio-only equivalent.
    const below = run([
      "pane", "split", statusPane, "--direction", "down", "--ratio", "0.45",
      "--cwd", worktreePath, "--no-focus",
    ]);
    if (below.status !== 0) return { error: (below.stderr || "herdr pane split failed").trim(), window };
    const setupPane = idFrom(below.stdout, ["pane_id", "id"], { bare: true });
    if (!setupPane) return { error: "couldn't parse herdr pane id", window };

    tag(statusPane, "status", worktreePath);
    tag(setupPane, "setup", worktreePath);
    tag(claudePane, "claude", worktreePath);
    tag(diffPane, "diff", worktreePath);

    if (statusCmd) runInPane(statusPane, statusCmd);
    if (setupCmd) runInPane(setupPane, setupCmd);
    if (claudeCmd) runInPane(claudePane, claudeCmd);
    if (diffCmd) runInPane(diffPane, diffCmd);

    return { window, panes: { status: statusPane, setup: setupPane, claude: claudePane, diff: diffPane } };
  };

  // What each review worktree's agent is doing, straight from herdr — no
  // screen-scraping. This is the one place the herdr backend does something the
  // tmux backend structurally can't: herdr detects agent state itself and
  // publishes it as a field, where tmux only ever gave us pixels.
  //
  // Returns worktree path → "busy" | "blocked" | "awaiting" for every claude
  // pane herdr has an opinion about. Panes it reports as `unknown` are left out
  // so agent-state.mjs can fall back to reading their screen.
  const nativeAgentStates = () => {
    const byPath = {};
    for (const p of listTaggedPanes()) {
      if (p.role !== "claude") continue;
      const state = AGENT_STATE[p.agentStatus];
      if (state) byPath[p.worktreePath] = state;
    }
    return byPath;
  };

  return {
    name: "herdr",
    inMux,
    findWindowByWorktree,
    focusWindow,
    killWindow,
    runInPane,
    sendLine,
    listTaggedPanes,
    capturePane,
    paneAlive,
    openPlainWindow,
    buildReviewWindow,
    nativeAgentStates,
  };
}

const backend = createHerdrBackend();

export const name = backend.name;
export const inMux = backend.inMux;
export const findWindowByWorktree = backend.findWindowByWorktree;
export const focusWindow = backend.focusWindow;
export const killWindow = backend.killWindow;
export const runInPane = backend.runInPane;
export const sendLine = backend.sendLine;
export const listTaggedPanes = backend.listTaggedPanes;
export const capturePane = backend.capturePane;
export const paneAlive = backend.paneAlive;
export const openPlainWindow = backend.openPlainWindow;
export const buildReviewWindow = backend.buildReviewWindow;
export const nativeAgentStates = backend.nativeAgentStates;
