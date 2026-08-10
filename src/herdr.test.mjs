import { expect, test } from "bun:test";
import { createHerdrBackend } from "./herdr.mjs";

// herdr isn't running in CI (or, usually, on the machine you're developing on),
// so every test here drives the backend through an injected `run` that stands in
// for the CLI. That covers the argument-building and parsing — the parts we can
// be sure about — and deliberately not the parts that depend on a live server.

const IN_HERDR = { HERDR_PANE_ID: "w1:p1" };

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

// Verbatim `herdr pane list` output from a real server (herdr in a plain shell,
// one untagged pane). Everything below is written against invented payloads, so
// this is the one fixture that proves the shape assumption itself.
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

// The reply envelope's `id` is the REQUEST id ("cli:tab:create"), not a
// resource id. Reading fields before unwrapping `result` handed that string
// back as the tab id, so every later `tab focus`/`tab close` targeted nothing.
test("the envelope's request id is never mistaken for a resource id", () => {
  const created = '{"id":"cli:tab:create","result":{"tab_id":"w3:t2","pane_id":"w3:p2","type":"tab_create"}}';
  const split = '{"id":"cli:pane:split","result":{"pane_id":"w3:p9","type":"pane_split"}}';
  const run = (args) => ({
    status: 0,
    stdout: args[0] === "tab" ? created : args[1] === "split" ? split : "",
    stderr: "",
  });
  const built = createHerdrBackend({ run, env: IN_HERDR }).buildReviewWindow({ worktreePath: "/wt/x" });
  expect(built.window).toBe("w3:t2");
  expect(built.panes.status).toBe("w3:p2");
});

// One `pane list` payload with all four review panes tagged, in the shape the
// socket API documents: pane_id / tab_id / agent_status / revision, plus the
// metadata tokens we report.
const PANE_LIST = JSON.stringify({
  id: "cli:pane:list",
  result: { type: "pane_list", panes: [
    {
      pane_id: "w1:p1", tab_id: "t1", revision: 7,
      tokens: { orbit_role: "status", orbit_wt: "/wt/feature", orbit_wtkey: "abc123" },
    },
    {
      pane_id: "w1:p2", tab_id: "t1", revision: 12, agent_status: "working",
      agent_session: { id: "s1" },
      tokens: { orbit_role: "claude", orbit_wt: "/wt/feature", orbit_wtkey: "abc123" },
    },
    {
      pane_id: "w2:p1", tab_id: "t2", revision: 3, agent_status: "blocked",
      agent_session: { id: "s2" },
      tokens: { orbit_role: "claude", orbit_wt: "/wt/other", orbit_wtkey: "def456" },
    },
    // Untagged — someone else's pane. Must be ignored entirely.
    { pane_id: "w3:p1", tab_id: "t3", revision: 1 },
  ] },
});

test("listTaggedPanes maps herdr's pane list onto the tmux backend's contract", () => {
  const { run } = fakeHerdr([[is("pane", "list"), PANE_LIST]]);
  const h = createHerdrBackend({ run, env: IN_HERDR });

  const panes = h.listTaggedPanes();
  expect(panes).toHaveLength(3); // the untagged pane is dropped

  const claude = panes.find((p) => p.pane === "w1:p2");
  expect(claude.role).toBe("claude");
  expect(claude.worktreePath).toBe("/wt/feature");
  expect(claude.window).toBe("t1");
  expect(claude.activity).toBe("12"); // revision stands in for window_activity
  expect(claude.command).toBe("s1"); // named from the reported agent session
});

