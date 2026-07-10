import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { useDimensions } from "./useDimensions.mjs";
import { prOverview, renderCommand, checkState } from "./pr.mjs";
import { tildeify } from "./paths.mjs";
import { markdownLines } from "./markdown.mjs";
import { Spinner } from "./Spinner.jsx";

// Load worktrees / sessions defensively — both are cheap local reads, but a
// transient failure should keep the last good list rather than blow up the TUI.
const safeCall = (fn) => {
  try {
    return fn() || [];
  } catch {
    return [];
  }
};

// PR-management TUI for the current repo.
//
//   ┌───────────────── PRs waiting on me ──────────────┬─ worktrees ─┐
//   ├──────────── overview + description ──────────────┼─ reviewers/ ─┤
//   └──────────────────────────────────────────────────┴─ checks ────┘
//
// The list, worktrees, and review sessions are fetched inside the component
// (`loadPRs` / `loadWorktrees` / `loadSessions`), so the shell paints instantly
// and the data streams in when `gh` answers; `r` refetches in place. Starting a
// PR (`enter`) hands off to `startReview` — it creates the worktree and a
// detached three-pane tmux review window in the background (you stay in the
// list) and a spinner tracks provisioning until the setup script's
// `orbit-diff env-report` lands, at which point the PR is tagged with its env
// instance. `o` opens the PR in the browser, `d` tears its workspace down (when
// one exists) via `finishReview`, `tab` moves focus to the worktrees pane (where
// `enter` jumps to a worktree's tmux window, `o` opens its PR, and `d` also
// tears it down), `n` opens a prompt for a branch name and hands it to
// `startLocal` — the same worktree + review window as a PR, but on a brand-new
// local branch with no PR behind it — `/` filters the list, and `left`/`right`
// switch between the "Mine" tab (assigned to or awaiting review from you) and
// "All" (every open PR in the repo) — each tab fetches its own list, cached
// until the next `r` refresh.
export function PrApp({ loadPRs, loadAllPRs, loadWorktrees, loadSessions, startReview, startLocal, finishReview, openUrl, openWorktree, config }) {
  const { exit } = useApp();
  const { cols, rows } = useDimensions();

  // Which tab is showing: "mine" (assigned to or awaiting review from you, the
  // original view) or "all" (every open PR in the repo). Each keeps its own
  // cached list/error, keyed by view, so switching tabs doesn't refetch a list
  // you've already loaded this session.
  const [view, setView] = useState("mine"); // "mine" | "all"
  // prsByView[view]: null = still loading · array = loaded (possibly empty).
  // errorByView[view] holds a message when `gh` couldn't answer at all (not a
  // repo, not authed, …).
  const [prsByView, setPrsByView] = useState({ mine: null, all: null });
  const [errorByView, setErrorByView] = useState({ mine: null, all: null });
  const [worktrees, setWorktrees] = useState([]);
  // Review sessions orbit-diff owns (from the session registry): drives the
  // per-PR "provisioning" spinner and the env-instance tags.
  const [sessions, setSessions] = useState(() => safeCall(loadSessions));
  const [selected, setSelected] = useState(0);
  const [selectedWt, setSelectedWt] = useState(0);
  const [descScroll, setDescScroll] = useState(0); // scroll offset into the description pane
  const [focus, setFocus] = useState("prs"); // "prs" | "worktrees"
  const [toast, setToast] = useState(null);
  const [mode, setMode] = useState("normal"); // "normal" | "search" | "newWorktree"
  const [query, setQuery] = useState("");
  const [newWtName, setNewWtName] = useState(""); // branch name being typed for `n`
  // Overview cache: number -> overview object (or { error }); undefined = unfetched.
  const [details, setDetails] = useState({});
  // Numbers we've already kicked off a fetch for. A ref (not `details`) so it
  // can't be a dependency of the effect below — depending on the cache we set
  // would re-run the effect and its cleanup would cancel the in-flight fetch.
  const requested = useRef(new Set());
  const [reloadTick, setReloadTick] = useState(0);

  // `r` (via reloadTick): invalidate both tabs' cached PR lists (so switching
  // tabs after a refresh re-fetches rather than showing stale data) and refetch
  // worktrees/sessions — a fast local read, so set immediately.
  useEffect(() => {
    setPrsByView({ mine: null, all: null });
    setErrorByView({ mine: null, all: null });
    requested.current = new Set();
    setDetails({});
    setWorktrees(safeCall(loadWorktrees));
    setSessions(safeCall(loadSessions));
  }, [reloadTick, loadWorktrees, loadSessions]);

  // Fetch the active tab's PR list the first time it's viewed (or after `r`
  // cleared its cache above). Only re-runs when this tab's own cache is null —
  // switching to an already-loaded tab is instant.
  useEffect(() => {
    if (prsByView[view] !== null) return;
    let live = true;
    const loader = view === "all" ? loadAllPRs : loadPRs;
    loader().then(
      (loaded) => {
        if (!live) return;
        setPrsByView((s) => ({ ...s, [view]: loaded }));
        setSelected((s) => clampIdx(s, loaded.length));
      },
      (err) => {
        if (!live) return;
        setPrsByView((s) => ({ ...s, [view]: [] }));
        setErrorByView((s) => ({ ...s, [view]: err.message || String(err) }));
      },
    );
    return () => {
      live = false;
    };
  }, [view, prsByView, loadPRs, loadAllPRs]);

  // Auto-refresh just the worktrees pane on an interval (a cheap local git call,
  // so we poll it without touching the PR list). 0 disables.
  const refreshMin = config.pr.worktreeRefreshMinutes;
  useEffect(() => {
    if (!refreshMin || refreshMin <= 0) return;
    const id = setInterval(() => setWorktrees(safeCall(loadWorktrees)), refreshMin * 60_000);
    return () => clearInterval(id);
  }, [refreshMin, loadWorktrees]);

  // Poll the session registry so a review's spinner tracks its lifecycle: setup
  // (`provisioning`) flips to the env instance when `orbit-diff env-report`
  // lands, and teardown (`tearing-down`) clears when the detached finish job
  // removes the session file. Tick fast while anything is in flight — and each
  // time an in-flight review completes, refresh the PR + worktree lists too.
  const anyProvisioning = sessions.some((s) => s.status === "provisioning");
  const anyTearingDown = sessions.some((s) => s.status === "tearing-down");
  const inFlight = anyProvisioning || anyTearingDown;
  useEffect(() => {
    const period = inFlight ? 1500 : 20_000;
    const id = setInterval(() => {
      setSessions(safeCall(loadSessions));
      if (inFlight) setWorktrees(safeCall(loadWorktrees)); // reflect the new/removed worktree promptly
    }, period);
    return () => clearInterval(id);
  }, [inFlight, loadSessions, loadWorktrees]);

  // When the last in-flight review finishes (setup reported ready, or teardown
  // cleared its session), `inFlight` flips true→false — refetch the PR list +
  // worktrees so both reflect the change.
  const wasInFlight = useRef(false);
  useEffect(() => {
    if (wasInFlight.current && !inFlight) setReloadTick((t) => t + 1);
    wasInFlight.current = inFlight;
  }, [inFlight]);

  // Auto-dismiss the top-right status toast so it doesn't linger forever.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  const prs = prsByView[view];
  const loadError = errorByView[view];
  const loading = prs === null;
  const loadedPrs = prs || [];
  // Branch → worktree, for both the PR indicator and the worktrees pane's PR tags.
  const wtByBranch = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch, w]));
  const prByBranch = new Map(loadedPrs.map((p) => [p.headRefName, p.number]));
  // Branch/path → session, for the spinner and env-instance tags.
  const sessionByBranch = new Map(sessions.filter((s) => s.branch).map((s) => [s.branch, s]));
  const sessionByPath = new Map(sessions.map((s) => [s.worktreePath, s]));

  const list = filterPRs(loadedPrs, query);
  const current = list[selected] || null;
  // Worktree selection, clamped to the live list (it can shrink on refresh).
  const wtSel = worktrees.length ? clampIdx(selectedWt, worktrees.length) : 0;
  // Effective focus: never rest on the worktrees pane when it's empty.
  const paneFocus = worktrees.length ? focus : "prs";

  // Lazily fetch the highlighted PR's overview once, caching by number. The
  // result is written unconditionally — the cache is keyed by number, so a fetch
  // that resolves after you've navigated away still correctly populates its own
  // entry. (Gating on an `live`/unmount flag here used to strand the entry at
  // `null` forever: navigating away cancelled the write, but `requested` still
  // blocked a refetch, leaving "loading overview…" stuck.)
  useEffect(() => {
    if (!current) return;
    const n = current.number;
    if (requested.current.has(n)) return;
    requested.current.add(n);
    setDetails((d) => ({ ...d, [n]: null })); // null = loading
    prOverview(n).then(
      (ov) => setDetails((d) => ({ ...d, [n]: ov })),
      (err) => {
        // prOverview catches its own errors, so this is a last-resort guard.
        // Clear the request flag so reselecting the PR retries the fetch.
        requested.current.delete(n);
        setDetails((d) => ({ ...d, [n]: { error: err?.message || String(err) } }));
      },
    );
  }, [current]);

  const setupCmd = current ? renderCommand(config.pr.setup || config.pr.start, current) : null;

  // Reflect registry/worktree changes immediately after an action, rather than
  // waiting for the next poll tick.
  const refreshLocal = () => {
    setSessions(safeCall(loadSessions));
    setWorktrees(safeCall(loadWorktrees));
  };

  // `enter` on a PR: orbit-diff creates the worktree, records the session, and
  // opens the detached three-pane review window (or focuses an existing one).
  const startPr = (pr) => {
    if (!pr) return;
    const res = startReview(pr);
    if (!res.ok) return setToast(res.error);
    refreshLocal();
    if (res.focused) return setToast(`⧉ focused review window for #${pr.number}`);
    setToast(
      res.provisioning
        ? `▶ #${pr.number}: worktree + review window opened · provisioning…`
        : `▶ #${pr.number}: review window opened in background`,
    );
  };

  // `n`'s prompt: a brand-new branch + worktree with no PR behind it, opened
  // the same way as a PR review.
  const startLocalWt = (name) => {
    const res = startLocal(name);
    if (!res.ok) return setToast(res.error);
    refreshLocal();
    if (res.focused) return setToast(`⧉ focused review window for ${name}`);
    setToast(
      res.provisioning
        ? `▶ ${name}: worktree + review window opened · provisioning…`
        : `▶ ${name}: review window opened in background`,
    );
  };

  // `o` on a PR opens it in the system's default browser.
  const openInBrowser = (pr) => {
    if (!pr) return;
    if (!pr.url) return setToast("no URL for this PR");
    const res = openUrl(pr.url);
    if (!res.ok) return setToast(res.error);
    setToast(`↗ opened #${pr.number} in browser`);
  };

  // `d` on a worktree finishes the review: teardown command (or worktree removal
  // when unset), closes the tmux window, drops the session. If its branch matches
  // a listed PR, target the full PR so {number}/{title}/{url} resolve too.
  const finishWorktree = (wt) => {
    if (!wt) return;
    const prNum = wt.branch ? prByBranch.get(wt.branch) : undefined;
    const matched = prNum ? loadedPrs.find((p) => p.number === prNum) : null;
    const target = matched
      ? { ...matched, path: wt.path }
      : { headRefName: wt.branch || "", path: wt.path };
    const label = matched ? `#${matched.number}` : wt.branch || tildeify(wt.path) || "worktree";
    const res = finishReview(target);
    refreshLocal();
    if (!res.ok) return setToast(res.error || `couldn't finish ${label}`);
    const bits = [];
    if (res.killed) bits.push("window closed");
    if (res.ranDone) bits.push("teardown + worktree removal running in background");
    else if (res.removed) bits.push("worktree removed");
    const where = res.logPath ? ` · log ${tildeify(res.logPath)}` : "";
    setToast(`✓ finishing ${label}${bits.length ? " · " + bits.join(" · ") : ""}${where}`);
  };

  // `enter` on a worktree opens it in a tmux window (or focuses the existing
  // one). The heavy lifting lives in the `openWorktree` callback; here we just
  // toast the outcome.
  const openWorktreeWindow = (wt) => {
    if (!wt) return;
    const res = openWorktree(wt);
    if (!res.ok) return setToast(res.error);
    const label = wt.branch || tildeify(wt.path) || "worktree";
    setToast(res.focused ? `⧉ focused ${label}` : `⧉ opened ${label} in a tmux window`);
  };

  // `o` on a worktree opens the matching PR in the browser (matched by branch).
  const openWorktreePr = (wt) => {
    if (!wt) return;
    const prNum = wt.branch ? prByBranch.get(wt.branch) : undefined;
    const matched = prNum ? loadedPrs.find((p) => p.number === prNum) : null;
    if (!matched) return setToast(wt.branch ? `no open PR for ${wt.branch}` : "no PR for this worktree");
    openInBrowser(matched);
  };

  // Layout geometry (computed here so the key handler can measure the
  // description pane for scrolling). Leave the last terminal row untouched:
  // filling it makes the terminal scroll, which forces Ink into a full-screen
  // clear+repaint (the flash). The body sits between the header and status bars.
  const bodyH = Math.max(6, rows - 3);
  const topH = Math.max(4, Math.min(Math.floor(bodyH * 0.45), Math.max(list.length, worktrees.length) + 3));
  const lowerH = Math.max(3, bodyH - topH);
  // One shared column split, so the top and bottom panes line up vertically.
  // The right rail only needs to fit a worktree row like
  // "⧉  seer/fix/diagonal-b9-filter-empty-target-id #4341 EV10" (57 chars)
  // without truncating, so keep it that narrow unless the terminal is wide
  // enough that 30% would be even smaller.
  const RIGHT_MIN_W = 57 + 4; // content width + border/padding
  const rightW = Math.max(RIGHT_MIN_W, Math.floor(cols * 0.3));
  const leftW = Math.max(24, cols - rightW);
  const ov = current ? details[current.number] : undefined;

  // Reset the description scroll whenever the highlighted PR changes.
  const currentNumber = current ? current.number : null;
  useEffect(() => setDescScroll(0), [currentNumber]);

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

    // ---- New local worktree: capture the branch name to hand to startLocal ----
    if (mode === "newWorktree") {
      if (key.escape) {
        setNewWtName("");
        return setMode("normal");
      }
      if (key.return) {
        const name = newWtName.trim();
        setMode("normal");
        setNewWtName("");
        if (name) startLocalWt(name);
        return;
      }
      if (key.backspace || key.delete) return setNewWtName((s) => s.slice(0, -1));
      if (input && !key.ctrl && !key.meta) return setNewWtName((s) => s + input);
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
    if (input === "n") {
      setToast(null);
      setNewWtName("");
      return setMode("newWorktree");
    }
    if (input === "r") {
      setToast(null);
      return setReloadTick((t) => t + 1);
    }
    if (key.tab) {
      // Toggle focus between the PR list and the worktrees pane (only land on
      // worktrees when there are any).
      return setFocus((f) => (f === "prs" && worktrees.length ? "worktrees" : "prs"));
    }
    if (key.leftArrow || key.rightArrow) {
      // Switch between the "Mine" and "All" tabs. Resets the selection so you
      // don't land on an unrelated row from the other tab's list.
      const next = key.rightArrow ? "all" : "mine";
      if (next === view) return;
      setToast(null);
      setSelected(0);
      return setView(next);
    }

    // ---- Worktrees pane focused ----
    if (paneFocus === "worktrees") {
      if (!worktrees.length) return;
      if (key.downArrow || input === "j") return setSelectedWt((s) => clampIdx(s + 1, worktrees.length));
      if (key.upArrow || input === "k") return setSelectedWt((s) => clampIdx(s - 1, worktrees.length));
      if (input === "g") return setSelectedWt(0);
      if (input === "G") return setSelectedWt(worktrees.length - 1);
      if (key.return) return openWorktreeWindow(worktrees[wtSel]);
      if (input === "o") return openWorktreePr(worktrees[wtSel]);
      if (input === "d") return finishWorktree(worktrees[wtSel]);
      return;
    }

    // ---- PR list focused ----
    if (loading || !list.length) return;
    // Ctrl-d / Ctrl-u scroll the description pane (half a viewport at a time),
    // clamped to what's actually scrollable for this PR's overview.
    if (key.ctrl && (input === "d" || input === "u")) {
      const { bodyLines, contentW, bodyRoom } = descMetrics(ov, leftW, lowerH);
      const { maxScroll } = layoutDescription(bodyLines, contentW, bodyRoom, descScroll);
      if (maxScroll <= 0) return;
      const step = Math.max(1, Math.floor(bodyRoom / 2));
      return setDescScroll((s) => Math.max(0, Math.min(s + (input === "d" ? step : -step), maxScroll)));
    }
    if (key.downArrow || input === "j") return setSelected((s) => clampIdx(s + 1, list.length));
    if (key.upArrow || input === "k") return setSelected((s) => clampIdx(s - 1, list.length));
    if (input === "g") return setSelected(0);
    if (input === "G") return setSelected(list.length - 1);
    if (key.return) return startPr(current);
    if (input === "o") return openInBrowser(current);
    if (input === "d") {
      const wt = current ? wtByBranch.get(current.headRefName) : null;
      if (!wt) return setToast("no workspace to tear down");
      return finishWorktree(wt);
    }
  });

  const countLabel = loading ? "loading…" : query ? `${list.length}/${loadedPrs.length}` : `${loadedPrs.length} open`;

  return (
    <Box flexDirection="column" width={cols} height={rows - 1}>
      <Box height={1} width={cols}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap="truncate">
            {" "}
            <Text bold color="magenta">orbit-diff</Text>
            <Text dimColor> · </Text>
            <Tab label="Mine" active={view === "mine"} count={view === "mine" ? countLabel : null} />
            <Text dimColor>  </Text>
            <Tab label="All" active={view === "all"} count={view === "all" ? countLabel : null} />
          </Text>
        </Box>
        {toast ? (
          <Box flexShrink={0} marginLeft={2}>
            <Text color="yellow" wrap="truncate">{toast} </Text>
          </Box>
        ) : null}
      </Box>

      <Box height={topH}>
        <PrList
          prs={list}
          loading={loading}
          error={loadError}
          selected={selected}
          focused={paneFocus === "prs"}
          query={query}
          searching={mode === "search"}
          view={view}
          wtBranches={wtByBranch}
          sessionByBranch={sessionByBranch}
          width={leftW}
          height={topH}
        />
        <WorktreePane
          worktrees={worktrees}
          prByBranch={prByBranch}
          sessionByPath={sessionByPath}
          selected={wtSel}
          focused={paneFocus === "worktrees"}
          width={rightW}
          height={topH}
        />
      </Box>

      <Box height={lowerH}>
        <OverviewPane pr={current} overview={ov} scroll={descScroll} width={leftW} height={lowerH} />
        <MetaPane pr={current} overview={ov} width={rightW} height={lowerH} />
      </Box>

      {mode === "search" ? (
        <SearchBar query={query} count={list.length} />
      ) : mode === "newWorktree" ? (
        <NewWorktreeBar name={newWtName} />
      ) : (
        <StatusBar focus={paneFocus} setupCmd={setupCmd} inTmux={!!process.env.TMUX} />
      )}
    </Box>
  );
}

