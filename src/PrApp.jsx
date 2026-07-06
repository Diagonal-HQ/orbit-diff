import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { useDimensions } from "./useDimensions.mjs";
import { prOverview, renderCommand, checkState } from "./pr.mjs";

// PR-management TUI for the current repo. Left rail = the open, non-draft PRs
// assigned to me or awaiting my review; right panel = a live overview of the
// highlighted one. Picking a PR (`enter`/`o`) or finishing it (`d`) sets a
// handoff and exits, so index.jsx can release the terminal to the configured
// `pr.start` / `pr.done` command, then re-launch us on a fresh list.
//
// The list itself is fetched *inside* the component (`loadPRs`), so the shell
// paints instantly and the PRs stream in when `gh` answers — the first `gh`
// round-trip no longer blocks boot. `r` re-runs the fetch in place.
//
// `handoff` is a plain object index.jsx passes in and reads after exit:
//   { action: "start" | "done" | null, pr, selected }
export function PrApp({ loadPRs, config, handoff, initialSelected = 0 }) {
  const { exit } = useApp();
  const { cols, rows } = useDimensions();

  // prs: null = still loading · array = loaded (possibly empty). loadError holds
  // a message when `gh` couldn't answer at all (not a repo, not authed, …).
  const [prs, setPrs] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState(clampIdx(initialSelected, 0));
  const [toast, setToast] = useState(null);
  // Overview cache: number -> overview object (or { error }); undefined = unfetched.
  const [details, setDetails] = useState({});
  // Numbers we've already kicked off a fetch for. A ref (not `details`) so it
  // can't be a dependency of the effect below — depending on the cache we set
  // would re-run the effect and its cleanup would cancel the in-flight fetch.
  const requested = useRef(new Set());
  // Bumped by `r` to re-run the list fetch.
  const [reloadTick, setReloadTick] = useState(0);

  // Fetch (and refetch) the PR list. Clears the overview caches so a refresh
  // pulls fresh detail too, and clamps the selection into the new list.
  useEffect(() => {
    let live = true;
    setPrs(null);
    setLoadError(null);
    requested.current = new Set();
    setDetails({});
    loadPRs().then(
      (list) => {
        if (!live) return;
        setPrs(list);
        setSelected((s) => clampIdx(s, list.length));
      },
      (err) => {
        if (live) {
          setPrs([]);
          setLoadError(err.message || String(err));
        }
      },
    );
    return () => {
      live = false;
    };
  }, [loadPRs, reloadTick]);

  const loading = prs === null;
  const list = prs || [];
  const current = list[selected] || null;

  // Lazily fetch the highlighted PR's overview once, caching by number.
  useEffect(() => {
    if (!current) return;
    const n = current.number;
    if (requested.current.has(n)) return;
    requested.current.add(n);
    let live = true;
    setDetails((d) => ({ ...d, [n]: null })); // null = loading
    prOverview(n).then((ov) => {
      if (live) setDetails((d) => ({ ...d, [n]: ov }));
    });
    return () => {
      live = false;
    };
  }, [current]);

  const startCmd = current ? renderCommand(config.pr.start, current) : null;
  const doneCmd = current ? renderCommand(config.pr.done, current) : null;

  const finish = (action) => {
    if (!current) return;
    if (action === "start" && !startCmd) return setToast("pr.start isn't configured — add it to config.js");
    if (action === "done" && !doneCmd) return setToast("pr.done isn't configured — add it to config.js");
    handoff.action = action;
    handoff.pr = current;
    handoff.selected = selected;
    exit();
  };

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      handoff.action = null;
      return exit();
    }
    if (input === "r") {
      setToast(null);
      return setReloadTick((t) => t + 1); // refetch in place
    }
    if (loading || !list.length) return;
    if (key.downArrow || input === "j") return setSelected((s) => clampIdx(s + 1, list.length));
    if (key.upArrow || input === "k") return setSelected((s) => clampIdx(s - 1, list.length));
    if (input === "g") return setSelected(0);
    if (input === "G") return setSelected(list.length - 1);
    if (key.return || input === "o") return finish("start");
    if (input === "d") return finish("done");
  });

  const bodyH = Math.max(6, rows - 2); // rows between the title and status bars
  // Full-width list up top; the detail area fills the rest, split into two panes.
  const topH = Math.max(4, Math.min(Math.floor(bodyH * 0.45), (loading ? 0 : list.length) + 3));
  const lowerH = Math.max(3, bodyH - topH);
  const leftW = Math.max(24, Math.floor(cols * 0.58));
  const rightW = Math.max(20, cols - leftW);
  const ov = current ? details[current.number] : undefined;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box height={1}>
        <Text wrap="truncate">
          {" "}
          <Text bold color="magenta">orbit-diff</Text>
          <Text dimColor> · PRs for me</Text>
          <Text dimColor>  ({loading ? "loading…" : `${list.length} open`})</Text>
        </Text>
      </Box>

      <PrList prs={list} loading={loading} error={loadError} selected={selected} width={cols} height={topH} />

      <Box height={lowerH}>
        <OverviewPane pr={current} overview={ov} width={leftW} height={lowerH} />
        <MetaPane pr={current} overview={ov} width={rightW} height={lowerH} />
      </Box>

      <StatusBar
        toast={toast}
        startSet={!!config.pr.start.trim()}
        doneSet={!!config.pr.done.trim()}
        startCmd={startCmd}
      />
    </Box>
  );
}

