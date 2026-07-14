// AI configuration: model, provider, and settings for the reviewer + Q&A.
//
// The user config lives at `~/.config/orbit-diff/config.js` (honours
// $XDG_CONFIG_HOME) and is merged over built-in DEFAULTS. It's a user-global file,
// since orbit-diff is usually installed as a standalone binary on PATH with no
// repo directory around. Because it's a real ES module, it can read `process.env`
// itself (e.g. `model: process.env.ORBIT_DIFF_MODEL ?? "claude-opus-4-8"`) — so there's
// no separate env-override layer here.
//
// We keep API keys OUT of this — the Pi SDK resolves those from its own env vars
// (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) or ~/.pi/agent/auth.json, so orbit-diff
// never handles secrets. The config file is a real ES module (`export default
// {…}`), not JSON, so a user can compute values (read env, branch, etc.).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

// Human-friendly path shown in "where do I configure this?" messages.
export const CONFIG_HINT = "~/.config/orbit-diff/config.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

export const DEFAULTS = {
  provider: "anthropic",
  model: "claude-opus-4-8",
  thinkingLevel: "medium",
  // Command run when you press `e` on a file in the diff viewer to open it in your
  // editor. The `{file}` token is substituted with the file's absolute path
  // (shell-quoted); the command runs in your login shell so aliases/functions
  // resolve. Terminal editors work — the viewer hands over the terminal while it
  // runs and reloads the diff when you exit. Empty = `e` is disabled.
  //   e.g. "vi {file}"  ·  "code {file}"  ·  "$EDITOR {file}"
  editor: "",
  review: { concurrency: 4 },
  // `orbit-diff prs` PR-management. Starting a PR now creates the worktree and a
  // three-pane tmux review window itself (setup · claude · orbit-diff); these
  // commands plug your own tooling into that flow. Tokens {branch} {base}
  // {number} {repo} {title} {url} are substituted (shell-quoted); commands run in
  // your login shell so aliases/functions resolve.
  //   setup   — runs in the top-left pane inside the fresh worktree (build env,
  //             deps, etc). Report the provisioned instance back to orbit-diff
  //             with `orbit-diff env-report <instance>` as its last step.
  //   claude  — runs in the top-right pane (default `claude`).
  //   done    — YOUR env teardown when you finish (destroy the instance, etc.).
  //             orbit-diff always removes the git worktree itself, after `done`
  //             runs — so `done` only needs your custom teardown, not worktree
  //             bookkeeping. Leave empty if there's nothing to tear down.
  //   worktreeDir — where to create worktrees. Tokens {repo} {branch} {base}
  //             {number}; `~` expands. Empty = sibling `<repo>-worktrees/<branch>`.
  //   start   — legacy alias for `setup` (still honoured when `setup` is empty).
  //   worktreeRefreshMinutes auto-refreshes the worktrees pane (0 disables).
  pr: {
    start: "",
    setup: "",
    claude: "claude",
    done: "",
    worktreeDir: "",
    worktreeRefreshMinutes: 2,
  },
};

// The starter file written by `orbit-diff init` and by the first-run auto-scaffold.
// It's the DEFAULTS above, spelled out as a real ES module the user can edit — the
// binary ships without the repo, so we can't point people at the example file.
export const CONFIG_TEMPLATE = `// orbit-diff AI configuration — controls the AI reviewer (\`A\`) and ask (\`?\`).
// This is a real ES module, so you can compute values (read env vars, etc.).
//
// API KEYS ARE NOT SET HERE. orbit-diff uses the Pi SDK, which reads credentials
// from its own env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) or ~/.pi/agent/auth.json.
// Set your key there, or run \`pi\` once and \`/login\`.
//
// \`provider\` + \`model\` can target any provider Pi supports (anthropic, openai,
// google, amazon-bedrock, groq, deepseek, mistral, cloudflare, …).

export default {
  provider: "anthropic",
  model: "claude-opus-4-8", // any model id Pi knows for the provider above
  thinkingLevel: "medium", // off | minimal | low | medium | high | xhigh
  // Pressing \`e\` on a file opens it in this editor. {file} = the file's absolute
  // path (shell-quoted); runs in your login shell. Terminal editors work — the
  // viewer hands over the terminal and reloads the diff when you exit. Empty = off.
  editor: "", // e.g. "vi {file}"  ·  "code {file}"  ·  "$EDITOR {file}"
  review: {
    concurrency: 4, // how many files to review in parallel (1–8)
  },
  // \`orbit-diff prs\` — starting a PR creates the worktree + a three-pane tmux
  // review window (setup · claude · orbit-diff) for you. These plug your tooling
  // into that flow. Tokens {branch} {base} {number} {repo} {title} {url} are
  // shell-quoted; commands run in your login shell so aliases/functions work.
  pr: {
    setup: "", //  e.g. "make dev-env {branch}" — runs in the top-left pane inside
    //             the new worktree. End it with \`orbit-diff env-report <instance>\`
    //             so orbit-diff can track the provisioned environment.
    claude: "claude", // command run in the top-right pane
    done: "", //   e.g. "tear-down {branch}" — YOUR env teardown; orbit-diff always
    //             removes the git worktree itself afterwards
    worktreeDir: "", // where worktrees go; tokens {repo} {branch} {base} {number},
    //             \`~\` expands. Empty = sibling "<repo>-worktrees/<branch>"
    worktreeRefreshMinutes: 2, // auto-refresh the worktrees pane (0 disables)
  },
};
`;

