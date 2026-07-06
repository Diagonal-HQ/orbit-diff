import React from "react";
import { Box, Text } from "ink";
import { annotationLabel } from "./annotations.mjs";
import { severityColor, findingLoc } from "./ai/findings.mjs";

const STATUS_GLYPH = {
  added: { char: "A", color: "green" },
  deleted: { char: "D", color: "red" },
  renamed: { char: "R", color: "yellow" },
  modified: { char: "M", color: "yellow" },
};

// Left pane: three stacked, navigable sections — "Files changed" on top, then
// annotations, then AI review findings — separated by blank rows. `files` is
// already filtered by the file-search query; `allFiles` is the full set, used to
// resolve annotation line labels even when the annotated file is filtered out.
// `section` says which list the rail cursor is in ("files" | "annotations" |
// "review"); `annSelected`/`reviewSelected` are the highlighted rows within them.
// When the review section is focused, the selected finding's full body shows in a
// detail box pinned to the bottom (there's no separate review panel anymore).
export function Sidebar({
  files, selected, focused, width, height,
  annotations = [], allFiles = files, section = "files", annSelected = 0,
  findings = [], reviewSelected = 0, reviewing = false,
  reviewProgress = { done: 0, total: 0 }, reviewError = null,
}) {
  const contentH = Math.max(1, height - 2); // rows inside the border
  const annCount = annotations.length;
  const revCount = findings.length;

  const annFocused = focused && section === "annotations";
  const reviewFocused = focused && section === "review";

  // The detail box only appears while the review section holds the cursor and
  // there's room — it borrows rows from the lists above it.
  const cur = section === "review" ? findings[clamp(reviewSelected, 0, Math.max(0, revCount - 1))] : null;
  const detailH = cur && contentH > 11 ? Math.min(5, contentH - 8) : 0;
  const detailReserve = detailH ? detailH + 1 : 0;

  // Chrome above the lists is always 5 rows: the files header, then a blank +
  // header for each of the annotations and AI review sections. The three lists
  // split what's left; annotations and review take a bounded share, files the rest.
  const avail = Math.max(3, contentH - 5 - detailReserve);
  const annRows = annCount > 0 ? Math.min(annCount, Math.max(2, Math.floor(avail * 0.28))) : 0;
  const revRows = revCount > 0 ? Math.min(revCount, Math.max(2, Math.floor(avail * 0.28))) : 1;
  const fileRows = Math.max(1, avail - annRows - revRows);

  // Each list windows around its own selection so it stays in view as it scrolls.
  const fStart = clampStart(selected, fileRows, files.length);
  const fWindow = files.slice(fStart, fStart + fileRows);
  const aStart = clampStart(annSelected, annRows, annCount);
  const annWindow = annotations.slice(aStart, aStart + annRows);
  const rStart = clampStart(reviewSelected, revRows, revCount);
  const revWindow = findings.slice(rStart, rStart + revRows);

  const reviewHeader = reviewing
    ? `AI Review · ${reviewProgress.done}/${reviewProgress.total}`
    : `AI Review (${revCount})`;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor={focused ? "cyan" : "gray"}
      paddingX={1}
    >
      <Text bold color="cyan">
        Files ({files.length})
      </Text>
      {fWindow.map((f, i) => {
        const idx = fStart + i;
        const active = idx === selected;
        const glyph = STATUS_GLYPH[f.status] || STATUS_GLYPH.modified;
        const stat = `+${f.additions} -${f.deletions}`;
        const room = width - 4 - 2; // borders/padding + glyph
        const label = truncateLeft(f.name, Math.max(4, room - stat.length - 1));
        return (
          <Text key={f.name + idx} inverse={active && focused && section === "files"} wrap="truncate">
            <Text color={glyph.color}>{glyph.char} </Text>
            <Text color={active ? "white" : undefined}>{label}</Text>
            <Text dimColor> {stat}</Text>
          </Text>
        );
      })}
      {files.length === 0 && <Text dimColor>no matches</Text>}

      <Text> </Text>
      <Text bold color="green">
        Annotations ({annCount})
      </Text>
      {annWindow.map((a, i) => {
        const idx = aStart + i;
        const active = idx === annSelected;
        // Compact "basename:line" so the comment text still has room in the
        // narrow rail; the full path is in the change-request doc on copy.
        const label = annotationLabel(a, allFiles).replace(/^.*\//, "");
        const text = a.text.trim() || "(empty)";
        return (
          <Text key={a.id} inverse={active && annFocused} wrap="truncate">
            <Text color="green">● </Text>
            <Text color="cyan">{label}</Text>
            <Text dimColor>  {text}</Text>
          </Text>
        );
      })}

      <Text> </Text>
      <Text bold color="blueBright">
        {reviewHeader}
      </Text>
      {revWindow.map((f, i) => {
        const idx = rStart + i;
        const active = idx === reviewSelected;
        const badge = f.severity[0].toUpperCase(); // H/M/L/I
        return (
          <Text key={f.id} inverse={active && reviewFocused} wrap="truncate">
            <Text color={severityColor(f.severity)} bold>{badge} </Text>
            <Text color="cyan">{findingLoc(f).replace(/^.*\//, "")}</Text>
            <Text color={f.promoted ? "green" : undefined}>{f.promoted ? " ✓" : ""}</Text>
            <Text dimColor>  {f.title}</Text>
          </Text>
        );
      })}
      {revCount === 0 &&
        (reviewing ? (
          <Text dimColor>reviewing…</Text>
        ) : reviewError ? (
          <Text color="red" wrap="truncate">{reviewError}</Text>
        ) : (
          <Text dimColor>press A to run</Text>
        ))}

      {detailH > 0 && cur && (
        <Box flexDirection="column" height={detailH} marginTop={1}>
          <Text bold color={severityColor(cur.severity)} wrap="truncate">
            {cur.severity} · {findingLoc(cur)}
          </Text>
          <Text wrap="wrap">
            {clip(cur.body || cur.title, Math.max(1, detailH - 2) * Math.max(1, width - 4))}
          </Text>
          <Text dimColor wrap="truncate">
            {cur.promoted ? "promoted ✓" : cur.anchored ? "p promote → note" : "no line anchor"}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// First index of a scroll window that keeps `selected` in view, clamped so the
// window never runs past either end of a `count`-long list.
function clampStart(selected, rows, count) {
  return Math.max(0, Math.min(selected - Math.floor(rows / 2), Math.max(0, count - rows)));
}

// File paths are most distinctive on the right (filename), so drop the head.
function truncateLeft(s, max) {
  if (s.length <= max) return s.padEnd(max);
  return "…" + s.slice(s.length - max + 1);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(n, hi));
}

function clip(s, max) {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";
}