// The left rail: one row per PR — review-state glyph, #number, title.
function PrList({ prs, loading, error, selected, width, height }) {
  const contentH = Math.max(1, height - 2);
  const start = Math.max(0, Math.min(selected - Math.floor(contentH / 2), Math.max(0, prs.length - contentH)));
  const window = prs.slice(start, start + contentH);
  const room = width - 4; // borders + padding

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan" wrap="truncate">Pull requests {loading ? "" : `(${prs.length})`}</Text>
      {loading && <Text dimColor>loading… (q to quit)</Text>}
      {!loading && error && <Text color="red" wrap="truncate">{error}</Text>}
      {!loading && !error && prs.length === 0 && <Text dimColor>nothing assigned to or awaiting you</Text>}
      {window.map((pr, i) => {
        const idx = start + i;
        const active = idx === selected;
        const g = reviewGlyph(pr.reviewDecision);
        const num = `#${pr.number}`;
        const title = truncate(pr.title, Math.max(4, room - num.length - 3));
        return (
          <Text key={pr.number} inverse={active} wrap="truncate">
            <Text color={g.color}>{g.char} </Text>
            <Text dimColor>{num} </Text>
            <Text color={active ? "white" : undefined}>{title}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

// Lower-left pane: the highlighted PR's overview summary + description.
function OverviewPane({ pr, overview, width, height }) {
  if (!pr) {
    return <Box width={width} height={height} borderStyle="round" borderColor="gray" paddingX={1} />;
  }

  const ov = overview; // undefined = not requested, null = loading, obj = ready
  const loaded = ov && !ov.error;
  const labels = loaded && Array.isArray(ov.labels) ? ov.labels.map((l) => l.name) : [];
  const bodyLines = loaded && ov.body ? ov.body.replace(/\r/g, "").trim().split("\n") : [];

  // Rows the summary block above the description consumes, counted exactly so
  // the description never overflows the fixed pane height (overflow garbles the
  // frame). 2 = title + author/branch; then a spacer + the status lines.
  const summaryRows = loaded ? 1 + 2 + (labels.length > 0 ? 1 : 0) : 1 + 1;
  // Inner height (minus border) minus the summary minus the description's own
  // margin + header row.
  const bodyRoom = Math.max(0, height - 2 - 2 - summaryRows - 2);
  const showBody = bodyLines.length > 0 && bodyRoom >= 1;
  const bodyShown = bodyLines.length > bodyRoom ? bodyLines.slice(0, Math.max(0, bodyRoom - 1)) : bodyLines;

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold wrap="truncate">
        <Text dimColor>#{pr.number} </Text>
        {pr.title}
      </Text>
      <Text wrap="truncate">
        <Text dimColor>by </Text>{pr.author?.login || "?"}
        <Text dimColor>   {pr.headRefName} → {pr.baseRefName}</Text>
      </Text>

      <Box marginTop={1} flexDirection="column">
        {ov === null && <Text dimColor>loading overview…</Text>}
        {ov && ov.error && <Text color="red" wrap="truncate">couldn't load: {ov.error}</Text>}
        {ov && !ov.error && (
          <>
            <Text wrap="truncate">
              <Text dimColor>review  </Text>
              <ReviewState decision={ov.reviewDecision} />
              <Text dimColor>    merge  </Text>
              <MergeState pr={ov} />
            </Text>
            <Text wrap="truncate">
              <Text dimColor>changes </Text>
              <Text color="green">+{ov.additions}</Text> <Text color="red">-{ov.deletions}</Text>
              <Text dimColor>  across {ov.changedFiles} file{ov.changedFiles === 1 ? "" : "s"}</Text>
            </Text>
            {labels.length > 0 && (
              <Text wrap="truncate"><Text dimColor>labels  </Text>{labels.join(", ")}</Text>
            )}
          </>
        )}
      </Box>

      {showBody && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>— description —</Text>
          {bodyShown.map((line, i) => (
            <Text key={i} wrap="truncate">{line || " "}</Text>
          ))}
          {bodyLines.length > bodyRoom && <Text dimColor>… {bodyLines.length - bodyShown.length} more lines</Text>}
        </Box>
      )}
    </Box>
  );
}

// Lower-right pane: who's on the hook (requested reviewers, assignees) and the
// per-check status rollup. Checks are ordered failing → pending → passing so the
// ones that need attention are always visible even when the list is long.
function MetaPane({ pr, overview, width, height }) {
  if (!pr) {
    return <Box width={width} height={height} borderStyle="round" borderColor="gray" paddingX={1} />;
  }
  const ov = overview;
  const room = width - 4;

  if (ov == null) {
    return (
      <Box width={width} height={height} borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>{ov === null ? "loading…" : ""}</Text>
      </Box>
    );
  }
  if (ov.error) {
    return (
      <Box width={width} height={height} borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color="red" wrap="truncate">{ov.error}</Text>
      </Box>
    );
  }

  const reviewers = (ov.reviewRequests || []).map((r) => r.login || r.name || r.slug || "?");
  const assignees = (ov.assignees || []).map((a) => a.login);
  const checks = [...(ov.statusCheckRollup || [])].sort(
    (a, b) => checkRank(checkState(a)) - checkRank(checkState(b)),
  );

  // Rows consumed above the checks list: the Reviewers block (header + its rows),
  // a spacer, the Assignees block (header + rows), a spacer, and the Checks
  // header. Whatever height is left is how many individual checks we can show.
  const reviewerRows = Math.max(1, reviewers.length); // "none requested" is 1 row
  const assigneeRows = Math.max(1, assignees.length);
  const above = 1 + reviewerRows + 1 + 1 + assigneeRows + 1 + 1;
  const checkRoom = Math.max(1, height - 2 - above);
  // Reserve a row for the "… N more" line when the list is longer than fits.
  const checksShown = checks.length > checkRoom ? checks.slice(0, Math.max(0, checkRoom - 1)) : checks;

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold color="cyan" wrap="truncate">Reviewers</Text>
      {reviewers.length === 0 && <Text dimColor>none requested</Text>}
      {reviewers.map((r, i) => (
        <Text key={"r" + i} wrap="truncate"><Text dimColor>• </Text>{truncate(r, room - 2)}</Text>
      ))}

      <Text bold color="cyan" wrap="truncate">{" "}</Text>
      <Text bold color="cyan" wrap="truncate">Assignees</Text>
      {assignees.length === 0 && <Text dimColor>none</Text>}
      {assignees.map((a, i) => (
        <Text key={"a" + i} wrap="truncate"><Text dimColor>• </Text>{truncate(a, room - 2)}</Text>
      ))}

      <Text bold color="cyan" wrap="truncate">{" "}</Text>
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
      {checks.length > checkRoom && <Text dimColor>… {checks.length - checksShown.length} more</Text>}
    </Box>
  );
}

const CHECK_GLYPH = {
  pass: { char: "✓", color: "green" },
  fail: { char: "✗", color: "red" },
  pending: { char: "●", color: "yellow" },
};
const checkRank = (s) => (s === "fail" ? 0 : s === "pending" ? 1 : 2);

function ReviewState({ decision }) {
  const map = {
    APPROVED: { text: "approved", color: "green" },
    CHANGES_REQUESTED: { text: "changes requested", color: "red" },
    REVIEW_REQUIRED: { text: "review required", color: "yellow" },
  };
  const s = map[decision] || { text: decision ? decision.toLowerCase() : "no reviews", color: "gray" };
  return <Text color={s.color}>{s.text}</Text>;
}

function MergeState({ pr }) {
  if (pr.mergeable === "CONFLICTING") return <Text color="red">conflicts</Text>;
  if (pr.mergeable === "MERGEABLE") return <Text color="green">clean</Text>;
  return <Text dimColor>{(pr.mergeable || "unknown").toLowerCase()}</Text>;
}

function StatusBar({ toast, startSet, doneSet, startCmd }) {
  if (toast) {
    return (
      <Box height={1}>
        <Text wrap="truncate"> <Text color="yellow">{toast}</Text></Text>
      </Box>
    );
  }
  return (
    <Box height={1}>
      <Text wrap="truncate">
        {" "}
        <Text dimColor>↑↓/jk</Text> move  <Text bold>enter</Text>
        <Text dimColor>/o</Text> {startSet ? "start" : <Text dimColor>start (unset)</Text>}  <Text bold>d</Text> {doneSet ? "done" : <Text dimColor>done (unset)</Text>}  <Text bold>r</Text> refresh  <Text bold>q</Text> quit
        {startCmd ? <Text dimColor>   ↵ {startCmd}</Text> : null}
      </Text>
    </Box>
  );
}

const reviewGlyph = (decision) => {
  switch (decision) {
    case "APPROVED": return { char: "✓", color: "green" };
    case "CHANGES_REQUESTED": return { char: "✗", color: "red" };
    case "REVIEW_REQUIRED": return { char: "●", color: "yellow" };
    default: return { char: "○", color: "gray" };
  }
};

function clampIdx(i, len) {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(i, len - 1));
}

function truncate(s, max) {
  s = String(s ?? "");
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}
