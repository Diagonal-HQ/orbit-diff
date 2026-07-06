import { spawnSync } from "node:child_process";
import { langFor } from "./highlight.mjs";

const BUF = 64 * 1024 * 1024;

function git(args) {
  return spawnSync("git", args, { encoding: "utf8", maxBuffer: BUF });
}

// List this repo's git worktrees as [{ path, branch, head, detached, bare }],
// parsed from `git worktree list --porcelain`. The first entry is the main
// working tree. `branch` is the short name (no refs/heads/) or null when the
// worktree is detached/bare. Returns [] when git can't answer.
export function listWorktrees() {
  const res = git(["worktree", "list", "--porcelain"]);
  if (res.status !== 0 || !res.stdout) return [];
  const out = [];
  let cur = null;
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice(9), branch: null, head: null, detached: false, bare: false };
    } else if (!cur) {
      continue; // records only appear after a `worktree` line
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      cur.detached = true;
    } else if (line === "bare") {
      cur.bare = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Load a patch to view.
//
// With explicit args, they pass straight through to `git diff` (e.g. a range
// like `main..feature`). With no args we show *everything outstanding on the
// branch*: work committed since the branch left its base, plus uncommitted
// changes, plus untracked new files — no range to specify.
export function loadDiff(args) {
  if (args.length > 0) {
    const res = git(["diff", "--no-color", "--no-ext-diff", ...args]);
    if (res.status !== 0 && res.stderr) {
      throw new Error(res.stderr.trim() || `git diff exited ${res.status}`);
    }
    return res.stdout;
  }
  return outstandingDiff();
}

// A short human label for whatever the no-arg default resolved to.
export function defaultSource() {
  const { ref } = branchBase();
  return ref === "HEAD" ? "working tree" : `${ref}…worktree +untracked`;
}

function outstandingDiff() {
  const { commit: base } = branchBase();
  // `git diff <base>` compares that commit to the working tree, so it already
  // spans both branch commits and uncommitted edits. Untracked files aren't in
  // the tree git compares, so we synthesize a new-file patch for each.
  const tracked = git(["diff", "--no-color", "--no-ext-diff", base]);
  const parts = [tracked.stdout];
  for (const file of untrackedFiles()) {
    parts.push(newFilePatch(file));
  }
  return parts.filter(Boolean).join("");
}

// Where this branch diverged from the repo's default branch: returns both the
// merge-base commit (to diff against) and a human ref name (to label). Falls
// back to HEAD (show only uncommitted work) if no base branch is found.
function branchBase() {
  const candidates = [];
  const originHead = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (originHead.status === 0 && originHead.stdout.trim()) {
    candidates.push(originHead.stdout.trim().replace("refs/remotes/", ""));
  }
  candidates.push("main", "master");
  for (const ref of candidates) {
    if (git(["rev-parse", "--verify", "--quiet", ref]).status !== 0) continue;
    const mb = git(["merge-base", ref, "HEAD"]);
    if (mb.status === 0 && mb.stdout.trim()) return { commit: mb.stdout.trim(), ref };
  }
  return { commit: "HEAD", ref: "HEAD" };
}

function untrackedFiles() {
  const res = git(["ls-files", "--others", "--exclude-standard"]);
  if (res.status !== 0) return [];
  return res.stdout.split("\n").filter(Boolean);
}

// `--no-index` diffs an untracked file against /dev/null, yielding a proper
// "new file" patch. It exits 1 precisely because there's a difference.
function newFilePatch(file) {
  const res = git(["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", file]);
  return res.stdout || "";
}

// Parse a unified-diff patch into structured files -> hunks -> lines.
//
// Each line carries its old/new line numbers so search results can jump the
// viewer to the right place, mirroring how GitHub anchors to a line.
export function parseDiff(patch) {
  const files = [];
  let file = null;
  let oldNum = 0;
  let newNum = 0;

  const push = () => {
    if (file) files.push(file);
  };

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git")) {
      push();
      file = {
        oldPath: null,
        newPath: null,
        path: "",
        status: "modified",
        additions: 0,
        deletions: 0,
        lines: [], // flat list across all hunks, for simple scrolling
      };
      continue;
    }
    if (!file) continue;

    if (raw.startsWith("--- ")) {
      file.oldPath = stripPrefix(raw.slice(4));
      continue;
    }
    if (raw.startsWith("+++ ")) {
      file.newPath = stripPrefix(raw.slice(4));
      file.path = file.newPath || file.oldPath || file.path;
      continue;
    }
    if (raw.startsWith("new file")) {
      file.status = "added";
      continue;
    }
    if (raw.startsWith("deleted file")) {
      file.status = "deleted";
      continue;
    }
    if (raw.startsWith("rename ")) {
      file.status = "renamed";
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(raw);
      if (m) {
        oldNum = Number(m[1]);
        newNum = Number(m[2]);
      }
      file.lines.push({ type: "hunk", content: raw, oldNum: null, newNum: null });
      continue;
    }
    // Skip the noise headers between the diff line and the hunks.
    if (
      raw.startsWith("index ") ||
      raw.startsWith("similarity ") ||
      raw.startsWith("old mode") ||
      raw.startsWith("new mode") ||
      raw.startsWith("Binary files")
    ) {
      continue;
    }

    const marker = raw[0];
    if (marker === "+") {
      file.additions++;
      file.lines.push({ type: "add", content: raw.slice(1), oldNum: null, newNum: newNum++ });
    } else if (marker === "-") {
      file.deletions++;
      file.lines.push({ type: "del", content: raw.slice(1), oldNum: oldNum++, newNum: null });
    } else if (marker === " ") {
      file.lines.push({ type: "context", content: raw.slice(1), oldNum: oldNum++, newNum: newNum++ });
    }
    // A trailing "\ No newline at end of file" and blank tail lines fall through.
  }
  push();

  // Derive display name and syntax language for each file.
  for (const f of files) {
    f.name = f.path;
    f.lang = langFor(f.name);
  }
  return files;
}

function stripPrefix(p) {
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}
