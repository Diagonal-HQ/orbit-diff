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

// One `pane list` payload with all four review panes tagged, in the shape the
// socket API documents: pane_id / tab_id / agent_status / revision, plus the
// metadata tokens we report.
const PANE_LIST = JSON.stringify({
  panes: [
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
  ],
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
  expect(claude.command).toBe("agent"); // a live agent session, not a bare shell

  // A pane with no agent session reads as "no agent running here", which is the
  // question `command` answers for the tmux backend too.
  expect(panes.find((p) => p.pane === "w1:p1").command).toBe("");
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

  // The tab is built in the background, and the diff pane is the one that ends
  // up active inside it.
  expect(calls[0]).toContain("--no-focus");
  const splits = calls.filter((c) => c[1] === "split");
  expect(splits[0]).toContain("--focus");
  expect(splits[0]).not.toContain("--no-focus");
  expect(splits[1]).toContain("--no-focus");
  expect(splits[2]).toContain("--no-focus");

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
