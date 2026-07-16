import wrapAnsi from "wrap-ansi";

// Soft-wrap support for the unified diff view. When wrapping is on a long
// logical line spans several terminal rows, so the viewport can no longer
// assume 1 line = 1 row. Everything here works in that variable-height model:
// heights are measured with the same wrapper used to render, so the scroll
// math and the panel agree on exactly how tall each line is.

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Width of the fixed prefix (marker + gutter + sign) before a unified line's
// content, so continuation rows can align under it. Mirrors DiffPanel's layout:
// marker(1) + gutter(2*numW+1) + space(1) + sign(1).
export const prefixWidth = (numW) => 2 * numW + 4;
export const contentWidth = (rowW, numW) => Math.max(1, rowW - prefixWidth(numW));

// Character-wrap a string (plain or ANSI-highlighted) into visual rows at a
// fixed column width. `hard`+`!wordWrap` breaks exactly at the column like a
// pager, not on word boundaries, which is what reads right for code; ANSI
// colors carry across the breaks. Always returns at least one row.
export function wrapRows(text, width) {
  const w = Math.max(1, width);
  const rows = wrapAnsi(text ?? "", w, { hard: true, wordWrap: false, trim: false }).split("\n");
  return rows.length ? rows : [""];
}

// Visual-row height of one diff line at the given panel width. Memoized on the
// line object (keyed by width so a resize invalidates it). Heights are computed
// from the plain content — an ANSI-highlighted line wraps to the same row count
// since the escape codes have zero display width — so this matches what
// DiffPanel renders whether or not the line is highlighted.
export function lineRows(line, rowW, numW) {
  if (line.__h && line.__h.w === rowW) return line.__h.rows;
  let rows;
  if (line.type === "hunk") {
    rows = wrapRows(line.content, Math.max(1, rowW - 1)).length;
  } else {
    const body = line.content.length > 0 ? line.content : " ";
    rows = wrapRows(body, contentWidth(rowW, numW)).length;
  }
  line.__h = { w: rowW, rows };
  return rows;
}

// Largest top line index we should ever scroll to: past it the remaining
// content would underfill the view, leaving blank rows below. Walk up from the
// last line summing heights; the first line that overflows `inner` is one line
// too far, so the smallest fully-fitting top is just below it. A final line
// taller than the whole view still gets to sit at the top (shown partially).
export function maxScroll(lines, inner, rowW, numW) {
  const n = lines.length;
  if (n === 0) return 0;
  let used = 0;
  for (let t = n - 1; t >= 0; t--) {
    used += lineRows(lines[t], rowW, numW);
    if (used > inner) return Math.min(n - 1, t + 1);
  }
  return 0;
}

// How many logical lines are (at least partly) visible from `start` — used to
// size a page jump and to reason about the window. Counts the partial line that
// straddles the bottom edge, and always returns at least one.
export function visibleLineCount(lines, start, inner, rowW, numW) {
  let used = 0, count = 0;
  for (let i = start; i < lines.length && used < inner; i++) {
    used += lineRows(lines[i], rowW, numW);
    count++;
  }
  return Math.max(1, count);
}

// Nudge the wrapped viewport so `cursor` stays visible with a small margin,
// moving as little as possible (the wrap-aware sibling of followScroll). Scrolls
// by whole lines: up when the cursor sits above the top margin, down when its
// last row would fall past the bottom. A cursor line taller than the view pins
// the top to that line.
export function followScrollWrapped(scroll, cursor, inner, lines, rowW, numW) {
  const n = lines.length;
  if (n === 0) return 0;
  const H = (i) => lineRows(lines[i], rowW, numW);
  const off = Math.min(2, Math.floor(inner / 6)); // lines of context to keep

  let top = clamp(scroll, 0, n - 1);

  if (cursor < top + off) {
    top = Math.max(0, cursor - off);
  } else {
    // Find the last line visible from `top`; scroll down a line at a time until
    // the cursor (plus its bottom margin) fits, or the cursor becomes the top.
    const lastVisible = (t) => {
      let used = 0, last = t;
      for (let i = t; i < n; i++) {
        used += H(i);
        if (used > inner) break;
        last = i;
      }
      return last;
    };
    while (cursor + off > lastVisible(top) && top < cursor) top++;
  }

  return clamp(top, 0, maxScroll(lines, inner, rowW, numW));
}

// Target cursor line for a page up/down in the wrapped view: walk from the
// cursor accumulating heights until roughly one screenful of rows is consumed,
// always moving at least one line.
export function pageMove(lines, cursor, inner, rowW, numW, dir) {
  const n = lines.length;
  if (n === 0) return 0;
  const budget = Math.max(1, inner - 2);
  let used = 0, i = cursor;
  while (i + dir >= 0 && i + dir < n && used + lineRows(lines[i], rowW, numW) <= budget) {
    used += lineRows(lines[i], rowW, numW);
    i += dir;
  }
  if (i === cursor) i = cursor + dir; // never stall on a line taller than a page
  return clamp(i, 0, n - 1);
}

// Top line index that brings `target` roughly to the middle of the wrapped
// view (for search-jump), by leaving about half a screen of rows above it.
export function scrollToShow(lines, target, inner, rowW, numW) {
  const half = Math.floor(inner / 2);
  let used = 0, top = target;
  while (top > 0 && used + lineRows(lines[top - 1], rowW, numW) <= half) {
    top--;
    used += lineRows(lines[top], rowW, numW);
  }
  return clamp(top, 0, maxScroll(lines, inner, rowW, numW));
}
