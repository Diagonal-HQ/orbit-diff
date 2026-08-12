// Presentation helpers shared by the two places orbit-diff renders PR state:
// the PR manager's overview/meta panes (`orbit-diff prs`) and the viewer's
// full-screen overview (`O`). Pure — no Ink, no `gh` — so both can import them
// and the two views can't drift apart on what a failing check looks like.

export const CHECK_GLYPH = {
  pass: { char: "✓", color: "green" },
  fail: { char: "✗", color: "red" },
  pending: { char: "●", color: "yellow" },
};

// Sort order for checks: the ones needing attention first, so a long list
// truncated to the available rows still shows what's broken.
export const checkRank = (s) => (s === "fail" ? 0 : s === "pending" ? 1 : 2);

export function truncate(s, max) {
  s = String(s ?? "");
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}

// A PR's review decision as text + colour.
export function reviewStateLabel(decision) {
  const map = {
    APPROVED: { text: "approved", color: "green" },
    CHANGES_REQUESTED: { text: "changes requested", color: "red" },
    REVIEW_REQUIRED: { text: "review required", color: "yellow" },
  };
  return map[decision] || { text: decision ? decision.toLowerCase() : "no reviews", color: "gray" };
}

// Whether it can merge, as text + colour.
export function mergeStateLabel(pr) {
  if (!pr) return { text: "unknown", color: "gray" };
  if (pr.mergeable === "CONFLICTING") return { text: "conflicts", color: "red" };
  if (pr.mergeable === "MERGEABLE") return { text: "clean", color: "green" };
  return { text: (pr.mergeable || "unknown").toLowerCase(), color: "gray" };
}

// A review submission's verdict as a short label + colour, for the conversation
// stream. `COMMENTED` is deliberately quiet — it's the most common and least
// significant of the three.
export function reviewVerdictLabel(state) {
  const map = {
    APPROVED: { text: "approved", color: "green" },
    CHANGES_REQUESTED: { text: "requested changes", color: "red" },
    COMMENTED: { text: "reviewed", color: "cyan" },
    DISMISSED: { text: "review dismissed", color: "gray" },
    PENDING: { text: "pending review", color: "gray" },
  };
  return map[state] || { text: (state || "reviewed").toLowerCase(), color: "cyan" };
}

// "3d" / "4h" / "12m" / "now" — a compact age for a timestamp, so a
// conversation reads as a sequence without eating a column of dates. `nowMs` is
// injectable for tests. Returns "" for anything unparseable.
export function relativeTime(iso, nowMs = Date.now()) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const secs = Math.max(0, Math.round((nowMs - t) / 1000));
  if (secs < 60) return "now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.round(days / 365)}y`;
}
