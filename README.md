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
| `g` / `G` | jump the cursor to top / bottom — **works from either pane** |
| `/` | filter files (fuzzy subsequence on path) |
| `f` | find in diff contents — matches every line, context included |
| `Tab` (while finding) | toggle search scope: **whole diff** ⇄ **focused file** |
| `n` / `N` | next / previous match (jumps across files in whole-diff scope) |
| `v` | start / cancel a multi-line selection (anchor at the cursor, extend with the cursor) |
| `c` | comment on the selection (or the cursor line); on an already-annotated line, edit it |
| `x` | delete the annotation on the cursor line (or the highlighted one in the rail's annotations list) |
| `a` | jump the rail cursor to the annotations list (then `↑↓`/`j` `k` navigate, `Enter` jumps to it in the diff) |
| `y` | copy all annotations to the clipboard as a change-request prompt for Claude Code |
| `r` | open the **submit** picker: apply via Claude Code, post to the GitHub PR (when one exists), or copy |
| `A` | **AI review** of the diff — findings stream into a side panel (`↑↓`/`j` `k` move · `Enter` jump to it · `p` promote to an annotation · `Esc` close) |
| `?` | **ask** the model a question about the diff / codebase — the answer streams into a panel (`Esc` close) |
| `Enter` | rail → focus diff · find → jump to first match |
| `Esc` | while typing: cancel · selecting: cancel the selection · normal: clear an applied filter/search |
| `q` / `Ctrl-c` | quit |

Only the matched **substring** is highlighted (the rest of the line keeps its
add/del color): cyan on the focused match (the one `n`/`N` points at), yellow on
the others.

Syntax highlighting is by file extension via `cli-highlight` (highlight.js),
emitted as ANSI that Ink renders directly. It's per-line, so multi-line
constructs (block comments, template strings) may not carry state across lines.

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

Results are **cached** outside the repo, under
`~/.cache/orbit-diff/<repo>/<branch>/ai-cache/` (honours `$XDG_CACHE_HOME`), so
nothing is written into the tree you're reviewing. Reviews are cached per file
keyed by the file's diff content, so re-running a review only calls the model for
files that actually changed — even across separate sessions. Answers to identical
questions on an unchanged diff are served from cache too.

### Configure the model & provider

The backend is the [Pi SDK](https://pi.dev), so you choose the provider and model.
Config lives at `~/.config/orbit-diff/config.js` (honours `$XDG_CONFIG_HOME`) — a
user-global file, so it works with the installed binary and no repo directory:

```bash
mkdir -p ~/.config/orbit-diff
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

### Clipboard over SSH + tmux

The copy uses **OSC 52**, a terminal escape sequence that sets the clipboard on
the machine your *terminal emulator* runs on — so it works from a tmux session
over SSH, where `pbcopy`/`xclip` would only reach the remote host. Two things to
know:

- **tmux** must allow it: add `set -g set-clipboard on` to your `~/.tmux.conf`.
  orbit-diff wraps the sequence in tmux's (and GNU screen's) passthrough form
  automatically.
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
