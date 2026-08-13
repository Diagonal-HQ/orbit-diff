import { expect, test } from "bun:test";
import { activeMux } from "./mux.mjs";

// Backend presence is read from the environment, so these pass one in
// explicitly — `activeMux` only memoizes when it's reading the real
// `process.env`.

test("a herdr pane selects the herdr backend", () => {
  expect(activeMux({ HERDR_PANE_ID: "w1:p1" }).name).toBe("herdr");
});

test("ORBIT_MUX=herdr drives herdr from outside a herdr pane", () => {
  expect(activeMux({ ORBIT_MUX: "herdr" }).name).toBe("herdr");
});

test("an ORBIT_MUX naming anything else falls back to no multiplexer rather than guessing", () => {
  expect(activeMux({ ORBIT_MUX: "tmux", HERDR_PANE_ID: "w1:p1" }).name).toBe(null);
});

test("outside herdr, the backend reports an empty world and refuses to build", () => {
  const mux = activeMux({});
  expect(mux.name).toBe(null);
  expect(mux.inMux()).toBe(false);
  expect(mux.listTaggedPanes()).toEqual([]);
  expect(mux.findWindowByWorktree("/wt/x")).toBe(null);
  expect(mux.capturePane("p")).toBe(null);
  expect(mux.buildReviewWindow({ worktreePath: "/wt/x" }).error).toMatch(/no multiplexer/);
  expect(mux.openPlainWindow("/wt/x", "x").ok).toBe(false);
});

// The null backend is the checklist: whatever it answers, the real backend has
// to answer too. This is what catches a name added to one and not the other —
// the failure mode that would otherwise only show up at runtime.
test("the herdr backend implements everything the null backend does", () => {
  const herdr = activeMux({ HERDR_PANE_ID: "w1:p1" });
  const none = activeMux({});

  // `name` and `nativeAgentStates` are data, not methods — their values are
  // meant to differ, so only require that they're present.
  const data = new Set(["name", "nativeAgentStates"]);
  for (const key of Object.keys(none)) {
    expect(key in herdr).toBe(true);
    if (!data.has(key)) expect(typeof herdr[key]).toBe("function");
  }
});

test("herdr claims native agent detection; nothing outside it does", () => {
  expect(typeof activeMux({ HERDR_PANE_ID: "w1:p1" }).nativeAgentStates).toBe("function");
  expect(activeMux({}).nativeAgentStates).toBe(null);
});
