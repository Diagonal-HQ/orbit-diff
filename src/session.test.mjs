import { expect, test } from "bun:test";
import { envTag, reviewTabLabel } from "./session.mjs";

// The instance is only worth showing once the environment is actually up. A
// record that's still provisioning has nothing to point at, and one that failed
// shouldn't advertise an instance you can't reach — in both cases the review tab
// stays plain "review" and the viewer's status bar shows nothing.

test("a ready environment gets a tag", () => {
  expect(envTag({ status: "ready", envInstance: "11" })).toBe("EV11");
  expect(reviewTabLabel({ status: "ready", envInstance: "11" })).toBe("review EV11");
});

test("instance 0 is an instance, not a missing one", () => {
  expect(envTag({ status: "ready", envInstance: 0 })).toBe("EV0");
});

test("provisioning, failed, and absent records show nothing", () => {
  expect(envTag({ status: "provisioning" })).toBe("");
  expect(envTag({ status: "provisioning", envInstance: "11" })).toBe("");
  expect(envTag({ status: "error", envInstance: "11", error: "boom" })).toBe("");
  expect(envTag({ status: "ready" })).toBe("");
  expect(envTag(null)).toBe("");
  expect(envTag(undefined)).toBe("");
});

test("the tab falls back to a plain label rather than a half-written one", () => {
  expect(reviewTabLabel(null)).toBe("review");
  expect(reviewTabLabel({ status: "provisioning" })).toBe("review");
});
