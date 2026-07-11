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
// Because the terminal's own click-drag selection is captured while this is on,
// we reuse the same captured events to implement in-app selection instead (see
// mouse-select.mjs) — the `?1002h` mode below adds motion reports (drags) on top
// of clicks so a selection can be dragged out. Any parsed event is handed to the
// optional `onEvent` callback; all mouse bytes are still stripped so Ink's
// keypress parser never sees them (wheel events are thereby swallowed as before).
import { parseMouseEvents } from "./mouse.mjs";

const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1000l\x1b[?1002l\x1b[?1006l";

let exitHandlerInstalled = false;

export function scrollLock(stdin = process.stdin, stdout = process.stdout, onEvent) {
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
          if (typeof chunk !== "string") return chunk;
          const { events, cleaned } = parseMouseEvents(chunk);
          if (onEvent) for (const ev of events) if (ev.type !== "wheel") onEvent(ev);
          return cleaned;
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return { stdin: lockedStdin, enable, disable };
}
