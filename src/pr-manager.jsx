// The `orbit-diff prs` driver: render the PR manager and wire up its command
// runner. The list, worktrees, overview, and refresh all live inside PrApp, and
// `pr.start` / `pr.done` run in the *background* (detached, output to a log
// file) rather than taking over the terminal — so this is a single render, not
// a handoff loop.

import React from "react";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, closeSync, existsSync } from "node:fs";
import { dirname, basename } from "node:path";
import { render } from "ink";
import { PrApp } from "./PrApp.jsx";
import { inPlaceStdout } from "./inplace-stdout.mjs";
import { listReviewPRs, renderCommand, renderPath, shq } from "./pr.mjs";
import { listWorktrees, addWorktree, createWorktree, removeWorktree } from "./git.mjs";
import { loadConfig, CONFIG_HINT } from "./ai/config.mjs";
import { orbitDir, repoRoot } from "./paths.mjs";
import { openUrl } from "./platform.mjs";
import {
  inTmux,
  findWindowByWorktree,
  focusWindow,
  killWindow,
  buildReviewWindow,
} from "./tmux.mjs";
import { sessionKey, sessionPath, writeSession, updateSession, deleteSession, listSessions } from "./session.mjs";

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

  // Run a raw shell command in the background, both streams redirected to a log
  // under the orbit cache dir. Detached + unref'd so it outlives the picker and
  // never writes onto the TUI's terminal. Returns { ok, cmd, logPath, pid } or
  // { ok:false, error }.
  const runDetached = (cmd, logSlug) => {
    try {
      const dir = orbitDir();
      mkdirSync(dir, { recursive: true });
      const logPath = `${dir}/pr-${logSlug}.log`;
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

  // Where a PR's worktree goes: the configured `pr.worktreeDir` template, else a
  // sibling directory `<repo>-worktrees/<branch>` next to the main checkout.
  const worktreePathFor = (pr) => {
    const tmpl = config.pr.worktreeDir;
    if (tmpl && tmpl.trim()) return renderPath(tmpl, pr);
    const root = repoRoot();
    return `${dirname(root)}/${basename(root)}-worktrees/${slug(pr.headRefName)}`;
  };

  // Start reviewing a PR: create its worktree (if new), record the session, and
  // open the detached three-pane review window (setup · claude · orbit-diff).
  // Re-starting a PR whose window is already open just focuses it. Returns
  // { ok, focused?, path, provisioning? } or { ok:false, error }.
  const startReview = (pr) => {
    if (!pr) return { ok: false, error: "no PR selected" };
    if (!inTmux()) return { ok: false, error: "not inside tmux — start tmux to open a review window" };

    const wtPath = worktreePathFor(pr);

    // Already open for this worktree? Focus it instead of duplicating.
    const existing = findWindowByWorktree(wtPath);
    if (existing) {
      focusWindow(existing);
      return { ok: true, focused: true, path: wtPath };
    }

    // Create the worktree if it isn't there yet.
    if (!existsSync(wtPath)) {
      const add = addWorktree(wtPath, pr.headRefName);
      if (!add.ok) return { ok: false, error: add.error };
    }

    const key = sessionKey(wtPath);
    writeSession({
      key,
      pr: pr.number,
      branch: pr.headRefName,
      base: pr.baseRefName,
      repo: pr.repo,
      url: pr.url,
      title: pr.title,
      worktreePath: wtPath,
      status: "provisioning",
      createdAt: new Date().toISOString(),
    });

    return openReviewWindow(key, wtPath, pr);
  };

  // Start a local, ad-hoc worktree: create a brand-new branch (off the current
  // HEAD, wherever this repo happens to be checked out) and open the same
  // four-pane review window as a PR review, but with no PR behind it — for
  // poking at something locally without a GitHub PR driving it. Shares the
  // worktree-dedup + window-build logic with startReview above.
  const startLocal = (name) => {
    const branch = name.trim();
    if (!branch) return { ok: false, error: "no name given" };
    if (!inTmux()) return { ok: false, error: "not inside tmux — start tmux to open a review window" };

    const root = repoRoot();
    const wtPath = `${dirname(root)}/${basename(root)}-worktrees/${slug(branch)}`;

    const existing = findWindowByWorktree(wtPath);
    if (existing) {
      focusWindow(existing);
      return { ok: true, focused: true, path: wtPath };
    }
    if (existsSync(wtPath)) return { ok: false, error: `${wtPath} already exists` };

    const add = createWorktree(wtPath, branch);
    if (!add.ok) return { ok: false, error: add.error };

    const key = sessionKey(wtPath);
    writeSession({
      key,
      pr: null,
      branch,
      title: branch,
      worktreePath: wtPath,
      status: "provisioning",
      createdAt: new Date().toISOString(),
    });

    return openReviewWindow(key, wtPath, { headRefName: branch, title: branch });
  };

  // Shared tail for startReview/startLocal: render the setup/claude commands,
  // build the four-pane window, and record it on the session. `target` is a
  // pr-like object (headRefName/baseRefName/number/repo/title/url) — startLocal
  // only has headRefName/title, and renderCommand leaves the rest blank.
  function openReviewWindow(key, wtPath, target) {
    // `setup` (falling back to the legacy `start`) runs in the setup pane; it
    // should call `orbit-diff env-report` when the environment is ready.
    const setupCmd = renderCommand(config.pr.setup || config.pr.start, { ...target, path: wtPath }) || "";
    const claudeCmd = renderCommand(config.pr.claude, { ...target, path: wtPath }) || "claude";

    const built = buildReviewWindow({
      worktreePath: wtPath,
      name: windowName({ path: wtPath, branch: target.headRefName }),
      statusCmd: "orbit-diff pr-status",
      setupCmd,
      claudeCmd,
      diffCmd: "orbit-diff",
    });
    if (built.error) {
      updateSession(key, { status: "failed", error: built.error, window: built.window || null });
      return { ok: false, error: built.error };
    }
    // With no setup command there's nothing to provision, so it's ready now;
    // otherwise it stays "provisioning" until `env-report` flips it.
    updateSession(key, {
      window: built.window,
      panes: built.panes,
      status: setupCmd ? "provisioning" : "ready",
    });
    return { ok: true, path: wtPath, provisioning: !!setupCmd };
  }

  // Finish a review. orbit-diff ALWAYS owns worktree removal, so your `pr.done`
  // only has to do env teardown (destroy the instance, etc.). Steps:
  //   1. close the review window and drop the session (immediate, safe),
  //   2. run `pr.done` — then remove the git worktree, then delete the session
  //      file, as ONE detached job so removal happens *after* teardown (which
  //      typically runs `make` inside the worktree and needs it present) and it
  //      survives you leaving the picker. `;` means each step runs regardless.
  // While that job runs, the session is marked "tearing-down" so the picker can
  // show a spinner; the job's final `rm` of the session file is how the picker
  // learns it finished. With no `pr.done`, the worktree is removed synchronously
  // (errors surface immediately). `target` carries at least { headRefName, path }.
  const finishReview = (target) => {
    const path = target && target.path;

    let killed = false;
    if (path) {
      const win = findWindowByWorktree(path);
      if (win) killed = killWindow(win);
    }

    const doneCmd = config.pr.done.trim() ? renderCommand(config.pr.done, target) : null;
    let removed = false;
    let logPath = null;
    let error = null;

    if (path && doneCmd) {
      const key = sessionKey(path);
      const removeCmd = `git -C ${shq(repoRoot())} worktree remove --force ${shq(path)}`;
      const cleanupCmd = `rm -f ${shq(sessionPath(key))}`;
      const res = runDetached(`${doneCmd} ; ${removeCmd} ; ${cleanupCmd}`, `finish-${slug(target.headRefName || "worktree")}`);
      logPath = res.logPath || null;
      error = res.ok ? null : res.error;
      // Keep the record as a spinner marker until the job's final `rm` clears it.
      if (res.ok) updateSession(key, { status: "tearing-down", logPath });
      else deleteSession(key); // never launched — nothing to track
    } else if (path) {
      const rm = removeWorktree(path);
      removed = rm.ok;
      error = rm.ok ? null : rm.error;
      deleteSession(sessionKey(path));
    }

    return { ok: !error, error, killed, removed, ranDone: !!doneCmd, logPath };
  };

  const app = render(
    <PrApp
      loadPRs={listReviewPRs}
      loadWorktrees={listWorktrees}
      loadSessions={listSessions}
      startReview={startReview}
      startLocal={startLocal}
      finishReview={finishReview}
      openUrl={openUrl}
      openWorktree={openWorktree}
      config={config}
    />,
    { exitOnCtrlC: true, stdout: inPlaceStdout(process.stdout) },
  );
  await app.waitUntilExit();
  process.stdout.write("\x1b[2J\x1b[H"); // clear the viewer's final frame
}
