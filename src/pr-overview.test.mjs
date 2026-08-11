import { expect, test } from "bun:test";
import { overviewRows, wrapText, clampScroll, overviewViewport } from "./pr-overview.mjs";
import { buildActivity, repoFromUrl } from "./pr.mjs";
import { relativeTime } from "./pr-view.mjs";

const NOW = Date.parse("2026-08-10T12:00:00Z");
const text = (rows) => rows.map((r) => r.segs.map((s) => s.text).join(""));

// ---- merging the conversation ----

test("comments, reviews and inline comments merge oldest-first", () => {
  const pr = {
    comments: [{ author: { login: "amy" }, body: "second", createdAt: "2026-08-02T00:00:00Z" }],
    reviews: [{ author: { login: "bo" }, body: "third", state: "APPROVED", submittedAt: "2026-08-03T00:00:00Z" }],
  };
  const inline = [{ login: "cy", body: "first", path: "a.js", line: 5, createdAt: "2026-08-01T00:00:00Z" }];

  const got = buildActivity(pr, inline);
  expect(got.map((e) => [e.kind, e.login])).toEqual([
    ["inline", "cy"],
    ["comment", "amy"],
    ["review", "bo"],
  ]);
});

// GitHub wraps a batch of inline comments in an empty COMMENTED review. Showing
// those as events would bury the actual conversation in "x reviewed" noise.
test("the empty review envelope around inline comments is dropped", () => {
  const pr = {
    reviews: [
      { author: { login: "amy" }, body: "", state: "COMMENTED", submittedAt: "2026-08-01T00:00:00Z" },
      { author: { login: "amy" }, body: "with words", state: "COMMENTED", submittedAt: "2026-08-02T00:00:00Z" },
      // A verdict with no body still matters — that IS the message.
      { author: { login: "bo" }, body: "", state: "APPROVED", submittedAt: "2026-08-03T00:00:00Z" },
    ],
  };
  expect(buildActivity(pr, []).map((e) => e.login + ":" + e.state)).toEqual(["amy:COMMENTED", "bo:APPROVED"]);
});

test("an undated event sorts last rather than jumping to the front", () => {
  const pr = {
    comments: [
      { author: { login: "nodate" }, body: "x", createdAt: "" },
      { author: { login: "dated" }, body: "y", createdAt: "2026-08-01T00:00:00Z" },
    ],
  };
  expect(buildActivity(pr, []).map((e) => e.login)).toEqual(["dated", "nodate"]);
});

test("an empty PR yields an empty stream rather than throwing", () => {
  expect(buildActivity({}, [])).toEqual([]);
  expect(buildActivity({ comments: null, reviews: null }, null || [])).toEqual([]);
});

test("the repo slug comes out of the PR url", () => {
  expect(repoFromUrl("https://github.com/acme/widgets/pull/42")).toBe("acme/widgets");
  expect(repoFromUrl("https://example.com/nope")).toBe(null);
  expect(repoFromUrl(null)).toBe(null);
});

// ---- rows ----

const LOADED = {
  state: "OPEN",
  author: { login: "author-person" },
  baseRefName: "main",
  mergeable: "MERGEABLE",
  reviewDecision: "CHANGES_REQUESTED",
  checkRuns: [],
  reviewRequests: [],
  reviews: [{ author: { login: "bo" }, state: "CHANGES_REQUESTED" }],
  body: "Some description.",
  // Oldest first, the order buildActivity hands over.
  activity: [
    { kind: "inline", login: "cy", body: "rename this", path: "src/a.js", line: 12, at: "2026-08-09T12:00:00Z" },
    { kind: "review", login: "bo", state: "CHANGES_REQUESTED", body: "not yet", at: "2026-08-10T10:00:00Z" },
    { kind: "comment", login: "amy", body: "looks good", at: "2026-08-10T11:00:00Z" },
  ],
};

// The status is the headline — it's the question the view exists to answer.
test("the verdict and its reasons come first, before anything else", () => {
  const lines = text(overviewRows(LOADED, 70, NOW));
  expect(lines[0]).toContain("Blocked");
  expect(lines[1]).toContain("Changes requested");
  expect(lines[1]).toContain("by bo");
  // Activity and description follow, in that order.
  const activity = lines.findIndex((l) => l.includes("Recent activity"));
  const desc = lines.findIndex((l) => l.includes("Description"));
  expect(activity).toBeGreaterThan(0);
  expect(desc).toBeGreaterThan(activity);
});

test("a review requested from you is called out as yours", () => {
  const ov = { ...LOADED, reviewDecision: "REVIEW_REQUIRED", reviews: [], reviewRequests: [{ login: "me-person" }] };
  const lines = text(overviewRows(ov, 70, NOW, "me-person"));
  expect(lines[0]).toContain("Waiting on you");
  expect(lines[1]).toContain("Your review is requested");
});

// Activity is a compact log now, not a transcript: one row per event, newest
// first, so the latest word on the PR is the first thing under the status.
test("activity is one line per event, newest first", () => {
  const lines = text(overviewRows(LOADED, 70, NOW));
  const at = lines.findIndex((l) => l.includes("Recent activity"));
  expect(lines[at + 1]).toContain("amy commented");
  expect(lines[at + 1]).toContain("looks good");
  expect(lines[at + 2]).toContain("bo requested changes");
  expect(lines[at + 3]).toContain("cy");
  expect(lines[at + 3]).toContain("src/a.js:12");
});

