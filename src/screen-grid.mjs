// A lightweight model of what's currently on screen, built by watching the
// frames Ink writes to stdout. Ink emits each frame as a single logUpdate write
// of the whole view (full-width lines joined by "\n"), and this app repaints in
// place at the bottom of the terminal (see inplace-stdout.mjs) — so we don't
// need a full terminal emulator. Stripping the escapes and splitting on "\n"
// gives us the visible text grid, which is enough to (a) map a mouse cell to a
// pane and a character, (b) extract the selected text, and (c) reinsert a
// selection highlight into the frame before it's written.
//
// Everything here is pure/stateless except makeScreen(), which just holds the
// most recent capture so the mouse handler and the stdout tap can share it.

// Match one ANSI escape sequence (CSI like `ESC[…m`/`ESC[…H`, or a bare 2-byte
// escape). Used both to strip escapes for the text grid and to skip them as
// zero-width while walking a raw frame line.
const ANSI = /^\x1b\[[0-9;:<>?]*[ -/]*[@-~]|^\x1b[@-Z\\-_]/;
const VERTICAL = new Set(["│", "┃", "║"]); // box-drawing pane edges

export function stripAnsi(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = ANSI.exec(s.slice(i));
      i += m ? m[0].length : 1;
      continue;
    }
    out += s[i];
    i += 1;
  }
  return out;
}

// The plain-text rows of a frame chunk. A frame's leading cursor-movement run
// (ESC[1A…ESC[G, left over after inplace-stdout strips the ESC[2K erases) has no
// newlines, so it rides on row 0 and vanishes with the escape strip.
export function toRows(chunk) {
  const text = stripAnsi(typeof chunk === "string" ? chunk : String(chunk));
  const rows = text.split("\n");
  if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop(); // drop trailing newline
  return rows;
}

// Columns that hold a vertical pane border across a good fraction of rows. These
// are the walls we clamp a selection to, so a drag stays inside one pane. We key
// on the box-drawing glyphs (U+2502 …), which diff/content text never contains
// (code uses ASCII "|"), so incidental matches aren't a concern.
export function dividerColumns(rows) {
  const counts = new Map();
  for (const row of rows) {
    const cells = [...row];
    for (let c = 0; c < cells.length; c++) {
      if (VERTICAL.has(cells[c])) counts.set(c, (counts.get(c) || 0) + 1);
    }
  }
  const need = Math.max(2, Math.floor(rows.length * 0.35));
  return [...counts.entries()].filter(([, n]) => n >= need).map(([c]) => c).sort((a, b) => a - b);
}

// The [left, right] content columns (inclusive) of the pane containing `col`,
// i.e. the gap between the nearest border walls on either side. Padding inside
// the border is included; per-line trimEnd in extract() handles the rest.
export function bandAt(dividers, col, maxCol) {
  let left = 0;
  let right = maxCol;
  for (const d of dividers) {
    if (d < col) left = d + 1;
    else if (d > col) { right = d - 1; break; }
  }
  return [left, right];
}

// Order two grid points in reading order (top-to-bottom, then left-to-right).
function order(a, b) {
  if (a.row !== b.row) return a.row < b.row ? [a, b] : [b, a];
  return a.col <= b.col ? [a, b] : [b, a];
}

// The text of a selection, clamped to `band` columns. Leading indentation is
// preserved; trailing padding/whitespace is trimmed per line.
export function extract(rows, anchor, head, band) {
  const [start, end] = order(anchor, head);
  const [bl, br] = band;
  const out = [];
  for (let r = start.row; r <= end.row; r++) {
    const cells = [...(rows[r] ?? "")];
    const from = r === start.row ? Math.max(bl, start.col) : bl;
    const to = r === end.row ? Math.min(br, end.col) : br;
    out.push(cells.slice(from, to + 1).join("").replace(/\s+$/, ""));
  }
  return out.join("\n");
}

// Rewrite a frame chunk so the selected cells render reversed. We insert
// `ESC[7m … ESC[27m` at the right *visible* columns of each selected line,
// walking past escapes as zero-width so existing syntax colors survive and
// merely get inverted. `rowOf(gridRow)` returns the chunk line for a grid row —
// they're 1:1 since both come from splitting the same frame on "\n".
export function highlightFrame(chunk, anchor, head, band) {
  if (typeof chunk !== "string" || !anchor || !head) return chunk;
  const [start, end] = order(anchor, head);
  const [bl, br] = band;
  const lines = chunk.split("\n");
  for (let r = start.row; r <= end.row; r++) {
    if (r < 0 || r >= lines.length) continue;
    const from = r === start.row ? Math.max(bl, start.col) : bl;
    const to = (r === end.row ? Math.min(br, end.col) : br) + 1; // exclusive
    if (to > from) lines[r] = reverseSpan(lines[r], from, to);
  }
  return lines.join("\n");
}

// Insert reverse-video on the [from, to) visible-column span of one raw line.
function reverseSpan(line, from, to) {
  let out = "";
  let vis = 0;
  let i = 0;
  let on = false;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const m = ANSI.exec(line.slice(i));
      const seq = m ? m[0] : line[i];
      out += seq;
      i += seq.length;
      continue;
    }
    if (vis === from && !on) { out += "\x1b[7m"; on = true; }
    if (vis === to && on) { out += "\x1b[27m"; on = false; }
    const cp = line.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    out += ch;
    vis += 1; // wide/emoji chars counted as 1 column (approximation)
    i += ch.length;
  }
  if (on) out += "\x1b[27m"; // selection ran to end of line
  return out;
}

// Shared mutable holder: the stdout tap captures each frame here, the mouse
// handler reads it to map cells and extract text.
export function makeScreen() {
  return {
    rows: [],
    dividers: [],
    topOffset: 0, // blank rows above the frame (termRows - frame height)
    // Record a freshly written frame. `termRows` is the terminal height, used to
    // map absolute mouse rows onto grid rows.
    capture(chunk, termRows) {
      this.rows = toRows(chunk);
      this.dividers = dividerColumns(this.rows);
      this.topOffset = Math.max(0, (termRows || this.rows.length) - this.rows.length);
    },
    // Absolute 1-based mouse (col,row) → 0-based grid cell, or null if off-frame.
    cellAt(mouseCol, mouseRow) {
      const row = mouseRow - this.topOffset - 1;
      const col = mouseCol - 1;
      if (row < 0 || row >= this.rows.length || col < 0) return null;
      return { row, col };
    },
  };
}
