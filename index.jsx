#!/usr/bin/env bun
import React from "react";
import { spawnSync } from "node:child_process";
import { render } from "ink";
import { loadDiff, parseDiff, defaultSource } from "./src/git.mjs";
import { App } from "./src/App.jsx";
import { inPlaceStdout } from "./src/inplace-stdout.mjs";
import { VERSION } from "./src/version.mjs";

// Everything after the script name is passed straight to `git diff`.
//   bun index.jsx                 → all outstanding work on the branch
//                                   (branch commits + uncommitted + untracked)
//   bun index.jsx --staged        → staged changes
//   bun index.jsx main..feature   → a branch range (PR-style)
const args = process.argv.slice(2);

// Subcommands, checked before the rest is handed to `git diff`.
if (args[0] === "update") {
  const { runUpdate } = await import("./src/update.mjs");
  await runUpdate();
  process.exit(0);
}
if (args[0] === "--version" || args[0] === "-v" || args[0] === "version") {
  console.log(VERSION);
  process.exit(0);
}
if (args[0] === "prs" || args[0] === "pr") {
  const { runPrManager } = await import("./src/pr-manager.jsx");
  await runPrManager();
  process.exit(0);
}
// `orbit-diff __watchdog <pid>` — internal. The sidecar process spawned by
// spawnWatchdog() to watch a viewer/prs process from outside and kill it if a
// Bun runtime bug (see src/watchdog.mjs) wedges it at 100% CPU. Never launched
// directly by a user.
if (args[0] === "__watchdog") {
  const { runWatchdog } = await import("./src/watchdog.mjs");
  await runWatchdog(args[1]);
  process.exit(0);
}
// `orbit-diff pr-status` — runs in the review window's status pane, polling
// the worktree's branch/PR/env state on a timer. Never returns on its own;
// the pane goes away when the review window is torn down.
if (args[0] === "pr-status") {
  const { runPrStatus } = await import("./src/pr-status.mjs");
  await runPrStatus();
  process.exit(0);
}
// `orbit-diff env-report [instance] [--instance X] [--url U] [--status S] [--error E]`
// The setup script calls this from inside its worktree once the environment is
// provisioned, so orbit-diff can record the instance (the "EV" number) against
// this worktree's review session and stop the "provisioning" spinner.
if (args[0] === "env-report") {
  const { repoRoot } = await import("./src/paths.mjs");
  const { sessionKey, readSession, updateSession } = await import("./src/session.mjs");
  const rest = args.slice(1);
  const patch = { status: "ready" };
  let positional = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--instance") patch.envInstance = rest[++i];
    else if (a === "--url") patch.envUrl = rest[++i];
    else if (a === "--status") patch.status = rest[++i];
    else if (a === "--error") patch.error = rest[++i];
    else if (!a.startsWith("--") && positional == null) positional = a;
  }
  if (positional != null && patch.envInstance == null) patch.envInstance = positional;

  const root = repoRoot();
  const key = sessionKey(root);
  // Upsert so an early/manual call still records the worktree path.
  if (!readSession(key)) updateSession(key, { worktreePath: root });
  const rec = updateSession(key, { ...patch, worktreePath: root });
  const inst = rec.envInstance != null ? ` → instance ${rec.envInstance}` : "";
  console.log(`orbit-diff: recorded env for ${root}${inst} (status: ${rec.status})`);
  process.exit(0);
}
if (args[0] === "init") {
  const { scaffoldConfig } = await import("./src/ai/config.mjs");
  const force = args.includes("--force") || args.includes("-f");
  const { path, created } = scaffoldConfig({ force });
  console.log(
    created
      ? `orbit-diff: wrote starter config → ${path}`
      : `orbit-diff: config already exists at ${path} (pass --force to overwrite)`,
  );
  process.exit(0);
}

// First-run convenience: materialise the config so there's a file to edit. This
// is best-effort — a missing/broken config already falls back to built-in
// defaults, so we never block the viewer on it.
{
  const { ensureConfig } = await import("./src/ai/config.mjs");
  const { created, path } = ensureConfig();
  if (created) console.error(`\x1b[2morbit-diff: wrote starter config → ${path} (edit to change model/provider)\x1b[0m`);
}

