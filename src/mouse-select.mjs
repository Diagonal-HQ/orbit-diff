import { useEffect, useReducer, useRef } from "react";
import { scrollLock } from "./scroll-lock.mjs";
import { stripEraseRun } from "./inplace-stdout.mjs";
import { makeScreen, bandAt, extract, highlightFrame } from "./screen-grid.mjs";

// Ties together the three moving parts of in-app mouse selection:
//   • a stdin wrap (scroll-lock) that turns terminal mouse reports into events,
//   • a screen model built from the frames Ink writes to stdout, and
//   • a stdout wrap that reinserts the selection highlight into each frame.
// Create one per Ink render and pass it in as the `mouse` prop; drive the
// selection state machine from React with useMouseSelection().
export function createMouseController(realStdout = process.stdout) {
  const screen = makeScreen();
  const listeners = new Set();
  let selection = null; // { anchor:{row,col}, head:{row,col}, band:[l,r] } in grid coords
  let repaint = null; // bump React so a frame is rewritten with the new highlight

  // One stdout wrap replacing inPlaceStdout: strip the erase run (repaint in
  // place), snapshot the frame into the screen model, then splice in the
  // selection highlight before the bytes go out.
  const stdout = new Proxy(realStdout, {
    get(target, prop) {
      if (prop === "write") {
        return (chunk, ...rest) => {
          if (typeof chunk === "string") {
            chunk = stripEraseRun(chunk);
            screen.capture(chunk, target.rows);
            if (selection) chunk = highlightFrame(chunk, selection.anchor, selection.head, selection.band);
          }
          return target.write(chunk, ...rest);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const dispatch = (ev) => {
    for (const l of listeners) l(ev);
  };
  // Mouse-mode toggles and swallowing still go through scroll-lock; we just tap
  // its parsed events. It writes control sequences to the *real* stdout.
  const { stdin, enable, disable } = scrollLock(process.stdin, realStdout, dispatch);

  return {
    stdin,
    stdout,
    enable,
    disable,
    screen,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setSelection(next) {
      selection = next;
      repaint?.();
    },
    getSelection: () => selection,
    setRepaint(fn) {
      repaint = fn;
    },
  };
}

// React glue: subscribe to mouse events and run the press → drag → release
// selection state machine. `copy(text)` is called with the selected text on
// release (App/PrApp supply their own clipboard+toast). A no-op if `mouse` is
// absent (e.g. under a non-TTY test harness that didn't create a controller).
export function useMouseSelection(mouse, copy) {
  const [, bump] = useReducer((n) => (n + 1) % 1e9, 0);
  const anchor = useRef(null); // active drag anchor (grid cell) + its pane band
  const band = useRef(null);
  const head = useRef(null); // last valid head, kept when a drag leaves the frame

  useEffect(() => {
    if (!mouse) return;
    mouse.setRepaint(bump);

    const off = mouse.subscribe((ev) => {
      const { screen } = mouse;
      const cell = screen.cellAt(ev.col, ev.row);

      if (ev.type === "press") {
        if (!cell) return mouse.setSelection(null);
        const maxCol = Math.max(0, [...(screen.rows[cell.row] ?? "")].length - 1);
        anchor.current = cell;
        head.current = cell;
        band.current = bandAt(screen.dividers, cell.col, maxCol);
        mouse.setSelection({ anchor: cell, head: cell, band: band.current });
        return;
      }

      if (ev.type === "drag") {
        if (!anchor.current) return;
        if (cell) head.current = cell; // dragged off-frame → keep the last cell
        mouse.setSelection({ anchor: anchor.current, head: head.current, band: band.current });
        return;
      }

      if (ev.type === "release") {
        const sel = mouse.getSelection();
        const moved = sel && (sel.anchor.row !== sel.head.row || sel.anchor.col !== sel.head.col);
        if (moved) {
          const text = extract(screen.rows, sel.anchor, sel.head, sel.band);
          if (text.trim()) copy(text);
        }
        anchor.current = null;
        head.current = null;
        mouse.setSelection(null);
      }
    });

    return () => {
      off();
      mouse.setRepaint(null);
    };
  }, [mouse, copy]);
}
