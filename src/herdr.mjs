// The review-window plumbing, spoken to herdr's CLI (https://herdr.dev).
// `mux.mjs` wraps this and is what the rest of the codebase imports; nothing
// else should import this module directly.
//
// # Vocabulary
//
// orbit-diff says "window" for the unit holding one worktree's review. In herdr
// that's a **workspace** — so every `window` id this module hands out is a herdr
// workspace id, and `focusWindow`/`killWindow` are `workspace focus`/`workspace
// close`.
//
// A workspace rather than a tab for three reasons:
//
//   1. herdr stores metadata on panes and workspaces but NOT on tabs. A tab can
//      only be found via its panes' tokens, which is how a half-built tab used
//      to end up unfindable and unclosable. A workspace is tagged directly,
//      once, on the container that outlives every pane inside it.
//   2. `workspace list` is global by construction, where the docs never say
//      whether `pane list` is scoped to the focused workspace. Anchoring
//      find/focus/close on workspaces means the operations that matter don't
//      depend on that unknown.
//   3. Closing a review takes any extra tabs you opened for that worktree with
//      it, instead of orphaning them.
//
// # Tagging
//
//   on the workspace:  orbit_wt    the worktree's absolute path
//                      orbit_wtkey a 16-hex-char hash of it (see session.mjs)
//   on each pane:      orbit_role  status | setup | diff | claude | codex
//                      (plus both worktree tokens, so a pane is still placeable
//                       if the workspace tag is ever lost)
//
// The hash is not belt-and-braces, it's load-bearing: **herdr truncates token
// values at 80 characters**, which most real worktree paths run past. The docs
// only limit token *names* (1-32 ASCII) and say nothing about values, so this
// was found the hard way — see `makePlacer`, which is why nothing in here trusts
// `orbit_wt` without checking it against the hash first.
//
// # Where the docs are silent
//
// This backend discovers rather than guesses. The field tokens come back in is
// undocumented, so `tokensOf` searches for a map containing tokens we wrote
// rather than betting on a name. `pane list` scoping is undocumented, so
// `listTaggedPanes` notices when a global call misses and re-asks per workspace.
// `--no-focus` is unverified, so building a review checks `focused` afterwards
// and puts the view back if it moved.
//
// Everything fails soft: an unreachable or unparseable herdr answers as
// "nothing there" rather than throwing, so a dead server degrades the worktrees
// rail instead of taking down the TUI.

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
// wrapper over it. A real reply looks like:
//
//   {"id":"cli:pane:list","result":{"panes":[…],"type":"pane_list"}}
//
// NDJSON and bare-id forms are still accepted below, since the docs don't
// promise this shape is the only one.
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

// Take the reply envelope off before looking at anything inside it.
//
// This MUST happen before any field lookup. The envelope's `id` is the *request*
// id — "cli:tab:create", "cli:pane:list" — and several of the ids we want are
// plausibly named `id` on the payload itself, so reading fields at the envelope
// level would hand back "cli:tab:create" as a tab id and every later
// `tab focus`/`tab close` would target nothing.
function unwrap(value) {
  let v = value;
  // Bounded: an envelope nested deeper than this is not something we understand.
  for (let i = 0; i < 4; i++) {
    if (!v || typeof v !== "object" || Array.isArray(v)) break;
    if (v.result && typeof v.result === "object") v = v.result;
    else if (v.data && typeof v.data === "object") v = v.data;
    else break;
  }
  return v;
}

// Dig an array out of an unwrapped payload: a bare array or `{panes:[…]}`.
function pickArray(value, key) {
  const v = unwrap(value);
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== "object") return [];
  if (Array.isArray(v[key])) return v[key];
  // A single row printed on its own — what NDJSON collapses to when there's
  // exactly one. An empty `{panes: []}` still returns [], because it carries
  // the key; only an object that looks like an item itself gets wrapped.
  if (!(key in v)) return [v];
  return [];
}

