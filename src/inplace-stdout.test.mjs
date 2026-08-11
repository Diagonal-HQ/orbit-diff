import { expect, test } from "bun:test";
import { padFrameLines } from "./inplace-stdout.mjs";

const ESC = "\x1b";

test("short lines are padded out to the terminal width", () => {
  expect(padFrameLines("ab\ncd\nlast", 5)).toBe("ab   \ncd   \nlast");
});

// The whole reason this exists: with Ink's line-erases stripped, a short line
// leaves the previous frame's tail on screen from that column on.
test("a line already at full width is untouched", () => {
  expect(padFrameLines("abcde\nx", 5)).toBe("abcde\nx");
});

test("a line longer than the terminal is left alone", () => {
  expect(padFrameLines("abcdefgh\nx", 5)).toBe("abcdefgh\nx");
});

// Padding by raw string length would under-pad every coloured line — which is
// most of them.
test("ANSI escapes cost no columns", () => {
  const coloured = `${ESC}[31mab${ESC}[39m`;
  expect(padFrameLines(`${coloured}\nx`, 5)).toBe(`${coloured}   \nx`);
});

test("the cursor-movement run at the head of a frame costs no columns", () => {
  const run = `${ESC}[1A${ESC}[G`;
  expect(padFrameLines(`${run}ab\nx`, 5)).toBe(`${run}ab   \nx`);
});

// Writing exactly `cols` characters parks the cursor against the right edge
// with a pending autowrap, and the next frame's cursor-up run would then start
// from the wrong row.
test("the final line is never padded", () => {
  expect(padFrameLines("ab\ncd", 6)).toBe("ab    \ncd");
  expect(padFrameLines("only", 6)).toBe("only");
});

test("a frame ending in a newline still pads the line before it", () => {
  expect(padFrameLines("ab\n", 4)).toBe("ab  \n");
});

test("nonsense input passes straight through", () => {
  expect(padFrameLines("ab\ncd", 0)).toBe("ab\ncd");
  expect(padFrameLines("ab\ncd", undefined)).toBe("ab\ncd");
  const buf = Buffer.from("x");
  expect(padFrameLines(buf, 10)).toBe(buf);
});
