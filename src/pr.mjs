// PR-management data layer: list the review-worthy PRs for the current repo and
// fetch a per-PR overview, both via the `gh` CLI. Kept separate from
// github.mjs (which posts annotations onto a branch's PR) because this is the
// other direction — discovering the PRs waiting on *me* and driving a
// configured workflow command for each.
//
// Scope is the current repo: `gh pr list` is repo-scoped by default, so the
// searches below implicitly carry `repo:<owner>/<name>`.

import { spawn } from "node:child_process";

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

// One `gh pr list --search` pass. Returns [] on any gh error (the caller merges
// several passes and would rather show a partial list than blow up).
async function search(query) {
  const res = await gh(["pr", "list", "--search", query, "--limit", "50", "--json", LIST_FIELDS]);
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

// List the open, non-draft PRs in this repo that are either assigned to me or
// awaiting my review. Merges the two searches, dedupes by number, tags each with
// the repo slug, and sorts newest-updated first.
//
// Throws only when `gh` itself is unusable (not installed, not a GitHub repo, not
// authed) — detected by a repo lookup failing; an empty result is a valid [].
export async function listReviewPRs() {
  const repo = await repoSlug();
  if (!repo) {
    throw new Error("`gh` couldn't identify a GitHub repo here (is it installed, authed, and a GitHub remote?)");
  }

  const [reviews, assigned] = await Promise.all([
    search("is:open draft:false review-requested:@me"),
    search("is:open draft:false assignee:@me"),
  ]);

  const byNumber = new Map();
  for (const pr of [...reviews, ...assigned]) {
    if (pr.isDraft) continue; // belt-and-suspenders; the search already excludes drafts
    if (!byNumber.has(pr.number)) byNumber.set(pr.number, { ...pr, repo });
  }

  return [...byNumber.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
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

// Fetch the detailed overview for one PR. Resolves an object (with a derived
// `checks` summary) or { error } so the panel can show a reason instead of
// nothing.
export async function prOverview(number) {
  const res = await gh(["pr", "view", String(number), "--json", VIEW_FIELDS]);
  if (res.status !== 0 || !res.stdout.trim()) {
    return { error: res.stderr.trim().split("\n").slice(-1)[0] || `gh exited ${res.status}` };
  }
  try {
    const pr = JSON.parse(res.stdout);
    return { ...pr, checks: summarizeChecks(pr.statusCheckRollup) };
  } catch (err) {
    return { error: `couldn't parse gh output: ${err.message}` };
  }
}

// Single-quote a value for safe interpolation into a POSIX shell command.
function shq(s) {
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
  };
  return template.replace(/\{(branch|base|number|repo|title|url)\}/g, (_, k) => shq(tokens[k]));
}
