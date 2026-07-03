#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { loadDiff, parseDiff, defaultSource } from "./src/git.mjs";
import { App } from "./src/App.jsx";
import { inPlaceStdout } from "./src/inplace-stdout.mjs";

// Everything after the script name is passed straight to `git diff`.
//   bun index.jsx                 → all outstanding work on the branch
//                                   (branch commits + uncommitted + untracked)
//   bun index.jsx --staged        → staged changes
//   bun index.jsx main..feature   → a branch range (PR-style)
const args = process.argv.slice(2);

let patch;
try {
  patch = loadDiff(args);
} catch (err) {
  console.error(`diffview: ${err.message}`);
  process.exit(1);
}

const files = parseDiff(patch);
if (files.length === 0) {
  const what = args.length ? `git diff ${args.join(" ")}` : "outstanding branch changes";
  console.error(`diffview: no ${args.length ? "changes for `" + what + "`" : what}`);
  process.exit(0);
}

const source = args.length ? args.join(" ") : defaultSource();
render(<App files={files} source={source} />, {
  exitOnCtrlC: true,
  stdout: inPlaceStdout(process.stdout),
});
