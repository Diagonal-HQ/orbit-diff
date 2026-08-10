import { expect, test } from "bun:test";
import { buildReviewComments, approvePR, requestChanges } from "./github.mjs";

// The verdict actions each do two or three outward-facing things in a specific
// order, and getting that order wrong is the kind of bug you only find in
// production on someone else's PR. So they take an injectable `gh` runner and
// these drive it end to end without anything leaving the machine.

const PR = { number: 42, repo: "acme/widgets", url: "https://x/42", headRefOid: "abc123", author: "author-person" };

// A fake `gh`. `fail` matches an argv the call should fail on.
function fakeGh({ me = "reviewer-person", fail = () => false } = {}) {
  const calls = [];
  const run = async (args, input) => {
    calls.push({ args, body: input ? JSON.parse(input) : null });
    if (fail(args)) return { status: 1, stdout: "", stderr: '{"message":"nope"}\nHTTP 422: nope' };
    if (args[0] === "api" && args[1] === "user") return { status: 0, stdout: `${me}\n`, stderr: "" };
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: false }), stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const find = (pred) => calls.find((c) => pred(c.args));
  const reviews = () => calls.filter((c) => c.args.includes("--method") && String(c.args).includes("/reviews"));
  const edits = () => calls.filter((c) => c.args[0] === "pr" && c.args[1] === "edit");
  const merges = () => calls.filter((c) => c.args[0] === "pr" && c.args[1] === "merge");
  return { run, calls, find, reviews, edits, merges };
}

// A file whose lines carry the old/new numbering the anchor logic reads.
const FILE = {
  path: "src/a.js",
  lines: [
    { newNum: null, oldNum: null }, // hunk header
    { newNum: 10, oldNum: 10 },
    { newNum: 11, oldNum: null }, // added
    { newNum: null, oldNum: 12 }, // deleted
  ],
};

// ---- turning annotations into review comments ----

test("an annotation anchors to the new side, spanning only when it's a range", () => {
  const { comments, skipped } = buildReviewComments(
    [{ file: "src/a.js", startIdx: 1, endIdx: 1, text: "single" }, { file: "src/a.js", startIdx: 1, endIdx: 2, text: "range" }],
    [FILE],
  );
  expect(skipped).toEqual([]);
  expect(comments[0]).toEqual({ path: "src/a.js", body: "single", side: "RIGHT", line: 10 });
  expect(comments[1]).toEqual({
    path: "src/a.js", body: "range", side: "RIGHT", line: 11, start_line: 10, start_side: "RIGHT",
  });
});

test("a pure deletion anchors to the old side", () => {
  const { comments } = buildReviewComments([{ file: "src/a.js", startIdx: 3, endIdx: 3, text: "gone" }], [FILE]);
  expect(comments[0]).toMatchObject({ side: "LEFT", line: 12 });
});

// The reviews API takes ONE commit id at the top level; a per-comment one is
// rejected. This is the only difference from the standalone-comment payload.
test("review comments carry no per-comment commit id", () => {
  const { comments } = buildReviewComments([{ file: "src/a.js", startIdx: 1, endIdx: 1, text: "x" }], [FILE]);
  expect(comments[0]).not.toHaveProperty("commit_id");
});

test("empty notes are dropped and unanchorable ones are reported", () => {
  const { comments, skipped } = buildReviewComments(
    [
      { file: "src/a.js", startIdx: 1, endIdx: 1, text: "   " }, // whitespace only
      { file: "src/a.js", startIdx: 0, endIdx: 0, text: "on a hunk header" },
      { file: "gone.js", startIdx: 1, endIdx: 1, text: "file not in the diff" },
    ],
    [FILE],
  );
  expect(comments).toEqual([]);
  expect(skipped).toEqual(["src/a.js", "gone.js"]);
});

// ---- approve ----

test("approve submits an APPROVE review and unassigns you", async () => {
  const gh = fakeGh();
  const res = await approvePR(PR, {}, gh.run);

  expect(res.ok).toBe(true);
  expect(res.approved).toBe(true);
  expect(res.unassigned).toBe(true);
  expect(res.warnings).toEqual([]);

  expect(gh.reviews()[0].body).toMatchObject({ event: "APPROVE", commit_id: "abc123" });
  expect(gh.edits()[0].args).toEqual(["pr", "edit", "42", "--repo", "acme/widgets", "--remove-assignee", "reviewer-person"]);
  expect(gh.merges()).toHaveLength(0); // plain approve never touches merge
});

test("approve & merge enables auto-merge and leaves you assigned to watch it", async () => {
  const gh = fakeGh();
  const res = await approvePR(PR, { merge: true }, gh.run);

  expect(res.ok).toBe(true);
  expect(res.autoMerge).toBe(true);
  expect(res.method).toBe("squash"); // the repo allows it, so it's preferred
  expect(gh.merges()[0].args).toEqual(["pr", "merge", "42", "--repo", "acme/widgets", "--auto", "--squash"]);
  expect(gh.edits()).toHaveLength(0); // still yours until it lands
});

// The one ordering that could actually do damage: auto-merge on a PR that was
// never approved could land unreviewed code.
test("a failed approval aborts before auto-merge is touched", async () => {
  const gh = fakeGh({ fail: (args) => String(args).includes("/reviews") });
  const res = await approvePR(PR, { merge: true }, gh.run);

  expect(res.ok).toBe(false);
  expect(res.approved).toBe(false);
  expect(res.error).toContain("nope");
  expect(gh.merges()).toHaveLength(0);
  expect(gh.edits()).toHaveLength(0);
});

