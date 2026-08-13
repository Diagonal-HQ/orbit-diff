import { expect, test } from "bun:test";
import { classifyAgentPane, createAgentPoller } from "./agent-state.mjs";

// The fixtures below are real captured output from Claude Code panes, trimmed
// to the bottom of the screen — the part the classifier looks at.

const BUSY = `
  Bash(tmux capture-pane -p -t "$TMUX_PANE" | grep -n)
  ⎿  Running…

· Tempering… (1m 26s · ↓ 4.8k tokens · thought for 5s)
────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────
  ❯ orbit-diff main ✔ Opus 5 (1M context) ctx:6% tokens:59k
  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

const AWAITING = `
✻ Churned for 49m 59s
────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────
  ❯ de-4855-workflow-step ✔ Opus 5 (1M context) ctx:26%
  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle) · PR #4928 · ← for agents
`;

// Same idle screen, but with an unsent draft typed into the composer — still
// the human's turn.
const AWAITING_DRAFT = `
────────────────────────────────────────────────────────
❯ fix the missing claim-instance-slot.sh so worktrees don't come up blank
────────────────────────────────────────────────────────
  ❯ de-5185-improve-ux ✘ Opus 5 (1M context) ctx:36%
  -- INSERT   ⏵⏵ bypass permissions on (shift+tab to cycle) · PR #4930 · ← fo…
`;

const BLOCKED = `
  Bash(rm -rf ./build)
  Do you want to proceed?
  ❯ 1. Yes
    2. Yes, and don't ask again for rm commands in this project
    3. No, and tell Claude what to do differently (esc)
`;

test("a spinner line with an elapsed-time parenthetical reads as busy", () => {
  expect(classifyAgentPane(BUSY)).toBe("busy");
});

test("older builds that spell out the interrupt hint still read as busy", () => {
  expect(classifyAgentPane("✻ Working (12s • Esc to interrupt)\n❯\n")).toBe("busy");
});

test("a finished turn on an idle composer reads as awaiting", () => {
  expect(classifyAgentPane(AWAITING)).toBe("awaiting");
  expect(classifyAgentPane(AWAITING_DRAFT)).toBe("awaiting");
});

test("a numbered permission prompt reads as blocked", () => {
  expect(classifyAgentPane(BLOCKED)).toBe("blocked");
});

// The regression this pattern was tightened for: collapsed tool output ends in
// an ellipsis followed by a parenthetical, and used to read as a live spinner.
test("collapsed tool output is not mistaken for a spinner", () => {
  const text = `
  Read(src/PrApp.jsx)
  ⎿  Read 43 lines
     … +4 lines (ctrl+o to expand)

✻ Churned for 2m 10s
❯
`;
  expect(classifyAgentPane(text)).toBe("awaiting");
});

test("a lone numbered line in the agent's own output is not blocked", () => {
  const text = `
  Here's the plan:
  1. Rename the module
