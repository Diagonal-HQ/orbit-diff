// Wrap a stdout stream to make Ink repaint *in place* instead of blanking.
//
// Ink redraws each frame by writing `eraseLines(n)` — which clears every line of
// the previous frame and then rewrites it. The blanked-then-refilled state is
// the white flash you see scrolling a full-screen TUI, and tmux amplifies it.
//
// eraseLines(n) is a run of `ESC[2K` (clear line) interleaved with `ESC[1A`
// (cursor up), e.g. `\e[2K\e[1A\e[2K...\e[G`. We strip just the `ESC[2K` clears
// from that leading run, leaving the cursor-up movement. Ink then overwrites the
// old frame line-for-line — and because every line it renders is full terminal
// width, the new frame completely covers the old one with no blank intermediate
// state. No erase → no flash.
const ERASE_LINE = "\x1b[2K";
const ERASE_RUN = /^\x1b\[2K(?:\x1b\[1A\x1b\[2K)*\x1b\[G/;

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
          if (typeof chunk === "string") chunk = stripEraseRun(chunk);
          return target.write(chunk, ...rest);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
