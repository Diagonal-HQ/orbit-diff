// Wrap a stdout stream to make Ink repaint *in place* instead of blanking.
//
// Ink redraws each frame by writing `eraseLines(n)` — which clears every line of
// the previous frame and then rewrites it. The blanked-then-refilled state is
// the white flash you see scrolling a full-screen TUI, and a multiplexer
// redrawing the pane on top of that amplifies it.
//
// eraseLines(n) is a run of `ESC[2K` (clear line) interleaved with `ESC[1A`
// (cursor up), e.g. `\e[2K\e[1A\e[2K...\e[G`. We strip just the `ESC[2K` clears
// from that leading run, leaving the cursor-up movement. Ink then overwrites the
// old frame line-for-line — and because every line it renders is full terminal
// width, the new frame completely covers the old one with no blank intermediate
// state. No erase → no flash.
const ERASE_LINE = "\x1b[2K";
const ERASE_RUN = /^\x1b\[2K(?:\x1b\[1A\x1b\[2K)*\x1b\[G/;

// …with one catch. "Every line it renders is full terminal width" holds for the
// panes, whose right edge is a border character, but not for every line: Ink
// trims trailing whitespace off each rendered line, so a line ending in blanks
// arrives short. With the erases stripped, the columns past its end keep
// whatever the *previous* frame put there.
//
// The status bar is where this shows. It swings from a long key list to a short
// mode line or toast, and the tail of the old bar was left stranded on screen.
// Padding each line back out to the terminal width restores the invariant the
// erase-stripping depends on, in one place rather than asking every component
// to remember it.
//
// The last line is deliberately left alone: writing exactly `cols` characters
// parks the cursor against the right edge with a pending autowrap, and the next
// frame's cursor-up run would then start from the wrong row.
export function padFrameLines(chunk, cols) {
  if (typeof chunk !== "string" || !cols || cols < 2) return chunk;
  const lines = chunk.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const width = visibleWidth(lines[i]);
    if (width < cols) lines[i] += " ".repeat(cols - width);
  }
  return lines.join("\n");
}

// Printable columns in a line, skipping ANSI escapes. Kept local (rather than
// imported from screen-grid.mjs) so this module stays dependency-free — it sits
// on the hot path for every frame.
const ANSI = /^\x1b\[[0-9;:<>?]*[ -/]*[@-~]|^\x1b[@-Z\\-_]/;
function visibleWidth(line) {
  let n = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const m = ANSI.exec(line.slice(i));
      i += m ? m[0].length : 1;
      continue;
    }
    n += 1;
    i += 1;
  }
  return n;
}

// Strip just the `ESC[2K` erases from a frame's leading cursor-movement run,
// leaving the cursor-up moves so Ink overwrites in place. Exported so the mouse
// controller can apply the same transform before it captures/highlights a frame.
export function stripEraseRun(chunk) {
  if (typeof chunk !== "string") return chunk;
  const run = chunk.match(ERASE_RUN);
  return run ? run[0].split(ERASE_LINE).join("") + chunk.slice(run[0].length) : chunk;
}

export function inPlaceStdout(stream = process.stdout) {
  return new Proxy(stream, {
    get(target, prop) {
      if (prop === "write") {
        return (chunk, ...rest) => {
          if (typeof chunk === "string") {
            chunk = stripEraseRun(chunk);
            chunk = padFrameLines(chunk, target.columns);
          }
          return target.write(chunk, ...rest);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
