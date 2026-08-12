// The viewer's full-screen PR overview (`O`) — everything about the PR that
// isn't the diff, so a review can be finished without opening a browser.
//
// It leads with what the PR is waiting on — failing checks, a review requested
// from you, unresolved threads — because that's the question it exists to
// answer. Recent activity is a compact log beneath it, and the description last.
// The right column carries the state you glance at: who's on the hook, what CI
// thinks, labels.
//
// Layout and content come from `pr-overview.mjs`; this file only slices the row
// list to the viewport and paints it.

import React from "react";
import { Box, Text } from "ink";
import { checkState } from "./pr.mjs";
import { CHECK_GLYPH, checkRank, truncate } from "./pr-view.mjs";
import { overviewRows, clampScroll, overviewViewport } from "./pr-overview.mjs";

// Width of the right-hand state column, as a share of the screen, bounded so it
// stays readable on a narrow terminal and doesn't sprawl on a wide one.
// Rows the header takes above the scrolling body: title, by-line, size, spacer.
export const HEAD_ROWS = 4;

export function overviewLayout(cols) {
  const side = Math.max(22, Math.min(38, Math.round(cols * 0.28)));
  return { mainW: Math.max(20, cols - side), sideW: side };
}

export function PrOverview({ pr, overview, scroll = 0, width, height, refreshing = false, me = null, env = null }) {
  const { mainW, sideW } = overviewLayout(width);
  // Border (2) + paddingX 1 each side (2).
  const innerW = Math.max(10, mainW - 4);
  const ov = overview;

  const rows = overviewRows(ov, innerW, Date.now(), me);
  const { viewport } = overviewViewport(rows.length, height, HEAD_ROWS);
  const start = clampScroll(scroll, rows.length, viewport);
  const shown = rows.slice(start, start + viewport);
  const below = Math.max(0, rows.length - (start + shown.length));

  const loaded = ov && !ov.error;

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
        {/* Size and lifecycle only. What the PR is *waiting on* is the block
            below, and repeating "review required" here just competed with it. */}
        <Text wrap="truncate">
          <Text color="green">+{loaded ? ov.additions : 0}</Text>
          <Text> </Text>
          <Text color="red">-{loaded ? ov.deletions : 0}</Text>
          <Text dimColor>
            {"  "}
            {loaded ? `${ov.changedFiles} file${ov.changedFiles === 1 ? "" : "s"}` : ""}
          </Text>
          {loaded && ov.isDraft ? <Text dimColor>  draft</Text> : null}
          {loaded && ov.mergeable === "CONFLICTING" ? <Text color="red">  conflicts</Text> : null}
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

      <StatePane ov={ov} env={env} width={sideW} height={height} />
    </Box>
  );
}

// The provisioned environment for this worktree, at the very top of the column.
//
// It sits above everything else because it's the one thing here you *act* on —
// `o` opens it — and because it was the only part of the old `orbit-diff
// pr-status` pane not already covered by this view. `env` is the worktree's
// session record, or null when there isn't one.
function EnvRows({ env, room }) {
  if (!env) return null;
  const { envInstance, envUrl, status, error } = env;
  let body;
  if (envInstance != null || envUrl) {
    body = (
      <>
        {envInstance != null && (
          <Text wrap="truncate"><Text dimColor>• </Text><Text color="green">#{envInstance}</Text></Text>
        )}
        {envUrl && <Text wrap="truncate"><Text dimColor>• </Text>{truncate(envUrl, room - 2)}</Text>}
      </>
    );
  } else if (status === "provisioning") {
    body = <Text color="yellow" wrap="truncate">provisioning…</Text>;
  } else if (status === "failed") {
    body = <Text color="red" wrap="truncate">{truncate(error || "provisioning failed", room)}</Text>;
  } else if (status === "tearing-down") {
    body = <Text dimColor wrap="truncate">tearing down…</Text>;
  } else {
    return null; // a worktree with no environment says nothing rather than "none"
  }

  return (
    <>
      <Text bold color="cyan" wrap="truncate">Env <Text dimColor>(o)</Text></Text>
      {body}
      <Text>{" "}</Text>
    </>
  );
}

// The right column: the environment, who's on the hook, and what CI thinks.
// Checks get whatever rows are left, worst-first, so a red build is never the
// thing that scrolled off.
function StatePane({ ov, env, width, height }) {
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
  // Rows the env block will take, so the checks list below still gets counted
  // space rather than overflowing the box.
  const envRows = envRowCount(env);
  const used =
    envRows +
    1 + listRows(reviewers.length) + 1 +
    1 + listRows(assignees.length) + 1 +
    (labels.length ? 1 + labels.length + 1 : 0) +
    1;
  const checkRoom = Math.max(1, height - 2 - used);
  const overflow = checks.length > checkRoom;
  const checksShown = overflow ? checks.slice(0, Math.max(0, checkRoom - 1)) : checks;

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="gray" paddingX={1}>
      <EnvRows env={env} room={room} />
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

// How many rows EnvRows renders, so StatePane can budget for it. Kept beside the
// component so the two can't disagree about the height.
function envRowCount(env) {
  if (!env) return 0;
  const { envInstance, envUrl, status } = env;
  if (envInstance != null || envUrl) {
    return 2 + (envInstance != null ? 1 : 0) + (envUrl ? 1 : 0); // header + rows + spacer
  }
  if (status === "provisioning" || status === "failed" || status === "tearing-down") return 3;
  return 0;
}
