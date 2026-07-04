// GitHub integration: detect the PR for the current branch and post diff
// annotations onto it as inline review comments.
//
// Annotations already carry everything a GitHub review comment needs — a file
// path, a real line-number span (new side preferred, old side for pure
// deletions), and the reviewer's text. This module translates each one into a
// `POST /pulls/{n}/comments` payload and submits them independently, so a line
// that doesn't exist on the pushed PR head (e.g. an uncommitted local edit)
// is skipped and reported rather than failing the whole batch.

import { spawn } from "node:child_process";

// Run `gh` asynchronously. Resolves { status, stdout, stderr } and never
// rejects, so callers branch on status rather than catching. `input`, if given,
// is written to stdin (used to hand a JSON body to `gh api --input -`).
function gh(args, input) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
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
    if (input != null) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

// Find the open PR for the current branch. Resolves { number, url, headRefOid,
// repo } when one exists, or null when there's no PR / no `gh` / not a GitHub
// repo. Cheap enough to call once on viewer start.
export async function detectPR() {
  const view = await gh(["pr", "view", "--json", "number,url,headRefOid,state"]);
  if (view.status !== 0 || !view.stdout.trim()) return null; // no PR, or gh error
  let pr;
  try {
    pr = JSON.parse(view.stdout);
  } catch {
    return null;
  }
  if (!pr || pr.state !== "OPEN" || !pr.number) return null;

  const repoRes = await gh(["repo", "view", "--json", "nameWithOwner"]);
  if (repoRes.status !== 0) return null;
  let repo;
  try {
    repo = JSON.parse(repoRes.stdout).nameWithOwner;
  } catch {
    return null;
  }
  if (!repo) return null;

  return { number: pr.number, url: pr.url, headRefOid: pr.headRefOid, repo };
}

// Resolve an annotation's index range to a GitHub comment anchor: the diff
// side and the real file line span. Prefers the new side (added/context lines
// → RIGHT); a range that is purely deletions anchors to the old side (LEFT).
// Returns null for a range with no attributable file lines (only hunk headers).
function anchorFor(file, startIdx, endIdx) {
  let rLo = null;
  let rHi = null; // new-side (RIGHT) span
  let lLo = null;
  let lHi = null; // old-side (LEFT) span
  for (let i = startIdx; i <= endIdx && i < file.lines.length; i++) {
    const l = file.lines[i];
    if (l.newNum != null) {
      if (rLo == null) rLo = l.newNum;
      rHi = l.newNum;
    } else if (l.oldNum != null) {
      if (lLo == null) lLo = l.oldNum;
      lHi = l.oldNum;
    }
  }
  if (rLo != null) return { side: "RIGHT", start: rLo, end: rHi };
  if (lLo != null) return { side: "LEFT", start: lLo, end: lHi };
  return null;
}

// Build the review-comment payloads for every annotation with text. Returns
// { comments, skipped } where each comment is ready for the PR comments API and
// `skipped` names annotations we couldn't anchor (reported back to the user).
export function buildComments(annotations, files, headRefOid) {
  const comments = [];
  const skipped = [];
  for (const a of annotations) {
    const text = a.text.trim();
    if (!text) continue;
    const file = files.find((f) => f.path === a.file);
    const anchor = file && anchorFor(file, a.startIdx, a.endIdx);
    if (!anchor) {
      skipped.push(a.file);
      continue;
    }
    const payload = {
      path: a.file,
      commit_id: headRefOid,
      body: text,
      side: anchor.side,
      line: anchor.end,
    };
    if (anchor.start !== anchor.end) {
      payload.start_line = anchor.start;
      payload.start_side = anchor.side;
    }
    comments.push(payload);
  }
  return { comments, skipped };
}

// Post one review comment via the PR comments API. Resolves { ok, error }; a
// 422 (line not part of the pushed diff) comes back as a non-fatal error so the
// caller can tally it as skipped rather than aborting the rest.
async function postComment(repo, number, payload) {
  const res = await gh(
    [
      "api",
      "--method",
      "POST",
      "-H",
      "Accept: application/vnd.github+json",
      `repos/${repo}/pulls/${number}/comments`,
      "--input",
      "-",
    ],
    JSON.stringify(payload),
  );
  if (res.status === 0) return { ok: true };
  // gh prints the API error JSON to stderr; surface a short reason.
  let reason = res.stderr.trim().split("\n").slice(-1)[0] || `gh exited ${res.status}`;
  return { ok: false, error: reason };
}

// Submit every text annotation as an inline PR review comment. Posts each
// independently so one unmappable line doesn't sink the rest. Resolves a
// summary: { posted, skipped, failed, url }.
export async function submitAnnotations(pr, annotations, files) {
  const { comments, skipped } = buildComments(annotations, files, pr.headRefOid);
  let posted = 0;
  let failed = 0;
  for (const payload of comments) {
    const res = await postComment(pr.repo, pr.number, payload);
    if (res.ok) posted++;
    else failed++;
  }
  return { posted, skipped: skipped.length, failed, url: pr.url };
}
