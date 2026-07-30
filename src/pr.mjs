// PR-management data layer: list the review-worthy PRs for the current repo and
// fetch a per-PR overview, both via the `gh` CLI. Kept separate from
// github.mjs (which posts annotations onto a branch's PR) because this is the
// other direction — discovering the PRs waiting on *me* and driving a
// configured workflow command for each.
//
// Scope is the current repo: `gh pr list` is repo-scoped by default, so the
// searches below implicitly carry `repo:<owner>/<name>`.

import { spawn } from "node:child_process";
import { homedir } from "node:os";

// Run `gh` asynchronously. Resolves { status, stdout, stderr } and never
// rejects, so callers branch on status. Mirrors the helper in github.mjs.
function gh(args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ status: -1, stdout: "", stderr: err.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ status: -1, stdout, stderr: err.message }));
    child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

// The JSON fields we pull for each PR in the list view.
const LIST_FIELDS = [
  "number", "title", "author", "headRefName", "baseRefName",
  "isDraft", "reviewDecision", "updatedAt", "url", "additions", "deletions", "labels",
].join(",");

// Unlike the scoped Mine searches below, the All tab must not go through
// GitHub's search API: search results are capped, and the old query also
// excluded drafts. Walk the repository's open-PR connection directly instead.
// `gh api --paginate` supplies `endCursor` until pageInfo.hasNextPage is false;
// `--slurp` wraps the page objects in one JSON array for straightforward
// parsing.
const ALL_PRS_QUERY = `
  query($owner: String!, $name: String!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      nameWithOwner
      pullRequests(
        first: 100
        after: $endCursor
        states: OPEN
        orderBy: {field: UPDATED_AT, direction: DESC}
      ) {
        nodes {
          number
          title
          author { login }
          headRefName
          baseRefName
          isDraft
          reviewDecision
          updatedAt
          url
          additions
          deletions
          labels(first: 100) {
            nodes { name color description }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

// One `gh pr list --search` pass. Returns [] on any gh error (the caller merges
// several passes and would rather show a partial list than blow up).
async function search(query, limit = 50) {
  const res = await gh(["pr", "list", "--search", query, "--limit", String(limit), "--json", LIST_FIELDS]);
  if (res.status !== 0 || !res.stdout.trim()) return [];
  try {
    return JSON.parse(res.stdout);
  } catch {
    return [];
  }
}

// The current repo's owner/name, so command templates can fill `{repo}`.
async function repoSlug() {
  const res = await gh(["repo", "view", "--json", "nameWithOwner"]);
  if (res.status !== 0) return null;
  try {
    return JSON.parse(res.stdout).nameWithOwner || null;
  } catch {
    return null;
  }
}

// List the open PRs in this repo that are assigned to me, awaiting my review, or
// authored by me (my own PRs always show up here). Drafts are included. Merges
// the searches, dedupes by number, tags each with the repo slug, and sorts
// newest-updated first.
//
// Throws only when `gh` itself is unusable (not installed, not a GitHub repo, not
// authed) — detected by a repo lookup failing; an empty result is a valid [].
export async function listReviewPRs() {
  const repo = await repoSlug();
  if (!repo) {
    throw new Error("`gh` couldn't identify a GitHub repo here (is it installed, authed, and a GitHub remote?)");
  }

  const [reviews, assigned, authored] = await Promise.all([
    search("is:open review-requested:@me"),
    search("is:open assignee:@me"),
    search("is:open author:@me"),
  ]);

  const byNumber = new Map();
  for (const pr of [...reviews, ...assigned, ...authored]) {
    if (!byNumber.has(pr.number)) byNumber.set(pr.number, { ...pr, repo });
  }

  return [...byNumber.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// List every open PR in this repo, drafts included, regardless of who's
// assigned or requested to review — the "All" tab. The optional runner is a
// test seam; production callers use the gh helper above.
export async function listAllPRs(runGh = gh) {
  const res = await runGh([
    "api", "graphql", "--paginate", "--slurp",
    "-F", "owner={owner}",
    "-F", "name={repo}",
    "-f", `query=${ALL_PRS_QUERY}`,
  ]);
  if (res.status !== 0 || !res.stdout.trim()) {
    throw new Error("`gh` couldn't identify a GitHub repo here (is it installed, authed, and a GitHub remote?)");
  }

  try {
    const pages = JSON.parse(res.stdout);
    const repo = pages[0]?.data?.repository?.nameWithOwner;
    if (!repo) throw new Error("missing repository");

    const prs = pages.flatMap((page) => page?.data?.repository?.pullRequests?.nodes || []);
    return prs
      .map((pr) => ({ ...pr, labels: pr.labels?.nodes || [], repo }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  } catch {
    throw new Error("`gh` returned an invalid response while listing this repo's pull requests");
  }
}

// Resolve the PR for a specific branch straight from `gh`, bypassing the loaded
// tab lists. The Mine/All tabs are open-only, so a branch can have a real PR
// that isn't in either loaded set — this is the fallback for `o` on a worktree
// when the in-memory lookup misses. `gh pr view
// <branch>` returns that branch's associated PR whether it's a draft, closed,
// or merged. Returns { number, url, state } or null (no PR / gh error).
export async function findPrForBranch(branch) {
  if (!branch) return null;
  const res = await gh(["pr", "view", branch, "--json", "number,url,state"]);
  if (res.status !== 0 || !res.stdout.trim()) return null;
  try {
    const pr = JSON.parse(res.stdout);
    return pr && pr.url ? pr : null;
  } catch {
    return null;
  }
}

