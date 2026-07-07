// The review-session registry: orbit-diff's record of the worktrees it spun up
// for a PR review, and everything it knows about each one — the PR, the git
// worktree, the tmux window + its three panes (setup / claude / diff), and the
// provisioned environment (the "EV" instance number the setup script reports
// back via `orbit-diff env-report`).
//
// This lives GLOBALLY under the cache home, keyed by a hash of the worktree's
// absolute path, so nothing is ever written into the repo you're reviewing:
//
//   ~/.cache/orbit-diff/sessions/<hash>.json
//
// Two processes touch these files: the PR manager (`orbit-diff prs`) writes the
// record when it starts a review, and the setup script — running inside the
// worktree — updates it through `orbit-diff env-report`. Both find the same file
// by hashing the worktree path, so no shared handle is needed.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { cacheHome } from "./paths.mjs";

// A record looks like:
//   { key, pr, branch, base, repo, url, title, worktreePath,
//     window, panes: { setup, claude, diff },
//     envInstance, envUrl, status, error, createdAt, updatedAt }
// status: "provisioning" (setup running) | "ready" | "failed".

export function sessionsDir() {
  return `${cacheHome()}/orbit-diff/sessions`;
}

// Stable key for a worktree: a short hash of its absolute path. The same path
// always maps to the same file, so the PR manager and the in-worktree
// `env-report` call agree without sharing anything else.
export function sessionKey(worktreePath) {
  return createHash("sha256").update(worktreePath).digest("hex").slice(0, 16);
}

// Absolute path of a session's JSON file. Exported so the teardown job can `rm`
// it as its final step, which is how the picker learns the teardown finished.
export function sessionPath(key) {
  return `${sessionsDir()}/${key}.json`;
}
const sessionFile = sessionPath;

// Write a full record (stamping key + updatedAt). Creates the dir as needed.
export function writeSession(record) {
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true });
  const key = record.key || sessionKey(record.worktreePath);
  const full = { ...record, key, updatedAt: new Date().toISOString() };
  writeFileSync(sessionFile(key), JSON.stringify(full, null, 2));
  return full;
}

// Read one record by key, or null when it's missing/unparseable.
export function readSession(key) {
  try {
    return JSON.parse(readFileSync(sessionFile(key), "utf8"));
  } catch {
    return null;
  }
}

// Merge `patch` over the existing record (or start a fresh one) and persist it.
export function updateSession(key, patch) {
  const existing = readSession(key) || { key };
  return writeSession({ ...existing, ...patch });
}

export function deleteSession(key) {
  try {
    rmSync(sessionFile(key), { force: true });
    return true;
  } catch {
    return false;
  }
}

// Every known session, newest-updated first. Returns [] when the dir is absent.
export function listSessions() {
  let names;
  try {
    names = readdirSync(sessionsDir());
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(`${sessionsDir()}/${name}`, "utf8")));
    } catch {
      /* skip a corrupt record */
    }
  }
  return out.sort((a, b) => ((a.updatedAt || "") < (b.updatedAt || "") ? 1 : -1));
}

export function sessionForWorktree(worktreePath) {
  return readSession(sessionKey(worktreePath));
}
