import { expect, test } from "bun:test";
import { createHerdrBackend } from "./herdr.mjs";
import { sessionKey } from "./session.mjs";

// herdr isn't running in CI (or, usually, on the machine you're developing on),
// so every test here drives the backend through an injected `run` that stands in
// for the CLI. That covers the argument-building and parsing — the parts we can
// be sure about — and deliberately not the parts that depend on a live server.
//
// A worktree's review is a herdr WORKSPACE of three tabs, so "window" ids in
// this backend are workspace ids. See the header of herdr.mjs for why.

const IN_HERDR = { HERDR_PANE_ID: "w1:p1" };
const SOURCE = ["--source", "orbit-diff"];

// A fake CLI. `routes` maps a matcher over the argv array to the stdout it
// should print; anything unmatched succeeds silently, like a herdr command that
// returns no output.
function fakeHerdr(routes = []) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    for (const [match, stdout, status] of routes) {
      if (match(args)) return { status: status ?? 0, stdout: stdout ?? "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const is = (...prefix) => (args) => prefix.every((p, i) => args[i] === p);

// herdr wraps every reply as {id, result}. Match that, since getting it wrong
// was a real bug (see the request-id test below).
const reply = (type, payload) => JSON.stringify({ id: `cli:${type}`, result: { type, ...payload } });

// ---- real output ----

// Verbatim `herdr pane list` from a real server (herdr in a plain shell, one
// untagged pane). Everything else here is written against payloads I invented,
// so this is the one fixture that proves the shape assumption rather than
// restating it.
const REAL_PANE_LIST =
  '{"id":"cli:pane:list","result":{"panes":[{"agent_status":"unknown","cwd":"/Users/owen",' +
  '"focused":true,"foreground_cwd":"/Users/owen","pane_id":"w3:p1","revision":1,' +
  '"scroll":{"max_offset_from_bottom":0,"offset_from_bottom":0,"viewport_rows":75},' +
  '"tab_id":"w3:t1","terminal_id":"term_658b210bea59f3",' +
  '"terminal_title":"owen@Owens-MacBook-Pro:~",' +
  '"terminal_title_stripped":"owen@Owens-MacBook-Pro:~","workspace_id":"w3"}],' +
  '"type":"pane_list"}}';

test("real `herdr pane list` output parses, and an untagged pane is ignored", () => {
  const { run } = fakeHerdr([[is("pane", "list"), REAL_PANE_LIST]]);
  const h = createHerdrBackend({ run, env: IN_HERDR });
  expect(h.listTaggedPanes()).toEqual([]);
  expect(h.findWindowByWorktree("/Users/owen")).toBe(null);
  expect(h.nativeAgentStates()).toEqual({});
});

// The envelope's `id` is the REQUEST id ("cli:workspace:create"), not a resource
// id. Reading fields before unwrapping `result` handed that string back as the
// container id, so every later focus/close targeted nothing.
test("the envelope's request id is never mistaken for a resource id", () => {
  const run = (args) => {
    if (is("workspace", "create")(args)) {
      return { status: 0, stdout: reply("workspace_create", { workspace_id: "w9", pane_id: "w9:p1" }), stderr: "" };
    }
    if (args[1] === "split") return { status: 0, stdout: reply("pane_split", { pane_id: "w9:p2" }), stderr: "" };
    if (is("tab", "create")(args)) return { status: 0, stdout: reply("tab_create", { pane_id: "w9:p3" }), stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const built = createHerdrBackend({ run, env: IN_HERDR }).buildReviewWindow({ worktreePath: "/wt/x" });
  expect(built.window).toBe("w9");
  expect(built.panes.diff).toBe("w9:p1");
});

// ---- reading the world ----

const WS_LIST = reply("workspace_list", {
  workspaces: [
    { workspace_id: "w1", tokens: { orbit_wt: "/wt/feature", orbit_wtkey: sessionKey("/wt/feature") } },
    { workspace_id: "w2", tokens: { orbit_wt: "/wt/other", orbit_wtkey: sessionKey("/wt/other") } },
    { workspace_id: "w9", label: "someone else's" }, // untagged — not ours
  ],
});

const PANE_LIST = reply("pane_list", {
  panes: [
    { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", revision: 7, tokens: { orbit_role: "status" } },
    {
      pane_id: "w1:p9", tab_id: "w1:t2", workspace_id: "w1", revision: 12,
      agent_status: "working", agent_session: { id: "s1" }, tokens: { orbit_role: "claude" },
    },
    {
      pane_id: "w2:p9", tab_id: "w2:t2", workspace_id: "w2", revision: 3,
      agent_status: "blocked", tokens: { orbit_role: "claude" },
    },
    { pane_id: "w9:p1", tab_id: "w9:t1", workspace_id: "w9", revision: 1 }, // untagged
  ],
});

const world = () => fakeHerdr([[is("workspace", "list"), WS_LIST], [is("pane", "list"), PANE_LIST]]);

test("panes inherit their worktree from the workspace that contains them", () => {
  const h = createHerdrBackend({ run: world().run, env: IN_HERDR });
  const panes = h.listTaggedPanes();
  expect(panes).toHaveLength(3); // the untagged pane is dropped

  const claude = panes.find((p) => p.pane === "w1:p9");
  expect(claude.role).toBe("claude");
  expect(claude.worktreePath).toBe("/wt/feature"); // from the workspace, not the pane
  expect(claude.window).toBe("w1"); // the WORKSPACE is the review container
  expect(claude.tab).toBe("w1:t2");
  expect(claude.activity).toBe("12"); // revision stands in for window_activity
  expect(claude.command).toBe("s1");
});

test("findWindowByWorktree returns the workspace, straight off the workspace tag", () => {
  const { run, calls } = world();
  const h = createHerdrBackend({ run, env: IN_HERDR });
  expect(h.findWindowByWorktree("/wt/other")).toBe("w2");
  expect(h.findWindowByWorktree("/wt/nothing-here")).toBe(null);
  // The hit is answered by `workspace list` alone — global by construction, so
  // it can't be defeated by `pane list` being scoped to the focused workspace.
  expect(calls[0]).toEqual(["workspace", "list"]);
});

test("focus and close act on the workspace, taking every tab with them", () => {
  const { run, calls } = fakeHerdr();
  const h = createHerdrBackend({ run, env: IN_HERDR });
  h.focusWindow("w1");
  h.killWindow("w1");
  expect(calls).toEqual([["workspace", "focus", "w1"], ["workspace", "close", "w1"]]);
});

test("herdr's own agent states are translated, and `unknown` is left to the scraper", () => {
  const ws = reply("workspace_list", {
    workspaces: ["a", "b", "c", "d", "e"].map((k) => ({ workspace_id: k, tokens: { orbit_wt: `/wt/${k}` } })),
  });
  const panes = reply("pane_list", {
    panes: [
      { pane_id: "pa", workspace_id: "a", tokens: { orbit_role: "claude" }, agent_status: "working" },
      { pane_id: "pb", workspace_id: "b", tokens: { orbit_role: "claude" }, agent_status: "blocked" },
      { pane_id: "pc", workspace_id: "c", tokens: { orbit_role: "claude" }, agent_status: "idle" },
      { pane_id: "pd", workspace_id: "d", tokens: { orbit_role: "claude" }, agent_status: "done" },
      { pane_id: "pe", workspace_id: "e", tokens: { orbit_role: "claude" }, agent_status: "unknown" },
      // Not an agent pane — never reported, whatever herdr thinks of it.
      { pane_id: "pf", workspace_id: "a", tokens: { orbit_role: "diff" }, agent_status: "working" },
    ],
  });
  const { run } = fakeHerdr([[is("workspace", "list"), ws], [is("pane", "list"), panes]]);
  expect(createHerdrBackend({ run, env: IN_HERDR }).nativeAgentStates()).toEqual({
    "/wt/a": "busy",
    "/wt/b": "blocked",
    "/wt/c": "awaiting",
    "/wt/d": "awaiting",
  });
});

// herdr's docs never say whether `pane list` is global or scoped to the focused
// workspace. If it's scoped, a global call returns nothing of ours even though
// `workspace list` found our workspaces — so fall back to asking each one.
test("a workspace-scoped `pane list` is detected and worked around", () => {
  const scopedTo = {
    w1: reply("pane_list", { panes: [{ pane_id: "w1:p9", workspace_id: "w1", tokens: { orbit_role: "claude" } }] }),
    w2: reply("pane_list", { panes: [{ pane_id: "w2:p9", workspace_id: "w2", tokens: { orbit_role: "claude" } }] }),
  };
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (is("workspace", "list")(args)) return { status: 0, stdout: WS_LIST, stderr: "" };
    if (is("pane", "list")(args)) {
      const i = args.indexOf("--workspace");
      // Unscoped: this server only ever shows the focused workspace, which here
      // holds nothing of ours.
      if (i < 0) return { status: 0, stdout: reply("pane_list", { panes: [] }), stderr: "" };
      return { status: 0, stdout: scopedTo[args[i + 1]] || "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  const panes = createHerdrBackend({ run, env: IN_HERDR }).listTaggedPanes();
  expect(panes.map((p) => p.worktreePath).sort()).toEqual(["/wt/feature", "/wt/other"]);
  expect(calls.filter((c) => c.includes("--workspace"))).toHaveLength(2);
});

test("a global `pane list` is not re-queried per workspace", () => {
  const { run, calls } = world();
  createHerdrBackend({ run, env: IN_HERDR }).listTaggedPanes();
  expect(calls.filter((c) => c[1] === "list" && c.includes("--workspace"))).toHaveLength(0);
});

// ---- placing a pane when tokens don't round-trip ----

test("a pane placeable only by hash is still findable, just not glyphable", () => {
  const wt = "/wt/feature";
  const ws = reply("workspace_list", { workspaces: [{ workspace_id: "w1", tokens: { orbit_wtkey: sessionKey(wt) } }] });
  const panes = reply("pane_list", {
    panes: [{ pane_id: "w1:p9", workspace_id: "w1", agent_status: "working", tokens: { orbit_role: "claude" } }],
  });
  const { run } = fakeHerdr([[is("workspace", "list"), ws], [is("pane", "list"), panes]]);
  const h = createHerdrBackend({ run, env: IN_HERDR, resolveKey: () => null });

  expect(h.findWindowByWorktree(wt)).toBe("w1"); // matched on the hash
  expect(h.listTaggedPanes()[0].worktreePath).toBe("");
  expect(h.nativeAgentStates()).toEqual({}); // no path to key a glyph on
});

test("a worktree path that didn't survive as a token resolves through its hash", () => {
  const ws = reply("workspace_list", { workspaces: [{ workspace_id: "w1", tokens: { orbit_wtkey: "abc123" } }] });
  const panes = reply("pane_list", {
    panes: [{ pane_id: "w1:p9", workspace_id: "w1", tokens: { orbit_role: "claude" } }],
  });
  const { run } = fakeHerdr([[is("workspace", "list"), ws], [is("pane", "list"), panes]]);
  const h = createHerdrBackend({
    run,
    env: IN_HERDR,
    resolveKey: (key) => (key === "abc123" ? "/wt/feature" : null),
  });
  expect(h.listTaggedPanes()[0].worktreePath).toBe("/wt/feature");
});

test("a pane with no worktree anywhere is dropped", () => {
  const { run } = fakeHerdr([
    [is("workspace", "list"), reply("workspace_list", { workspaces: [] })],
    [is("pane", "list"), reply("pane_list", { panes: [{ pane_id: "p", tokens: { orbit_role: "claude" } }] })],
  ]);
  expect(createHerdrBackend({ run, env: IN_HERDR }).listTaggedPanes()).toEqual([]);
});

// ---- finding tokens at all ----

// The field tokens arrive in is undocumented, and the one real payload we have
// is from an untagged pane so it doesn't reveal one. Guessing wrong would mean
// no pane or workspace is ever found — the whole backend dead. So it searches.
test("tokens are found wherever herdr puts them", () => {
  const tokens = { orbit_wt: "/wt/a" };
  const shapes = [
    { workspace_id: "w1", tokens },
    { workspace_id: "w1", metadata: { tokens } },
    { workspace_id: "w1", metadata: tokens },
    { workspace_id: "w1", metadata: { "orbit-diff": { tokens } } },
    { workspace_id: "w1", reported: { by_source: { "orbit-diff": tokens } } },
    // Values as { value, expires_at } records rather than bare strings.
    { workspace_id: "w1", tokens: { orbit_wt: { value: "/wt/a" } } },
  ];
  for (const workspace of shapes) {
    const { run } = fakeHerdr([[is("workspace", "list"), reply("workspace_list", { workspaces: [workspace] })]]);
    expect(createHerdrBackend({ run, env: IN_HERDR }).findWindowByWorktree("/wt/a")).toBe("w1");
  }
});

test("someone else's metadata is not mistaken for ours", () => {
  const { run } = fakeHerdr([
    [is("workspace", "list"), reply("workspace_list", {
      workspaces: [{ workspace_id: "w1", metadata: { tokens: { build: "green", pid: "412" } } }],
    })],
    [is("pane", "list"), reply("pane_list", { panes: [] })],
  ]);
  expect(createHerdrBackend({ run, env: IN_HERDR }).findWindowByWorktree("/wt/a")).toBe(null);
});

// ---- input and output ----

test("sendLine types the text and submits it as a separate key", () => {
  const { run, calls } = fakeHerdr();
  expect(createHerdrBackend({ run, env: IN_HERDR }).sendLine("w1:p9", "apply the change requests")).toBe(true);
  expect(calls).toEqual([
    ["pane", "send-text", "w1:p9", "apply the change requests"],
    ["pane", "send-keys", "w1:p9", "enter"],
  ]);
});

test("sendLine doesn't press enter if the text never landed", () => {
  const { run, calls } = fakeHerdr([[is("pane", "send-text"), "", 1]]);
  expect(createHerdrBackend({ run, env: IN_HERDR }).sendLine("w1:p9", "hello")).toBe(false);
  expect(calls).toHaveLength(1);
});

test("capturePane reads the visible viewport, and reports a dead pane as null", () => {
  const alive = fakeHerdr([[is("pane", "read"), "· Tempering… (1m 26s)\n"]]);
  const h = createHerdrBackend({ run: alive.run, env: IN_HERDR });
  expect(h.capturePane("w1:p9")).toBe("· Tempering… (1m 26s)\n");
  expect(alive.calls[0]).toEqual(["pane", "read", "w1:p9", "--source", "visible", "--format", "text"]);

  const dead = fakeHerdr([[is("pane", "read"), "", 1]]);
  expect(createHerdrBackend({ run: dead.run, env: IN_HERDR }).capturePane("w1:p9")).toBe(null);
});

// `command` exists so agent-state.mjs can skip a pane whose REPL exited and left
// a bare shell. herdr can't answer that, and `agent_session` is NOT a stand-in:
// it's populated only when an official integration reported a native session, so
// a live screen-detected agent has none. Deriving `command` from it would make
// the scraper skip exactly the panes that most need scraping.
test("a pane herdr can't identify still reports a command, so it gets scraped", () => {
  const ws = reply("workspace_list", {
    workspaces: [
      { workspace_id: "a", tokens: { orbit_wt: "/wt/a" } },
      { workspace_id: "b", tokens: { orbit_wt: "/wt/b" } },
    ],
  });
  const panes = reply("pane_list", {
    panes: [
      // Screen-detected: a name, but no official session reference.
      { pane_id: "pa", workspace_id: "a", tokens: { orbit_role: "claude" }, agent: "claude-code" },
      // herdr knows nothing at all about this one.
      { pane_id: "pb", workspace_id: "b", tokens: { orbit_role: "claude" }, agent_status: "unknown" },
    ],
  });
  const { run } = fakeHerdr([[is("workspace", "list"), ws], [is("pane", "list"), panes]]);
  const found = createHerdrBackend({ run, env: IN_HERDR }).listTaggedPanes();
  expect(found.find((p) => p.pane === "pa").command).toBe("claude-code");
  expect(found.find((p) => p.pane === "pb").command).toBeTruthy();
});

// ---- building a review workspace ----

// Creates a workspace whose pane is w5:p1, and hands out fresh ids for each
// split and tab so the layout can be asserted.
function buildingHerdr({ focusedAfter = null } = {}) {
  let n = 0;
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (is("workspace", "create")(args)) {
      return { status: 0, stdout: reply("workspace_create", { workspace_id: "w5", pane_id: "w5:p1" }), stderr: "" };
    }
    if (args[1] === "split") return { status: 0, stdout: reply("pane_split", { pane_id: `w5:s${++n}` }), stderr: "" };
    if (is("tab", "create")(args)) {
      n++;
      return { status: 0, stdout: reply("tab_create", { tab_id: `w5:t${n}`, pane_id: `w5:t${n}p` }), stderr: "" };
    }
    if (args[1] === "get" && focusedAfter !== null) {
      return { status: 0, stdout: reply("pane_get", { pane_id: "w1:p1", focused: focusedAfter }), stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

test("a review is a workspace of three tabs, agents sharing the middle one", () => {
  const { run, calls } = buildingHerdr();
  const built = createHerdrBackend({ run, env: IN_HERDR }).buildReviewWindow({
    worktreePath: "/wt/feature",
    name: "feature",
    setupCmd: "make setup",
    diffCmd: "orbit-diff",
    claudeCmd: "claude",
    codexCmd: "codex",
  });

  expect(built.error).toBeUndefined();
  expect(built.window).toBe("w5"); // the workspace
  expect(Object.keys(built.panes).sort()).toEqual(["claude", "codex", "diff", "setup"]);

  // The workspace's own first tab is the diff; two more are created.
  expect(built.panes.diff).toBe("w5:p1");
  const tabs = calls.filter((c) => is("tab", "create")(c));
  expect(tabs.map((t) => t[t.indexOf("--label") + 1])).toEqual(["agents", "setup"]);
  for (const t of tabs) expect(t[t.indexOf("--workspace") + 1]).toBe("w5");

  // Exactly one split, and it's the agents' tab down the middle.
  const splits = calls.filter((c) => c[1] === "split");
  expect(splits).toHaveLength(1);
  expect(splits[0][2]).toBe(built.panes.claude); // claude keeps the left
  expect(splits[0]).toContain("right");
  expect(splits[0][splits[0].indexOf("--ratio") + 1]).toBe("0.50");

  // Every command lands in the right place.
  const ran = calls.filter((c) => c[1] === "run").map((c) => [c[2], c[3]]);
  expect(ran).toEqual([
    [built.panes.diff, "orbit-diff"],
    [built.panes.claude, "claude"],
    [built.panes.codex, "codex"],
    [built.panes.setup, "make setup"],
  ]);
});

test("a failed agent split reports the workspace so it can still be closed", () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (is("workspace", "create")(args)) {
      return { status: 0, stdout: reply("workspace_create", { workspace_id: "w5", pane_id: "w5:p1" }), stderr: "" };
    }
    if (is("tab", "create")(args)) return { status: 0, stdout: reply("tab_create", { pane_id: "w5:t1p" }), stderr: "" };
    if (args[1] === "split") return { status: 1, stdout: "", stderr: "no room" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const built = createHerdrBackend({ run, env: IN_HERDR }).buildReviewWindow({ worktreePath: "/wt/x" });
  expect(built.error).toBe("no room");
  expect(built.window).toBe("w5");
});

// The pr-status pane is gone: `G` covers it, with room to render it properly.
test("no status pane is built, and a statusCmd is ignored rather than run", () => {
  const { run, calls } = buildingHerdr();
  const built = createHerdrBackend({ run, env: IN_HERDR }).buildReviewWindow({
    worktreePath: "/wt/x",
    statusCmd: "orbit-diff pr-status",
  });
  expect(built.panes.status).toBeUndefined();
  expect(calls.some((c) => String(c).includes("pr-status"))).toBe(false);
  expect(calls.some((c) => c.includes("orbit_role=status"))).toBe(false);
});

test("nothing in the build focuses anything", () => {
  const { run, calls } = buildingHerdr();
  createHerdrBackend({ run, env: IN_HERDR }).buildReviewWindow({ worktreePath: "/wt/x" });
  for (const c of calls.filter((x) => x[1] === "create" || x[1] === "split")) {
    expect(c).toContain("--no-focus");
    expect(c).not.toContain("--focus");
  }
});

// The workspace is the container, so tagging it is the one write that makes the
// whole review findable. It has to happen before anything else can fail.
test("the workspace is tagged before any step that could fail", () => {
  const { run, calls } = buildingHerdr();
  createHerdrBackend({ run, env: IN_HERDR }).buildReviewWindow({ worktreePath: "/wt/feature" });

  const tagIdx = calls.findIndex((c) => is("workspace", "report-metadata")(c));
  const firstTab = calls.findIndex((c) => is("tab", "create")(c));
  expect(tagIdx).toBeGreaterThan(-1);
  expect(tagIdx).toBeLessThan(firstTab);
  expect(calls[tagIdx]).toContain("orbit_wt=/wt/feature");
  expect(calls[tagIdx]).toContain(`orbit_wtkey=${sessionKey("/wt/feature")}`);
  expect(calls[tagIdx].slice(3, 5)).toEqual(SOURCE);
});

test("a workspace abandoned mid-build is still findable, so it can be cleaned up", () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (is("workspace", "create")(args)) {
      return { status: 0, stdout: reply("workspace_create", { workspace_id: "w5", pane_id: "w5:p1" }), stderr: "" };
    }
    if (is("tab", "create")(args)) return { status: 1, stdout: "", stderr: "boom" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const built = createHerdrBackend({ run, env: IN_HERDR }).buildReviewWindow({ worktreePath: "/wt/x" });
  expect(built.error).toBe("boom"); // herdr's own message, not one we invented
  expect(built.window).toBe("w5"); // handed back so the caller can record it

  // And the container tag went down first, so a later scan finds it.
  const relist = fakeHerdr([[is("workspace", "list"), reply("workspace_list", {
    workspaces: [{ workspace_id: "w5", tokens: { orbit_wt: "/wt/x" } }],
  })]]);
  expect(createHerdrBackend({ run: relist.run, env: IN_HERDR }).findWindowByWorktree("/wt/x")).toBe("w5");
});

test("a failed agent tab still reports the workspace for cleanup", () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (is("workspace", "create")(args)) {
      return { status: 0, stdout: reply("workspace_create", { workspace_id: "w5", pane_id: "w5:p1" }), stderr: "" };
    }
    if (args[1] === "split") return { status: 0, stdout: reply("pane_split", { pane_id: "w5:s1" }), stderr: "" };
    if (is("tab", "create")(args)) return { status: 1, stdout: "", stderr: "no room" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const built = createHerdrBackend({ run, env: IN_HERDR }).buildReviewWindow({ worktreePath: "/wt/x" });
  expect(built.error).toBeTruthy();
  expect(built.window).toBe("w5");
});

test("buildReviewWindow refuses when we're not running inside herdr", () => {
  const { run, calls } = fakeHerdr();
  const h = createHerdrBackend({ run, env: {} });
  expect(h.buildReviewWindow({ worktreePath: "/wt/x" }).error).toMatch(/not inside herdr/);
  expect(calls).toEqual([]); // nothing was attempted
});

test("ORBIT_MUX=herdr counts as being inside herdr", () => {
  const { run } = fakeHerdr();
  expect(createHerdrBackend({ run, env: { ORBIT_MUX: "herdr" } }).inMux()).toBe(true);
});

test("an unreachable herdr reads as an empty world, not an exception", () => {
  const { run } = fakeHerdr([[() => true, "", 1]]);
  const h = createHerdrBackend({ run, env: IN_HERDR });
  expect(h.listTaggedPanes()).toEqual([]);
  expect(h.findWindowByWorktree("/wt/feature")).toBe(null);
  expect(h.paneAlive("w1:p1")).toBe(false);
  expect(h.nativeAgentStates()).toEqual({});
  expect(h.openPlainWindow("/wt/x", "x").ok).toBe(false);
});

test("a plain worktree gets a tagged single-pane workspace", () => {
  const { run, calls } = buildingHerdr();
  expect(createHerdrBackend({ run, env: IN_HERDR }).openPlainWindow("/wt/x", "x").ok).toBe(true);
  expect(calls[0]).toContain("--focus"); // matches tmux's new-window, which selects it
  expect(calls.some((c) => is("workspace", "report-metadata")(c) && c.includes("orbit_wt=/wt/x"))).toBe(true);
});

// ---- focus guard ----
//
// The background-review contract is the most disruptive thing this backend can
// get wrong, and `--no-focus` has never been verified against a live server.
// PaneInfo carries `focused`, so building a review checks rather than trusts.

const IN_HERDR_FULL = { HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1" };

test("if building a review stole focus, the view is put back", () => {
  const { run, calls } = buildingHerdr({ focusedAfter: false });
  createHerdrBackend({ run, env: IN_HERDR_FULL }).buildReviewWindow({ worktreePath: "/wt/x" });
  expect(calls.some((c) => is("tab", "focus", "w1:t1")(c))).toBe(true);
});

test("if focus never moved, nothing is refocused", () => {
  const { run, calls } = buildingHerdr({ focusedAfter: true });
  createHerdrBackend({ run, env: IN_HERDR_FULL }).buildReviewWindow({ worktreePath: "/wt/x" });
  expect(calls.some((c) => c[1] === "focus")).toBe(false);
});

test("when herdr won't say whether we're focused, the view is left alone", () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (is("workspace", "create")(args)) {
      return { status: 0, stdout: reply("workspace_create", { workspace_id: "w5", pane_id: "w5:p1" }), stderr: "" };
    }
    if (args[1] === "split") return { status: 0, stdout: reply("pane_split", { pane_id: "w5:s1" }), stderr: "" };
    if (is("tab", "create")(args)) return { status: 0, stdout: reply("tab_create", { pane_id: "w5:tp" }), stderr: "" };
    if (args[1] === "get") return { status: 1, stdout: "", stderr: "nope" };
    return { status: 0, stdout: "", stderr: "" };
  };
  createHerdrBackend({ run, env: IN_HERDR_FULL }).buildReviewWindow({ worktreePath: "/wt/x" });
  expect(calls.some((c) => c[1] === "focus")).toBe(false);
});

test("the guard is skipped entirely when herdr didn't export our tab id", () => {
  const { run, calls } = buildingHerdr({ focusedAfter: false });
  createHerdrBackend({ run, env: { HERDR_PANE_ID: "w1:p1" } }).buildReviewWindow({ worktreePath: "/wt/x" });
  expect(calls.some((c) => c[1] === "get" || c[1] === "focus")).toBe(false);
});