// Classify one status check as "pass" | "fail" | "pending". GitHub reports each
// either as a CheckRun (has `conclusion`/`status`) or a legacy StatusContext
// (has `state`).
export function checkState(c) {
  const s = (c.conclusion || c.state || c.status || "").toUpperCase();
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(s)) return "pass";
  if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(s)) return "fail";
  return "pending"; // PENDING, QUEUED, IN_PROGRESS, EXPECTED, …
}

// Collapse a status-check rollup to the latest run per check. GitHub can return
// several entries for the same check (re-runs), so we key by workflow + check
// name and keep the one that started (or completed) most recently.
export function latestChecks(rollup) {
  if (!Array.isArray(rollup)) return [];
  const byName = new Map();
  for (const c of rollup) {
    const name = c.name || c.context || c.workflowName || "check";
    const key = `${c.workflowName || ""} ${name}`;
    const t = c.startedAt || c.completedAt || "";
    const prev = byName.get(key);
    if (!prev || (prev._t || "") <= t) byName.set(key, { ...c, _t: t });
  }
  return [...byName.values()];
}

// Roll a PR's status checks up into { passing, failing, pending, total }.
export function summarizeChecks(rollup) {
  const out = { passing: 0, failing: 0, pending: 0, total: 0 };
  if (!Array.isArray(rollup)) return out;
  for (const c of rollup) {
    out.total++;
    const s = checkState(c);
    if (s === "pass") out.passing++;
    else if (s === "fail") out.failing++;
    else out.pending++;
  }
  return out;
}

const VIEW_FIELDS = [
  "number", "title", "author", "headRefName", "baseRefName", "state", "isDraft",
  "reviewDecision", "mergeable", "mergeStateStatus", "additions", "deletions",
  "changedFiles", "url", "body", "labels", "updatedAt", "createdAt",
  "statusCheckRollup", "assignees", "reviewRequests",
].join(",");

// Fetch the detailed overview for one PR, or (with no argument) the PR for
// the current branch. Resolves an object (with a derived `checks` summary) or
// { error } so the caller can show a reason instead of nothing.
export async function prOverview(number = null) {
  const res = await gh(["pr", "view", ...(number != null ? [String(number)] : []), "--json", VIEW_FIELDS]);
  if (res.status !== 0 || !res.stdout.trim()) {
    return { error: res.stderr.trim().split("\n").slice(-1)[0] || `gh exited ${res.status}` };
  }
  try {
    const pr = JSON.parse(res.stdout);
    const checkRuns = latestChecks(pr.statusCheckRollup);
    return { ...pr, checkRuns, checks: summarizeChecks(checkRuns) };
  } catch (err) {
    return { error: `couldn't parse gh output: ${err.message}` };
  }
}

// Single-quote a value for safe interpolation into a POSIX shell command.
export function shq(s) {
  return "'" + String(s ?? "").replace(/'/g, "'\\''") + "'";
}

// Fill a command template with a PR's fields. Every token is shell-quoted so a
// title with spaces/quotes can't break out of the command. Unknown tokens are
// left as-is. Returns null for an empty/whitespace template.
export function renderCommand(template, pr) {
  if (!template || !template.trim()) return null;
  const tokens = {
    branch: pr.headRefName,
    base: pr.baseRefName,
    number: pr.number,
    repo: pr.repo,
    title: pr.title,
    url: pr.url,
    path: pr.path,
  };
  return template.replace(/\{(branch|base|number|repo|title|url|path)\}/g, (_, k) => shq(tokens[k]));
}

// Fill an editor command template with a file path. Mirrors renderCommand's
// {token} substitution but for the diff viewer's `e` action: {file} becomes the
// (shell-quoted) path so a path with spaces can't break out of the command.
// Returns null for an empty/whitespace template.
export function renderEditor(template, file) {
  if (!template || !template.trim()) return null;
  return template.replace(/\{file\}/g, () => shq(file));
}

// Fill a filesystem-path template with a PR's fields. Unlike renderCommand this
// does NOT shell-quote — the result is a path, not a shell command — and it
// expands a leading `~/`. Used for `pr.worktreeDir`.
export function renderPath(template, pr) {
  const tokens = {
    branch: pr.headRefName,
    base: pr.baseRefName,
    number: pr.number,
    repo: pr.repo,
  };
  let out = template.replace(/\{(branch|base|number|repo)\}/g, (_, k) => String(tokens[k] ?? ""));
  if (out === "~") out = homedir();
  else if (out.startsWith("~/")) out = homedir() + out.slice(1);
  return out;
}
