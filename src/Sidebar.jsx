import React from "react";
import { Box, Text } from "ink";

const STATUS_GLYPH = {
  added: { char: "A", color: "green" },
  deleted: { char: "D", color: "red" },
  renamed: { char: "R", color: "yellow" },
  modified: { char: "M", color: "yellow" },
};

// Left pane: the list of changed files, GitHub's "Files changed" rail.
// `files` is already filtered by the active file-search query.
export function Sidebar({ files, selected, focused, width, height }) {
  const rows = Math.max(1, height - 3); // border (2) + header (1)
  // Keep the selected row in view as the list scrolls.
  const start = Math.max(0, Math.min(selected - Math.floor(rows / 2), files.length - rows));
  const window = files.slice(Math.max(0, start), Math.max(0, start) + rows);

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
      {window.map((f, i) => {
        const idx = Math.max(0, start) + i;
        const active = idx === selected;
        const glyph = STATUS_GLYPH[f.status] || STATUS_GLYPH.modified;
        const stat = `+${f.additions} -${f.deletions}`;
        const room = width - 4 - 2; // borders/padding + glyph
        const label = truncateLeft(f.name, Math.max(4, room - stat.length - 1));
        return (
          <Text key={f.name + idx} inverse={active && focused} wrap="truncate">
            <Text color={glyph.color}>{glyph.char} </Text>
            <Text color={active ? "white" : undefined}>{label}</Text>
            <Text dimColor> {stat}</Text>
          </Text>
        );
      })}
      {files.length === 0 && <Text dimColor>no matches</Text>}
    </Box>
  );
}

// File paths are most distinctive on the right (filename), so drop the head.
function truncateLeft(s, max) {
  if (s.length <= max) return s.padEnd(max);
  return "…" + s.slice(s.length - max + 1);
}
