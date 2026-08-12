// The viewer's full-screen PR overview (`O`), as data.
//
// `overviewRows` turns a loaded PR into a flat list of renderable rows. The
// order is the priority order: what the PR is waiting on, then recent activity
// as one line per event, then the description.
//
// It used to lead with the description and a full transcript of every comment.
// That buried the only question the view exists to answer — is this blocked, and
// is it blocked on me — under a wall of quoted prose, so the conversation is now
// a compact log and `pr-blockers.mjs` does the actual thinking.
//
// Keeping this pure and separate from the component means the scrolling maths
// and the empty-PR cases are testable without rendering anything.
//
// A row is `{ segs: [{ text, bold, color, dimColor, … }] }` — the same segment
// shape `markdownLines` produces, so a rendered markdown line drops straight in.

import { markdownLines } from "./markdown.mjs";
import { oneLine } from "./html-text.mjs";
import { relativeTime, reviewVerdictLabel } from "./pr-view.mjs";
import { prStatus, VERDICT_STYLE } from "./pr-blockers.mjs";

const row = (...segs) => ({ segs: segs.filter(Boolean) });
const BLANK = () => row({ text: " " });

// A heading like "── Recent activity ─────". Cheap visual anchor when scrolling.
function rule(label, width) {
  const dashes = Math.max(0, width - label.length - 4);
  return row({ text: `── ${label} ${"─".repeat(dashes)}`, dimColor: true });
}

// Wrap plain text to `width`, preserving existing newlines. We have to know the
// row count up front to scroll correctly, so Ink's own wrapping can't help.
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

// The whole point of the view: what is this PR waiting on, and is it me?
function statusRows(status, width) {
  const style = VERDICT_STYLE[status.verdict] || VERDICT_STYLE.waiting;
  const rows = [row({ text: `${style.glyph} ${status.headline}`, color: style.color, bold: true })];

  // Reasons are already ordered most-urgent-first by prStatus. Each gets one
  // line: glyph, what it is, and the specific names behind it.
  for (const r of status.reasons) {
    const label = r.you ? `${r.text} ←` : r.text;
    rows.push(
      row(
        { text: `  ${r.glyph} `, color: r.color },
        { text: label, color: r.you ? "magenta" : undefined, bold: r.you },
        r.detail ? { text: `  ${oneLine(r.detail, Math.max(10, width - label.length - 8))}`, dimColor: true } : null,
      ),
    );
  }
  return rows;
}

// One conversation event, compact: who, what, when, and the first line of it.
// Deliberately NOT the full body — the overview answers "what's this blocked
// on", and a wall of quoted prose buried that. Open the PR (`p`) to read a
// thread properly.
function activityRow(ev, width, nowMs) {
  const age = relativeTime(ev.at, nowMs);
  const head = [];
  if (ev.kind === "review") {
    const v = reviewVerdictLabel(ev.state);
    head.push({ text: ev.login, bold: true }, { text: " " }, { text: v.text, color: v.color });
  } else if (ev.kind === "inline") {
    const where = ev.line != null ? `${ev.path}:${ev.line}` : ev.path;
    head.push(
      { text: ev.login, bold: true },
      { text: ev.reply ? " ↳ " : " on ", dimColor: true },
      { text: where || "the diff", color: "cyan" },
    );
  } else {
    head.push({ text: ev.login, bold: true }, { text: " commented", dimColor: true });
  }
  // Exact, so a row never overruns its column: the head, the "  age" segment,
  // and the two spaces before the excerpt all come out of the budget.
  const used = head.reduce((n, s) => n + s.text.length, 0) + (age ? age.length + 2 : 0) + 2;
  const excerpt = oneLine(ev.body, Math.max(12, width - used));
  return row(...head, age ? { text: `  ${age}`, dimColor: true } : null,
    excerpt ? { text: `  ${excerpt}`, dimColor: true } : null);
}

// Every row of the overview's main column, in order: what it's waiting on
// first, then recent activity, then the description. `width` is the inner text
// width; `nowMs` and `me` are injectable so tests are deterministic.
export function overviewRows(ov, width, nowMs = Date.now(), me = null) {
  if (!ov) return [row({ text: "loading…", dimColor: true })];
  if (ov.error) return [row({ text: `couldn't load: ${ov.error}`, color: "red" })];

  const w = Math.max(20, width);
  const rows = [];

  const status = prStatus(ov, { me, threads: ov.threads });
  rows.push(...statusRows(status, w));
  rows.push(BLANK());

  const activity = ov.activity || [];
  if (activity.length) {
    rows.push(rule(`Recent activity (${activity.length})`, w));
    // Newest first here, unlike a transcript: the latest comment is the one
    // that tells you where things stand.
    for (const ev of [...activity].reverse().slice(0, 12)) rows.push(activityRow(ev, w, nowMs));
    if (activity.length > 12) {
      rows.push(row({ text: `  … ${activity.length - 12} older`, dimColor: true }));
    }
    rows.push(BLANK());
  }

  const body = (ov.body || "").trim();
  rows.push(rule("Description", w));
  if (body) rows.push(...markdownLines(body).map((segs) => ({ segs })));
  else rows.push(row({ text: "no description", dimColor: true }));

  return rows;
}

// Clamp a scroll offset to what's actually scrollable: never past the point
// where the last row sits at the bottom of the viewport.
export function clampScroll(scroll, rowCount, viewportRows) {
  const max = Math.max(0, rowCount - Math.max(1, viewportRows));
  return Math.max(0, Math.min(scroll, max));
}

// How many rows the body actually gets, and how far it can scroll.
//
// The subtlety is the "↓ N more" hint: it occupies a row of its own, so when
// there IS more to show the body gets one row less. Getting that wrong overflows
// the box by a line and Ink silently drops the top of the header — which is how
// the title disappeared on a short terminal.
//
// Shared by the component (to slice) and the key handler (to clamp), because
// the two computing it separately is exactly how they drift.
export function overviewViewport(rowCount, height, headRows) {
  const space = Math.max(1, height - 2 - headRows);
  const viewport = rowCount > space ? Math.max(1, space - 1) : space;
  return { viewport, maxScroll: Math.max(0, rowCount - viewport) };
}
