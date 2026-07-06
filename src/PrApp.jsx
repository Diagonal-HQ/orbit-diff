import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { useDimensions } from "./useDimensions.mjs";
import { prOverview, renderCommand, checkState } from "./pr.mjs";
import { tildeify } from "./paths.mjs";

// PR-management TUI for the current repo.
//
//   ┌───────────────── PRs waiting on me ──────────────┬─ worktrees ─┐
//   ├──────────── overview + description ──────────────┼─ reviewers/ ─┤
//   └──────────────────────────────────────────────────┴─ checks ────┘
//
// The list + worktrees are fetched inside the component (`loadPRs` /
// `loadWorktrees`), so the shell paints instantly and the data streams in when
// `gh` answers; `r` refetches in place. Picking a PR (`enter`/`o`) or finishing
// it (`d`) runs the configured `pr.start` / `pr.done` command in the background
// (via the `runPr` callback) — it does NOT take over the terminal — and a toast
// reports where its output is logged. `/` filters the list.
export function PrApp({ loadPRs, loadWorktrees, runPr, config }) {
  const { exit } = useApp();
  const { cols, rows } = useDimensions();

  // prs: null = still loading · array = loaded (possibly empty). loadError holds
  // a message when `gh` couldn't answer at all (not a repo, not authed, …).
  const [prs, setPrs] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [worktrees, setWorktrees] = useState([]);
  const [selected, setSelected] = useState(0);
  const [toast, setToast] = useState(null);
  const [mode, setMode] = useState("normal"); // "normal" | "search"
  const [query, setQuery] = useState("");
  // Overview cache: number -> overview object (or { error }); undefined = unfetched.
  const [details, setDetails] = useState({});
  // Numbers we've already kicked off a fetch for. A ref (not `details`) so it
  // can't be a dependency of the effect below — depending on the cache we set
  // would re-run the effect and its cleanup would cancel the in-flight fetch.
  const requested = useRef(new Set());
  const [reloadTick, setReloadTick] = useState(0);

  // Fetch (and refetch) the PR list + worktrees. Worktrees are a fast local git
  // call, so we set them immediately; the PR list arrives asynchronously.
  useEffect(() => {
    let live = true;
    setPrs(null);
    setLoadError(null);
    requested.current = new Set();
    setDetails({});
    try {
      setWorktrees(loadWorktrees() || []);
    } catch {
      setWorktrees([]);
    }
    loadPRs().then(
      (loaded) => {
        if (!live) return;
        setPrs(loaded);
        setSelected((s) => clampIdx(s, loaded.length));
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
  }, [loadPRs, loadWorktrees, reloadTick]);

  const loading = prs === null;
  const all = prs || [];
  // Branch → worktree, for both the PR indicator and the worktrees pane's PR tags.
  const wtByBranch = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch, w]));
  const prByBranch = new Map(all.map((p) => [p.headRefName, p.number]));

  const list = filterPRs(all, query);
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

  const run = (action) => {
    if (!current) return;
    const res = runPr(action, current);
    if (!res.ok) return setToast(res.error);
    const verb = action === "start" ? "started" : "finishing";
    const where = res.logPath ? ` · log ${tildeify(res.logPath)}` : "";
    setToast(`▶ ${verb} #${current.number} in background${where} · r to refresh`);
  };

  useInput((input, key) => {
    // ---- Search mode: capture typing into the filter ----
    if (mode === "search") {
      if (key.escape) {
        setQuery("");
        return setMode("normal");
      }
      if (key.return) return setMode("normal"); // keep the filter, exit typing
      if (key.backspace || key.delete) return setQuery((q) => q.slice(0, -1));
      if (input && !key.ctrl && !key.meta) return setQuery((q) => q + input);
      return;
    }

    // ---- Normal mode ----
    if (input === "q") return exit();
    if (key.escape) {
      if (query) return setQuery(""); // clear an active filter first
      return exit();
    }
    if (input === "/") {
      setToast(null);
      return setMode("search");
    }
    if (input === "r") {
      setToast(null);
      return setReloadTick((t) => t + 1);
    }
    if (loading || !list.length) return;
    if (key.downArrow || input === "j") return setSelected((s) => clampIdx(s + 1, list.length));
    if (key.upArrow || input === "k") return setSelected((s) => clampIdx(s - 1, list.length));
    if (input === "g") return setSelected(0);
    if (input === "G") return setSelected(list.length - 1);
    if (key.return || input === "o") return run("start");
    if (input === "d") return run("done");
  });

  const bodyH = Math.max(6, rows - 2); // rows between the title and status bars
  const topH = Math.max(4, Math.min(Math.floor(bodyH * 0.45), Math.max(list.length, worktrees.length) + 3));
  const lowerH = Math.max(3, bodyH - topH);
  // One shared column split, so the top and bottom panes line up vertically.
  const leftW = Math.max(24, Math.floor(cols * 0.6));
  const rightW = Math.max(20, cols - leftW);
  const ov = current ? details[current.number] : undefined;

  const countLabel = loading ? "loading…" : query ? `${list.length}/${all.length}` : `${all.length} open`;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box height={1}>
        <Text wrap="truncate">
          {" "}
          <Text bold color="magenta">orbit-diff</Text>
          <Text dimColor> · PRs for me</Text>
          <Text dimColor>  ({countLabel})</Text>
        </Text>
      </Box>

      <Box height={topH}>
        <PrList
          prs={list}
          loading={loading}
          error={loadError}
          selected={selected}
          query={query}
          searching={mode === "search"}
          wtBranches={wtByBranch}
          width={leftW}
          height={topH}
        />
        <WorktreePane worktrees={worktrees} prByBranch={prByBranch} width={rightW} height={topH} />
      </Box>

      <Box height={lowerH}>
        <OverviewPane pr={current} overview={ov} width={leftW} height={lowerH} />
        <MetaPane pr={current} overview={ov} width={rightW} height={lowerH} />
      </Box>

      {mode === "search" ? (
        <SearchBar query={query} count={list.length} />
      ) : (
        <StatusBar
          toast={toast}
          startSet={!!config.pr.start.trim()}
          doneSet={!!config.pr.done.trim()}
          startCmd={startCmd}
        />
      )}
    </Box>
  );
}

