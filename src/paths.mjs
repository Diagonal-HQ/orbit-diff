// Where orbit-diff keeps its per-repo working data (the change-request handoff doc
// and the AI review/answer cache). This lives GLOBALLY, outside the repo, so an
// installed binary never writes into the tree you're reviewing:
//
//   ~/.cache/orbit-diff/<repo>-<hash>/<branch>/
//     ├── change-request.md
//     └── ai-cache/{reviews,answers}/…
//
// Honours $XDG_CACHE_HOME. Keyed by repo AND branch: <repo> is the git top-level
// directory name (readable) plus a short hash of its absolute path (so two repos
// that share a basename don't collide), and <branch> is the current git branch
// (detached HEAD falls back to the short commit).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

function git(args) {
  return spawnSync("git", args, { encoding: "utf8" });
}

// Absolute path of the repo's top level, so the location is stable no matter which
// subdirectory you launch from. Falls back to cwd when git can't answer.
export function repoRoot() {
  const r = git(["rev-parse", "--show-toplevel"]);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : process.cwd();
}

// Current branch name; detached HEAD → "detached-<shortsha>"; no repo → "nobranch".
export function branchName() {
  const r = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const b = r.status === 0 ? r.stdout.trim() : "";
  if (b && b !== "HEAD") return b;
  const c = git(["rev-parse", "--short", "HEAD"]);
  return c.status === 0 && c.stdout.trim() ? `detached-${c.stdout.trim()}` : "nobranch";
}

export function cacheHome() {
  return process.env.XDG_CACHE_HOME || `${homedir()}/.cache`;
}

// Filesystem-safe slug for a path segment (branches can contain `/`, etc.).
function slug(s) {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

// The per-repo/branch directory under the global cache home.
export function orbitDir() {
  const root = repoRoot();
  const name = slug(root.split("/").filter(Boolean).pop() || "repo");
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `${cacheHome()}/orbit-diff/${name}-${hash}/${slug(branchName())}`;
}

export function changeRequestPath() {
  return `${orbitDir()}/change-request.md`;
}

export function aiCacheDir() {
  return `${orbitDir()}/ai-cache`;
}

// Abbreviate the home dir to ~ for display in the status bar.
export function tildeify(p) {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