// `command` exists so agent-state.mjs can skip a pane whose REPL exited and
// left a bare shell. herdr can't answer that — PaneInfo has no foreground
// process — and `agent_session` is NOT a stand-in: herdr populates it only when
// an official integration reported a native session, so a live screen-detected
// agent has none. Deriving `command` from it would make the scraper skip
// exactly the panes that most need scraping.
test("a pane herdr can't identify still reports a command, so it gets scraped", () => {
  const payload = JSON.stringify({
    panes: [
      // Screen-detected: a name, but no official session reference.
      { pane_id: "a", tokens: { orbit_role: "claude", orbit_wt: "/wt/a" }, agent: "claude-code" },
      // herdr knows nothing at all about this one.
      { pane_id: "b", tokens: { orbit_role: "claude", orbit_wt: "/wt/b" }, agent_status: "unknown" },
    ],
  });
  const { run } = fakeHerdr([[is("pane", "list"), payload]]);
  const panes = createHerdrBackend({ run, env: IN_HERDR }).listTaggedPanes();

  expect(panes.find((p) => p.pane === "a").command).toBe("claude-code");
  expect(panes.find((p) => p.pane === "b").command).toBeTruthy();
});

test("a worktree path that didn't survive as a token resolves through its hash", () => {
  const payload = JSON.stringify({
    panes: [{ pane_id: "w1:p2", tab_id: "t1", tokens: { orbit_role: "claude", orbit_wtkey: "abc123" } }],
  });
  const { run } = fakeHerdr([[is("pane", "list"), payload]]);
  const h = createHerdrBackend({
    run,
    env: IN_HERDR,
    resolveKey: (key) => (key === "abc123" ? "/wt/feature" : null),
  });
  expect(h.listTaggedPanes()[0].worktreePath).toBe("/wt/feature");
});

test("a pane we can't place is skipped rather than reported under a blank path", () => {
  const payload = JSON.stringify({
    panes: [{ pane_id: "w1:p2", tokens: { orbit_role: "claude", orbit_wtkey: "nope" } }],
  });
  const { run } = fakeHerdr([[is("pane", "list"), payload]]);
  const h = createHerdrBackend({ run, env: IN_HERDR, resolveKey: () => null });
  expect(h.listTaggedPanes()).toEqual([]);
});

test("findWindowByWorktree returns the tab holding that worktree's panes", () => {
  const { run } = fakeHerdr([[is("pane", "list"), PANE_LIST]]);
  const h = createHerdrBackend({ run, env: IN_HERDR });
  expect(h.findWindowByWorktree("/wt/other")).toBe("t2");
  expect(h.findWindowByWorktree("/wt/nothing-here")).toBe(null);
});

test("herdr's own agent states are translated, and `unknown` is left to the scraper", () => {
  const payload = JSON.stringify({
    panes: [
      { pane_id: "a", tokens: { orbit_role: "claude", orbit_wt: "/wt/a" }, agent_status: "working" },
      { pane_id: "b", tokens: { orbit_role: "claude", orbit_wt: "/wt/b" }, agent_status: "blocked" },
      { pane_id: "c", tokens: { orbit_role: "claude", orbit_wt: "/wt/c" }, agent_status: "idle" },
      { pane_id: "d", tokens: { orbit_role: "claude", orbit_wt: "/wt/d" }, agent_status: "done" },
      { pane_id: "e", tokens: { orbit_role: "claude", orbit_wt: "/wt/e" }, agent_status: "unknown" },
      // Not the agent pane — never reported, whatever herdr thinks of it.
      { pane_id: "f", tokens: { orbit_role: "diff", orbit_wt: "/wt/a" }, agent_status: "working" },
    ],
  });
  const { run } = fakeHerdr([[is("pane", "list"), payload]]);
  const h = createHerdrBackend({ run, env: IN_HERDR });

  expect(h.nativeAgentStates()).toEqual({
    "/wt/a": "busy",
    "/wt/b": "blocked",
    "/wt/c": "awaiting",
    "/wt/d": "awaiting",
  });
});

test("sendLine types the text and submits it as a separate key", () => {
  const { run, calls } = fakeHerdr();
  const h = createHerdrBackend({ run, env: IN_HERDR });

  expect(h.sendLine("w1:p2", "apply the change requests")).toBe(true);
  expect(calls).toEqual([
    ["pane", "send-text", "w1:p2", "apply the change requests"],
    ["pane", "send-keys", "w1:p2", "enter"],
  ]);
});

