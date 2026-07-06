// The `orbit-diff prs` driver: render the PR manager and wire up its command
// runner. The list, worktrees, overview, and refresh all live inside PrApp, and
// `pr.start` / `pr.done` run in the *background* (detached, output to a log
// file) rather than taking over the terminal — so this is a single render, not
// a handoff loop.

import React from "react";
import { spawn, spawnSync } from "node:child_process";
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

// tmux window name for a worktree: its branch, else a short detached-HEAD tag,
// else the leaf directory. Only used for display — windows are matched by path
// (see `@orbit_wt` below), so this can collide or be renamed harmlessly.
function windowName(wt) {
  if (wt.branch) return wt.branch;
  if (wt.head) return `det-${wt.head.slice(0, 7)}`;
  const parts = String(wt.path).split("/").filter(Boolean);
  return parts[parts.length - 1] || "worktree";
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

  // Open a URL in the system's default browser, detached so it never touches the
  // TUI's terminal. Returns { ok } / { ok:false, error }.
  const openUrl = (url) => {
    if (!url) return { ok: false, error: "no URL to open" };
    const platform = process.platform;
    const [cmd, args] =
      platform === "darwin" ? ["open", [url]]
      : platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", () => {}); // swallow ENOENT etc.; nothing to log onto the TUI
      child.unref();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };

  // Open a worktree in a tmux window: focus the existing window for this
  // worktree if there is one, otherwise create a new one rooted at its path.
  // Windows are tagged with the worktree path via the `@orbit_wt` window option
  // (survives shell-driven automatic-rename and name collisions), so re-opening
  // a worktree jumps back to its window instead of spawning a duplicate.
  // Requires running inside tmux. Returns { ok, focused } / { ok:false, error }.
  const openWorktree = (wt) => {
    if (!wt || !wt.path) return { ok: false, error: "no worktree to open" };
    if (wt.bare) return { ok: false, error: "can't open a bare worktree in tmux" };
    if (!process.env.TMUX) return { ok: false, error: "not inside tmux — start tmux to open worktrees in windows" };
    try {
      const list = spawnSync("tmux", ["list-windows", "-F", "#{window_id}\t#{@orbit_wt}"], { encoding: "utf8" });
      if (list.status === 0 && list.stdout) {
        for (const line of list.stdout.split("\n")) {
          const tab = line.indexOf("\t");
          if (tab < 0) continue;
          if (line.slice(tab + 1) === wt.path) {
            spawnSync("tmux", ["select-window", "-t", line.slice(0, tab)]);
            return { ok: true, focused: true };
          }
        }
      }
      // -P -F prints the new window's id; new-window also selects it (so the
      // user lands in the new window). Tag it so a later open re-focuses it.
      const created = spawnSync(
        "tmux",
        ["new-window", "-P", "-F", "#{window_id}", "-n", windowName(wt), "-c", wt.path],
        { encoding: "utf8" },
      );
      if (created.status !== 0) {
        return { ok: false, error: (created.stderr || "").trim() || "tmux new-window failed" };
      }
      const id = created.stdout.trim();
      if (id) spawnSync("tmux", ["set-option", "-w", "-t", id, "@orbit_wt", wt.path]);
      return { ok: true, focused: false };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };

  const app = render(
    <PrApp loadPRs={listReviewPRs} loadWorktrees={listWorktrees} runPr={runPr} openUrl={openUrl} openWorktree={openWorktree} config={config} />,
    { exitOnCtrlC: true, stdout: inPlaceStdout(process.stdout) },
  );
  await app.waitUntilExit();
  process.stdout.write("\x1b[2J\x1b[H"); // clear the viewer's final frame
}
