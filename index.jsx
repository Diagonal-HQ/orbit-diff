#!/usr/bin/env bun
import React from "react";
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

const app = render(<App files={files} source={source} activeBg={activeBg} selectBg={selectBg} />, {
  exitOnCtrlC: true,
  stdout: inPlaceStdout(process.stdout),
});

// On quit, clear the viewer's final frame so you land back on a clean prompt
// instead of the last diff frame left scrolled into the terminal. (2J clears the
// screen, H homes the cursor; scrollback history is left intact.)
await app.waitUntilExit();
process.stdout.write("\x1b[2J\x1b[H");