test("sendLine doesn't press enter if the text never landed", () => {
  const { run, calls } = fakeHerdr([[is("pane", "send-text"), "", 1]]);
  const h = createHerdrBackend({ run, env: IN_HERDR });

  expect(h.sendLine("w1:p2", "hello")).toBe(false);
  expect(calls).toHaveLength(1);
});

test("capturePane reads the visible viewport, and reports a dead pane as null", () => {
  const alive = fakeHerdr([[is("pane", "read"), "· Tempering… (1m 26s)\n"]]);
  const h = createHerdrBackend({ run: alive.run, env: IN_HERDR });
  expect(h.capturePane("w1:p2")).toBe("· Tempering… (1m 26s)\n");
  expect(alive.calls[0]).toEqual(["pane", "read", "w1:p2", "--source", "visible", "--format", "text"]);

  const dead = fakeHerdr([[is("pane", "read"), "", 1]]);
  expect(createHerdrBackend({ run: dead.run, env: IN_HERDR }).capturePane("w1:p2")).toBe(null);
});

test("buildReviewWindow lays out four panes and seeds each one's command", () => {
  let split = 0;
  const { run, calls } = fakeHerdr([
    [is("tab", "create"), JSON.stringify({ tab_id: "t9", pane_id: "w9:p1" })],
    [is("pane", "split"), null], // handled below
  ]);
  // The canned-route fake can't vary per split, so wrap it with a counter.
  const ids = ["w9:diff", "w9:claude", "w9:setup"];
  const counting = (args) => {
    if (args[0] === "pane" && args[1] === "split") {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify({ pane_id: ids[split++] }), stderr: "" };
    }
    return run(args);
  };

  const h = createHerdrBackend({ run: counting, env: IN_HERDR });
  const built = h.buildReviewWindow({
    worktreePath: "/wt/feature",
    name: "feature",
    statusCmd: "orbit-diff pr-status",
    setupCmd: "make setup",
    claudeCmd: "claude",
    diffCmd: "orbit-diff",
  });

  expect(built.error).toBeUndefined();
  expect(built.window).toBe("t9");
  // The tab's original pane stays top-left as `status`; everything else is
  // created by a split, in the order diff → claude → setup.
  expect(built.panes).toEqual({
    status: "w9:p1",
    setup: "w9:setup",
    claude: "w9:claude",
    diff: "w9:diff",
  });

  // Nothing focuses anything. herdr's default is to leave focus alone and
  // `--focus` "selects the new layout" — which could pull the user out of the
  // PR list, breaking the promise that reviews open in the background.
  expect(calls[0]).toContain("--no-focus");
  const splits = calls.filter((c) => c[1] === "split");
  expect(splits).toHaveLength(3);
  for (const split of splits) {
    expect(split).toContain("--no-focus");
    expect(split).not.toContain("--focus");
  }

  // Every pane is tagged with its role and its worktree.
  const tags = calls.filter((c) => c[1] === "report-metadata");
  expect(tags).toHaveLength(4);
  for (const t of tags) expect(t).toContain("orbit_wt=/wt/feature");

  // And each one is given its command.
  const ran = calls.filter((c) => c[1] === "run").map((c) => [c[2], c[3]]);
  expect(ran).toEqual([
    ["w9:p1", "orbit-diff pr-status"],
    ["w9:setup", "make setup"],
    ["w9:claude", "claude"],
    ["w9:diff", "orbit-diff"],
  ]);
});

test("buildReviewWindow refuses when we're not running inside herdr", () => {
  const { run, calls } = fakeHerdr();
  const h = createHerdrBackend({ run, env: {} });
  expect(h.buildReviewWindow({ worktreePath: "/wt/x" }).error).toMatch(/not inside herdr/);
  expect(calls).toEqual([]); // nothing was attempted
});

test("a failed split reports the error and hands back the tab so it can be cleaned up", () => {
  const { run } = fakeHerdr([
    [is("tab", "create"), JSON.stringify({ tab_id: "t9", pane_id: "w9:p1" })],
    [is("pane", "split"), "", 1],
  ]);
  const built = createHerdrBackend({ run, env: IN_HERDR }).buildReviewWindow({ worktreePath: "/wt/x" });
  expect(built.error).toMatch(/split/);
  expect(built.window).toBe("t9");
});

