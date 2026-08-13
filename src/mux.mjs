// The terminal multiplexer we drive, if there is one.
//
// orbit-diff's review flow needs a handful of things from whatever is managing
// the terminal: make a detached workspace of panes, run a command in each, find
// a worktree's window again later, read a pane's screen without focusing it,
// and poke the live agent with a line of text. herdr (https://herdr.dev) does
// all of that, and is the only backend — this module wraps it so nothing
// outside `herdr.mjs` has to care whether one is present.
//
// Presence is read from the environment, not configuration: a process running
// inside a herdr pane gets `HERDR_PANE_ID`. `ORBIT_MUX=herdr` forces the
// backend on anyway, for driving herdr from a plain terminal.
//
// Outside herdr, the backend is a no-op that reports nothing there. The PR
// list, worktree rail, and diff viewer all still work; only opening review
// windows doesn't.
//
// # Adding to the surface
//
// The null backend below is the checklist of what a backend has to provide; if
// you add a name to `herdr.mjs`, add it here too.

import * as herdr from "./herdr.mjs";

// What we answer with when there's no multiplexer to talk to.
const NONE = {
  name: null,
  inMux: () => false,
  findWindowByWorktree: () => null,
  focusWindow: () => false,
  killWindow: () => false,
  runInPane: () => false,
  sendLine: () => false,
  listTaggedPanes: () => [],
  capturePane: () => null,
  paneAlive: () => false,
  openPlainWindow: () => ({ ok: false, error: "no multiplexer — start herdr" }),
  buildReviewWindow: () => ({ error: "no multiplexer — start herdr to open a review window" }),
  labelReviewTab: () => false,
  nativeAgentStates: null,
};

function select(env) {
  const forced = (env.ORBIT_MUX || "").trim().toLowerCase();
  // An explicit `ORBIT_MUX` is honoured when it names herdr and refused
  // otherwise — an unrecognized value means the user is asking for something we
  // don't have, and guessing herdr anyway would drive the wrong thing.
  if (forced) return forced === "herdr" ? herdr : NONE;
  if (env.HERDR_PANE_ID) return herdr;
  return NONE;
}

// Resolved once. Nothing in a session's lifetime moves it in or out of herdr,
// and re-reading the environment on every pane poll would just be work — but
// tests can pass an env to get a specific backend.
let active = null;
export function activeMux(env = process.env) {
  if (env !== process.env) return select(env);
  if (!active) active = select(env);
  return active;
}

// "herdr" | null — for messages that name what the user is running.
export function muxName() {
  return activeMux().name;
}

// Are we inside a multiplexer we can drive at all?
export function inMux() {
  return activeMux().inMux();
}

// The message shown when an action needs a multiplexer and there isn't one.
// `verb` completes "start herdr to …".
export function noMuxError(verb) {
  return `not inside herdr — start it to ${verb}`;
}

export const findWindowByWorktree = (path) => activeMux().findWindowByWorktree(path);
export const focusWindow = (id) => activeMux().focusWindow(id);
export const killWindow = (id) => activeMux().killWindow(id);
export const runInPane = (pane, cmd) => activeMux().runInPane(pane, cmd);
export const sendLine = (pane, text) => activeMux().sendLine(pane, text);
export const listTaggedPanes = () => activeMux().listTaggedPanes();
export const capturePane = (pane) => activeMux().capturePane(pane);
export const paneAlive = (pane) => activeMux().paneAlive(pane);
export const openPlainWindow = (path, label) => activeMux().openPlainWindow(path, label);
export const buildReviewWindow = (opts) => activeMux().buildReviewWindow(opts);

// Put `label` on a worktree's review tab — how the provisioned env instance
// stays readable from every tab of the review. Best-effort: false when there's
// no multiplexer, no open review, or nothing to rename.
export const labelReviewTab = (path, label) => activeMux().labelReviewTab(path, label);

// Close whatever window is holding `path`, whether or not we're inside herdr.
// Returns the closed window's id, or null if nothing was holding it.
//
// Everything else in this module deliberately goes through `activeMux()`, which
// is a no-op outside herdr. Teardown is the exception: `herdr workspace list`
// answers from a plain shell as long as the server is up, and `orbit-diff
// reset` is routinely run from a normal terminal to clean up after a worktree.
// Gating that on being inside herdr would delete the worktree and the branch
// while leaving the window and its processes running.
//
// With the server down, herdr answers "nothing there" rather than throwing, so
// this costs one cheap failed call and can't close anything it shouldn't.
export function closeWorktreeWindow(path) {
  const window = herdr.findWindowByWorktree(path);
  if (window && herdr.killWindow(window)) return window;
  return null;
}

// The backend's own agent-state detection, or null when there is none. herdr
// publishes semantic agent states for the panes it can classify; callers should
// treat null as "scrape instead" — see agent-state.mjs.
export function nativeAgentStates() {
  const fn = activeMux().nativeAgentStates;
  return fn ? fn() : null;
}
