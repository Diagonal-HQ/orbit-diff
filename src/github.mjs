// GitHub integration: detect the PR for the current branch, post diff
// annotations onto it as inline review comments, and run the review verdicts
// (`g` in the viewer) — approve, approve + merge when ready, request changes.
//
// Annotations already carry everything a GitHub review comment needs — a file
// path, a real line-number span (new side preferred, old side for pure
// deletions), and the reviewer's text. This module translates each one into a
// `POST /pulls/{n}/comments` payload and submits them independently, so a line
// that doesn't exist on the pushed PR head (e.g. an uncommitted local edit)
// is skipped and reported rather than failing the whole batch.
//
// The verdicts at the bottom take the other route: ONE `POST /pulls/{n}/reviews`
// carrying every annotation as an inline comment plus the verdict itself. That's
// what makes them land as a single review in the PR timeline (with a real
// "requested changes" state) rather than a scatter of standalone comments.

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
  const view = await gh(["pr", "view", "--json", "number,url,headRefOid,state,author"]);
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

  return {
    number: pr.number,
    url: pr.url,
    headRefOid: pr.headRefOid,
    repo,
    author: (pr.author && pr.author.login) || null,
  };
}

// The login `gh` is authenticated as. Used by the review verdicts to take the
// PR off your own plate — we unassign *whoever is running orbit-diff* rather
// than a name baked into the source, so this does the right thing for everyone
// and keeps doing it if your handle changes. Null when gh can't say.
export async function currentUser(run = gh) {
  const res = await run(["api", "user", "--jq", ".login"]);
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
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

// ---- review verdicts (`g` in the viewer) ----
//
// Everything below is outward-facing and effectively irreversible from here: a
// submitted review can't be unsubmitted, and enabling auto-merge can land a PR
// without you touching it again. Each is therefore only ever reached from an
// explicit pick in the verdict menu, and each reports exactly what it did.
//
// The exported ones take a trailing `run` that defaults to the real `gh`, so the
// tests can drive the ordering — approve-before-merge, who gets assigned — with
// nothing leaving the machine.

// Annotations as inline comments for the REVIEWS api. Same anchoring as
// `buildComments`, minus the per-comment `commit_id` — a review carries one
// commit id at the top level instead.
export function buildReviewComments(annotations, files) {
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
    const payload = { path: a.file, body: text, side: anchor.side, line: anchor.end };
    if (anchor.start !== anchor.end) {
      payload.start_line = anchor.start;
      payload.start_side = anchor.side;
    }
    comments.push(payload);
  }
  return { comments, skipped };
}

// A short reason out of a failed `gh` call. The API's JSON error goes to stderr;
// its last line is the useful part.
function reasonFrom(res, fallback) {
  const line = res.stderr.trim().split("\n").filter(Boolean).slice(-1)[0];
  return line || fallback || `gh exited ${res.status}`;
}

// Submit one review: `event` is APPROVE | REQUEST_CHANGES | COMMENT, `comments`
// the inline ones (may be empty). Resolves { ok } / { ok:false, error }.
//
// GitHub rejects the whole review if ANY comment fails to anchor — unlike the
// per-comment path, there's no partial success — so a rejection here leaves the
// PR untouched and the caller reports it rather than half-applying a verdict.
async function postReview(run, pr, { event, comments = [], body = "" }) {
  const payload = { commit_id: pr.headRefOid, event };
  if (body) payload.body = body;
  if (comments.length) payload.comments = comments;
  const res = await run(
    [
      "api", "--method", "POST",
      "-H", "Accept: application/vnd.github+json",
      `repos/${pr.repo}/pulls/${pr.number}/reviews`,
      "--input", "-",
    ],
    JSON.stringify(payload),
  );
  if (res.status === 0) return { ok: true };
  return { ok: false, error: reasonFrom(res, "couldn't submit the review") };
}

// Add and/or remove assignees. Both lists are optional; empty ones are dropped,
// so this is a no-op call rather than an error when there's nothing to change.
async function editAssignees(run, pr, { add = [], remove = [] }) {
  const args = ["pr", "edit", String(pr.number), "--repo", pr.repo];
  for (const login of add) if (login) args.push("--add-assignee", login);
  for (const login of remove) if (login) args.push("--remove-assignee", login);
  if (args.length === 5) return { ok: true }; // nothing to do
  const res = await run(args);
  if (res.status === 0) return { ok: true };
  return { ok: false, error: reasonFrom(res, "couldn't update assignees") };
}

