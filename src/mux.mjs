// Which terminal multiplexer are we driving?
//
// orbit-diff's review flow needs a handful of things from whatever is managing
// the terminal: make a detached window of four panes, run a command in each,
// find a worktree's window again later, read a pane's screen without focusing
// it, and poke the live agent with a line of text. tmux can do all of that;
// so can herdr (https://herdr.dev). This module picks one and hands the rest of
// the codebase a single surface, so nothing outside `tmux.mjs` / `herdr.mjs`
// has to know which is underneath.
//
// Selection is by environment, not configuration: a process running inside a
// herdr pane gets `HERDR_PANE_ID`, one inside tmux gets `TMUX`, and orbit-diff
// always wants to drive the multiplexer it's *already living in* — driving the
// other one would build a window you can't see. `ORBIT_MUX=tmux|herdr` forces a
// backend anyway, for testing one from inside the other.
//
// Outside both, the backend is a no-op that reports nothing there. That's the
// pre-existing "not inside tmux" behaviour, generalized: the PR list, worktree
// rail, and diff viewer all still work; only opening review windows doesn't.
//
// # Adding to the surface
//
// Both backends export the same names. If you add one, add it to both — the
// null backend below is the checklist of what a backend has to provide.

import * as tmux from "./tmux.mjs";
import * as herdr from "./herdr.mjs";

// What a backend answers with when there's no multiplexer to talk to.
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
  openPlainWindow: () => ({ ok: false, error: "no multiplexer — start tmux or herdr" }),
  buildReviewWindow: () => ({ error: "no multiplexer — start tmux or herdr to open a review window" }),
  nativeAgentStates: null,
};

const BACKENDS = { tmux, herdr };

function select(env) {
  const forced = (env.ORBIT_MUX || "").trim().toLowerCase();
  if (forced) return BACKENDS[forced] || NONE;
  // herdr first: if both are set we're in a tmux session nested inside a herdr
  // pane, and herdr is the outer one that actually owns the window we'd build.
  if (env.HERDR_PANE_ID) return herdr;
  if (env.TMUX) return tmux;
  return NONE;
}

// Resolved once. Nothing in a session's lifetime moves it between
// multiplexers, and re-reading the environment on every pane poll would just
// be work — but tests can pass an env to get a specific backend.
let active = null;
export function activeMux(env = process.env) {
  if (env !== process.env) return select(env);
  if (!active) active = select(env);
  return active;
}

// "tmux" | "herdr" | null — for messages that name what the user is running.
export function muxName() {
  return activeMux().name;
}

// Are we inside a multiplexer we can drive at all? Replaces the bare
// `process.env.TMUX` checks that used to gate the review flow.
export function inMux() {
  return activeMux().inMux();
}

// The message shown when an action needs a multiplexer and there isn't one.
// `verb` completes "start tmux to …".
export function noMuxError(verb) {
  return `not inside tmux or herdr — start one to ${verb}`;
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

// The backend's own agent-state detection, or null when it has none. herdr
// publishes semantic agent states; tmux can only show you the screen. Callers
// should treat null as "scrape instead" — see agent-state.mjs.
export function nativeAgentStates() {
  const fn = activeMux().nativeAgentStates;
  return fn ? fn() : null;
}