// Top-left rail: one row per PR — review-state glyph, a `⧉` when the branch is
// already checked out in a local worktree, #number, and the title.
function PrList({ prs, loading, error, selected, focused, query, searching, view, wtBranches, sessionByBranch, width, height }) {
  const listRoom = Math.max(1, height - 2 - 1); // minus border rows and the header
  const start = Math.max(0, Math.min(selected - Math.floor(listRoom / 2), Math.max(0, prs.length - listRoom)));
  const window = prs.slice(start, start + listRoom);
  const room = width - 4; // borders + padding
  const border = searching ? "yellow" : focused ? "cyan" : "gray";

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor={border} paddingX={1}>
      <Text bold color="cyan" wrap="truncate">
        Pull requests {loading ? "" : `(${prs.length})`}
        {query ? <Text dimColor> · /{query}</Text> : null}
      </Text>
      {loading && <Text dimColor>loading… (q to quit)</Text>}
      {!loading && error && <Text color="red" wrap="truncate">{error}</Text>}
      {!loading && !error && prs.length === 0 && (
        <Text dimColor>
          {query ? "no PRs match" : view === "all" ? "no open PRs in this repo" : "nothing assigned to or awaiting you"}
        </Text>
      )}
      {window.map((pr, i) => {
        const idx = start + i;
        const active = idx === selected;
        const g = reviewGlyph(pr.reviewDecision);
        const hasWt = wtBranches.has(pr.headRefName);
        const sess = sessionByBranch.get(pr.headRefName);
        // Busy = provisioning the env or tearing it down; both show a spinner.
        const busy = sess && (sess.status === "provisioning" || sess.status === "tearing-down");
        // When the env is provisioned, tag the row with its instance number.
        const envTag = sess && sess.status === "ready" && sess.envInstance != null ? ` EV${sess.envInstance}` : "";
        const num = `#${pr.number}`;
        const author = pr.author?.login ? `@${pr.author.login}` : "";
        // Consumed before the title: indicator(2) + "#num "(num.length+1) + envTag,
        // then the trailing " @author" if present.
        const authorRoom = author ? author.length + 1 : 0;
        const title = truncate(pr.title, Math.max(4, room - num.length - 5 - envTag.length - authorRoom));
        return (
          <Text key={pr.number} inverse={active} wrap="truncate">
            <Text color={g.color}>{g.char} </Text>
            {busy ? (
              <Text color="yellow"><Spinner color="yellow" /> </Text>
            ) : (
              <Text color="blueBright">{hasWt || sess ? "⧉ " : "  "}</Text>
            )}
            <Text dimColor>{num}</Text>
            {envTag ? <Text color="cyan">{envTag}</Text> : null}
            <Text> </Text>
            <Text color={active ? "white" : undefined}>{title}</Text>
            {author ? <Text dimColor> {author}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

// Top-right pane: the repo's git worktrees, tagged with the matching PR number
// when a worktree's branch is one of the PRs above.
function WorktreePane({ worktrees, prByBranch, sessionByPath, selected, focused, width, height }) {
  const listRoom = Math.max(1, height - 2 - 1); // minus border rows and the header
  const overflow = worktrees.length > listRoom;
  const room2 = overflow ? Math.max(1, listRoom - 1) : listRoom; // reserve a row for "… N more"
  // Scroll so the selected worktree stays visible, mirroring the PR list.
  const start = Math.max(0, Math.min(selected - Math.floor(room2 / 2), Math.max(0, worktrees.length - room2)));
  const window = worktrees.slice(start, start + room2);
  const hidden = worktrees.length - window.length;
  const room = width - 4;
  const border = focused ? "blueBright" : "gray";

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor={border} paddingX={1}>
      <Text bold color="blueBright" wrap="truncate">Worktrees ({worktrees.length})</Text>
      {worktrees.length === 0 && <Text dimColor>none</Text>}
      {window.map((w, i) => {
        const idx = start + i;
        const active = focused && idx === selected;
        const label = w.bare
          ? "(bare)"
          : w.branch || (w.head ? `detached ${w.head.slice(0, 7)}` : "(detached)");
        const prNum = w.branch ? prByBranch.get(w.branch) : undefined;
        const sess = sessionByPath.get(w.path);
        const busy = sess && (sess.status === "provisioning" || sess.status === "tearing-down");
        // A short suffix: the PR number and, once known, the env instance.
        const env = sess && sess.status === "ready" && sess.envInstance != null ? ` EV${sess.envInstance}` : "";
        const failed = sess && sess.status === "failed";
        const tag = `${prNum ? ` #${prNum}` : ""}${env}`;
        return (
          <Text key={w.path + idx} inverse={active} wrap="truncate">
            {busy ? (
              <Text color="yellow"><Spinner color="yellow" />  </Text>
            ) : (
              <Text color={failed ? "red" : "blueBright"}>{failed ? "✗  " : "⧉  "}</Text>
            )}
            <Text color={prNum ? "cyan" : undefined}>{truncate(label, Math.max(4, room - 3 - tag.length))}</Text>
            {prNum ? <Text dimColor>{` #${prNum}`}</Text> : null}
            {env ? <Text color="cyan">{env}</Text> : null}
          </Text>
        );
      })}
      {hidden > 0 && <Text dimColor>… {hidden} more</Text>}
    </Box>
  );
}

// Wrapped-row count for one markdown source line at a given inner width.
const descRowsFor = (segs, contentW) =>
  Math.max(1, Math.ceil(segs.reduce((n, s) => n + (s.text ? s.text.length : 0), 0) / contentW));

// The description's raw ingredients: its wrapped lines, the inner width, and how
// many wrapped rows are available for it. Shared by the pane (to render) and the
// key handler (to measure how far it can scroll).
export function descMetrics(ov, width, height) {
  const loaded = ov && !ov.error;
  const labels = loaded && Array.isArray(ov.labels) ? ov.labels.map((l) => l.name) : [];
  const bodyLines = loaded && ov.body ? markdownLines(ov.body) : [];
  // Rows the summary block above the description consumes: title + author/branch,
  // a spacer, the status lines, plus the "— description —" header + its spacer.
  const summaryRows = loaded ? 1 + 2 + (labels.length > 0 ? 1 : 0) : 1 + 1;
  const bodyRoom = Math.max(0, height - 2 - 2 - summaryRows - 2);
  const contentW = Math.max(1, width - 4); // border (2) + paddingX 1 each side (2)
  return { bodyLines, contentW, bodyRoom, labels, loaded };
}

// Lay out the (possibly scrolled) description within `bodyRoom` wrapped rows.
// Returns the clamped start line, the source lines to show, how many are hidden
// above/below, and the max scroll offset (so the caller can clamp the same way).
export function layoutDescription(bodyLines, contentW, bodyRoom, scroll) {
  const n = bodyLines.length;
  if (n === 0 || bodyRoom < 1) return { start: 0, shown: [], above: 0, below: 0, maxScroll: 0 };
  const rowsAt = (i) => descRowsFor(bodyLines[i], contentW);

  const total = bodyLines.reduce((sum, _, i) => sum + rowsAt(i), 0);
  let maxScroll = 0;
  if (total > bodyRoom) {
    // Once scrolled, a top "↑ more" hint costs a row, so the deepest useful
    // start is the smallest one whose tail [start..n) fits in bodyRoom - 1.
    let acc = 0;
    let maxStart = n;
    for (let i = n - 1; i >= 0; i--) {
      acc += rowsAt(i);
      if (acc > bodyRoom - 1) break;
      maxStart = i;
    }
    maxScroll = Math.max(0, maxStart);
  }
  const start = Math.max(0, Math.min(scroll, maxScroll));
  const above = start;

  // Greedily fill from `start`, reserving a row for each hint that will show.
  const fill = (budget) => {
    const shown = [];
    let used = 0;
    for (let i = start; i < n; i++) {
      const r = rowsAt(i);
      if (used + r > budget) break;
      used += r;
      shown.push(bodyLines[i]);
    }
    return shown;
  };
  const topR = above > 0 ? 1 : 0;
  let shown = fill(bodyRoom - topR);
  let below = n - start - shown.length;
  if (below > 0) {
    shown = fill(bodyRoom - topR - 1); // reserve a row for the "↓ more" hint too
    below = n - start - shown.length;
  }
  return { start, shown, above, below, maxScroll };
}

// Lower-left pane: the highlighted PR's overview summary + description. The
// description scrolls with Ctrl-d / Ctrl-u (offset passed in as `scroll`).
function OverviewPane({ pr, overview, scroll = 0, width, height }) {
  if (!pr) {
    return <Box width={width} height={height} borderStyle="round" borderColor="gray" paddingX={1} />;
  }

  const ov = overview; // undefined = not requested, null = loading, obj = ready
  const { bodyLines, contentW, bodyRoom, labels, loaded } = descMetrics(ov, width, height);
  const showBody = bodyLines.length > 0 && bodyRoom >= 1;
  const { shown: bodyShown, above, below } = layoutDescription(bodyLines, contentW, bodyRoom, scroll);

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
          <Text dimColor wrap="truncate">
            — description —{(above > 0 || below > 0) ? <Text dimColor>  (^u/^d scroll)</Text> : null}
          </Text>
          {above > 0 && <Text dimColor>↑ {above} more line{above === 1 ? "" : "s"}</Text>}
          {bodyShown.map((segs, i) => (
            <Text key={i} wrap="wrap">
              {segs.map((s, j) => (
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

// One entry in the header's Mine/All tab bar (switched with ←/→). The active
// tab carries its own PR count so the parens read as belonging to it, not
// floating ambiguously after both labels.
function Tab({ label, active, count }) {
  return active ? (
    <Text bold color="cyan">{label}{count ? ` (${count})` : ""}</Text>
  ) : (
    <Text dimColor>{label}</Text>
  );
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

function NewWorktreeBar({ name }) {
  return (
    <Box height={1}>
      <Text wrap="truncate">
        {" "}
        <Text color="green">new worktree</Text>
        <Text dimColor>  branch </Text>
        {name}
        <Text inverse> </Text>
        <Text dimColor>  enter create · esc cancel</Text>
      </Text>
    </Box>
  );
}

function StatusBar({ focus, setupCmd, inTmux }) {
  // Action hints depend on which pane is focused: start/open on the PR list,
  // focus/finish on the worktrees pane. (Transient status shows in the header's
  // top-right, so the shortcuts stay visible here.)
  const actions =
    focus === "worktrees" ? (
      <>
        <Text bold>enter</Text> tmux  <Text bold>o</Text> open  <Text bold>d</Text> finish
      </>
    ) : (
      <>
        <Text bold>enter</Text> {inTmux ? "start" : <Text dimColor>start (needs tmux)</Text>}  <Text bold>o</Text> open  <Text bold>d</Text> finish
      </>
    );
  return (
    <Box height={1}>
      <Text wrap="truncate">
        {" "}
        <Text dimColor>↑↓/jk</Text> move  <Text dimColor>←→</Text> tab  <Text bold>tab</Text> pane  {actions}  <Text bold>n</Text> new  <Text bold>/</Text> search  <Text bold>r</Text> refresh  <Text bold>q</Text> quit
        {focus !== "worktrees" && setupCmd ? <Text dimColor>   ⚙ {setupCmd}</Text> : null}
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
