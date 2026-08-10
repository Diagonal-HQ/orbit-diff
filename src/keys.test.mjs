import { expect, test } from "bun:test";
import { navStep } from "./keys.mjs";

test("a single keypress moves one row", () => {
  expect(navStep("j")).toBe(1);
  expect(navStep("k")).toBe(-1);
});

// The reason this helper exists: keys arriving faster than the read loop land in
// one chunk, and `input === "j"` silently drops them.
test("a coalesced burst moves once per keypress in it", () => {
  expect(navStep("jj")).toBe(2);
  expect(navStep("jjj")).toBe(3);
  expect(navStep("kk")).toBe(-2);
});

test("a burst that doubles back nets out", () => {
  expect(navStep("jjk")).toBe(1);
  expect(navStep("jk")).toBe(0);
});

test("arrows come through `key`, and count once", () => {
  expect(navStep("", { downArrow: true })).toBe(1);
  expect(navStep("", { upArrow: true })).toBe(-1);
});

test("anything that isn't pure navigation is left alone", () => {
  for (const chunk of ["", "q", "gj", "j ", "jx", "1j", "note"]) {
    expect(navStep(chunk)).toBe(0);
  }
});
