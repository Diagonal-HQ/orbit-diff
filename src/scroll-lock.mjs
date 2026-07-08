// This app repaints in place rather than using the terminal's alternate
// screen buffer (see inplace-stdout.mjs), so scrolling the mouse wheel /
// trackpad while it's open scrolls the terminal's real scrollback and
// surfaces stale, half-overwritten frames underneath. Mouse-tracking mode
// turns wheel (and click) input into SGR escape sequences instead of native
// scrolling; we enable it and strip those sequences out of every stdin read
// before Ink's keypress parser ever sees them — left unfiltered they'd get
// parsed as an unrecognized key and echoed as literal text into whatever
// field currently has focus (e.g. a comment draft). Net effect: scrolling
// does nothing while the app is open.
//
// Trade-off: mouse-tracking mode also captures ordinary clicks, so
// click-drag text selection in the terminal needs its bypass modifier while
// this is active (Option on Terminal.app/iTerm2, Shift on most Linux
// terminals).
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";
const SGR_MOUSE = /\x1b\[<\d+;\d+;\d+[Mm]/g;

let exitHandlerInstalled = false;

export function scrollLock(stdin = process.stdin, stdout = process.stdout) {
  const enable = () => {
    if (stdout.isTTY) stdout.write(MOUSE_ON);
  };
  const disable = () => {
    if (stdout.isTTY) stdout.write(MOUSE_OFF);
  };

  // Best-effort: make sure a hard exit (uncaught error, Ctrl+C) still leaves
  // the terminal's mouse mode off rather than stuck reporting into whatever
  // runs next.
  if (!exitHandlerInstalled) {
    process.on("exit", disable);
    exitHandlerInstalled = true;
  }

  const lockedStdin = new Proxy(stdin, {
    get(target, prop) {
      if (prop === "read") {
        return (...args) => {
          const chunk = target.read(...args);
          return typeof chunk === "string" ? chunk.replace(SGR_MOUSE, "") : chunk;
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return { stdin: lockedStdin, enable, disable };
}
