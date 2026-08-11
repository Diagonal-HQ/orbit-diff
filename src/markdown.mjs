// Tiny, dependency-free markdown → Ink renderer for the narrow, height-bounded
// panes in this app. It deliberately keeps ONE output line per source line so
// callers can keep counting rows exactly (fenced code drops its ``` markers,
// which is the only place the line count shifts). Each output line is a list of
// styled segments: { text, bold, italic, color, dimColor, strikethrough,
// underline }, ready to splat onto an Ink <Text>.

import { htmlToText } from "./html-text.mjs";

// Split one line of prose into styled segments, handling inline code, bold,
// italic, strikethrough, and links. Non-nesting and leftmost-match — enough for
// real-world PR descriptions without a full parser.
function inline(text, base = {}) {
  const re = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(__[^_]+?__)|(\*[^*\s][^*]*?\*)|(_[^_\s][^_]*?_)|(~~[^~]+?~~)|(\[[^\]]+\]\([^)]+\))/;
  const segs = [];
  let rest = text;
  while (rest) {
    const m = re.exec(rest);
    if (!m) {
      segs.push({ ...base, text: rest });
      break;
    }
    if (m.index > 0) segs.push({ ...base, text: rest.slice(0, m.index) });
    const tok = m[0];
    if (tok.startsWith("`")) segs.push({ ...base, text: tok.slice(1, -1), color: "yellow" });
    else if (tok.startsWith("**") || tok.startsWith("__")) segs.push({ ...base, text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith("~~")) segs.push({ ...base, text: tok.slice(2, -2), strikethrough: true });
    else if (tok.startsWith("[")) {
      const lm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
      segs.push({ ...base, text: lm[1], color: "cyan", underline: true });
    } else segs.push({ ...base, text: tok.slice(1, -1), italic: true });
    rest = rest.slice(m.index + tok.length);
  }
  return segs.length ? segs : [{ ...base, text: "" }];
}

// Turn a markdown body into an array of segment-lists (one per rendered line).
//
// GitHub prose is markdown *plus* whatever raw HTML the author (or the bot) felt
// like, so it goes through htmlToText first — otherwise a dependabot description
// renders as forty lines of `<blockquote><li><a href=…>`.
export function markdownLines(body) {
  const raw = htmlToText(body).replace(/\t/g, "  ").split("\n");
  const out = [];
  let inFence = false;
  for (const line of raw) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence; // drop the fence marker itself
      continue;
    }
    if (inFence) {
      out.push([{ text: line, color: "gray" }]);
      continue;
    }
    if (line.trim() === "") {
      out.push([{ text: " " }]);
      continue;
    }
    // Horizontal rule: ---, ___, ***
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push([{ text: "────────────────────", dimColor: true }]);
      continue;
    }
    // ATX heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(inline(h[2].trim(), { bold: true, color: "cyan" }));
      continue;
    }
    // Blockquote
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      out.push([{ text: "│ ", dimColor: true }, ...inline(q[1], { dimColor: true })]);
      continue;
    }
    // List item (bullet or ordered) — normalize the marker to a bullet, keep indent
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      out.push([{ text: `${li[1]}• `, color: "green" }, ...inline(li[3])]);
      continue;
    }
    out.push(inline(line));
  }
  return out;
}
