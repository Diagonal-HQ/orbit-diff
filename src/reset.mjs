// Destructive recovery for a broken review worktree.
//
// `orbit-diff reset <branch>` removes only local state: tagged tmux windows,
// registered or stale worktree directories, Git's worktree bookkeeping, the
// local branch ref, path-hashed session records, and per-repo/branch caches.
// The remote branch is deliberately untouched, so starting the PR again creates
// a clean local branch tracking origin.

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./ai/config.mjs";
import { listWorktrees } from "./git.mjs";
import { renderPath } from "./pr.mjs";
import { orbitDirFor, pathSlug } from "./paths.mjs";
import { deleteSession, listSessions, sessionKey } from "./session.mjs";
import { closeWorktreeWindow } from "./mux.mjs";

function runGit(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function removeDir(path) {
  rmSync(path, { recursive: true, force: true });
}

const DEFAULT_DEPS = {
  loadConfig,
  listWorktrees,
  listSessions,
  deleteSession,
  sessionKey,
  closeWorktreeWindow,
  orbitDirFor,
  existsSync,
  removeDir,
  git: runGit,
};

// Turn common Git remote URL shapes into owner/repo for session scoping.
export function remoteRepoSlug(url) {
  const raw = String(url || "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (!raw) return null;
  const scp = raw.match(/^[^@]+@[^:]+:(.+)$/);
  let path = scp ? scp[1] : null;
  if (!path) {
    try {
      path = new URL(raw).pathname;
    } catch {
      path = raw;
    }
  }
  const parts = String(path).split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : null;
}

function expectedWorktreePath(config, root, branch, repo) {
  const template = config.pr.worktreeDir;
  if (template && template.trim()) {
    return resolve(renderPath(template, { headRefName: branch, repo }));
  }
  return `${dirname(root)}/${basename(root)}-worktrees/${pathSlug(branch)}`;
}

function safeToRemove(path, primaryRoot) {
  const target = resolve(path);
  return target !== resolve(primaryRoot) && target !== "/" && target !== homedir();
}

function errorText(res, fallback) {
  return (res?.stderr || res?.stdout || fallback).trim();
}

// The optional dependency overrides keep the destructive orchestration
// testable without creating or deleting real worktrees.
export async function resetBranch(rawBranch, overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const branch = String(rawBranch || "").trim().replace(/^origin\//, "");
  if (!branch) return { ok: false, error: "usage: orbit-diff reset <branch>" };

  const worktrees = deps.listWorktrees();
  if (!worktrees.length) {
    return { ok: false, error: "run `orbit-diff reset` from inside a valid checkout of the repository" };
  }

  const primary = worktrees.find((wt) => !wt.bare)?.path;
  if (!primary) return { ok: false, error: "couldn't identify the repository's primary worktree" };

  const registered = worktrees.filter((wt) => wt.branch === branch);
  if (registered.some((wt) => resolve(wt.path) === resolve(primary))) {
    return { ok: false, error: `refusing to reset ${branch}: it is checked out in the primary worktree` };
  }

  const validBranch = deps.git(primary, ["check-ref-format", "--branch", branch]);
  if (validBranch.status !== 0) {
    return { ok: false, error: errorText(validBranch, `invalid branch name: ${branch}`) };
  }

  const config = await deps.loadConfig();
  const remote = deps.git(primary, ["config", "--get", "remote.origin.url"]);
  const repo = remote.status === 0 ? remoteRepoSlug(remote.stdout) : null;
  const expected = expectedWorktreePath(config, primary, branch, repo);
  const branchSpecificExpected =
    !config.pr.worktreeDir?.trim() || config.pr.worktreeDir.includes("{branch}");
  const expectedOwner = worktrees.find((wt) => resolve(wt.path) === resolve(expected));
  if (expectedOwner && expectedOwner.branch !== branch) {
    return {
      ok: false,
      error: `refusing to reset ${branch}: configured path ${expected} belongs to ${expectedOwner.branch || "another worktree"}`,
    };
  }

  // Begin with paths Git knows plus the configured path. Matching session
  // records can recover older paths after a worktree has fallen out of Git's
  // registry.
  const paths = new Set(registered.map((wt) => resolve(wt.path)));
  if (branchSpecificExpected) paths.add(resolve(expected));
  const sessions = deps.listSessions();
  for (const session of sessions) {
    if (session.branch !== branch || !session.worktreePath) continue;
    if ((repo && session.repo === repo) || paths.has(resolve(session.worktreePath))) {
      paths.add(resolve(session.worktreePath));
    }
  }

  for (const path of paths) {
    if (!safeToRemove(path, primary)) {
      return { ok: false, error: `refusing to remove unsafe worktree path: ${path}` };
    }
  }

  const removedWindows = [];
  const removedWorktrees = [];
  const removedState = [];
  const errors = [];

  // Sweeps both multiplexers rather than the one we're inside — reset is
  // normally run from a plain shell, and it must not leave a live window behind
  // after removing the worktree out from under it.
  for (const path of paths) {
    const window = deps.closeWorktreeWindow(path);
    if (window) removedWindows.push(window);
  }

  const registeredPaths = new Set(registered.map((wt) => resolve(wt.path)));
  for (const path of paths) {
    let registeredRemoveError = null;
    if (registeredPaths.has(path)) {
      const res = deps.git(primary, ["worktree", "remove", "--force", path]);
      if (res.status !== 0) registeredRemoveError = errorText(res, `couldn't remove registered worktree ${path}`);
    }

    // Recover paths Git no longer recognizes (the failure mode that leaves an
    // empty directory and causes setup to run without package.json). A
    // configured path is only treated as stale when its template is
    // branch-specific; registered/session-backed paths are already proven.
    const proven =
      registeredPaths.has(path) ||
      sessions.some((session) => session.worktreePath && resolve(session.worktreePath) === path) ||
      (path === resolve(expected) && branchSpecificExpected);
    if (proven && deps.existsSync(path)) {
      try {
        deps.removeDir(path);
      } catch (err) {
        errors.push(`couldn't remove stale worktree ${path}: ${err.message}`);
      }
    }
    if (!deps.existsSync(path)) removedWorktrees.push(path);
    else if (registeredRemoveError) errors.push(registeredRemoveError);
  }

  // Drop stale administrative entries before deleting the local branch.
  const prune = deps.git(primary, ["worktree", "prune"]);
  if (prune.status !== 0) errors.push(errorText(prune, "git worktree prune failed"));

  const local = deps.git(primary, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  let removedBranch = false;
  if (local.status === 0) {
    const del = deps.git(primary, ["branch", "-D", branch]);
    if (del.status === 0) removedBranch = true;
    else errors.push(errorText(del, `couldn't delete local branch ${branch}`));
  }

  // Delete readable records scoped to this repository, plus every exact
  // path-hash record (which also catches a corrupt/unreadable JSON file).
  const sessionKeys = new Set([...paths].map((path) => deps.sessionKey(path)));
  for (const session of sessions) {
    const pathMatch = session.worktreePath && paths.has(resolve(session.worktreePath));
    const repoMatch = session.branch === branch && repo && session.repo === repo;
    if (pathMatch || repoMatch) sessionKeys.add(session.key || deps.sessionKey(session.worktreePath));
  }
  for (const key of sessionKeys) {
    if (deps.deleteSession(key)) removedState.push(`session:${key}`);
  }

  // Viewer state is keyed by the hash of whichever checkout path it ran from,
  // so clear the primary checkout and every recovered worktree path.
  for (const root of new Set([resolve(primary), ...paths])) {
    const stateDir = deps.orbitDirFor(root, branch);
    if (!deps.existsSync(stateDir)) continue;
    try {
      deps.removeDir(stateDir);
      removedState.push(stateDir);
    } catch (err) {
      errors.push(`couldn't remove state ${stateDir}: ${err.message}`);
    }
  }

  return {
    ok: errors.length === 0,
    branch,
    repo,
    paths: [...paths],
    removedWindows,
    removedWorktrees,
    removedBranch,
    removedState,
    errors,
    error: errors.join("; ") || null,
  };
}

export async function runResetCommand(branch) {
  if (branch === "--help" || branch === "-h") {
    console.log("usage: orbit-diff reset <branch>");
    console.log("removes the local worktree, branch, review window, sessions, and cached branch state");
    return 0;
  }
  const result = await resetBranch(branch);
  if (!result.ok) {
    console.error(`orbit-diff: reset failed: ${result.error}`);
    return 1;
  }

  console.log(`orbit-diff: reset ${result.branch}`);
  console.log(`  worktrees: ${result.removedWorktrees.length || "none"}`);
  console.log(`  local branch: ${result.removedBranch ? "deleted" : "not present"}`);
  console.log(`  state entries: ${result.removedState.length || "none"}`);
  console.log("  remote branch: untouched");
  return 0;
}
