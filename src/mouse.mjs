// Parse xterm SGR (1006) mouse reports out of a stdin chunk.
//
// With mouse tracking on (see scroll-lock.mjs) the terminal encodes every mouse
// action as `ESC [ < Cb ; Col ; Row M` (button press / motion) or `… m`
// (release), 1-based Col/Row. `Cb` packs the button in its low bits plus flags:
//   bit 5 (32) → motion (a drag, i.e. moving with a button held)
//   bit 6 (64) → wheel / extended button (64 = wheel up, 65 = wheel down)
//   low 2 bits → 0 left, 1 middle, 2 right (meaningful only when bit 6 is clear)
// We classify each report into a small event and, crucially, hand back the chunk
// with the report bytes removed so Ink's keypress parser never sees them.
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

// Classify one report. `cb` is the button/flags byte, `final` is 'M' or 'm'.
function classify(cb, final) {
  if (cb & 64) return "wheel"; // wheel up/down (and other extended buttons)
  if (final === "m") return "release"; // button lifted
  if (cb & 32) return "drag"; // motion with a button held
  return "press"; // button first went down
}

// Pull all mouse reports out of `str`. Returns the events (in stream order) and
// `cleaned`, the same text with every report stripped so it can be forwarded to
// Ink untouched. `col`/`row` are 1-based, matching the terminal's own numbering.
export function parseMouseEvents(str) {
  if (typeof str !== "string" || str.indexOf("\x1b[<") === -1) {
    return { events: [], cleaned: str };
  }
  const events = [];
  let cleaned = "";
  let last = 0;
  for (let m; (m = SGR.exec(str)); ) {
    cleaned += str.slice(last, m.index);
    last = SGR.lastIndex;
    const cb = Number(m[1]);
    events.push({
      type: classify(cb, m[4]),
      button: cb & 3,
      col: Number(m[2]),
      row: Number(m[3]),
    });
  }
  cleaned += str.slice(last);
  return { events, cleaned };
}
