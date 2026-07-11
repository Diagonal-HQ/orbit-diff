import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { parseMouseEvents } from "./mouse.mjs";
import { toRows, dividerColumns, bandAt, extract, highlightFrame, makeScreen } from "./screen-grid.mjs";
import { useMouseSelection } from "./mouse-select.mjs";

// ── mouse parsing ─────────────────────────────────────────────────────────
test("parses press / drag / release and strips them from the stream", () => {
  const chunk = `a\x1b[<0;10;5Mb\x1b[<32;20;7Mc\x1b[<0;20;7md`;
  const { events, cleaned } = parseMouseEvents(chunk);
  expect(cleaned).toBe("abcd");
  expect(events).toEqual([
    { type: "press", button: 0, col: 10, row: 5 },
    { type: "drag", button: 0, col: 20, row: 7 },
    { type: "release", button: 0, col: 20, row: 7 },
  ]);
});

test("classifies wheel events (bit 6) so they can be swallowed", () => {
  const { events } = parseMouseEvents(`\x1b[<64;3;3M\x1b[<65;3;3M`);
  expect(events.map((e) => e.type)).toEqual(["wheel", "wheel"]);
});

test("passes plain input through untouched", () => {
  const { events, cleaned } = parseMouseEvents("hello");
  expect(events).toEqual([]);
  expect(cleaned).toBe("hello");
});

// ── grid + panes ──────────────────────────────────────────────────────────
const FRAME = [
  "╭ Files ─────╮╭ Diff ───────────────╮",
  "│ a.js       ││ 1  const x = 42;     │",
  "│ b.js       ││ 2  const label = 7;  │",
  "╰────────────╯╰─────────────────────╯",
].join("\n");

test("toRows strips color and splits into visible rows", () => {
  const colored = `\x1b[1A\x1b[G\x1b[36m│ a \x1b[39m│\n\x1b[36m│ b │`;
  expect(toRows(colored)).toEqual(["│ a │", "│ b │"]);
});

test("detects the pane divider walls and bands a column to its pane", () => {
  const rows = toRows(FRAME);
  const dividers = dividerColumns(rows);
  // walls: left edge(0), between-panes(12,13), right edge(36)
  expect(dividers).toContain(0);
  expect(dividers).toContain(13);
  const maxCol = [...rows[1]].length - 1;
  // a column inside the diff pane bands to the gap after the between-wall
  expect(bandAt(dividers, 20, maxCol)[0]).toBeGreaterThan(13);
  // a column inside the files pane stays left of the between-wall
  expect(bandAt(dividers, 5, maxCol)[1]).toBeLessThan(13);
});

test("extract pulls a character range and preserves indentation, trims pad", () => {
  const rows = toRows(FRAME);
  const dividers = dividerColumns(rows);
  const maxCol = [...rows[1]].length - 1;
  const band = bandAt(dividers, 20, maxCol);
  // select from the "const" on row 1 down through the end of row 2
  const anchor = { row: 1, col: 15 };
  const head = { row: 2, col: 99 }; // past line end → whole last line (clamped to band)
  const text = extract(rows, anchor, head, band);
  expect(text.split("\n").length).toBe(2);
  expect(text).toContain("const x = 42;");
  expect(text).toContain("const label = 7;");
  // must not bleed the neighbouring files pane
  expect(text).not.toContain("a.js");

  // character-level: a head that stops mid-line trims the last row there
  const partial = extract(rows, anchor, { row: 2, col: 32 }, band);
  expect(partial.endsWith("const label =")).toBe(true);
});

test("highlightFrame wraps only the selected span in reverse video", () => {
  const line = "\x1b[36mhello world\x1b[39m";
  const out = highlightFrame(line, { row: 0, col: 6 }, { row: 0, col: 10 }, [0, 100]);
  // "world" (cols 6-10) gets reversed; color codes survive
  expect(out).toContain("\x1b[7m");
  expect(out).toContain("\x1b[27m");
  const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
  expect(plain).toBe("hello world");
});

test("makeScreen maps absolute mouse rows onto grid rows via the top offset", () => {
  const screen = makeScreen();
  screen.capture(FRAME, 10); // 4-line frame at bottom of a 10-row terminal
  expect(screen.topOffset).toBe(6);
  // absolute row 8 → grid row 1 (8 - 6 - 1)
  expect(screen.cellAt(3, 8)).toEqual({ row: 1, col: 2 });
  expect(screen.cellAt(3, 6)).toBeNull(); // above the frame
});

// ── end-to-end: the React hook's press → drag → release state machine ─────────
function mockMouse(frame, termRows) {
  const screen = makeScreen();
  screen.capture(frame, termRows);
  let selection = null;
  let listener = null;
  return {
    screen,
    subscribe(fn) { listener = fn; return () => { listener = null; }; },
    setSelection(s) { selection = s; },
    getSelection: () => selection,
    setRepaint() {},
    emit(ev) { listener?.(ev); },
  };
}

function Probe({ mouse, copy }) {
  useMouseSelection(mouse, copy);
  return null;
}

const tick = () => new Promise((r) => setTimeout(r, 10));

test("drag press→drag→release copies the pane-constrained text", async () => {
  const mouse = mockMouse(FRAME, 4); // 4-row frame, no top offset
  const copied = [];
  render(React.createElement(Probe, { mouse, copy: (t) => copied.push(t) }));
  await tick(); // let the effect subscribe

  // press inside the diff pane at grid (1,15); drag to end of grid row 2
  mouse.emit({ type: "press", button: 0, col: 16, row: 2 });
  mouse.emit({ type: "drag", button: 0, col: 100, row: 3 });
  mouse.emit({ type: "release", button: 0, col: 100, row: 3 });

  expect(copied.length).toBe(1);
  expect(copied[0]).toContain("const x = 42;");
  expect(copied[0]).toContain("const label = 7;");
  expect(copied[0]).not.toContain("a.js"); // stayed in the diff pane
});

test("a plain click (no drag) copies nothing", async () => {
  const mouse = mockMouse(FRAME, 4);
  const copied = [];
  render(React.createElement(Probe, { mouse, copy: (t) => copied.push(t) }));
  await tick();

  mouse.emit({ type: "press", button: 0, col: 16, row: 2 });
  mouse.emit({ type: "release", button: 0, col: 16, row: 2 });

  expect(copied.length).toBe(0);
});
