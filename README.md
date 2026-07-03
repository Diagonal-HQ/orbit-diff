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
| `Enter` | rail → focus diff · find → jump to first match |
| `Esc` | while typing: cancel the search · in normal mode: clear an applied filter/search |
| `q` / `Ctrl-c` | quit |

Only the matched **substring** is highlighted (the rest of the line keeps its
add/del color): cyan on the focused match (the one `n`/`N` points at), yellow on
the others.

Syntax highlighting is by file extension via `cli-highlight` (highlight.js),
emitted as ANSI that Ink renders directly. It's per-line, so multi-line
constructs (block comments, template strings) may not carry state across lines.

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