✻ Churned for 12s
❯
`;
  expect(classifyAgentPane(text)).toBe("awaiting");
});

test("a pane that hasn't drawn anything yet has no state", () => {
  expect(classifyAgentPane("")).toBe(null);
  expect(classifyAgentPane("   \n\n  ")).toBe(null);
});

// ---- poller ----

// The poller asks the active backend for agent states before scraping. These
// tests are about the scraping path, so they pin the backend to "no opinion" —
// otherwise they'd talk to whatever multiplexer the test runner is inside.
const scraping = (opts) => createAgentPoller({ native: () => null, ...opts });

const pane = (over = {}) => ({
  pane: "%1",
  role: "claude",
  worktreePath: "/wt/feature",
  command: "2.1.220",
  activity: "1000",
  ...over,
});

test("poll maps worktree paths to their agent's state", () => {
  const poll = scraping({
    list: () => [pane(), pane({ pane: "%2", worktreePath: "/wt/other" })],
    capture: (p) => (p === "%1" ? AWAITING : BUSY),
  });
  expect(poll()).toEqual({ "/wt/feature": "awaiting", "/wt/other": "busy" });
});

test("poll ignores non-agent panes and panes that fell back to a shell", () => {
  const poll = scraping({
    list: () => [
      pane({ role: "diff", worktreePath: "/wt/a" }),
      pane({ pane: "%2", worktreePath: "/wt/b", command: "zsh" }),
      pane({ pane: "%3", worktreePath: "/wt/c" }),
    ],
    capture: () => AWAITING,
  });
  expect(poll()).toEqual({ "/wt/c": "awaiting" });
});

test("an unchanged pane is answered from cache instead of re-read", () => {
  let captures = 0;
  const poll = scraping({
    list: () => [pane()],
    capture: () => {
      captures++;
      return AWAITING;
    },
  });
  expect(poll()).toEqual({ "/wt/feature": "awaiting" });
  expect(poll()).toEqual({ "/wt/feature": "awaiting" });
  expect(captures).toBe(1);
});

test("new output on a window re-reads that pane", () => {
  let text = BUSY;
  let activity = "1000";
  const poll = scraping({
    list: () => [pane({ activity })],
    capture: () => text,
  });
  expect(poll()).toEqual({ "/wt/feature": "busy" });
  text = AWAITING;
  activity = "1001"; // the agent finishing its turn necessarily redraws
  expect(poll()).toEqual({ "/wt/feature": "awaiting" });
});

test("a settled pane is re-read periodically, so a missed tick can't pin a glyph", () => {
  let captures = 0;
  const poll = scraping({
    list: () => [pane()],
    capture: () => {
      captures++;
      return AWAITING;
    },
  });
  for (let i = 0; i < 8; i++) poll();
  expect(captures).toBe(2); // once up front, once when the cache aged out
});

test("a pane that vanishes mid-poll drops out rather than throwing", () => {
  const poll = scraping({ list: () => [pane()], capture: () => null });
  expect(poll()).toEqual({});
});

// ---- native states ----
//
// Under herdr the multiplexer reports agent state itself, so the classifier
// above is a fallback rather than the mechanism. These cover the handover.

test("a state the backend reports is used without reading the pane", () => {
  let captures = 0;
  const poll = createAgentPoller({
    list: () => [pane()],
    capture: () => {
      captures++;
      return BUSY;
    },
    native: () => ({ "/wt/feature": "blocked" }),
  });
  expect(poll()).toEqual({ "/wt/feature": "blocked" });
  expect(captures).toBe(0);
});

test("panes the backend has no opinion about still get scraped", () => {
  const poll = createAgentPoller({
    list: () => [pane(), pane({ pane: "%2", worktreePath: "/wt/other" })],
    capture: () => BUSY,
    // herdr answered for one worktree and reported `unknown` for the other.
    native: () => ({ "/wt/feature": "awaiting" }),
  });
  expect(poll()).toEqual({ "/wt/feature": "awaiting", "/wt/other": "busy" });
});

test("a backend that throws mid-poll falls back to scraping rather than blanking the rail", () => {
  const poll = createAgentPoller({
    list: () => [pane()],
    capture: () => BUSY,
    native: () => {
      throw new Error("herdr socket went away");
    },
  });
  expect(poll()).toEqual({ "/wt/feature": "busy" });
});

test("a worktree switching from reported to scraped doesn't serve a stale cached state", () => {
  let reported = { "/wt/feature": "blocked" };
  let text = BUSY;
  const poll = createAgentPoller({
    list: () => [pane()],
    capture: () => text,
    native: () => reported,
  });
  expect(poll()).toEqual({ "/wt/feature": "blocked" });
  // herdr loses track of the agent (it reports `unknown` now) — the next poll
  // must read the screen, not resurrect the cache entry from before.
  reported = {};
  text = AWAITING;
  expect(poll()).toEqual({ "/wt/feature": "awaiting" });
});