// Which merge method to use for auto-merge. An explicit `configured` value wins;
// otherwise ask the repo what it allows and prefer squash → merge → rebase.
// Guessing wrong is a confusing failure ("Squash merging is not allowed"), and
// the repo already knows the answer, so it's worth the extra call.
async function mergeMethodFor(run, repo, configured) {
  const want = String(configured || "").trim().toLowerCase();
  if (want === "squash" || want === "merge" || want === "rebase") return want;
  const res = await run([
    "repo", "view", repo, "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed",
  ]);
  if (res.status !== 0) return "squash";
  try {
    const allowed = JSON.parse(res.stdout);
    if (allowed.squashMergeAllowed) return "squash";
    if (allowed.mergeCommitAllowed) return "merge";
    if (allowed.rebaseMergeAllowed) return "rebase";
  } catch {
    /* fall through to the default */
  }
  return "squash";
}

// Turn on "merge when ready" — GitHub's auto-merge, which lands the PR once its
// checks and approvals pass. Resolves { ok, method } / { ok:false, error }.
export async function enableAutoMerge(pr, configuredMethod, run = gh) {
  const method = await mergeMethodFor(run, pr.repo, configuredMethod);
  const res = await run(["pr", "merge", String(pr.number), "--repo", pr.repo, "--auto", `--${method}`]);
  if (res.status === 0) return { ok: true, method };
  return { ok: false, error: reasonFrom(res, "couldn't enable auto-merge"), method };
}

// Approve the PR and take it off your plate.
//
// `merge` also turns on auto-merge. The approval goes first and its failure
// aborts: enabling auto-merge on a PR you haven't actually approved is the one
// ordering here that could land unreviewed code. Unassigning is bookkeeping, so
// its failure is reported but doesn't undo the approval.
//
// Resolves { ok, approved, unassigned, autoMerge, method, warnings[], error? }.
export async function approvePR(pr, { merge = false, mergeMethod = "" } = {}, run = gh) {
  const out = { ok: false, approved: false, unassigned: false, autoMerge: false, method: null, warnings: [] };

  const review = await postReview(run, pr, { event: "APPROVE" });
  if (!review.ok) return { ...out, error: review.error };
  out.approved = true;
  out.ok = true;

  if (merge) {
    const am = await enableAutoMerge(pr, mergeMethod, run);
    out.autoMerge = am.ok;
    out.method = am.method;
    if (!am.ok) out.warnings.push(`auto-merge: ${am.error}`);
  } else {
    // Approving and moving on: the PR is no longer yours to look at. When it's
    // set to merge itself we leave the assignment alone — you're still the one
    // watching it land.
    const me = await currentUser(run);
    if (!me) out.warnings.push("couldn't tell who you are, so assignment is unchanged");
    else {
      const edit = await editAssignees(run, pr, { remove: [me] });
      out.unassigned = edit.ok;
      if (!edit.ok) out.warnings.push(`unassign: ${edit.error}`);
    }
  }
  return out;
}

// Request changes: every annotation as an inline comment, submitted as ONE
// review with the REQUEST_CHANGES verdict, then hand the PR back to its author.
//
// Resolves { ok, posted, skipped, reassigned, author, warnings[], error? }.
export async function requestChanges(pr, annotations, files, run = gh) {
  const { comments, skipped } = buildReviewComments(annotations, files);
  const out = {
    ok: false, posted: 0, skipped: skipped.length,
    reassigned: false, author: pr.author || null, warnings: [],
  };

  // GitHub requires a body when there are no inline comments to carry the
  // verdict, and rejects the review outright otherwise.
  const body = comments.length ? "" : "Requesting changes.";
  const review = await postReview(run, pr, { event: "REQUEST_CHANGES", comments, body });
  if (!review.ok) return { ...out, error: review.error };
  out.posted = comments.length;
  out.ok = true;

  // Off your plate, onto the author's. Both halves are reported separately so a
  // partial result reads honestly.
  const me = await currentUser(run);
  const author = pr.author;
  if (!author) out.warnings.push("couldn't tell who the author is, so they weren't assigned");
  const edit = await editAssignees(run, pr, {
    add: author && author !== me ? [author] : [],
    remove: me ? [me] : [],
  });
  out.reassigned = edit.ok && !!author;
  if (!edit.ok) out.warnings.push(`assignees: ${edit.error}`);
  else if (!me) out.warnings.push("couldn't tell who you are, so you weren't unassigned");
  return out;
}
