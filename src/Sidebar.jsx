import React from "react";
import { Box, Text } from "ink";
import { annotationLabel } from "./annotations.mjs";

const STATUS_GLYPH = {
  added: { char: "A", color: "green" },
  deleted: { char: "D", color: "red" },
  renamed: { char: "R", color: "yellow" },
  modified: { char: "M", color: "yellow" },
};

// Left pane: the "Files changed" rail on top, with a live, navigable list of
// annotations stacked beneath it (separated by a blank line). `files` is already
// filtered by the file-search query; `allFiles` is the full set, used to resolve
// annotation line labels even when the annotated file is filtered out above.
// `section` says which list the rail cursor is in ("files" | "annotations") and
// `annSelected` is the highlighted annotation index within it.
export function Sidebar({
  files, selected, focused, width, height,
  annotations = [], allFiles = files, section = "files", annSelected = 0,
}) {
  const contentH = Math.max(1, height - 2); // rows inside the border
  const annCount = annotations.length;

  // Reserve a bounded section at the bottom for annotations (a header plus up to
  // ~40% of the content). Chrome above the file list is always 3 rows: the files
  // header, a blank spacer, and the annotations header. Files take the rest.
  let annRows = 0;
  if (annCount > 0) {
    annRows = Math.min(annCount, Math.max(2, Math.floor((contentH - 3) * 0.4)));
  }
  const fileRows = Math.max(1, contentH - 3 - annRows);

  // Each list windows around its own selection so it stays in view as it scrolls.
  const fStart = clampStart(selected, fileRows, files.length);
  const fWindow = files.slice(fStart, fStart + fileRows);
  const annFocused = focused && section === "annotations";
  const aStart = clampStart(annSelected, annRows, annCount);
  const annWindow = annotations.slice(aStart, aStart + annRows);

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
