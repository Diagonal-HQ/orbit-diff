// tmux plumbing for the PR-review flow: building the four-pane review window,
// finding a worktree's window (so re-opening focuses instead of duplicating),
// and poking the live Claude pane with a change request.
//
// Every pane orbit-diff creates is tagged with two user options:
//   @orbit_wt   <worktree path>          (on the window — matches the old behaviour)
//   @orbit_role status|setup|claude|diff (on each pane — so the diff viewer can
//                                         find its Claude sibling to send
//                                         annotations to)

import { spawnSync } from "node:child_process";

function tmux(args) {
  return spawnSync("tmux", args, { encoding: "utf8" });
}

export function inTmux() {
  return !!process.env.TMUX;
}

// The window id (e.g. "@7") tagged with this worktree path, or null. Scans all
// sessions so it works no matter which one you're driving from.
export function findWindowByWorktree(path) {
  const res = tmux(["list-windows", "-a", "-F", "#{window_id}\t#{@orbit_wt}"]);
  if (res.status !== 0 || !res.stdout) return null;
  for (const line of res.stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    if (line.slice(tab + 1) === path) return line.slice(0, tab);
  }
  return null;
}

export function focusWindow(id) {
  return tmux(["select-window", "-t", id]).status === 0;
}

export function killWindow(id) {
  return tmux(["kill-window", "-t", id]).status === 0;
}

// Run a command in a pane by typing it and pressing Enter. The pane's shell
// reads it whenever it's ready, so this is safe to call right after creating it.
export function runInPane(pane, cmd) {
  return tmux(["send-keys", "-t", pane, cmd, "Enter"]).status === 0;
}

// Send a line of input to a pane already running an interactive program (e.g.
// the Claude REPL), submitting it with Enter. Returns false if the pane is gone.
export function sendLine(pane, text) {
  return tmux(["send-keys", "-t", pane, text, "Enter"]).status === 0;
}

// Is this pane still alive?
export function paneAlive(pane) {
  const res = tmux(["list-panes", "-a", "-F", "#{pane_id}"]);
  if (res.status !== 0 || !res.stdout) return false;
  return res.stdout.split("\n").includes(pane);
}

// Build the detached four-pane review window for a worktree:
//
//   ┌ status ┬─────────── claude ────────────┐
//   ├────────┤                                │
//   │ setup  │                                │
//   ├────────────────── orbit-diff ───────────┤
//   └────────────────────────────────────────-┘
//
// The left column (status + setup) is 30% of the top row's width; Claude gets
// the rest. Created with `new-window -d`, so it never steals the current
// view. Returns { window, panes: { status, setup, claude, diff } } or
// { error } (with `window` set if the window was created before a later step
// failed, so the caller can record it for cleanup).
export function buildReviewWindow({ worktreePath, name, statusCmd, setupCmd, claudeCmd, diffCmd }) {
  if (!inTmux()) return { error: "not inside tmux — start tmux to open a review window" };

  // 1. New detached window; its single pane becomes the bottom (diff) pane.
  const win = tmux([
    "new-window", "-d", "-P", "-F", "#{window_id}\t#{pane_id}",
    "-n", name || "review", "-c", worktreePath,
  ]);
  if (win.status !== 0) return { error: (win.stderr || "tmux new-window failed").trim() };
  const [window, diffPane] = win.stdout.trim().split("\t");
  if (!window || !diffPane) return { error: "couldn't parse tmux window/pane ids" };
  tmux(["set-option", "-w", "-t", window, "@orbit_wt", worktreePath]);

  // 2. Split a pane ABOVE the diff pane (-b) for the top row; the top row gets
  //    1/3 so the diff pane (bottom) keeps 2/3.
  const top = tmux([
    "split-window", "-b", "-v", "-l", "33%", "-t", diffPane, "-c", worktreePath,
    "-P", "-F", "#{pane_id}",
  ]);
  if (top.status !== 0) return { error: (top.stderr || "tmux split-window failed").trim(), window };
  const setupPane = top.stdout.trim();

  // 3. Split the top row left|right → Claude to the right of setup, taking
  //    70% of the row's width (setup + status keep the other 30%: they're
  //    short-line status text and a script runner, not code, so they don't
  //    need much room).
  const right = tmux([
    "split-window", "-h", "-l", "70%", "-t", setupPane, "-c", worktreePath, "-P", "-F", "#{pane_id}",
  ]);
  if (right.status !== 0) return { error: (right.stderr || "tmux split-window failed").trim(), window };
  const claudePane = right.stdout.trim();

  // 4. Split the setup pane again, stacking a short status pane ABOVE it (-b,
  //    -v): branch/PR/env info. Fixed at 8 lines — exactly the most that
  //    render() in pr-status.mjs ever prints (branch, blank, PR, Assignee,
  //    Reviewers, Checks, blank, Env) — so it's as tight as it can be without
  //    clipping that content.
  const above = tmux([
    "split-window", "-b", "-v", "-l", "8", "-t", setupPane, "-c", worktreePath,
    "-P", "-F", "#{pane_id}",
  ]);
  if (above.status !== 0) return { error: (above.stderr || "tmux split-window failed").trim(), window };
  const statusPane = above.stdout.trim();

  // Tag panes by role so the diff viewer can find the Claude pane later.
  tmux(["set-option", "-p", "-t", statusPane, "@orbit_role", "status"]);
  tmux(["set-option", "-p", "-t", setupPane, "@orbit_role", "setup"]);
  tmux(["set-option", "-p", "-t", claudePane, "@orbit_role", "claude"]);
  tmux(["set-option", "-p", "-t", diffPane, "@orbit_role", "diff"]);

  // Seed each pane's command.
  if (statusCmd) runInPane(statusPane, statusCmd);
  if (setupCmd) runInPane(setupPane, setupCmd);
  if (claudeCmd) runInPane(claudePane, claudeCmd);
  if (diffCmd) runInPane(diffPane, diffCmd);

  // Land on the diff pane when the user later focuses this window — that's the
  // review surface, and where annotations get sent to Claude from.
  tmux(["select-pane", "-t", diffPane]);

  return { window, panes: { status: statusPane, setup: setupPane, claude: claudePane, diff: diffPane } };
}
