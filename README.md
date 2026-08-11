# orbit-diff

A GitHub-style git diff viewer for the terminal, built with [Ink](https://github.com/vadimdemedes/ink) (React for CLIs). A prototype exploring how well a "web GUI mental model" — components, flexbox layout — holds up rendered to terminal cells.

## Run

```bash
cd orbit-diff
bun install

bun index.jsx                 # uncommitted work vs HEAD
bun index.jsx --staged        # staged changes only
bun index.jsx main..feature   # a branch range, PR-style
bun index.jsx HEAD~3 HEAD     # any args pass straight through to `git diff`
```

## Install (get `orbit-diff` on your PATH)

Fastest — the installer picks the right binary for your platform from the latest
[Release](../../releases) and drops it in `~/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/Diagonal-HQ/orbit-diff/main/install.sh | sh
```

Set `ORBIT_DIFF_BIN_DIR` to install elsewhere. Once installed, upgrade in place
anytime:

```bash
orbit-diff update           # self-replaces with the latest release
orbit-diff --version        # show the installed version
orbit-diff init             # write a starter config (--force to overwrite)
orbit-diff prs              # manage the PRs assigned to / awaiting you
orbit-diff reset <branch>   # remove a broken local branch/worktree and its state
```

Binaries are published for macOS arm64, Linux x64, and Linux arm64 (built on
every push to `main`, tagged `v0.0.<run>`). You can also grab one straight from
the [Releases](../../releases) page, `chmod +x`, and drop it on your PATH.

### Build locally instead

Two options.

**1. Standalone binary (no Bun needed to run it).** `bun build --compile` bundles
the app *and* the Bun runtime into a single ~62 MB executable — copy it anywhere on
your PATH and it runs on machines without Bun installed.

```bash
bun install
bun run install:local     # builds dist/orbit-diff and copies it to ~/.local/bin/orbit-diff
```

`install:local` targets `~/.local/bin` (already on most PATHs). To place it
elsewhere, build and copy yourself:

```bash
bun run build             # -> dist/orbit-diff
cp dist/orbit-diff /usr/local/bin/   # or any dir on your PATH
```

**2. `bun link` (dev symlink; needs Bun + this repo to stay put).** Uses the
`bin` entry in `package.json` to symlink `orbit-diff` into Bun's global bin. Fast,
always tracks your working copy, but breaks if you move/delete the repo.

```bash
bun install
bun link                  # registers orbit-diff -> index.jsx
# ensure Bun's global bin is on PATH: export PATH="$HOME/.bun/bin:$PATH"
```

Either way:

```bash
orbit-diff                  # uncommitted work vs HEAD
orbit-diff main..feature    # a branch range, PR-style
```

## Layout

- **Left rail** — files changed, with `A`/`M`/`D`/`R` status and `+/-` counts (GitHub's "Files changed" list).
- **Right panel** — the unified diff of the selected file, syntax-highlighted, with old/new line-number gutters. A current-line cursor (`▸` + brightened gutter, and an `L n/N` readout in the status bar) tracks where you are as you scroll; the viewport follows it.

## Keys

| Key | Action |
| --- | --- |
| `Tab` | switch focus between the file rail and the diff |
| `s` | show / hide the file rail (diff goes full-width when hidden) |
| `[` / `]` | narrow / widen the file rail (responsive default until adjusted) |
| `↑↓` / `j` `k` | move file (rail) · move the line cursor (diff) |
| `PgUp/PgDn` / `Ctrl-u` `Ctrl-d` | move the cursor a page — **works from either pane** |
| `t` / `b` | jump the cursor to top / bottom — **works from either pane** |
| `/` | filter files (fuzzy subsequence on path) |
| `f` | find in diff contents — matches every line, context included |
| `Tab` (while finding) | toggle search scope: **whole diff** ⇄ **focused file** |
| `n` / `N` | next / previous match (jumps across files in whole-diff scope) |
| `v` | start / cancel a multi-line selection (anchor at the cursor, extend with the cursor) |
| `c` | comment on the selection (or the cursor line); on an already-annotated line, edit it |
| `x` | delete the annotation on the cursor line (or the highlighted one in the rail's annotations list) |
| `a` | jump the rail cursor to the annotations list (then `↑↓`/`j` `k` navigate, `Enter` jumps to it in the diff) |
| `o` | open this worktree's **provisioned environment** in the browser (the URL `orbit-diff env-report --url` recorded) |
| `p` | open this branch's GitHub PR in the browser (in the AI Review section, `p` still promotes the highlighted finding) |
| `y` | copy all annotations to the clipboard as a change-request prompt for Claude Code |
| `r` | open the **submit** picker: apply via Claude Code (or *send to the Claude pane* in a managed review window), post to the GitHub PR (when one exists), or copy |
| `g` | **finish the review** — approve, approve + merge when ready, or request changes (see below; only when this branch has an open PR) |
| `G` | **PR overview** — description, conversation, checks and reviewers, full-screen (see below) |
| `R` | reload the diff — pick up edits Claude made in its pane |
| `A` | **AI review** of the diff — findings stream into a side panel (`↑↓`/`j` `k` move · `Enter` jump to it · `p` promote to an annotation · `Esc` close) |
| `?` | **ask** the model a question about the diff / codebase — the answer streams into a panel (`Ctrl-u`/`Ctrl-d` scroll the transcript · `Tab` past conversations · `Esc` close) |
| `Enter` | rail → focus diff · find → jump to first match |
| `Esc` | while typing: cancel · selecting: cancel the selection · normal: clear an applied filter/search |
| `q` / `Ctrl-c` | quit |

Only the matched **substring** is highlighted (the rest of the line keeps its
add/del color): cyan on the focused match (the one `n`/`N` points at), yellow on
the others.

Syntax highlighting is by file extension via `cli-highlight` (highlight.js),
emitted as ANSI that Ink renders directly. It's per-line, so multi-line
constructs (block comments, template strings) may not carry state across lines.

## Manage PRs (`orbit-diff prs`)

A second mode that turns orbit-diff into a lightweight PR manager for the
**current repo**. The **Mine** tab lists open PRs assigned to you, awaiting your
review, or authored by you; the **All** tab lists every open PR, including
drafts. It can spin up a whole review environment for the one you pick.

```bash
orbit-diff prs              # (alias: orbit-diff pr)
```

- **Top-left** — the PRs waiting on you, each with a review-state glyph
  (`✓` approved · `✗` changes requested · `●` review required · `○` no reviews).
  A `⧉` marks a PR that already has a worktree; a spinner marks one whose review
  environment is still provisioning; `EV<n>` shows its instance once it reports.
- **Top-right** — the repo's git worktrees, each tagged with its matching PR
  number and env instance (spinner while provisioning, `✗` if setup failed), plus
  a second glyph for what the coding agent in that worktree is doing:
  a green `●` when it has **finished its turn and is waiting on you**, `!` when
  it's blocked on a permission prompt, and a dim `·` while it's still working.
  The header counts them (`Worktrees (6) · 2 waiting`) so you can see at a glance
  whether anything needs you without visiting each window.
- **Bottom-left** — an overview of the highlighted PR: review decision,
  mergeability, diff size, labels, and the description.
- **Bottom-right** — who's on the hook: requested reviewers, assignees, and the
  per-check status (latest run per check, failing/pending first).

The list loads asynchronously, so the shell paints immediately and the PRs
stream in when `gh` answers.

| Key | Action |
| --- | --- |
| `↑↓` / `j` `k` | move · `g` / `G` jump to top / bottom |
| `Enter` | **start** a review for this PR (or focus its window if already open) |
| `o` | open the PR (or the worktree's PR) in the browser |
| `d` | **finish** — tear the review down, if this PR has one (see below) |
| `n` | **new local worktree** — prompt for a branch name and open it the same way as a PR, with no PR behind it |
| `b` | **check out a branch** — prompt for an existing branch (origin's or local) and open just a worktree + plain window, no setup script |
| `Tab` | switch focus between the PR list and the worktrees pane |
| `Enter` (worktrees) | jump to that worktree's window |
| `/` | filter the list (fuzzy match on number / title / branch) |
| `r` | refresh the list + worktrees |
| `q` / `Esc` / `Ctrl-c` | quit (`Esc` clears an active filter first) |

Press `n` to work on something that isn't (yet) a PR — type a branch name and
`Enter` creates a new branch off wherever the repo is currently checked out, in
its own worktree, and opens the exact same four-pane review window a PR gets
(status · setup · claude · orbit-diff). It shows up in the worktrees pane like
any other, so `Enter` refocuses it and `d` tears it down when you're done —
it's just not tagged with a PR number since there isn't one.

Press `b` when you only want the code. Type an existing branch name (a leading
`origin/` is fine) and `Enter` fetches it, checks it out in a worktree, and
drops you in a plain window there — that's all. No `pr.setup`, no review
panes, no session record, so nothing is provisioned and there's nothing to
report back. It still lands in the worktrees pane, where `Enter` refocuses its
window and `d` cleans it up like any other worktree.

#### Which agents are waiting on you

How this works depends on which multiplexer you're in.

**Under herdr**, it just asks. herdr detects agent state itself and publishes it
as a field on the pane, so orbit-diff reads `working` / `blocked` / `idle` /
`done` straight off the pane list — no guessing.

**Under tmux**, there's nothing to ask. Neither Claude Code nor Codex publishes
its turn state anywhere another process can read it, so orbit-diff reads the one
thing they do publish: the screen. Every couple of seconds it looks at each
review window's `claude` pane with `tmux capture-pane` — no focusing, nothing
stolen — and tells a live spinner ("`· Tempering… (1m 26s · ↓ 4.8k tokens)`")
from a settled composer. Panes are only re-read when tmux says the window has
printed something since the last look, so a rail of idle worktrees costs one
`tmux list-panes` per tick.

That screen-reading is a hint rather than a guarantee: an unfamiliar screen
reports "waiting" rather than erroring, and a worktree whose agent has exited
(leaving a bare shell) simply loses its glyph. It's also the fallback under
herdr, for panes herdr itself reports as `unknown`. Worktrees opened with `b`
have no agent pane, so they never carry one.

### The review flow

Starting a PR (`Enter`) makes orbit-diff **own the whole review environment** —
you stay in the PR list (the new window opens in the background) and a spinner on
the PR line tracks progress. Under the hood it:

1. **creates a git worktree** for the PR branch (fetching it if it's remote-only),
2. **opens a detached window** — a tmux window or a herdr tab — split into four panes —

   ```
   ┌─ status ─┬──────── claude ───────┐
   ├──────────┤                       │
   │  setup   │                       │
   ├───────────────── orbit-diff ─────┤
   └───────────────────────────────────┘
   ```

   top-left shows a live **status** panel (branch, PR state/assignee/
   reviewers/checks, provisioned env), stacked above `setup` (which runs
   inside the worktree), top-right runs `claude` (a live session, ready to
   talk to), and the bottom, full-width pane runs `orbit-diff` on the PR's diff;
3. **tracks it all** — the PR ↔ worktree ↔ panes ↔ env instance — in a
   session registry under `~/.cache/orbit-diff/sessions/` (nothing is written
   into the repo).

Because the diff viewer and Claude run side by side, sending annotations to
Claude (the **submit** picker's *"Send to Claude pane"*) routes them into that
open session (`tmux send-keys` / `herdr pane send-text`) instead of taking over
the diff — then press
`R` in the viewer to reload once Claude has edited. Outside a managed window the
old behaviour stands (orbit-diff steps aside for a fresh `claude`).

**Report your env instance back.** Your `setup` command should end by telling
orbit-diff what it provisioned, which stops the spinner and tags the PR with the
instance:

```bash
orbit-diff env-report <instance> [--url <url>] [--status ready|failed]
```

Run from inside the worktree, it's matched to that worktree's session by path.

**Finishing** (`d` on a worktree) closes the review window, runs your `done`
command, then removes the git worktree and drops the session. orbit-diff
**always** owns worktree removal — `done` only needs to do *your* teardown
(destroy the provisioned instance, etc.), and it runs first (in the background,
logged) so anything it does inside the worktree still sees it. Leave `done`
empty if there's nothing external to tear down.

If a worktree or its bookkeeping is broken, run this from any valid checkout of
the same repository:

```bash
orbit-diff reset <branch>
```

Reset is intentionally destructive to local state. It closes the branch's
orbit-diff window, force-removes registered or stale worktree directories,
prunes Git worktree metadata, deletes the local branch, and clears both
path-hashed session records and branch-scoped viewer/AI state. The remote branch
is never changed, so selecting the PR again creates a clean tracking branch and
worktree from `origin`.

Configure it in `~/.config/orbit-diff/config.js`. The tokens `{branch}` `{base}`
`{number}` `{repo}` `{title}` `{url}` are substituted (shell-quoted), and
commands run in your login shell so aliases/functions resolve:

```js
export default {
  // …model/provider settings…
  pr: {
    setup: "make dev-env {branch} && orbit-diff env-report $EV_INSTANCE",
    claude: "claude",           // top-right pane (tmux) or its own tab (herdr)
    codex: "codex",             // a second agent in its own tab; herdr only
    done: "tear-down {branch}", // your env teardown; the worktree is removed for you
    worktreeDir: "",            // "" ⇒ sibling "<repo>-worktrees/<branch>"
    worktreeRefreshMinutes: 2,  // auto-refresh the worktrees pane (0 disables)
  },
};
```

Starting a review needs to be **inside a multiplexer** — either
[tmux](https://github.com/tmux/tmux) or [herdr](https://herdr.dev). Requires the
[`gh`](https://cli.github.com) CLI, authenticated (`gh auth login`) with a GitHub
remote. (`pr.start` is still honoured as a legacy alias for `pr.setup`.)

#### tmux or herdr

orbit-diff drives whichever multiplexer it's already running inside, detected
from the environment — `HERDR_PANE_ID` for herdr, `TMUX` for tmux. There's
nothing to configure, and if you're in a tmux session nested inside a herdr pane
it drives herdr, which is the one that owns the window it would build. Set
`ORBIT_MUX=tmux|herdr` to force a backend.

**The review environment is shaped differently.** Under tmux a review is one
window of four panes. Under herdr it's a **workspace of three tabs**:

```
tab 1 "review"   orbit-diff, the whole tab
tab 2 "agents"   claude │ codex, side by side   (set `pr.codex`)
tab 3 "setup"    your provisioning script
```

The agents share a tab because they're a pair you compare — both on screen beats
tabbing between them. Everything else gets a whole tab: a diff wants the width,
build output scrolls. That's the only split, and slicing tab 1 into thirds as
well only made all three of its occupants worse.

There's no `orbit-diff pr-status` panel under herdr: the viewer's `G` overview
covers the same ground with room to render it, and the provisioned environment
now appears at the top of that view's sidebar. The tmux window still builds one,
because tmux has no tabs and its single window is the only place that
information can live.

A workspace also means closing a review (`d`) takes any extra tabs you opened
for that worktree with it, rather than orphaning them.

`pr.codex` is herdr-only — the tmux layout has no room for a second agent.

Other differences worth knowing:

- **Agent state** is reported by herdr rather than scraped off the screen (see
  above) — more reliable, and it doesn't cost a pane read per tick.
- **An agent that exits**, leaving a bare shell in its pane, loses its glyph
  under tmux (which can see the pane's foreground process) but reads as
  "waiting on you" under herdr, which exposes no equivalent.
- **The overview pane** is sized as a fraction of its column under herdr, where
  tmux pins it to exactly 8 rows. herdr's split API takes ratios only, so on a
  short terminal it can clip where the tmux one wouldn't.
- **The pane you land on** when you jump to a review is the diff viewer under
  tmux and the overview pane under herdr. herdr can only focus panes
  directionally, and the flags that would set it outright risk yanking you out
  of the PR list — not worth it to save one keystroke.
- **Clipboard** needs no `set-clipboard` setting under herdr: it's the terminal
  emulator itself, so OSC 52 goes straight through (see below).

`orbit-diff reset` is the one command that doesn't care which multiplexer you're
in — it closes a worktree's window in either, from a plain shell, since it's
routinely run from outside both.

The herdr backend is written against herdr's documented CLI and one real
`pane list` payload, but hasn't been exercised end to end against a running
herdr server. Where the docs are silent it discovers rather than guesses — it
finds reported metadata wherever herdr puts it, matches worktrees on a hash as
well as a path, and checks `focused` after building a review tab so it can put
the view back if creation ever turns out to steal it. If something in the
review-window flow still misbehaves there, that's the place to look, and
`ORBIT_MUX=tmux` gets you back to the well-worn path.

## AI review & Q&A

orbit-diff can act as a reviewer assistant. Press `A` to have a model review the
diff — it looks at each changed file and reports concrete findings (bugs,
correctness, security, error handling, …), which stream into a side panel as they
land. Navigate with `↑↓`/`j` `k`, `Enter` to jump the diff cursor to a finding, and
`p` to **promote** a finding into a regular annotation — from there it flows through
the normal submit pipelines (`r`): post to the GitHub PR, apply via Claude Code, or
copy. You decide which findings become change requests.

Press `?` to **ask a question** about the diff or the surrounding codebase. The
model has read-only tools (read/grep/find/ls) so it can explore the repo to answer;
it can never edit files or run commands.

Every conversation is saved automatically, so `Tab` inside the chat panel opens a
list of past conversations for this branch — `↑↓` to pick one, `Enter` to reopen
it, `Tab` again to go back to the live chat. Reopening one loads its transcript
and, if you ask a follow-up, seeds a fresh model session with that history so it
has the context of the earlier turns.

Results are **cached** outside the repo, under
`~/.cache/orbit-diff/<repo>/<branch>/ai-cache/` (honours `$XDG_CACHE_HOME`), so
nothing is written into the tree you're reviewing. Reviews are cached per file
keyed by the file's diff content, so re-running a review only calls the model for
files that actually changed — even across separate sessions. Answers to identical
questions on an unchanged diff are served from cache too.

### Configure the model & provider

The backend is the [Pi SDK](https://pi.dev), so you choose the provider and model.
Config lives at `~/.config/orbit-diff/config.js` (honours `$XDG_CONFIG_HOME`) — a
user-global file, so it works with the installed binary and no repo directory.

The first time you run orbit-diff it writes a starter config there automatically
(and `orbit-diff init` does the same on demand), so you can jump straight to
editing it. You don't have to — a missing config just uses the built-in defaults
below:

```bash
orbit-diff init             # or just run orbit-diff once
$EDITOR ~/.config/orbit-diff/config.js
```

```js
// ~/.config/orbit-diff/config.js
export default {
  provider: "anthropic",     // any Pi-supported provider (openai, google, groq, …)
  model: "claude-opus-4-8",  // a model id Pi knows for that provider
  thinkingLevel: "medium",   // off | minimal | low | medium | high | xhigh
  review: { concurrency: 4 },
};
```

It's a real ES module, so you can compute values — e.g. read an env var for a
one-off override: `model: process.env.ORBIT_DIFF_MODEL ?? "claude-opus-4-8"`. If you
have the repo, `orbit-diff.config.example.js` is a ready-to-copy template.

**Credentials** are never stored in orbit-diff. Pi resolves them from its own env
vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or from `~/.pi/agent/auth.json` — set
your provider's key env var, or run `pi` once and `/login`. If nothing is
configured, `A`/`?` explain what's missing instead of failing silently.

## Annotate → change requests for Claude Code

Review a diff, leave comments on the lines you want changed, then press `r` to
**submit** them — hand the whole set to [Claude Code](https://claude.com/claude-code)
as a change-request prompt and watch the diff reload with Claude's edits, post
them as inline comments on the branch's GitHub PR, or copy them out.

- **Comment** — put the cursor on a line and press `c`, or select a block first
  (`v`, move the cursor to extend, then `c`). Type your request and `Enter`.
  Annotated lines carry a green `●` in the gutter. Press `c` again on an
  annotated line to edit it (saving it empty deletes it), or `x` to delete.
- **Review** — annotations are always listed beneath the file rail on the left.
  Navigate down out of the file list (or press `a`) to move the rail cursor into
  the annotations; `↑↓`/`j` `k` move between them, `Enter` jumps to one in the
  diff, and `x` deletes the highlighted one.
- **Submit** — press `r` for a small picker with up to three targets (`↑↓` to
  move, `Enter` to choose, `Esc` to cancel):

  - **Apply via Claude Code** — orbit-diff steps aside and hands the terminal to
    a **real, interactive Claude Code session** seeded with your change-request
    prompt — you see its full window, watch it work, answer any questions, and
    approve tools exactly as you normally would. When you exit Claude (`/exit` or
    Ctrl-D), orbit-diff **re-reads the working tree** and relaunches on the
    updated diff — review → request → re-review in one flow. The annotations
    don't survive the round-trip (their line anchors no longer point at the same
    code once files change), so you land on a fresh diff to comment on again.
    Requires the `claude` CLI on your `PATH`.
  - **Post to GitHub PR** — shown only when the branch has an open PR (detected
    via `gh`). Each annotation becomes an inline review comment anchored to its
    file and line(s) on the PR head. Comments post independently, so an
    annotation on a line that isn't part of the pushed PR diff (e.g. an
    uncommitted local edit) is skipped and reported rather than sinking the rest.
    Requires the `gh` CLI, authenticated, on your `PATH`.
  - **Copy to clipboard** — every comment is assembled into a markdown prompt
    (each request anchored to its real file line numbers, with the code snippet
    inline) and copied to your clipboard, plus a copy saved outside the repo under
    `~/.cache/orbit-diff/<repo>/<branch>/change-request.md` (the exact path is shown
    in the status bar). Paste it into Claude Code, or pipe the saved file:

    ```bash
    claude    # then paste, or:  claude -p "$(cat <path-shown-in-status-bar>)"
    ```

  `y` remains a direct shortcut for that last copy step, skipping the picker.

Annotations are **in-memory for the session** — they're gone when you quit, so
copy (or run) before you leave.

### The PR overview (`G`)

`G` swaps the file rail and diff for the answer to one question: **is this PR
waiting on something, and is that something me?**

```
┌ #42 Add caching to the resolver chain ──────────────┬ Env (o) ──────┐
│ by author-person   de-1234-resolver-cache → main    │ • #7          │
│ +214 -37  6 files                                   │ • https://ev7…│
│                                                     │ Reviewers     │
│ ◆ Waiting on you                                    │ • you         │
│   ✗ 1 check failing            test                 │ • someone-else│
│   ● 1 check still running      lint                 │ Assignees     │
│   ◆ Your review is requested ←                      │ • you         │
│   ◷ Also waiting on            someone-else         │ Checks (1✓1✗) │
│   ◷ 2 unresolved threads       resolver.js, cache.js│ ✗ test        │
│                                                     │ ● lint        │
│ ── Recent activity (2) ───────────────────────────  │ ✓ build       │
│ amy commented  2d  Nice — does this handle nesting? │               │
│ cy on resolver.js:2  2d  Should this be `TWO_VALUE`?│               │
└─────────────────────────────────────────────────────┴───────────────┘
```

GitHub scatters that answer across fields that each ignore the others —
`mergeStateStatus` is `BLOCKED` on nearly every open PR and never says why,
`reviewDecision` ignores CI, the check rollup ignores reviews, and unresolved
review threads live in a different API entirely. The top block gathers the lot
into one verdict and a list of **specific, named** reasons:

| Verdict | Meaning |
| --- | --- |
| `◆ Waiting on you` | your review is requested, or it's your PR and something needs fixing |
| `✗ Blocked` | conflicts, or failing checks |
| `◷ Waiting on others` | someone else's review, checks still running, unresolved threads |
| `✓ Ready to merge` | nothing left in the way |

Reasons carrying a `←` are the ones that need *you*. Anything that would be
noise is left out: `BLOCKED` is only mentioned when nothing else explains the
situation, and unresolved threads are never reported as "0" when the extra call
to fetch them failed.

Below that, recent activity is **one line per event** — newest first, so the
latest word is nearest the verdict — and the description last. Comments,
reviews and inline review comments all appear, each with the file and line where
it applies.

All prose goes through an HTML-to-text pass first. GitHub bodies are markdown
*plus* arbitrary HTML, and a dependabot description is almost entirely
`<details><blockquote><ul>` — which rendered as literal source before. `<details>`
blocks collapse to `▸ Release notes (collapsed)`, matching how GitHub renders
them; HTML comments (every PR template) disappear; links and `<code>` keep their
text; entities decode.

| Key | Action |
| --- | --- |
| `↑↓` / `j` `k` · `^u` / `^d` · `t` / `b` | scroll · page · jump to ends |
| `g` | the review-verdict menu, without leaving the overview — it returns here afterwards and refreshes |
| `p` / `o` | open the PR / the provisioned environment in a browser |
| `R` | refetch |
| `Esc` / `G` / `q` | back to the diff |

The sidebar leads with **Env** — the instance and URL your `setup` script
reported via `orbit-diff env-report`, or `provisioning…` while it's still
running. It's first because it's the one thing there you act on (`o` opens it),
and re-read every time the view opens or refreshes, since `env-report` usually
lands long after the viewer started. A worktree with no environment simply
doesn't show the block.

It's fetched on first open and cached, so reopening is instant and refreshes
behind what you're already looking at. Two extra API calls back it: inline
comments and review threads, neither of which `gh pr view` will return.

### Finishing a review (`g`)

When the branch has an open PR, `g` opens a small menu for the verdict itself.
Every row is outward-facing and can't be undone from here, so picking a row *is*
the confirmation and each one spells out its full set of side effects:

| Row | What it does |
| --- | --- |
| **Approve** | approves the PR, then unassigns you — it's off your plate |
| **Approve & merge when ready** | approves and turns on GitHub auto-merge. You stay assigned, since you're the one watching it land |
| **Request changes** | submits every annotation as inline comments on **one** review with the *requested changes* verdict, then unassigns you and assigns the PR's author |

"You" is whoever `gh` is authenticated as, so this needs no configuration.

Request changes posts a single review rather than the scatter of standalone
comments `r` → *Post to GitHub PR* produces — that's what makes it land as one
"requested changes" entry in the PR timeline. The trade is that GitHub rejects
the whole review if any comment can't be anchored to the pushed head, where the
`r` path posts what it can and reports the rest; the tally afterwards tells you
which happened. Requesting changes with nothing annotated is allowed and submits
the verdict on its own.

Auto-merge picks a merge method from `pr.mergeMethod` (`"squash"` / `"merge"` /
`"rebase"`). Left empty, it asks the repo which methods it allows and prefers
squash — so it won't fail on a repo that has squash-merging turned off.

### Clipboard over SSH

The copy uses **OSC 52**, a terminal escape sequence that sets the clipboard on
the machine your *terminal emulator* runs on — so it works from a tmux session
over SSH, where `pbcopy`/`xclip` would only reach the remote host. Two things to
know:

- **tmux** must allow it: add `set -g set-clipboard on` to your `~/.tmux.conf`.
  orbit-diff wraps the sequence in tmux's (and GNU screen's) passthrough form
  automatically. Under herdr there's nothing to set — it's the terminal emulator
  rather than a layer inside one, so the sequence goes straight through.
- **Terminal support varies.** iTerm2, kitty, WezTerm, Alacritty, and Windows
  Terminal honor OSC 52; macOS **Terminal.app does not**, and there's no reply
  to confirm success either way. So `y` **also** writes the prompt to a file under
  `~/.cache/orbit-diff/` (the path is shown in the status bar) as a recoverable
  fallback — piping that file into `claude -p` works regardless.

## Demo

`bun smoke.jsx` renders the UI headlessly through a fake TTY and drives a scripted
sequence of keystrokes — useful as a smoke test since Ink needs a real terminal
to run interactively.

## Notes / known limits

- Find respects the `/` file filter — whole-diff scope means all **visible** files.
- A matched line drops syntax highlighting (its unmatched parts fall back to
  the flat add/del color) since ANSI resets would fight the match background.
- No word-level intra-line **diff** highlighting yet (GitHub's red/green spans
  marking what changed within a line — distinct from search highlighting).
- Horizontal scroll isn't implemented; long lines truncate with `…`, which can
  also truncate the scroll-position indicator in the panel title for long paths.
- The current-line / selection highlight is a subtle off-shade of your terminal
  background, detected at startup via an OSC 11 query so it adapts to light and
  dark themes. Terminals that don't answer (some over multiplexers) fall back to
  a dark-tuned default after a brief timeout.
- Mouse wheel / trackpad scrolling is intentionally inert while orbit-diff is
  open (use `j`/`k`, arrows, or `PgUp`/`PgDn` instead) — the viewer repaints in
  place rather than using the terminal's alternate screen buffer, so a native
  scroll would otherwise reveal stale, half-overwritten frames. This works by
  enabling terminal mouse tracking, which also means click-drag text selection
  needs its bypass modifier while it's running (Option on Terminal.app/iTerm2,
  Shift on most Linux terminals).
