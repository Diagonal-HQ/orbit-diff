import { expect, test } from "bun:test";
import { remoteRepoSlug, resetBranch } from "./reset.mjs";

test("remoteRepoSlug handles SSH and HTTPS remotes", () => {
  expect(remoteRepoSlug("git@github.com:acme/widgets.git")).toBe("acme/widgets");
  expect(remoteRepoSlug("https://github.com/acme/widgets.git")).toBe("acme/widgets");
  expect(remoteRepoSlug("ssh://git@example.test/acme/widgets.git")).toBe("acme/widgets");
});

test("resetBranch removes worktrees, the local branch, and all matching state", async () => {
  const primary = "/repos/widgets";
  const worktree = "/env/feature-one";
  const oldWorktree = "/old/feature-one";
  const existing = new Set([
    worktree,
    oldWorktree,
    `${primary}/state/feature-one`,
    `${worktree}/state/feature-one`,
    `${oldWorktree}/state/feature-one`,
  ]);
  const removedDirs = [];
  const deletedSessions = [];
  const gitCalls = [];
  const killedWindows = [];

  const result = await resetBranch("origin/feature-one", {
    loadConfig: async () => ({ pr: { worktreeDir: "/env/{branch}" } }),
    listWorktrees: () => [
      { path: primary, branch: "main", bare: false },
      { path: worktree, branch: "feature-one", bare: false },
    ],
    listSessions: () => [
      {
        key: "old-session",
        branch: "feature-one",
        repo: "acme/widgets",
        worktreePath: oldWorktree,
      },
      {
        key: "other-repo",
        branch: "feature-one",
        repo: "elsewhere/widgets",
        worktreePath: "/elsewhere/feature-one",
      },
    ],
    sessionKey: (path) => `hash:${path}`,
    deleteSession: (key) => {
      deletedSessions.push(key);
      return true;
    },
    closeWorktreeWindow: (path) => {
      if (path !== worktree) return null;
      killedWindows.push("@7");
      return "@7";
    },
    orbitDirFor: (root, branch) => `${root}/state/${branch}`,
    existsSync: (path) => existing.has(path),
    removeDir: (path) => {
      removedDirs.push(path);
      existing.delete(path);
    },
    git: (_cwd, args) => {
      gitCalls.push(args);
      if (args[0] === "config") {
        return { status: 0, stdout: "git@github.com:acme/widgets.git\n", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        existing.delete(args.at(-1));
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  expect(result.ok).toBe(true);
  expect(result.branch).toBe("feature-one");
  expect(result.paths).toEqual([worktree, oldWorktree]);
  expect(result.removedBranch).toBe(true);
  expect(killedWindows).toEqual(["@7"]);
  expect(gitCalls).toContainEqual(["worktree", "remove", "--force", worktree]);
  expect(gitCalls).toContainEqual(["worktree", "prune"]);
  expect(gitCalls).toContainEqual(["branch", "-D", "feature-one"]);
  expect(removedDirs).toContain(oldWorktree);
  expect(removedDirs).toContain(`${primary}/state/feature-one`);
  expect(deletedSessions).toContain("old-session");
  expect(deletedSessions).toContain(`hash:${worktree}`);
  expect(deletedSessions).not.toContain("other-repo");
});

test("resetBranch refuses to remove a branch checked out in the primary worktree", async () => {
  let mutated = false;
  const result = await resetBranch("main", {
    listWorktrees: () => [{ path: "/repos/widgets", branch: "main", bare: false }],
    loadConfig: async () => {
      mutated = true;
      return { pr: { worktreeDir: "" } };
    },
  });

  expect(result.ok).toBe(false);
  expect(result.error).toContain("primary worktree");
  expect(mutated).toBe(false);
});

test("resetBranch does not target an unregistered shared worktree path", async () => {
  const removed = [];
  const result = await resetBranch("feature-one", {
    loadConfig: async () => ({ pr: { worktreeDir: "/env/shared" } }),
    listWorktrees: () => [{ path: "/repos/widgets", branch: "main", bare: false }],
    listSessions: () => [],
    closeWorktreeWindow: () => null,
    orbitDirFor: (root, branch) => `${root}/state/${branch}`,
    existsSync: () => false,
    removeDir: (path) => removed.push(path),
    deleteSession: () => true,
    sessionKey: (path) => `hash:${path}`,
    git: (_cwd, args) => {
      if (args[0] === "config") {
        return { status: 0, stdout: "git@github.com:acme/widgets.git\n", stderr: "" };
      }
      if (args[0] === "show-ref") return { status: 1, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  expect(result.ok).toBe(true);
  expect(result.paths).toEqual([]);
  expect(removed).toEqual([]);
});