test("an inline reply is marked as one", () => {
  const ov = { ...LOADED, activity: [{ kind: "inline", login: "cy", body: "ok", path: "a.js", line: 1, reply: true, at: "" }] };
  expect(text(overviewRows(ov, 70, NOW)).join("\n")).toContain("cy ↳ a.js:1");
});

test("a long comment is cut to its row rather than wrapping", () => {
  const ov = { ...LOADED, activity: [{ kind: "comment", login: "amy", body: "x".repeat(400), at: "" }] };
  for (const line of text(overviewRows(ov, 70, NOW))) expect(line.length).toBeLessThanOrEqual(70);
});

// The rendering complaint that prompted the redesign: raw HTML everywhere.
test("HTML in a comment or description never reaches the screen", () => {
  const ov = {
    ...LOADED,
    body: "<details><summary>Notes</summary><p>hidden</p></details>",
    activity: [{ kind: "comment", login: "amy", body: "<p>see <a href='http://x'>this</a></p>", at: "" }],
  };
  const joined = text(overviewRows(ov, 70, NOW)).join("\n");
  expect(joined).not.toContain("<");
  expect(joined).toContain("▸ Notes (collapsed)");
  expect(joined).toContain("see this");
});

test("a long activity list is capped with a count of the rest", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ kind: "comment", login: `u${i}`, body: "x", at: "" }));
  const joined = text(overviewRows({ ...LOADED, activity: many }, 70, NOW)).join("\n");
  expect(joined).toContain("8 older");
});

test("an empty PR still renders, saying what's missing", () => {
  const ov = { ...LOADED, reviewDecision: "APPROVED", reviews: [], body: "", activity: [] };
  const joined = text(overviewRows(ov, 70, NOW)).join("\n");
  expect(joined).toContain("Ready to merge");
  expect(joined).toContain("no description");
  expect(joined).not.toContain("Recent activity"); // nothing to show, no empty section
});

test("loading and failure states render instead of a blank pane", () => {
  expect(text(overviewRows(null, 60, NOW))).toEqual(["loading…"]);
  expect(text(overviewRows({ error: "gh exploded" }, 60, NOW))[0]).toContain("gh exploded");
});

// ---- wrapping ----

test("prose wraps to the column and keeps its own line breaks", () => {
  expect(wrapText("aaa bbb ccc ddd", 7)).toEqual(["aaa bbb", "ccc ddd"]);
  expect(wrapText("one\n\ntwo", 20)).toEqual(["one", "", "two"]);
});

// A pasted URL or a long identifier must not blow out the column — the row
// count is what the scrolling maths is built on.
test("a word longer than the column is hard-split", () => {
  expect(wrapText("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "xxxxx"]);
});

test("no line ever exceeds the column", () => {
  const long = "The quick brown fox jumps over the lazy dog and then supercalifragilisticexpialidocious.";
  for (const w of [12, 20, 40]) {
    for (const line of wrapText(long, w)) expect(line.length).toBeLessThanOrEqual(w);
  }
});

// ---- scrolling ----

test("scroll stops where the last row reaches the bottom of the viewport", () => {
  expect(clampScroll(0, 100, 10)).toBe(0);
  expect(clampScroll(50, 100, 10)).toBe(50);
  expect(clampScroll(999, 100, 10)).toBe(90);
  expect(clampScroll(-5, 100, 10)).toBe(0);
});

test("content shorter than the viewport doesn't scroll at all", () => {
  expect(clampScroll(5, 3, 10)).toBe(0);
});

// ---- relative time ----

test("ages read compactly", () => {
  const at = (s) => relativeTime(new Date(NOW - s * 1000).toISOString(), NOW);
  expect(at(5)).toBe("now");
  expect(at(120)).toBe("2m");
  expect(at(3 * 3600)).toBe("3h");
  expect(at(2 * 86400)).toBe("2d");
  expect(at(800 * 86400)).toBe("2y");
});

test("an unparseable timestamp reads as nothing rather than NaN", () => {
  expect(relativeTime("", NOW)).toBe("");
  expect(relativeTime("not a date", NOW)).toBe("");
  expect(relativeTime(null, NOW)).toBe("");
});

// ---- viewport ----

// The "↓ N more" hint takes a row of its own. Forgetting that overflows the box
// by one line, and Ink resolves the overflow by silently dropping the top of
// the header — which is how the PR title vanished on a short terminal.
test("a scrolling body gives up a row for the more-hint", () => {
  // 20 rows of content, 10 rows of chrome-free space: needs the hint.
  const scrolling = overviewViewport(20, 16, 4);
  expect(scrolling.viewport).toBe(9);
  expect(scrolling.viewport + 1).toBe(10); // body + hint fits the space exactly
});

test("content that fits keeps the whole space", () => {
  expect(overviewViewport(5, 16, 4).viewport).toBe(10);
  expect(overviewViewport(5, 16, 4).maxScroll).toBe(0);
});

test("the last row is always reachable", () => {
  for (const [count, height] of [[20, 16], [100, 30], [7, 10], [1, 8]]) {
    const { viewport, maxScroll } = overviewViewport(count, height, 4);
    expect(maxScroll + viewport).toBeGreaterThanOrEqual(count);
  }
});

test("a terminal too short for any body still yields a usable row", () => {
  expect(overviewViewport(50, 4, 4).viewport).toBeGreaterThanOrEqual(1);
  expect(overviewViewport(50, 1, 4).viewport).toBeGreaterThanOrEqual(1);
});
