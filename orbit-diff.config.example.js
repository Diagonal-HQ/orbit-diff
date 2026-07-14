// orbit-diff AI configuration. Copy this file to
//   ~/.config/orbit-diff/config.js        (honours $XDG_CONFIG_HOME)
// and edit to taste. It controls the model, provider, and settings used by the AI
// reviewer (`A`) and the ask-a-question feature (`?`).
//
//   mkdir -p ~/.config/orbit-diff && cp orbit-diff.config.example.js ~/.config/orbit-diff/config.js
//
// API KEYS ARE NOT SET HERE. orbit-diff uses the Pi SDK, which reads credentials
// from its own env vars (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY) or from
// ~/.pi/agent/auth.json. Set your key there, or run `pi` once and `/login`.
//
// `provider` + `model` can target any provider Pi supports (anthropic, openai,
// google, amazon-bedrock, groq, deepseek, mistral, cloudflare, …). The example
// below uses Anthropic; switch both fields to point elsewhere.

export default {
  provider: "anthropic",
  model: "claude-opus-4-8", // any model id Pi knows for the provider above
  thinkingLevel: "medium", // off | minimal | low | medium | high | xhigh
  // Pressing `e` on a file in the diff viewer opens it in this editor. The {file}
  // token becomes the file's absolute path (shell-quoted) and the command runs in
  // your login shell (aliases/functions work). Terminal editors are fine — the
  // viewer hands over the terminal while the editor runs and reloads the diff when
  // you exit it. Empty disables `e`.
  editor: "", // e.g. "vi {file}"  ·  "code {file}"  ·  "$EDITOR {file}"
  review: {
    concurrency: 4, // how many files to review in parallel (1–8)
  },
  // `orbit-diff prs` — a PR manager for the current repo. It lists the open,
  // non-draft PRs assigned to you or awaiting your review. Picking one (enter)
  // makes orbit-diff:
  //   1. create a git worktree for the PR branch,
  //   2. open a detached tmux review window with four panes —
  //        ┌ status ┬─── claude ───┐
  //        ├────────┤              │
  //        │ setup  │              │
  //        ├──────────── orbit-diff ┤   (bottom, full width)
  //        └───────────────────────┘
  //   3. track it all (PR ↔ worktree ↔ panes ↔ env instance) in a session
  //      registry under ~/.cache/orbit-diff/sessions/ — nothing touches the repo.
  //
  // Tokens {branch} {base} {number} {repo} {title} {url} are substituted
  // (shell-quoted) and commands run in your login shell (aliases/functions work).
  pr: {
    // Runs in the top-left pane inside the fresh worktree — build the env, install
    // deps, etc. End it by reporting the provisioned instance back so orbit-diff
    // can track it and stop the "provisioning" spinner on the PR line:
    //   orbit-diff env-report <instance> [--url <url>]
    setup: "", // e.g. "make dev-env {branch} && orbit-diff env-report $EV_INSTANCE"
    claude: "claude", // command run in the top-right pane
    done: "", // e.g. "tear-down {branch}" — YOUR env teardown (destroy the instance,
    //            etc.); orbit-diff always removes the git worktree itself afterwards
    worktreeDir: "", // where worktrees go; tokens {repo}{branch}{base}{number}, `~`
    //                  expands. Empty = sibling "<repo>-worktrees/<branch>".
    worktreeRefreshMinutes: 2, // auto-refresh the worktrees pane (0 disables)
  },
};

// This is a real ES module, so you can compute values — e.g. read env vars for a
// one-off override without editing the file:
//
//   export default {
//     provider: process.env.ORBIT_DIFF_PROVIDER ?? "anthropic",
//     model: process.env.ORBIT_DIFF_MODEL ?? "claude-opus-4-8",
//     thinkingLevel: "medium",
//   };
