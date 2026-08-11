// "Is this PR waiting on me, waiting on someone else, or actually blocked?"
//
// GitHub answers that across half a dozen unrelated fields — `mergeStateStatus`
// is `BLOCKED` for nearly every open PR and never says why, `reviewDecision`
// ignores CI, the check rollup ignores reviews, and unresolved review threads
// live in a different API altogether. This turns the lot into one verdict and a
// short list of specific, named reasons.
//
// Pure and injectable so the whole decision table is testable without `gh`.

import { checkState } from "./pr.mjs";

// Highest-priority verdict wins. "on you" beats everything: it's the only one
// that means the PR is going nowhere until you personally act.
const RANK = { you: 0, blocked: 1, waiting: 2, ready: 3 };

const reason = (kind, glyph, color, text, detail = "", you = false) =>
  ({ kind, glyph, color, text, detail, you });

// Join a few names for a detail line without letting it run away.
function names(list, max = 3) {
  const arr = list.filter(Boolean);
  if (!arr.length) return "";
  if (arr.length <= max) return arr.join(", ");
  return `${arr.slice(0, max).join(", ")} +${arr.length - max}`;
}

// `ov` is a loaded prOverview; `me` the viewer's login (null if unknown);
// `threads` the review threads from `reviewThreads()` (may be null when the
// extra call failed — unresolved threads are simply not reported then).
//
// Returns { verdict, headline, reasons }. `verdict` is one of:
//   "you"     — it needs something from you
//   "blocked" — something concrete is wrong (conflicts, red CI)
//   "waiting" — waiting on other people or on CI to finish
//   "ready"   — nothing left in the way
//   "closed"  — merged or closed, nothing to do
export function prStatus(ov, { me = null, threads = null } = {}) {
  if (!ov || ov.error) {
    return { verdict: "waiting", headline: "Status unavailable", reasons: [] };
  }

  const state = String(ov.state || "OPEN").toUpperCase();
  if (state === "MERGED") {
    return { verdict: "closed", headline: "Merged", reasons: [] };
  }
  if (state === "CLOSED") {
    return { verdict: "closed", headline: "Closed without merging", reasons: [] };
  }

  const author = ov.author?.login || null;
  const mine = !!me && me === author;
  const base = ov.baseRefName || "the base branch";
  const reasons = [];

  if (ov.isDraft) {
    reasons.push(reason("draft", "✎", "gray", "Draft", "mark it ready for review when it is", mine));
  }

  // Conflicts and red CI are the author's to fix, so they land on you when it's
  // your PR.
  if (ov.mergeable === "CONFLICTING") {
    reasons.push(reason("conflict", "✗", "red", `Conflicts with ${base}`, "rebase or merge to resolve", mine));
  }

  const runs = ov.checkRuns || [];
  const failing = runs.filter((c) => checkState(c) === "fail");
  const pending = runs.filter((c) => checkState(c) === "pending");
  if (failing.length) {
    reasons.push(reason(
      "checks-failing", "✗", "red",
      `${failing.length} check${failing.length === 1 ? "" : "s"} failing`,
      names(failing.map((c) => c.name || c.context || c.workflowName)),
      mine,
    ));
  }
  if (pending.length) {
    reasons.push(reason(
      "checks-running", "●", "yellow",
      `${pending.length} check${pending.length === 1 ? "" : "s"} still running`,
      names(pending.map((c) => c.name || c.context || c.workflowName)),
    ));
  }

  // Reviews. CHANGES_REQUESTED puts the ball in the author's court; a pending
  // request puts it in the reviewer's — and we care loudly when that's you.
  const requested = (ov.reviewRequests || []).map((r) => r.login || r.name || r.slug).filter(Boolean);
  const decision = ov.reviewDecision || null;
  const yourReview = !!me && requested.includes(me);

  if (decision === "CHANGES_REQUESTED") {
    const who = names((ov.reviews || [])
      .filter((r) => r.state === "CHANGES_REQUESTED")
      .map((r) => r.author?.login));
    reasons.push(reason("changes-requested", "✎", "red", "Changes requested", who ? `by ${who}` : "", mine));
  } else if (decision === "REVIEW_REQUIRED" || decision === null) {
    if (yourReview) {
      reasons.push(reason("your-review", "◆", "magenta", "Your review is requested", "", true));
      const others = requested.filter((r) => r !== me);
      if (others.length) {
        reasons.push(reason("review-others", "◷", "yellow", "Also waiting on", names(others)));
      }
    } else if (requested.length) {
      reasons.push(reason("review-pending", "◷", "yellow", "Waiting on review", names(requested)));
    } else if (decision === "REVIEW_REQUIRED") {
      reasons.push(reason("review-needed", "◷", "yellow", "Needs a review", "no reviewer requested yet"));
    }
  }

  // Unresolved threads block the merge button in most protected repos, and are
  // invisible in every other field.
  if (Array.isArray(threads)) {
    const open = threads.filter((t) => !t.isResolved && !t.isOutdated);
    if (open.length) {
      reasons.push(reason(
        "threads", "◷", "yellow",
        `${open.length} unresolved thread${open.length === 1 ? "" : "s"}`,
        names([...new Set(open.map((t) => t.path).filter(Boolean))]),
        mine,
      ));
    }
  }

  const mergeState = String(ov.mergeStateStatus || "").toUpperCase();
  if (mergeState === "BEHIND") {
    reasons.push(reason("behind", "↓", "yellow", `Behind ${base}`, "update the branch", mine));
  }
  // Only worth saying when nothing above explained it — otherwise it's noise on
  // top of the real reason.
  if (mergeState === "BLOCKED" && reasons.length === 0) {
    reasons.push(reason("protected", "◷", "yellow", "Blocked by branch protection", "a required rule isn't satisfied"));
  }

  if (ov.autoMergeRequest) {
    reasons.push(reason("auto-merge", "⏻", "magenta", "Auto-merge is on", "it lands by itself once this clears"));
  }

  // The verdict is the most urgent thing in the list.
  let verdict = "ready";
  for (const r of reasons) {
    if (r.kind === "auto-merge") continue; // informational, never the verdict
    const level = r.you ? "you" : r.color === "red" ? "blocked" : "waiting";
    if (RANK[level] < RANK[verdict]) verdict = level;
  }

  return { verdict, headline: headlineFor(verdict, reasons, mine), reasons };
}

function headlineFor(verdict, reasons, mine) {
  if (verdict === "ready") {
    return reasons.some((r) => r.kind === "auto-merge") ? "Ready — auto-merge will land it" : "Ready to merge";
  }
  if (verdict === "you") return mine ? "Waiting on you (your PR)" : "Waiting on you";
  if (verdict === "blocked") return "Blocked";
  return "Waiting on others";
}

export const VERDICT_STYLE = {
  you: { color: "magenta", glyph: "◆" },
  blocked: { color: "red", glyph: "✗" },
  waiting: { color: "yellow", glyph: "◷" },
  ready: { color: "green", glyph: "✓" },
  closed: { color: "gray", glyph: "·" },
};
