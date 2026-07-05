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
const { activeBg, selectBg } = await detectLineColors();

// The review loop. render the viewer; when it exits, either the user quit (done)
// or they pressed `r` to apply their annotations, leaving a change-request doc in
// `handoff.doc`. In that case we hand the *bare* terminal to an interactive
// `claude` session so they can watch it work and answer any questions, then
// reload the diff and re-launch the viewer on the result.
let current = files;
while (true) {
  const handoff = { doc: null };
  const app = render(
    <App files={current} source={source} handoff={handoff} activeBg={activeBg} selectBg={selectBg} />,
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