// Bookkeeping failures are reported but must not imply the approval didn't land.
test("a failed unassign still reports the approval as done", async () => {
  const gh = fakeGh({ fail: (args) => args[1] === "edit" });
  const res = await approvePR(PR, {}, gh.run);

  expect(res.ok).toBe(true);
  expect(res.approved).toBe(true);
  expect(res.unassigned).toBe(false);
  expect(res.warnings.join(" ")).toContain("unassign");
});

test("a failed auto-merge still reports the approval as done", async () => {
  const gh = fakeGh({ fail: (args) => args[1] === "merge" });
  const res = await approvePR(PR, { merge: true }, gh.run);

  expect(res.ok).toBe(true);
  expect(res.approved).toBe(true);
  expect(res.autoMerge).toBe(false);
  expect(res.warnings.join(" ")).toContain("auto-merge");
});

test("an explicit merge method is used verbatim, without asking the repo", async () => {
  const gh = fakeGh();
  await approvePR(PR, { merge: true, mergeMethod: "rebase" }, gh.run);
  expect(gh.merges()[0].args).toContain("--rebase");
  expect(gh.find((a) => a[0] === "repo" && a[1] === "view")).toBeUndefined();
});

test("a repo that forbids squash falls back to what it does allow", async () => {
  const gh = fakeGh();
  const run = async (args, input) => {
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ squashMergeAllowed: false, mergeCommitAllowed: false, rebaseMergeAllowed: true }), stderr: "" };
    }
    return gh.run(args, input);
  };
  const res = await approvePR(PR, { merge: true }, run);
  expect(res.method).toBe("rebase");
});

// ---- request changes ----

test("request changes posts one review carrying every annotation", async () => {
  const gh = fakeGh();
  const annotations = [
    { file: "src/a.js", startIdx: 1, endIdx: 1, text: "fix this" },
    { file: "src/a.js", startIdx: 2, endIdx: 2, text: "and this" },
  ];
  const res = await requestChanges(PR, annotations, [FILE], gh.run);

  expect(res.ok).toBe(true);
  expect(res.posted).toBe(2);
  // ONE review, not one call per comment — that's what makes it a single
  // "requested changes" entry in the PR timeline.
  expect(gh.reviews()).toHaveLength(1);
  const body = gh.reviews()[0].body;
  expect(body.event).toBe("REQUEST_CHANGES");
  expect(body.comments).toHaveLength(2);
  expect(body.comments[0]).toMatchObject({ path: "src/a.js", body: "fix this", line: 10 });
});

test("request changes hands the PR back to its author in one edit", async () => {
  const gh = fakeGh();
  const res = await requestChanges(PR, [{ file: "src/a.js", startIdx: 1, endIdx: 1, text: "x" }], [FILE], gh.run);

  expect(res.reassigned).toBe(true);
  expect(res.author).toBe("author-person");
  expect(gh.edits()).toHaveLength(1);
  expect(gh.edits()[0].args).toEqual([
    "pr", "edit", "42", "--repo", "acme/widgets",
    "--add-assignee", "author-person",
    "--remove-assignee", "reviewer-person",
  ]);
});

// GitHub rejects a REQUEST_CHANGES review that carries neither a body nor any
// comments, so one is supplied.
test("requesting changes with nothing annotated still submits a valid review", async () => {
  const gh = fakeGh();
  const res = await requestChanges(PR, [], [FILE], gh.run);

  expect(res.ok).toBe(true);
  expect(res.posted).toBe(0);
  const body = gh.reviews()[0].body;
  expect(body.event).toBe("REQUEST_CHANGES");
  expect(body.body).toBeTruthy();
  expect(body.comments).toBeUndefined();
});

test("reviewing your own PR doesn't try to assign you to it", async () => {
  const gh = fakeGh({ me: "author-person" }); // the author is also the reviewer
  await requestChanges(PR, [{ file: "src/a.js", startIdx: 1, endIdx: 1, text: "x" }], [FILE], gh.run);
  // Nothing to add, so the only change is removing them — no add/remove churn on
  // the same login.
  expect(gh.edits()[0].args).toEqual([
    "pr", "edit", "42", "--repo", "acme/widgets", "--remove-assignee", "author-person",
  ]);
});

test("a rejected review reports the failure and changes no assignees", async () => {
  const gh = fakeGh({ fail: (args) => String(args).includes("/reviews") });
  const res = await requestChanges(PR, [{ file: "src/a.js", startIdx: 1, endIdx: 1, text: "x" }], [FILE], gh.run);

  expect(res.ok).toBe(false);
  expect(res.error).toContain("nope");
  expect(res.posted).toBe(0);
  expect(gh.edits()).toHaveLength(0);
});

test("unmappable annotations are counted rather than silently dropped", async () => {
  const gh = fakeGh();
  const res = await requestChanges(
    PR,
    [{ file: "src/a.js", startIdx: 1, endIdx: 1, text: "ok" }, { file: "gone.js", startIdx: 1, endIdx: 1, text: "orphan" }],
    [FILE],
    gh.run,
  );
  expect(res.posted).toBe(1);
  expect(res.skipped).toBe(1);
});

test("a PR with no known author still submits the review, and says so", async () => {
  const gh = fakeGh();
  const res = await requestChanges({ ...PR, author: null }, [{ file: "src/a.js", startIdx: 1, endIdx: 1, text: "x" }], [FILE], gh.run);

  expect(res.ok).toBe(true);
  expect(res.reassigned).toBe(false);
  expect(res.warnings.join(" ")).toContain("author");
  // Still taken off your own plate.
  expect(gh.edits()[0].args).toContain("--remove-assignee");
});