// First present value among `names` on an unwrapped payload, descending into a
// single named resource object (`{"result":{"pane":{…}}}`) if that's the shape.
function pickField(value, names) {
  const v = unwrap(value);
  if (!v || typeof v !== "object") return null;
  for (const name of names) {
    const found = v[name];
    if (typeof found === "string" && found) return found;
    if (typeof found === "number") return String(found);
  }
  for (const resource of ["pane", "tab", "workspace"]) {
    if (v[resource] && typeof v[resource] === "object") {
      const inner = pickField(v[resource], names);
      if (inner) return inner;
    }
  }
  return null;
}

// A named boolean anywhere in an unwrapped payload (`focused`), or null if it
// isn't there. Separate from pickField, which only reads strings and numbers.
function pickBool(value, name, depth = 0) {
  const v = unwrap(value);
  if (!v || typeof v !== "object" || depth > 3) return null;
  if (typeof v[name] === "boolean") return v[name];
  for (const inner of Object.values(v)) {
    const found = pickBool(inner, name, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

// An id printed by a create/split call, read out of structured output.
//
// `bare` allows the fallback for a command that printed nothing but a single
// id and no JSON around it. Only pass it when the id you're asking for is
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

const OUR_TOKENS = [TOK_ROLE, TOK_WT, TOK_WTKEY];

// Read a { name: value } bag, or null if it doesn't hold tokens of ours. Values
// may be bare strings or `{ value, expires_at }` records.
function asTokenBag(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
    else if (v && typeof v === "object" && typeof v.value === "string") out[k] = v.value;
  }
  return OUR_TOKENS.some((t) => t in out) ? out : null;
}

// Our reported tokens, found anywhere in a PaneInfo.
//
// The docs confirm tokens come back on `pane.list`/`pane.get` but never name
// the field they arrive in, and the one real payload we have is from an
// untagged pane, so it doesn't show one either. Guessing a name would be a
// single point of failure for the whole backend — get it wrong and no pane is
// ever found, so no review window can be focused, closed, or deduplicated.
//
// So don't guess: walk the object and take the first nested map that actually
// contains tokens we wrote. That works whether they land at `tokens`,
// `metadata.tokens`, or namespaced under the reporting source. Bounded to a few
// levels and to a pane-sized object, so it's cheap enough to do per poll.
function tokensOf(pane, depth = 0) {
  if (!pane || typeof pane !== "object" || depth > 3) return null;
  const here = asTokenBag(pane);
  if (here) return here;
  for (const value of Object.values(pane)) {
    const found = tokensOf(value, depth + 1);
    if (found) return found;
  }
  return null;
}

// hash → worktree path, over every worktree orbit-diff has a session for. The
// authority on what a `orbit_wtkey` means when the path token didn't survive the
// round trip — see `makePlacer`.
function sessionPathsByKey() {
  const map = new Map();
  for (const s of listSessions()) {
    if (s && s.worktreePath) map.set(s.key || sessionKey(s.worktreePath), s.worktreePath);
  }
  return map;
}

export function createHerdrBackend({ run = defaultRun, env = process.env, resolveKey = null } = {}) {
  const ok = (args) => run(args).status === 0;

  // `ORBIT_MUX=herdr` counts as being inside herdr — it's an explicit
  // instruction to drive it, so this must honour the same gate `mux.mjs` does.
  const inMux = () => env.ORBIT_MUX === "herdr" || !!env.HERDR_PANE_ID;

  // Which worktree is this workspace/pane actually for?
  //
  // **herdr truncates token VALUES at 80 characters.** Verified against a live
  // `agent list` on 2026-08-13: `orbit_wt` came back as
  // `…/worktrees/de-5407-support-images-within-th` — exactly 80 characters, cut
  // mid-word — while the same pane's `cwd` carried the path in full. The docs
  // only ever mention a 1-32 limit on token *names*, which is why this was
  // written as a belt-and-braces `orbit_wtkey` rather than a known constraint.
  //
  // A clipped path is worse than a missing one: it's non-empty, so it reads as
  // an answer, and every consumer that compares it to a real worktree path
  // silently misses. That cost the agent glyph on every worktree whose path runs
  // past 80 characters, while `orbit_wtkey` (16 hex chars, never clipped) kept
  // focus/close/reset working — which is exactly why only the rail broke.
  //
  // So don't trust a path token: verify it. The key is the hash of the true
  // path, so a candidate that rehashes to it round-tripped intact. Candidates
  // are tried in order, then the key is resolved through orbit-diff's own
  // session records. Returns "" when nothing places it.
  //
  // The session read is lazy and at most once per placer, so a rail whose panes
  // all report a usable `cwd` never touches the disk.
  const makePlacer = () => {
    let byKey = null;
    return (key, candidates) => {
      for (const c of candidates) {
        if (!c) continue;
        // Nothing to verify against — an unhashed candidate is all we have.
        if (!key) return c;
        if (sessionKey(c) === key) return c;
      }
      if (!key) return "";
      if (resolveKey) return resolveKey(key) || "";
      if (!byKey) byKey = sessionPathsByKey();
      return byKey.get(key) || "";
    };
  };

  // Every workspace orbit-diff has tagged: { window, worktreePath, worktreeKey }.
  //
  // The workspace IS the container for a worktree's review, so this is the
  // primary lookup — and it's the one that made the workspace model worth
  // switching to. `workspace list` is global by construction, where `pane list`
  // may or may not be scoped to the focused workspace (herdr's docs don't say).
  // Anchoring find/focus/close here means the operations that matter don't
  // depend on that unknown; only the agent glyph does.
  const taggedWorkspaces = (place = makePlacer()) => {
    const res = run(["workspace", "list"]);
    if (res.status !== 0) return [];
    const out = [];
    for (const w of pickArray(parseJson(res.stdout), "workspaces")) {
      const tokens = tokensOf(w) || {};
      const worktreeKey = tokens[TOK_WTKEY] || "";
      if (!tokens[TOK_WT] && !worktreeKey) continue;
      const worktreePath = place(worktreeKey, [tokens[TOK_WT], pickField(w, ["cwd"])]);
      const window = pickField(w, ["workspace_id", "id"]);
      if (window) out.push({ window, worktreePath, worktreeKey });
    }
    return out;
  };

  // Every pane orbit-diff has tagged:
  //   { pane, role, worktreePath, worktreeKey, command, activity, window, agentStatus }
  //
  // `window` is the pane's WORKSPACE, not its tab, because that's orbit-diff's
  // unit of "one worktree's review". `activity` is herdr's per-pane `revision`
  // counter: it changes when the pane does, so an unchanged pane can be
  // answered from cache without re-reading its screen.
  //
  // `command` has no honest herdr equivalent. agent-state.mjs reads it for one
  // thing — telling a running REPL from a pane whose agent exited and left a
  // bare shell — and PaneInfo carries no foreground process name to answer it.
  //
  // It must NOT be derived from `agent_session`: herdr populates that "when an
  // official integration has reported a native session reference" and omits it
  // otherwise, so a perfectly live screen-detected agent has none. Reporting ""
  // there would make agent-state.mjs skip the pane as a shell, and a worktree
  // whose agent herdr can't classify would lose its glyph entirely — the exact
  // case the scrape fallback exists to cover.
  //
  // So a tagged agent pane always reports something non-empty: we launched the
  // agent in it ourselves, so it is an agent pane by construction. The trade is
  // that under herdr we can't notice the REPL exiting, and such a worktree reads
  // as "waiting on you" rather than dropping its glyph.
  const listTaggedPanes = () => {
    const place = makePlacer();
    const workspaces = taggedWorkspaces(place);
    const byWorkspace = new Map(workspaces.map((w) => [w.window, w]));

    // One global call. If it comes back without any of our panes but we know of
    // tagged workspaces, `pane list` is scoped to the focused workspace — so ask
    // each workspace in turn instead. Costs one call per active review, and only
    // on a server that needs it.
    let panes = readPanes([]);
    if (workspaces.length && !panes.some((p) => byWorkspace.has(pickField(p, ["workspace_id"])))) {
      panes = workspaces.flatMap((w) => readPanes(["--workspace", w.window]));
    }

    const out = [];
    for (const p of panes) {
      const tokens = tokensOf(p) || {};
      const role = tokens[TOK_ROLE];
      if (!role) continue;

      const window = pickField(p, ["workspace_id"]) || "";
      const fromWorkspace = byWorkspace.get(window);

      // The workspace's own tag is the most reliable source — it's written once
      // on the container and can't be lost by a pane being replaced. Its path
      // has already been through the placer, so it's whole or empty, never
      // clipped; `foreground_cwd` and `cwd` are herdr's own untruncated view of
      // where the pane is sitting, and back it up.
      const worktreeKey = tokens[TOK_WTKEY] || (fromWorkspace && fromWorkspace.worktreeKey) || "";
      const worktreePath = place(worktreeKey, [
        fromWorkspace && fromWorkspace.worktreePath,
        tokens[TOK_WT],
        pickField(p, ["foreground_cwd"]),
        pickField(p, ["cwd"]),
      ]);
      // A pane we can't place at all is useless. One we can place only by hash
      // is still worth reporting: `findWindowByWorktree` matches on either, so
      // focus/close/cleanup keep working even if the path token didn't survive
      // the round trip. Only the agent glyph needs the path itself.
      if (!worktreePath && !worktreeKey) continue;

      const pane = pickField(p, ["pane_id", "id"]);
      if (!pane) continue;
      // The agent's name when herdr knows it (`agent` for a screen-detected
      // one, `agent_session` for an officially integrated one), else a marker
      // that keeps the pane in the scraper's sights. Never "".
      const agent =
        pickField(p, ["agent"]) ||
        (p.agent_session && pickField(p.agent_session, ["name", "agent", "id"])) ||
        (p.agent_session ? "agent" : "") ||
        "agent";
      out.push({
        pane,
        role,
        worktreePath,
        worktreeKey,
        command: agent,
        activity: pickField(p, ["revision"]) || "",
        window,
        tab: pickField(p, ["tab_id"]) || "",
        agentStatus: pickField(p, ["agent_status"]) || "",
      });
    }
    return out;
  };

  function readPanes(extra) {
    const res = run(["pane", "list", ...extra]);
    if (res.status !== 0) return [];
    return pickArray(parseJson(res.stdout), "panes");
  }

  // The workspace holding this worktree's review, or null.
  //
  // Matches on the path token OR its hash. The hash is 16 hex characters and
  // can't be mangled by any plausible token-value limit, so this keeps working
  // even if long slash-bearing paths turn out not to round-trip — the difference
  // between "the agent glyph is missing" and "reviews can never be re-focused,
  // closed, or cleaned up". Falls back to scanning panes for a workspace that
  // exists but whose container tag didn't land.
  const findWindowByWorktree = (path) => {
    const key = sessionKey(path);
    for (const w of taggedWorkspaces()) {
      if (w.worktreePath === path || w.worktreeKey === key) return w.window;
    }
    for (const p of listTaggedPanes()) {
      if (!p.window) continue;
      if (p.worktreePath === path || p.worktreeKey === key) return p.window;
    }
    return null;
  };

  const focusWindow = (id) => ok(["workspace", "focus", id]);
  const killWindow = (id) => ok(["workspace", "close", id]);

  // `pane run` hands the command to herdr rather than typing it, so there's no
  // race with a shell that hasn't drawn its prompt yet.
  const runInPane = (pane, cmd) => ok(["pane", "run", pane, cmd]);

  // A line of input into whatever's already running in the pane. Text and the
  // Enter key are separate calls in herdr — `send-text` deliberately doesn't
  // interpret its argument, so the newline has to come through `send-keys`.
  //
  // (herdr also has `agent prompt`, which is purpose-built for handing a prompt
  // to a detected agent. It's the better call for an agent pane specifically,
  // but it needs herdr to have recognized the agent; this path works on any
  // pane, recognized or not.)
  const sendLine = (pane, text) => {
    if (!ok(["pane", "send-text", pane, text])) return false;
    return ok(["pane", "send-keys", pane, "enter"]);
  };

  // The pane's visible screen, or null if it's gone. `--source visible` is the
  // current viewport — the equivalent of `capture-pane -p`, and likewise the
  // right source for a full-screen TUI, where scrollback holds nothing useful.
  //
  // The documented flags are `--source` and `--lines` (`herdr pane read w1:p1
  // --source visible --lines 80`); there is no `--format`, and passing one we
  // invented risks the whole call being rejected — which would fail silently as
  // "pane's gone" and take the scrape fallback out entirely.
  //
  // What it prints isn't documented either, so take either shape: a JSON reply
  // gets its screen text pulled out, anything else is already the screen.
  const capturePane = (pane) => {
    const res = run(["pane", "read", pane, "--source", "visible", "--lines", "80"]);
    if (res.status !== 0) return null;
    const text = pickField(parseJson(res.stdout), ["text", "content", "screen", "lines"]);
    return text === null ? res.stdout || "" : text;
  };

  const paneAlive = (pane) => ok(["pane", "get", pane]);

  const wtTokens = (worktreePath) => [
    "--token", `${TOK_WT}=${worktreePath}`,
    "--token", `${TOK_WTKEY}=${sessionKey(worktreePath)}`,
  ];

  // Stamp the container — one write, on the thing that outlives every pane
  // inside it, which is the tagging herdr tabs can't do at all. Tokens carry no
  // TTL, so they last as long as the workspace does.
  const tagWorkspace = (workspace, worktreePath) =>
    ok(["workspace", "report-metadata", workspace, "--source", SOURCE, ...wtTokens(worktreePath)]);

  // Stamp a pane with its role. The worktree tokens go on too, so a pane is
  // still placeable if the workspace tag is ever lost.
  const tag = (pane, role, worktreePath) =>
    ok([
      "pane", "report-metadata", pane,
      "--source", SOURCE,
      "--token", `${TOK_ROLE}=${role}`,
      ...wtTokens(worktreePath),
    ]);

  // A bare single-pane workspace rooted at `path` — no review tabs, nothing run
  // in it. Focused on creation — you asked for it, so you land in it — and
  // tagged so a later open re-focuses rather than duplicating.
  const openPlainWindow = (path, name) => {
    const created = run(["workspace", "create", "--cwd", path, "--label", name || "worktree", "--focus"]);
    if (created.status !== 0) {
      return { ok: false, error: (created.stderr || "").trim() || "herdr workspace create failed" };
    }
    const workspace = idFrom(created.stdout, ["workspace_id", "id"], { bare: true });
    if (workspace) tagWorkspace(workspace, path);
    const pane = idFrom(created.stdout, ["pane_id"]) || firstPaneOf(workspace, null);
    if (pane) tag(pane, "plain", path);
    return { ok: true };
  };

  // The pane herdr put in a freshly created workspace or tab, for when the
  // create call reported the container but not its pane.
  function firstPaneOf(workspaceId, tabId) {
    if (!workspaceId && !tabId) return null;
    for (const p of readPanes(workspaceId ? ["--workspace", workspaceId] : [])) {
      if (tabId && pickField(p, ["tab_id"]) !== tabId) continue;
      if (!tabId && workspaceId && pickField(p, ["workspace_id"]) !== workspaceId) continue;
      return pickField(p, ["pane_id", "id"]);
    }
    return null;
  }

  // Create a tab in `workspace` and return its pane, or null.
  function addTab(workspace, worktreePath, label) {
    const res = run([
      "tab", "create", "--workspace", workspace, "--cwd", worktreePath,
      "--label", label, "--no-focus",
    ]);
    if (res.status !== 0) return { error: (res.stderr || "herdr tab create failed").trim() };
    const tab = idFrom(res.stdout, ["tab_id"], { bare: true });
    const pane = idFrom(res.stdout, ["pane_id"]) || firstPaneOf(workspace, tab);
    if (!pane) return { error: `couldn't parse the pane id for the ${label} tab` };
    return { pane };
  }

  // Relabel an existing tab.
  //
  // herdr documents the method (`tab.rename`) but not the CLI's argument shape,
  // and the two plausible forms are a `--label` flag (matching `tab create`) and
  // a bare positional (matching `pane run <id> <cmd>`). So try the flag and fall
  // back to the positional — the same discover-rather-than-guess approach the
  // rest of this module takes, and it costs one extra call only when the first
  // form is the wrong one. A tab that won't rename is cosmetic, never fatal.
  const renameTab = (tab, label) => {
    if (!tab || !label) return false;
    return ok(["tab", "rename", tab, "--label", label]) || ok(["tab", "rename", tab, label]);
  };

  // The tab holding this worktree's diff pane, or "". Matches on path or hash,
  // exactly as `findWindowByWorktree` does.
  const findReviewTab = (worktreePath) => {
    const key = sessionKey(worktreePath);
    for (const p of listTaggedPanes()) {
      if (p.role !== "diff") continue;
      if (p.worktreePath === worktreePath || (p.worktreeKey && p.worktreeKey === key)) return p.tab;
    }
    return "";
  };

  // Put `label` on the review tab of the worktree at `worktreePath`.
  //
  // This is how the provisioned environment stays visible: the tab bar is on
  // screen from every tab of the workspace, so the instance is readable from the
  // agents or setup tab too — where neither the viewer's status bar nor its `O`
  // overview can reach. `orbit-diff env-report` calls it when the instance lands,
  // which is well after the review was built.
  //
  // Best-effort by construction: a review that isn't open, a tab we can't place,
  // or a herdr that won't rename all answer false and change nothing.
  const labelReviewTab = (worktreePath, label) => renameTab(findReviewTab(worktreePath), label);

  // Put the view back if building a review workspace moved it.
  //
  // herdr's docs say creation and splitting "leave focus unchanged", and we pass
  // `--no-focus` everywhere, so this should never fire. But the whole
  // background-review contract rests on that being true, it's the single most
  // disruptive way for this backend to be wrong, and it has never been checked
  // against a live server. PaneInfo carries `focused`, so verifying costs one
  // call once per review start rather than trusting a doc sentence.
  //
  // Silent when it can't tell: no env ids, no answer from `pane get`, or no
  // `focused` field means we leave well alone rather than yank the view.
  const restoreFocus = () => {
    const homeTab = env.HERDR_TAB_ID;
    const homePane = env.HERDR_PANE_ID;
    if (!homeTab || !homePane) return;
    const res = run(["pane", "get", homePane]);
    if (res.status !== 0) return;
    if (pickBool(parseJson(res.stdout), "focused") === false) run(["tab", "focus", homeTab]);
  };

  const buildReviewWindow = (opts) => {
    if (!inMux()) return { error: "not inside herdr — start herdr to open a review window" };
    const built = buildReviewSpace(opts);
    restoreFocus();
    return built;
  };

  // Build a worktree's review as its own herdr WORKSPACE of three tabs:
  //
  //   tab 1 "review"  orbit-diff, the whole tab
  //   tab 2 "agents"  claude │ codex, side by side
  //   tab 3 "setup"   the provisioning script
  //
  // The only split left is the one between the two agents, and it earns its
  // place: they're a pair you compare, so having both on screen beats tabbing
  // between them. Everything else gets a whole tab — a diff wants the width,
  // build output scrolls — which is why slicing tab 1 into thirds made all
  // three of its occupants worse.
  //
  // There used to be a fifth thing here, an `orbit-diff pr-status` pane showing
  // branch/PR/checks/env. The viewer's `O` overview covers all of it and more,
  // so it's gone rather than duplicated in a column too narrow to read.
  //
  // Why a workspace rather than a tab: herdr stores metadata on panes and
  // workspaces but NOT on tabs, so a tab can only be found via its panes'
  // tokens — which is how a half-built tab used to end up unfindable and
  // unclosable. A workspace can be tagged directly, once, on the container. It
  // also means closing a review takes any extra tabs you opened for that
  // worktree with it.
  //
  // Nothing here focuses anything (see restoreFocus above).
  const buildReviewSpace = ({ worktreePath, name, reviewTabLabel, setupCmd, diffCmd, claudeCmd, codexCmd }) => {
    const created = run([
      "workspace", "create", "--cwd", worktreePath, "--label", name || "review", "--no-focus",
    ]);
    if (created.status !== 0) {
      return { error: (created.stderr || "herdr workspace create failed").trim() };
    }
    const window = idFrom(created.stdout, ["workspace_id", "id"], { bare: true });
    if (!window) return { error: "couldn't parse the herdr workspace id" };

    // Tag the container before anything else can fail. However badly the rest of
    // this goes, the workspace is now findable — so `d` and `orbit-diff reset`
    // can always close it.
    tagWorkspace(window, worktreePath);

    // The workspace's own first tab is the diff. `workspace create` takes a
    // label for the workspace but none for that tab, so it's the one tab we have
    // to name afterwards — which is also where the env instance goes once
    // `env-report` lands. See labelReviewTab.
    const diffPane = idFrom(created.stdout, ["pane_id"]) || firstPaneOf(window, null);
    if (!diffPane) return { error: "couldn't parse the herdr pane id", window };
    tag(diffPane, "diff", worktreePath);
    renameTab(idFrom(created.stdout, ["tab_id"]) || findReviewTab(worktreePath), reviewTabLabel || "review");

    const panes = { diff: diffPane };

    // Tab 2: both agents, an even left/right split.
    const agents = addTab(window, worktreePath, "agents");
    if (agents.error) return { error: agents.error, window };
    tag(agents.pane, "claude", worktreePath);
    panes.claude = agents.pane;

    const right = run([
      "pane", "split", agents.pane, "--direction", "right", "--ratio", "0.50",
      "--cwd", worktreePath, "--no-focus",
    ]);
    if (right.status !== 0) return { error: (right.stderr || "herdr pane split failed").trim(), window };
    const codexPane = idFrom(right.stdout, ["pane_id", "id"], { bare: true });
    if (!codexPane) return { error: "couldn't parse the herdr pane id", window };
    tag(codexPane, "codex", worktreePath);
    panes.codex = codexPane;

    // Tab 3: the provisioning script.
    const setup = addTab(window, worktreePath, "setup");
    if (setup.error) return { error: setup.error, window };
    tag(setup.pane, "setup", worktreePath);
    panes.setup = setup.pane;

    if (diffCmd) runInPane(panes.diff, diffCmd);
    if (claudeCmd) runInPane(panes.claude, claudeCmd);
    if (codexCmd) runInPane(panes.codex, codexCmd);
    if (setupCmd) runInPane(panes.setup, setupCmd);

    return { window, panes };
  };

  // What each review worktree's agent is doing, straight from herdr — no
  // screen-scraping. herdr detects agent state itself and publishes it as a
  // field, so for the panes it can classify we never have to read pixels.
  //
  // Returns worktree path → "busy" | "blocked" | "awaiting" for every claude
  // pane herdr has an opinion about. Panes it reports as `unknown` are left out
  // so agent-state.mjs can fall back to reading their screen.
  const nativeAgentStates = () => {
    const byPath = {};
    for (const p of listTaggedPanes()) {
      if (p.role !== "claude" || !p.worktreePath) continue;
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
    labelReviewTab,
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
export const labelReviewTab = backend.labelReviewTab;
export const nativeAgentStates = backend.nativeAgentStates;
