import React from "react";
import { Box, Text } from "ink";
import { severityColor, findingLoc } from "./ai/findings.mjs";

// Left-column panel (mode === "review") listing AI review findings, mirroring the
// SubmitMenu / CommentEditor layout so the diff stays visible on the right. The
// selected finding's body shows in a detail box beneath the list. `p` promotes a
// finding to a real annotation (handled in App); promoted ones are marked ✓.
export function ReviewPanel({ findings, selected, reviewing, progress, error, width, height }) {
  const contentH = Math.max(3, height - 2);
  const cur = findings[selected];
  const detailH = cur && contentH > 9 ? Math.min(6, contentH - 5) : 0;
  const listRows = Math.max(1, contentH - 1 - 1 - (detailH ? detailH + 1 : 0));
  const start = clampStart(selected, listRows, findings.length);
  const window = findings.slice(start, start + listRows);

  const title = reviewing
    ? `AI review — reviewing ${progress.done}/${progress.total}…`
    : `AI review (${findings.length})`;

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan" wrap="truncate">{title}</Text>

      <Box flexDirection="column" height={listRows}>
        {window.map((f, i) => {
          const idx = start + i;
          const on = idx === selected;
          const badge = f.severity[0].toUpperCase(); // H/M/L/I
          return (
            <Text key={f.id} inverse={on} wrap="truncate">
              <Text color={severityColor(f.severity)} bold>{badge} </Text>
              <Text color="cyan">{findingLoc(f).replace(/^.*\//, "")}</Text>
              <Text color={f.promoted ? "green" : undefined}>{f.promoted ? " ✓" : ""}</Text>
              <Text dimColor>  {f.title}</Text>
            </Text>
          );
        })}
        {findings.length === 0 && (
          reviewing ? (
            <Text dimColor>reviewing…</Text>
          ) : error ? (
            <Text color="red" wrap="wrap">{clip(error, 3 * Math.max(1, width - 4))}</Text>
          ) : (
            <Text dimColor>no findings</Text>
          )
        )}
      </Box>

      {detailH > 0 && (
        <Box flexDirection="column" height={detailH} marginTop={1}>
          <Text bold color={severityColor(cur.severity)} wrap="truncate">
            {cur.severity} · {findingLoc(cur)}
          </Text>
          <Text wrap="wrap">{clip(cur.body || cur.title, (detailH - 1) * Math.max(1, width - 4))}</Text>
        </Box>
      )}

      <Text dimColor wrap="truncate">
        ↑↓ move · enter jump · p promote · esc close
      </Text>
    </Box>
  );
}

function clampStart(selected, rows, count) {
  return Math.max(0, Math.min(selected - Math.floor(rows / 2), Math.max(0, count - rows)));
}

function clip(s, max) {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";
}