// Top-left rail: one row per PR — review-state glyph, a `⧉` when the branch is
// already checked out in a local worktree, #number, and the title.
function PrList({ prs, loading, error, selected, query, searching, wtBranches, width, height }) {
  const listRoom = Math.max(1, height - 2 - 1); // minus border rows and the header
  const start = Math.max(0, Math.min(selected - Math.floor(listRoom / 2), Math.max(0, prs.length - listRoom)));
  const window = prs.slice(start, start + listRoom);
  const room = width - 4; // borders + padding

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor={searching ? "yellow" : "cyan"} paddingX={1}>
      <Text bold color="cyan" wrap="truncate">
        Pull requests {loading ? "" : `(${prs.length})`}
        {query ? <Text dimColor> · /{query}</Text> : null}
      </Text>
      {loading && <Text dimColor>loading… (q to quit)</Text>}
      {!loading && error && <Text color="red" wrap="truncate">{error}</Text>}
      {!loading && !error && prs.length === 0 && (
        <Text dimColor>{query ? "no PRs match" : "nothing assigned to or awaiting you"}</Text>
      )}
      {window.map((pr, i) => {
        const idx = start + i;
        const active = idx === selected;
        const g = reviewGlyph(pr.reviewDecision);
        const hasWt = wtBranches.has(pr.headRefName);
        const num = `#${pr.number}`;
        const title = truncate(pr.title, Math.max(4, room - num.length - 5));
        return (
          <Text key={pr.number} inverse={active} wrap="truncate">
            <Text color={g.color}>{g.char} </Text>
            <Text color="blueBright">{hasWt ? "⧉ " : "  "}</Text>
            <Text dimColor>{num} </Text>
            <Text color={active ? "white" : undefined}>{title}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

// Top-right pane: the repo's git worktrees, tagged with the matching PR number
// when a worktree's branch is one of the PRs above.
function WorktreePane({ worktrees, prByBranch, width, height }) {
  const listRoom = Math.max(1, height - 2 - 1); // minus border rows and the header
  // Reserve a row for "… N more" when the list is longer than fits.
  const window = worktrees.length > listRoom ? worktrees.slice(0, listRoom - 1) : worktrees;
  const room = width - 4;

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold color="blueBright" wrap="truncate">Worktrees ({worktrees.length})</Text>
      {worktrees.length === 0 && <Text dimColor>none</Text>}
      {window.map((w, i) => {
        const label = w.bare
          ? "(bare)"
          : w.branch || (w.head ? `detached ${w.head.slice(0, 7)}` : "(detached)");
        const prNum = w.branch ? prByBranch.get(w.branch) : undefined;
        const tag = prNum ? ` #${prNum}` : "";
        return (
          <Text key={w.path + i} wrap="truncate">
            <Text color="blueBright">⧉ </Text>
            <Text color={prNum ? "cyan" : undefined}>{truncate(label, Math.max(4, room - 2 - tag.length))}</Text>
            {prNum ? <Text dimColor>{tag}</Text> : null}
          </Text>
        );
      })}
      {worktrees.length > listRoom && <Text dimColor>… {worktrees.length - window.length} more</Text>}
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
        {loaded && (
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
// per-check status — one row per check (latest run only), ordered failing →
// pending → passing so the ones that need attention are always visible.
function MetaPane({ pr, overview, width, height }) {
  if (!pr) {
    return <Box width={width} height={height} borderStyle="round" borderColor="gray" paddingX={1} />;
  }
  const ov = overview;
  const room = width - 4;

  if (ov == null || ov.error) {
    return (
      <Box width={width} height={height} borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color={ov && ov.error ? "red" : undefined} dimColor={!ov || !ov.error} wrap="truncate">
          {ov === null ? "loading…" : ov && ov.error ? ov.error : ""}
        </Text>
      </Box>
    );
  }

  const reviewers = (ov.reviewRequests || []).map((r) => r.login || r.name || r.slug || "?");
  const assignees = (ov.assignees || []).map((a) => a.login);
  const checks = [...(ov.checkRuns || [])].sort((a, b) => checkRank(checkState(a)) - checkRank(checkState(b)));

  // Rows consumed above the checks list: Reviewers header + its rows, a spacer,
  // Assignees header + rows, a spacer, the Checks header. What's left is checks.
  const reviewerRows = Math.max(1, reviewers.length);
  const assigneeRows = Math.max(1, assignees.length);
  const above = 1 + reviewerRows + 1 + 1 + assigneeRows + 1 + 1;
  const checkRoom = Math.max(1, height - 2 - above);
  const checksShown = checks.length > checkRoom ? checks.slice(0, Math.max(0, checkRoom - 1)) : checks;

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
      {checks.length > checkRoom && <Text dimColor>… {checks.length - checksShown.length} more</Text>}
    </Box>
  );
}

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

function SearchBar({ query, count }) {
  return (
    <Box height={1}>
      <Text wrap="truncate">
        {" "}
        <Text color="yellow">/</Text>
        {query}
        <Text inverse> </Text>
        <Text dimColor>  {count} match{count === 1 ? "" : "es"} · enter keep · esc clear</Text>
      </Text>
    </Box>
  );
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
        <Text dimColor>/o</Text> {startSet ? "start" : <Text dimColor>start (unset)</Text>}  <Text bold>d</Text> {doneSet ? "done" : <Text dimColor>done (unset)</Text>}  <Text bold>/</Text> search  <Text bold>r</Text> refresh  <Text bold>q</Text> quit
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

const CHECK_GLYPH = {
  pass: { char: "✓", color: "green" },
  fail: { char: "✗", color: "red" },
  pending: { char: "●", color: "yellow" },
};
const checkRank = (s) => (s === "fail" ? 0 : s === "pending" ? 1 : 2);

// Fuzzy-filter PRs by a subsequence match over "#number title branch".
function filterPRs(prs, query) {
  const q = query.trim().toLowerCase();
  if (!q) return prs;
  return prs.filter((p) => subseq(q, `#${p.number} ${p.title} ${p.headRefName}`.toLowerCase()));
}

function subseq(needle, hay) {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

function clampIdx(i, len) {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(i, len - 1));
}

function truncate(s, max) {
  s = String(s ?? "");
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}
