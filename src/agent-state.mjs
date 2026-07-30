// Is the coding agent in this worktree still working, or is it sitting there
// waiting for you?
//
// Each review window orbit-diff builds has a pane tagged `@orbit_role claude`
// running whatever `pr.claude` launches (Claude Code by default, Codex or
// anything else if you've configured it). Neither writes its turn state
// anywhere another process can read, so we read the only thing they *do*
// publish: the screen. `tmux capture-pane` gives us the pane's visible content
// without focusing it, and the REPL renders an unambiguous status line right
// above its composer box.
//
// This is a heuristic on someone else's UI, so it's built to fail soft: an
// unrecognized screen reports "awaiting" (the agent is alive but we can't see a
// spinner), never an error, and the worst case is a stale glyph in a list.
//
// States:
//   "busy"     — mid-turn, actively working
//   "blocked"  — stopped on a permission/choice prompt, needs an answer NOW
//   "awaiting" — turn finished, composer idle, waiting on you
//   (absent)   — no agent in that worktree, or the pane fell back to a shell

import { listTaggedPanes, capturePane } from "./tmux.mjs";

// How many non-blank lines up from the bottom to consider. The status line sits
// directly above the composer box, which itself is the last 2-4 rendered rows,
// so ten is comfortably enough while staying clear of scrollback that could
// coincidentally look like a prompt.
const TAIL_LINES = 10;

// A pane whose foreground process is one of these has no agent running — the
// REPL exited (or never started) and left a shell behind.
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "ksh", "dash", "tcsh", "csh", "nu", "elvish"]);

// A working agent renders an elapsed-time status line above the composer:
//
//   · Tempering… (1m 26s · ↓ 4.8k tokens · thought for 5s)     Claude Code
//   ✻ Working (12s • Esc to interrupt)                         Codex
//
// The leading glyph animates and the verb is randomized, so we match the shape
// instead: an ellipsis or word followed by a parenthetical that OPENS with an
// elapsed time or token counter. Requiring that lead character is what keeps
// finished tool output like "… +4 lines (ctrl+o to expand)" from reading as
// busy. Builds that spell the hint out get caught by the second pattern.
const BUSY_PATTERNS = [/…\s*\(\s*[\d↓↑]/, /\besc to interrupt\b/i];

// A permission/choice prompt: the agent has stopped mid-turn and is blocking on
// a numbered list ("1. Yes" / "2. No, and tell Claude what to do differently").
// Both options must be on screen — a single "1." is more likely to be a
// numbered list in the agent's own output.
const OPTION_ONE = /^\s*[❯>»*]?\s*1[.)]\s+\S/;
const OPTION_TWO = /^\s*[❯>»*]?\s*2[.)]\s+\S/;

// Classify one pane's visible text. Exported for testing; `pollAgentStates`
// below is what the app actually calls.
export function classifyAgentPane(text) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  if (!lines.length) return null; // nothing drawn yet — the REPL is still booting
  const tail = lines.slice(-TAIL_LINES);

  if (tail.some((l) => BUSY_PATTERNS.some((re) => re.test(l)))) return "busy";
  if (tail.some((l) => OPTION_ONE.test(l)) && tail.some((l) => OPTION_TWO.test(l))) return "blocked";
  return "awaiting";
}

// Re-read a pane at most every this many polls even when tmux reports no new
// output for its window. Purely a self-heal: the activity timestamp is a sound
// filter (a REPL that changes state necessarily draws something), but a missed
// tick would otherwise pin a glyph forever.
const FORCE_EVERY = 6;

// Build the poller the PR manager hands to the TUI. Returns a function mapping
// worktree path → state for every review pane tmux currently knows about.
//
// Cost per call is one `list-panes` plus one `capture-pane` for each agent pane
// that has printed something since the last look — so a screen full of settled
// worktrees costs a single tmux invocation, and a busy one costs a handful.
//
// Panes are injectable so the tests don't need a tmux server.
export function createAgentPoller({ list = listTaggedPanes, capture = capturePane } = {}) {
  // pane id → { activity, state, age } — survives across polls so an unchanged
  // pane can be answered from cache.
  const cache = new Map();

  return function pollAgentStates() {
    const byPath = {};
    const live = new Set();

    for (const p of list()) {
      if (p.role !== "claude") continue;
      live.add(p.pane);
      // The REPL exited and left a shell (or tmux couldn't read the command).
      if (!p.command || SHELLS.has(p.command)) {
        cache.delete(p.pane);
        continue;
      }

      const prev = cache.get(p.pane);
      const settled = prev && prev.activity === p.activity && prev.age < FORCE_EVERY;
      if (settled) {
        cache.set(p.pane, { ...prev, age: prev.age + 1 });
        if (prev.state) byPath[p.worktreePath] = prev.state;
        continue;
      }

      const text = capture(p.pane);
      if (text === null) {
        cache.delete(p.pane); // pane vanished between the two calls
        continue;
      }
      const state = classifyAgentPane(text);
      cache.set(p.pane, { activity: p.activity, state, age: 0 });
      if (state) byPath[p.worktreePath] = state;
    }

    for (const pane of cache.keys()) if (!live.has(pane)) cache.delete(pane);
    return byPath;
  };
}
