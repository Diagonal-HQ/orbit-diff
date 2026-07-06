// The `orbit-diff prs` driver: render the PR manager and wire up its command
// runner. The list, worktrees, overview, and refresh all live inside PrApp, and
// `pr.start` / `pr.done` run in the *background* (detached, output to a log
// file) rather than taking over the terminal — so this is a single render, not
// a handoff loop.

import React from "react";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { render } from "ink";
import { PrApp } from "./PrApp.jsx";
import { inPlaceStdout } from "./inplace-stdout.mjs";
import { listReviewPRs, renderCommand } from "./pr.mjs";
import { listWorktrees } from "./git.mjs";
import { loadConfig, CONFIG_HINT } from "./ai/config.mjs";
import { orbitDir } from "./paths.mjs";

// Filesystem-safe slug for a branch name in a log filename.
function slug(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

export async function runPrManager() {
  const config = await loadConfig();
  if (config.warning) console.error(`\x1b[2morbit-diff: ${config.warning}\x1b[0m`);

  // Launch a configured PR command in the background. Returns { ok, cmd,
  // logPath, pid } or { ok:false, error }. Output is redirected to a per-action,
  // per-branch log under the orbit cache dir; the child is detached + unref'd so
  // it outlives the picker and never writes onto the TUI's terminal.
  const runPr = (action, pr) => {
    const template = action === "start" ? config.pr.start : config.pr.done;
    const cmd = renderCommand(template, pr);
    if (!cmd) return { ok: false, error: `pr.${action} isn't configured — set pr.${action} in ${CONFIG_HINT}` };
    try {
      const dir = orbitDir();
      mkdirSync(dir, { recursive: true });
      const logPath = `${dir}/pr-${action}-${slug(pr.headRefName)}.log`;
      const fd = openSync(logPath, "a");
      const shell = process.env.SHELL || "/bin/sh";
      // `-i` sources the interactive rc so shell aliases/functions resolve; the
      // child gets no stdin and writes both streams to the log.
      const child = spawn(shell, ["-ic", cmd], { stdio: ["ignore", fd, fd], detached: true });
      child.unref();
      closeSync(fd); // the child holds its own dup of the fd
      return { ok: true, cmd, logPath, pid: child.pid };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };

  const app = render(
    <PrApp loadPRs={listReviewPRs} loadWorktrees={listWorktrees} runPr={runPr} config={config} />,
    { exitOnCtrlC: true, stdout: inPlaceStdout(process.stdout) },
  );
  await app.waitUntilExit();
  process.stdout.write("\x1b[2J\x1b[H"); // clear the viewer's final frame
}
