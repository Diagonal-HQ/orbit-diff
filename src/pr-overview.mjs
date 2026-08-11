// The viewer's full-screen PR overview (`G`), as data.
//
// `overviewRows` turns a loaded PR into a flat list of renderable rows — the
// description and then the conversation, oldest first. Keeping it pure and
// separate from the component means the scrolling maths and the "what does an
// empty PR look like" cases are testable without rendering anything, and the
// component stays a dumb slice-and-paint of whatever comes back.
//
// A row is `{ segs: [{ text, bold, color, dimColor, … }] }` — the same segment
// shape `markdownLines` produces, so a rendered markdown line drops straight in.

import { markdownLines } from "./markdown.mjs";
import { relativeTime, reviewVerdictLabel } from "./pr-view.mjs";

const row = (...segs) => ({ segs: segs.filter(Boolean) });
const BLANK = () => row({ text: " " });

// A heading like "── Conversation ─────". Cheap visual anchor when scrolling
// through a long PR.
function rule(label, width) {
  const dashes = Math.max(0, width - label.length - 3);
  return row({ text: `── ${label} ${"─".repeat(dashes)}`, dimColor: true });
}

// Wrap plain text to `width`, preserving existing newlines. Comment bodies are
// arbitrary prose, and Ink's own wrapping can't help us here because we have to
// know the row count up front to scroll correctly.
export function wrapText(text, width) {
  const out = [];
  for (const paragraph of String(text || "").replace(/\r/g, "").split("\n")) {
    if (!paragraph.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!line) {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += " " + word;
      } else {
        out.push(line);
        line = word;
      }
      // A single word longer than the column: hard-split rather than overflow.
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    if (line) out.push(line);
  }
  return out;
}

// One conversation event as rows: an attribution line, then its body indented
// under it.
function eventRows(ev, width, nowMs) {
  const rows = [];
  const age = relativeTime(ev.at, nowMs);
  const when = age ? { text: `  ${age}`, dimColor: true } : null;

  if (ev.kind === "review") {
    const v = reviewVerdictLabel(ev.state);
    rows.push(row({ text: ev.login, bold: true }, { text: " " }, { text: v.text, color: v.color }, when));
  } else if (ev.kind === "inline") {
    const where = ev.line != null ? `${ev.path}:${ev.line}` : ev.path;
    rows.push(
      row(
        { text: ev.login, bold: true },
        { text: ev.reply ? " replied on " : " commented on ", dimColor: true },
        { text: where || "the diff", color: "cyan" },
        when,
      ),
    );
  } else {
    rows.push(row({ text: ev.login, bold: true }, { text: " commented", dimColor: true }, when));
  }

  // Indent bodies so the attribution lines stay scannable down the left edge.
  for (const line of wrapText(ev.body, Math.max(8, width - 2))) {
    rows.push(line ? row({ text: "  " + line }) : BLANK());
  }
  rows.push(BLANK());
  return rows;
}

// Every row of the overview's main column, in order. `width` is the inner text
// width; `nowMs` is injectable so tests get stable relative times.
export function overviewRows(ov, width, nowMs = Date.now()) {
  if (!ov) return [row({ text: "loading…", dimColor: true })];
  if (ov.error) return [row({ text: `couldn't load: ${ov.error}`, color: "red" })];

  const rows = [];
  const w = Math.max(20, width);

  const body = (ov.body || "").trim();
  rows.push(rule("Description", w));
  if (body) rows.push(...markdownLines(body).map((segs) => ({ segs })));
  else rows.push(row({ text: "no description", dimColor: true }));
  rows.push(BLANK());

  const activity = ov.activity || [];
  rows.push(rule(`Conversation (${activity.length})`, w));
  if (!activity.length) rows.push(row({ text: "nothing yet", dimColor: true }));
  else for (const ev of activity) rows.push(...eventRows(ev, w, nowMs));

  return rows;
}

// Clamp a scroll offset to what's actually scrollable: never past the point
// where the last row sits at the bottom of the viewport.
export function clampScroll(scroll, rowCount, viewportRows) {
  const max = Math.max(0, rowCount - Math.max(1, viewportRows));
  return Math.max(0, Math.min(scroll, max));
}