// The base config directory ($XDG_CONFIG_HOME, else ~/.config) and the resolved
// global config path.
export function configHome() {
  return process.env.XDG_CONFIG_HOME || `${homedir()}/.config`;
}
export function globalConfigPath() {
  return `${configHome()}/orbit-diff/config.js`;
}

// Write the starter config to `globalConfigPath()`. Skips an existing file unless
// `force`, so it's safe to call on every run. Creates the parent dir as needed.
// Returns { path, created } — `created` is false when an existing file was kept.
export function scaffoldConfig({ force = false } = {}) {
  const path = globalConfigPath();
  if (existsSync(path) && !force) return { path, created: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, CONFIG_TEMPLATE);
  return { path, created: true };
}

// Best-effort first-run scaffold used at startup: materialise the config file if
// it's missing, but never let a read-only home (or any fs error) break the viewer.
export function ensureConfig() {
  try {
    return scaffoldConfig({ force: false });
  } catch (err) {
    return { path: globalConfigPath(), created: false, error: err };
  }
}

// Load and normalise the effective AI config. Never throws — a missing config
// falls back to DEFAULTS; a broken one is reported via `warning` so the UI can
// nudge the user rather than crash the viewer.
export async function loadConfig() {
  const configPath = globalConfigPath();
  let fileCfg = null;
  let source = "default";
  let warning = null;

  if (existsSync(configPath)) {
    try {
      const mod = await import(pathToFileURL(configPath).href);
      const raw = mod.default ?? mod.config ?? mod;
      if (raw && typeof raw === "object") {
        fileCfg = raw;
        source = "file";
      }
    } catch (err) {
      warning = `couldn't load ${configPath}: ${err.message}`;
    }
  }

  const merged = {
    ...DEFAULTS,
    ...(fileCfg || {}),
    review: { ...DEFAULTS.review, ...(fileCfg?.review || {}) },
    pr: { ...DEFAULTS.pr, ...(fileCfg?.pr || {}) },
  };
  // Commands must be strings; coerce anything else back to the empty default.
  merged.editor = typeof merged.editor === "string" ? merged.editor : "";
  merged.pr.start = typeof merged.pr.start === "string" ? merged.pr.start : "";
  merged.pr.setup = typeof merged.pr.setup === "string" ? merged.pr.setup : "";
  merged.pr.claude = typeof merged.pr.claude === "string" && merged.pr.claude.trim() ? merged.pr.claude : "claude";
  merged.pr.done = typeof merged.pr.done === "string" ? merged.pr.done : "";
  merged.pr.worktreeDir = typeof merged.pr.worktreeDir === "string" ? merged.pr.worktreeDir : "";
  const wtMin = Number(merged.pr.worktreeRefreshMinutes);
  merged.pr.worktreeRefreshMinutes = Number.isFinite(wtMin) && wtMin >= 0 ? wtMin : DEFAULTS.pr.worktreeRefreshMinutes;

  if (!THINKING_LEVELS.includes(merged.thinkingLevel)) {
    warning = warning || `unknown thinkingLevel "${merged.thinkingLevel}"; using "${DEFAULTS.thinkingLevel}"`;
    merged.thinkingLevel = DEFAULTS.thinkingLevel;
  }
  const conc = Number(merged.review.concurrency);
  merged.review.concurrency = Number.isFinite(conc) && conc > 0 ? Math.min(8, Math.floor(conc)) : DEFAULTS.review.concurrency;

  return { ...merged, source, configPath, warning };
}
