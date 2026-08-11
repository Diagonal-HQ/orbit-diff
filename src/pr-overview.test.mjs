import { expect, test } from "bun:test";
import { overviewRows, wrapText, clampScroll } from "./pr-overview.mjs";
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
  body: "Some description.",
  activity: [
    { kind: "comment", login: "amy", body: "looks good", at: "2026-08-10T11:00:00Z" },
    { kind: "review", login: "bo", state: "CHANGES_REQUESTED", body: "not yet", at: "2026-08-10T10:00:00Z" },
    { kind: "inline", login: "cy", body: "rename this", path: "src/a.js", line: 12, at: "2026-08-09T12:00:00Z" },
  ],
};

test("the overview renders a description and the conversation under it", () => {
  const lines = text(overviewRows(LOADED, 60, NOW));
  expect(lines[0]).toContain("Description");
  expect(lines.join("\n")).toContain("Some description.");
  const convo = lines.findIndex((l) => l.includes("Conversation (3)"));
  expect(convo).toBeGreaterThan(0);
  expect(lines.join("\n")).toContain("looks good");
});

test("each kind of event is attributed in its own way", () => {
  const lines = text(overviewRows(LOADED, 60, NOW)).join("\n");
  expect(lines).toContain("amy commented");
  expect(lines).toContain("bo requested changes");
  expect(lines).toContain("cy commented on src/a.js:12");
});

test("an inline reply says so", () => {
  const ov = { body: "", activity: [{ kind: "inline", login: "cy", body: "ok", path: "a.js", line: 1, reply: true, at: "" }] };
  expect(text(overviewRows(ov, 60, NOW)).join("\n")).toContain("cy replied on a.js:1");
});

test("relative ages are shown next to each event", () => {
  const lines = text(overviewRows(LOADED, 60, NOW)).join("\n");
  expect(lines).toContain("1h"); // amy, an hour ago
  expect(lines).toContain("2h"); // bo
});

test("an empty PR still renders both sections, saying they're empty", () => {
  const lines = text(overviewRows({ body: "", activity: [] }, 60, NOW)).join("\n");
  expect(lines).toContain("no description");
  expect(lines).toContain("Conversation (0)");
  expect(lines).toContain("nothing yet");
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
