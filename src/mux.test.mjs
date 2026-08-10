import { expect, test } from "bun:test";
import { activeMux } from "./mux.mjs";

// Backend selection is by environment, so these pass one in explicitly —
// `activeMux` only memoizes when it's reading the real `process.env`.

test("a herdr pane selects the herdr backend", () => {
  expect(activeMux({ HERDR_PANE_ID: "w1:p1" }).name).toBe("herdr");
});

test("a tmux pane selects the tmux backend", () => {
  expect(activeMux({ TMUX: "/tmp/tmux-501/default,123,0" }).name).toBe("tmux");
});

test("tmux nested inside herdr drives herdr — the outer one owns the window", () => {
  const env = { HERDR_PANE_ID: "w1:p1", TMUX: "/tmp/tmux-501/default,123,0" };
  expect(activeMux(env).name).toBe("herdr");
});

test("ORBIT_MUX overrides what the environment implies", () => {
  const env = { HERDR_PANE_ID: "w1:p1", ORBIT_MUX: "tmux" };
  expect(activeMux(env).name).toBe("tmux");
});

test("an unrecognized ORBIT_MUX falls back to no multiplexer rather than guessing", () => {
  expect(activeMux({ ORBIT_MUX: "screen", TMUX: "x" }).name).toBe(null);
});

test("outside any multiplexer, the backend reports an empty world and refuses to build", () => {
  const mux = activeMux({});
  expect(mux.name).toBe(null);
  expect(mux.inMux()).toBe(false);
  expect(mux.listTaggedPanes()).toEqual([]);
  expect(mux.findWindowByWorktree("/wt/x")).toBe(null);
  expect(mux.capturePane("p")).toBe(null);
  expect(mux.buildReviewWindow({ worktreePath: "/wt/x" }).error).toMatch(/no multiplexer/);
  expect(mux.openPlainWindow("/wt/x", "x").ok).toBe(false);
});

// The null backend is the checklist: whatever it answers, a real backend has to
// answer too. This is what catches a method added to one backend and not the
// other — the failure mode that would otherwise only show up at runtime, in
// whichever multiplexer you weren't using.
test("both backends implement everything the null backend does", () => {
  const tmux = activeMux({ TMUX: "x" });
  const herdr = activeMux({ HERDR_PANE_ID: "w1:p1" });
  const none = activeMux({});

  // `name` and `nativeAgentStates` are data, not methods — their values are
  // meant to differ per backend, so only require that they're present.
  const data = new Set(["name", "nativeAgentStates"]);
  for (const key of Object.keys(none)) {
    for (const backend of [tmux, herdr]) {
      expect(key in backend).toBe(true);
      if (!data.has(key)) expect(typeof backend[key]).toBe("function");
    }
  }
});

test("only herdr claims native agent detection", () => {
  expect(activeMux({ TMUX: "x" }).nativeAgentStates).toBe(null);
  expect(typeof activeMux({ HERDR_PANE_ID: "w1:p1" }).nativeAgentStates).toBe("function");
});
