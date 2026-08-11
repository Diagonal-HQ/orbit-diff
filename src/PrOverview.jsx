// The viewer's full-screen PR overview (`G`) — everything about the PR that
// isn't the diff, so a review can be finished without opening a browser.
//
// Replaces the file rail + diff entirely (rather than squeezing into a pane)
// because the conversation is the point: inline review comments, issue
// comments, and review verdicts interleaved in one scrollable stream, which
// needs the width. The right column carries the state you glance at — who's on
// the hook, what CI thinks, labels.
//
// Layout and content come from `pr-overview.mjs`; this file only slices the row
// list to the viewport and paints it.

import React from "react";
import { Box, Text } from "ink";
import { checkState } from "./pr.mjs";
import { CHECK_GLYPH, checkRank, truncate, reviewStateLabel, mergeStateLabel } from "./pr-view.mjs";
import { overviewRows, clampScroll } from "./pr-overview.mjs";

// Width of the right-hand state column, as a share of the screen, bounded so it
// stays readable on a narrow terminal and doesn't sprawl on a wide one.
export function overviewLayout(cols) {
  const side = Math.max(22, Math.min(38, Math.round(cols * 0.28)));
  return { mainW: Math.max(20, cols - side), sideW: side };
}

export function PrOverview({ pr, overview, scroll = 0, width, height, refreshing = false }) {
  const { mainW, sideW } = overviewLayout(width);
  // Border (2) + paddingX 1 each side (2).
  const innerW = Math.max(10, mainW - 4);
  const ov = overview;

  // Rows above the scrolling body: title, branch line, the status line, spacer.
  const headRows = 4;
  const viewport = Math.max(1, height - 2 - headRows);
  const rows = overviewRows(ov, innerW);
  const start = clampScroll(scroll, rows.length, viewport);
  const shown = rows.slice(start, start + viewport);
  const below = Math.max(0, rows.length - (start + shown.length));

  const loaded = ov && !ov.error;
  const review = reviewStateLabel(loaded ? ov.reviewDecision : null);
  const merge = mergeStateLabel(loaded ? ov : null);

  return (
    <Box width={width} height={height}>
      <Box flexDirection="column" width={mainW} height={height} borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold wrap="truncate">
          <Text dimColor>#{pr?.number} </Text>
          {loaded ? ov.title : pr?.title || ""}
          {refreshing ? <Text dimColor> · refreshing…</Text> : null}
        </Text>
        <Text wrap="truncate">
          <Text dimColor>by </Text>
          {(loaded ? ov.author?.login : null) || "?"}
          <Text dimColor>
            {"   "}
            {loaded ? `${ov.headRefName} → ${ov.baseRefName}` : ""}
          </Text>
        </Text>
        <Text wrap="truncate">
          <Text dimColor>review </Text>
          <Text color={review.color}>{review.text}</Text>
          <Text dimColor>  merge </Text>
          <Text color={merge.color}>{merge.text}</Text>
          {loaded ? (
            <>
              <Text dimColor>{"  "}</Text>
              <Text color="green">+{ov.additions}</Text>
              <Text> </Text>
              <Text color="red">-{ov.deletions}</Text>
              {ov.isDraft ? <Text dimColor>  draft</Text> : null}
              {ov.autoMergeRequest ? <Text color="magenta">  auto-merge</Text> : null}
            </>
          ) : null}
        </Text>
        <Text>{" "}</Text>

        {shown.map((r, i) => (
          <Text key={start + i} wrap="truncate">
            {r.segs.map((s, j) => (
              <Text
                key={j}
                bold={s.bold}
                italic={s.italic}
                color={s.color}
                dimColor={s.dimColor}
                strikethrough={s.strikethrough}
                underline={s.underline}
              >
                {s.text}
              </Text>
            ))}
          </Text>
        ))}
        {below > 0 && <Text dimColor>↓ {below} more line{below === 1 ? "" : "s"}</Text>}
      </Box>

      <StatePane ov={ov} width={sideW} height={height} />
    </Box>
  );
}

// The right column: who's on the hook and what CI thinks. Checks get whatever
// rows are left, worst-first, so a red build is never the thing that scrolled
// off.
function StatePane({ ov, width, height }) {
  const room = Math.max(6, width - 4);
  if (!ov || ov.error) {
    return (
      <Box width={width} height={height} borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color={ov?.error ? "red" : undefined} dimColor={!ov?.error} wrap="truncate">
          {ov?.error ? truncate(ov.error, room) : "loading…"}
        </Text>
      </Box>
    );
  }

  const reviewers = (ov.reviewRequests || []).map((r) => r.login || r.name || r.slug || "?");
  const assignees = (ov.assignees || []).map((a) => a.login);
  const labels = (ov.labels || []).map((l) => l.name);
  const checks = [...(ov.checkRuns || [])].sort((a, b) => checkRank(checkState(a)) - checkRank(checkState(b)));

  const listRows = (n) => Math.max(1, n);
  const used =
    1 + listRows(reviewers.length) + 1 +
    1 + listRows(assignees.length) + 1 +
    (labels.length ? 1 + labels.length + 1 : 0) +
    1;
  const checkRoom = Math.max(1, height - 2 - used);
  const overflow = checks.length > checkRoom;
  const checksShown = overflow ? checks.slice(0, Math.max(0, checkRoom - 1)) : checks;

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold color="cyan" wrap="truncate">Reviewers</Text>
      {reviewers.length === 0 && <Text dimColor>none requested</Text>}
      {reviewers.map((r, i) => (
        <Text key={"r" + i} wrap="truncate"><Text dimColor>• </Text>{truncate(r, room - 2)}</Text>
      ))}

      <Text>{" "}</Text>
      <Text bold color="cyan" wrap="truncate">Assignees</Text>
      {assignees.length === 0 && <Text dimColor>none</Text>}
      {assignees.map((a, i) => (
        <Text key={"a" + i} wrap="truncate"><Text dimColor>• </Text>{truncate(a, room - 2)}</Text>
      ))}

      {labels.length > 0 && (
        <>
          <Text>{" "}</Text>
          <Text bold color="cyan" wrap="truncate">Labels</Text>
          {labels.map((l, i) => (
            <Text key={"l" + i} wrap="truncate"><Text dimColor>• </Text>{truncate(l, room - 2)}</Text>
          ))}
        </>
      )}

      <Text>{" "}</Text>
      <Text bold color="cyan" wrap="truncate">
        Checks <Text dimColor>({ov.checks.passing}✓ {ov.checks.failing}✗ {ov.checks.pending}●)</Text>
      </Text>
      {checks.length === 0 && <Text dimColor>none</Text>}
      {checksShown.map((c, i) => {
        const g = CHECK_GLYPH[checkState(c)];
        return (
          <Text key={"c" + i} wrap="truncate">
            <Text color={g.color}>{g.char} </Text>
            {truncate(c.name || c.context || c.workflowName || "check", room - 2)}
          </Text>
        );
      })}
      {overflow && <Text dimColor>… {checks.length - checksShown.length} more</Text>}
    </Box>
  );
}
