import { expect, test } from "bun:test";
import { prStatus } from "./pr-blockers.mjs";

// The whole decision table, without `gh`. This is the bit that has to be right:
// the view exists to answer "is this waiting on me", and a wrong verdict is
// worse than no verdict.

const ME = "reviewer-person";
const check = (name, conclusion, status = "COMPLETED") =>
  ({ name, status, conclusion, __typename: "CheckRun" });

const pr = (over = {}) => ({
  state: "OPEN",
  isDraft: false,
  author: { login: "author-person" },
  baseRefName: "main",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  checkRuns: [],
  reviewRequests: [],
  reviews: [],
  ...over,
});

const kinds = (s) => s.reasons.map((r) => r.kind);

test("a clean approved PR is ready", () => {
  const s = prStatus(pr(), { me: ME });
  expect(s.verdict).toBe("ready");
  expect(s.headline).toBe("Ready to merge");
  expect(s.reasons).toEqual([]);
});

test("merged and closed PRs are done, whatever else is set", () => {
  expect(prStatus(pr({ state: "MERGED", mergeable: "CONFLICTING" }), {}).verdict).toBe("closed");
  expect(prStatus(pr({ state: "CLOSED" }), {}).headline).toContain("Closed");
});

// ---- the reason each thing is stuck ----

test("conflicts are reported against the base branch by name", () => {
  const s = prStatus(pr({ mergeable: "CONFLICTING", baseRefName: "develop" }), { me: ME });
  expect(s.verdict).toBe("blocked");
  expect(s.reasons[0].text).toBe("Conflicts with develop");
});

test("failing checks are counted and named", () => {
  const s = prStatus(pr({ checkRuns: [check("test", "FAILURE"), check("lint", "FAILURE"), check("build", "SUCCESS")] }), { me: ME });
  expect(s.verdict).toBe("blocked");
  const r = s.reasons.find((x) => x.kind === "checks-failing");
  expect(r.text).toBe("2 checks failing");
  expect(r.detail).toBe("test, lint");
});

test("a long list of failing checks is capped rather than run on", () => {
  const runs = ["a", "b", "c", "d", "e"].map((n) => check(n, "FAILURE"));
  expect(prStatus(pr({ checkRuns: runs }), {}).reasons[0].detail).toBe("a, b, c +2");
});

test("running checks are waiting, not blocked", () => {
  const s = prStatus(pr({ checkRuns: [check("lint", "", "IN_PROGRESS")] }), { me: ME });
  expect(s.verdict).toBe("waiting");
  expect(s.reasons[0].text).toBe("1 check still running");
});

test("changes requested names who asked", () => {
  const s = prStatus(
    pr({
      reviewDecision: "CHANGES_REQUESTED",
      reviews: [{ author: { login: "bo" }, state: "CHANGES_REQUESTED" }, { author: { login: "x" }, state: "APPROVED" }],
    }),
    { me: ME },
  );
  expect(s.reasons[0].text).toBe("Changes requested");
  expect(s.reasons[0].detail).toBe("by bo");
});

test("unresolved review threads are counted, resolved and outdated ones ignored", () => {
  const threads = [
    { isResolved: false, isOutdated: false, path: "a.js" },
    { isResolved: false, isOutdated: false, path: "b.js" },
    { isResolved: true, isOutdated: false, path: "c.js" },
    { isResolved: false, isOutdated: true, path: "d.js" },
  ];
  const s = prStatus(pr({ reviewDecision: "REVIEW_REQUIRED" }), { me: ME, threads });
  const r = s.reasons.find((x) => x.kind === "threads");
  expect(r.text).toBe("2 unresolved threads");
  expect(r.detail).toBe("a.js, b.js");
});

// null means the extra call failed — saying "0 unresolved" would be a lie.
test("threads we couldn't fetch are not reported as zero", () => {
  const s = prStatus(pr(), { me: ME, threads: null });
  expect(kinds(s)).not.toContain("threads");
});

test("a branch behind its base says so", () => {
  const s = prStatus(pr({ mergeStateStatus: "BEHIND" }), { me: ME });
  expect(s.reasons[0].text).toBe("Behind main");
});