let patch;
try {
  patch = loadDiff(args);
} catch (err) {
  console.error(`orbit-diff: ${err.message}`);
  process.exit(1);
}

const files = parseDiff(patch);
if (files.length === 0) {
  const what = args.length ? `git diff ${args.join(" ")}` : "outstanding branch changes";
  console.error(`orbit-diff: no ${args.length ? "changes for `" + what + "`" : what}`);
  process.exit(0);
}

const source = args.length ? args.join(" ") : defaultSource();

// Ask the terminal for its background so the current-line / selection bands can
// be a subtle off-shade of the actual theme (light or dark). Falls back to
// dark-tuned defaults when the terminal doesn't answer. Runs before render so
// stdin is free for the OSC 11 round-trip; Ink reclaims it afterward.
const { detectLineColors } = await import("./src/theme.mjs");
const { activeBg, selectBg, addBg, delBg } = await detectLineColors();

// Are we the diff pane of a managed review window? If this worktree has a
// review session with a live Claude pane, the viewer routes annotations there
// (send-keys) instead of quitting to hand off to a fresh `claude`.
let claudePane = null;
if (process.env.TMUX) {
  try {
    const { repoRoot } = await import("./src/paths.mjs");
    const { sessionForWorktree } = await import("./src/session.mjs");
    const { paneAlive } = await import("./src/tmux.mjs");
    const sess = sessionForWorktree(repoRoot());
    const pane = sess?.panes?.claude;
    if (pane && paneAlive(pane)) claudePane = pane;
  } catch {
    /* best-effort — fall back to the quit-and-handoff path */
  }
}

// Guard against a known Bun runtime bug that can wedge this process at 100%
// CPU (see src/watchdog.mjs) — spawned once, watches this pid for the whole
// handoff loop below, and exits on its own once we do.
const { spawnWatchdog } = await import("./src/watchdog.mjs");
spawnWatchdog();

// The review loop. render the viewer; when it exits, either the user quit (done)
// or they pressed `r` to apply their annotations, leaving a change-request doc in
// `handoff.doc`. In that case we hand the *bare* terminal to an interactive
// `claude` session so they can watch it work and answer any questions, then
// reload the diff and re-launch the viewer on the result.
let current = files;
while (true) {
  const handoff = { doc: null };
  const app = render(
    <App files={current} reloadDiff={() => parseDiff(loadDiff(args))} source={source} handoff={handoff} claudePane={claudePane} activeBg={activeBg} selectBg={selectBg} addBg={addBg} delBg={delBg} />,
    { exitOnCtrlC: true, stdout: inPlaceStdout(process.stdout) },
  );
  await app.waitUntilExit();
  // Clear the viewer's final frame so nothing bleeds into what comes next.
  process.stdout.write("\x1b[2J\x1b[H");

  if (!handoff.doc) break; // a plain quit — we're done

  // Ink has released the terminal; give it to an interactive claude session.
  // stdio "inherit" hands over the real TTY, so its window shows and it can
  // prompt. The prompt is seeded as the first message; a copy is also saved under
  // ~/.cache/orbit-diff/<repo>/<branch>/. spawnSync blocks until the user exits claude.
  console.log("\x1b[2morbit-diff → handing off to Claude Code (exit it to return)…\x1b[0m\n");
  const res = spawnSync("claude", [handoff.doc], { stdio: "inherit" });
  if (res.error) {
    const why = res.error.code === "ENOENT" ? "`claude` not found on PATH" : res.error.message;
    console.error(`\norbit-diff: couldn't launch Claude Code: ${why}`);
    process.exit(1);
  }

  // Re-read the working tree Claude just edited.
  let next;
  try {
    next = parseDiff(loadDiff(args));
  } catch (err) {
    console.error(`orbit-diff: reload failed: ${err.message}`);
    process.exit(1);
  }
  if (next.length === 0) {
    console.log("orbit-diff: no changes remain after applying — nothing left to review.");
    break;
  }
  current = next; // loop back into the viewer on the fresh diff
}