// A tab is only findable through its panes' tokens, so a half-built one has to
// be tagged before it can be abandoned — otherwise neither `d` nor `orbit-diff
// reset` could ever close it, and it would sit there orphaned forever.
test("a tab abandoned mid-build is still findable, so it can be cleaned up", () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === "tab") return { status: 0, stdout: JSON.stringify({ tab_id: "t9", pane_id: "w9:p1" }), stderr: "" };
    if (args[1] === "split") return { status: 1, stdout: "", stderr: "boom" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const built = createHerdrBackend({ run, env: IN_HERDR }).buildReviewWindow({ worktreePath: "/wt/x" });
  expect(built.error).toBeTruthy();

  // The surviving pane carries the worktree tag, written before the split.
  const tagged = calls.find((c) => c[1] === "report-metadata");
  expect(tagged).toBeTruthy();
  expect(tagged).toContain("orbit_wt=/wt/x");
  expect(calls.indexOf(tagged)).toBeLessThan(calls.findIndex((c) => c[1] === "split"));

  // And a later scan finds the tab through it.
  const relist = fakeHerdr([[is("pane", "list"), JSON.stringify({
    panes: [{ pane_id: "w9:p1", tab_id: "t9", tokens: { orbit_role: "status", orbit_wt: "/wt/x" } }],
  })]]);
  expect(createHerdrBackend({ run: relist.run, env: IN_HERDR }).findWindowByWorktree("/wt/x")).toBe("t9");
});

test("ORBIT_MUX=herdr counts as being inside herdr", () => {
  const { run } = fakeHerdr();
  expect(createHerdrBackend({ run, env: { ORBIT_MUX: "herdr" } }).inMux()).toBe(true);
});

test("a herdr that isn't answering reads as an empty world, not an exception", () => {
  const { run } = fakeHerdr([[() => true, "", 1]]);
  const h = createHerdrBackend({ run, env: IN_HERDR });
  expect(h.listTaggedPanes()).toEqual([]);
  expect(h.findWindowByWorktree("/wt/feature")).toBe(null);
  expect(h.paneAlive("w1:p1")).toBe(false);
  expect(h.nativeAgentStates()).toEqual({});
});

// The CLI's exact stdout envelope isn't pinned down in herdr's docs, so the
// parser accepts the forms it could reasonably take rather than betting on one.
test("pane list parses whether it comes back wrapped, bare, or as NDJSON", () => {
  const pane = { pane_id: "w1:p2", tab_id: "t1", tokens: { orbit_role: "claude", orbit_wt: "/wt/a" } };
  const shapes = [
    JSON.stringify({ panes: [pane] }),
    JSON.stringify([pane]),
    JSON.stringify({ result: { panes: [pane] } }),
    JSON.stringify(pane), // NDJSON, one row
  ];
  for (const stdout of shapes) {
    const { run } = fakeHerdr([[is("pane", "list"), stdout]]);
    const panes = createHerdrBackend({ run, env: IN_HERDR }).listTaggedPanes();
    expect(panes).toHaveLength(1);
    expect(panes[0].worktreePath).toBe("/wt/a");
  }
});

test("an id printed bare, tmux-style, is accepted as well as a JSON one", () => {
  let split = 0;
  const run = (args) => {
    if (args[0] === "tab") return { status: 0, stdout: "t9\n", stderr: "" };
    if (args[0] === "pane" && args[1] === "list") {
      return {
        status: 0,
        stdout: JSON.stringify({ panes: [{ pane_id: "w9:p1", tab_id: "t9" }] }),
        stderr: "",
      };
    }
    if (args[1] === "split") return { status: 0, stdout: `w9:p${++split + 1}\n`, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const built = createHerdrBackend({ run, env: IN_HERDR }).buildReviewWindow({ worktreePath: "/wt/x" });
  expect(built.window).toBe("t9");
  // `tab create` printed only the tab id, so the pane was found by listing.
  expect(built.panes.status).toBe("w9:p1");
  expect(built.panes.diff).toBe("w9:p2");
});