// ---- is it waiting on ME ----

test("a review requested from you outranks everything else", () => {
  const s = prStatus(
    pr({ reviewDecision: "REVIEW_REQUIRED", reviewRequests: [{ login: ME }, { login: "someone" }] }),
    { me: ME },
  );
  expect(s.verdict).toBe("you");
  expect(s.headline).toBe("Waiting on you");
  expect(s.reasons[0].kind).toBe("your-review");
  expect(s.reasons[0].you).toBe(true);
  // The others are still listed, just not as yours.
  expect(s.reasons[1].detail).toBe("someone");
});

test("a review requested from other people is waiting, not yours", () => {
  const s = prStatus(pr({ reviewDecision: "REVIEW_REQUIRED", reviewRequests: [{ login: "someone" }] }), { me: ME });
  expect(s.verdict).toBe("waiting");
  expect(s.headline).toBe("Waiting on others");
  expect(s.reasons[0].text).toBe("Waiting on review");
});

test("on your own PR, the things you have to fix are yours", () => {
  const mine = { me: "author-person" };
  expect(prStatus(pr({ mergeable: "CONFLICTING" }), mine).verdict).toBe("you");
  expect(prStatus(pr({ checkRuns: [check("test", "FAILURE")] }), mine).verdict).toBe("you");
  expect(prStatus(pr({ reviewDecision: "CHANGES_REQUESTED" }), mine).headline).toBe("Waiting on you (your PR)");
});

test("someone else's failing checks are their problem, not yours", () => {
  const s = prStatus(pr({ checkRuns: [check("test", "FAILURE")] }), { me: ME });
  expect(s.verdict).toBe("blocked");
  expect(s.reasons[0].you).toBe(false);
});

test("without knowing who we are, nothing is attributed to you", () => {
  const s = prStatus(pr({ reviewDecision: "REVIEW_REQUIRED", reviewRequests: [{ login: ME }] }), { me: null });
  expect(s.verdict).toBe("waiting");
});

// ---- drafts, protection, auto-merge ----

test("a draft says so, and is the author's to advance", () => {
  expect(prStatus(pr({ isDraft: true }), { me: "author-person" }).verdict).toBe("you");
  expect(prStatus(pr({ isDraft: true }), { me: ME }).reasons[0].text).toBe("Draft");
});

// BLOCKED is set on nearly every open PR and never says why, so it's only worth
// surfacing when nothing else explained the situation.
test("branch protection is only mentioned when nothing else explains it", () => {
  expect(kinds(prStatus(pr({ mergeStateStatus: "BLOCKED" }), { me: ME }))).toEqual(["protected"]);
  const withReason = prStatus(pr({ mergeStateStatus: "BLOCKED", checkRuns: [check("t", "FAILURE")] }), { me: ME });
  expect(kinds(withReason)).not.toContain("protected");
});

test("auto-merge is noted but never becomes the verdict", () => {
  const s = prStatus(pr({ autoMergeRequest: { enabledAt: "x" } }), { me: ME });
  expect(s.verdict).toBe("ready");
  expect(s.headline).toContain("auto-merge");
  expect(kinds(s)).toEqual(["auto-merge"]);
});

test("everything at once is reported worst-first and reads as yours", () => {
  const s = prStatus(
    pr({
      mergeable: "CONFLICTING",
      checkRuns: [check("test", "FAILURE"), check("lint", "", "IN_PROGRESS")],
      reviewDecision: "REVIEW_REQUIRED",
      reviewRequests: [{ login: ME }],
      mergeStateStatus: "BEHIND",
    }),
    { me: ME, threads: [{ isResolved: false, isOutdated: false, path: "a.js" }] },
  );
  expect(s.verdict).toBe("you");
  expect(kinds(s)).toEqual(["conflict", "checks-failing", "checks-running", "your-review", "threads", "behind"]);
});

test("an unloaded or failed overview doesn't throw", () => {
  expect(prStatus(null, {}).reasons).toEqual([]);
  expect(prStatus({ error: "boom" }, {}).headline).toBe("Status unavailable");
});
