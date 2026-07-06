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
  review: {
    concurrency: 4, // how many files to review in parallel (1–8)
  },
  // `orbit-diff prs` — a PR manager for the current repo. It lists the open,
  // non-draft PRs assigned to you or awaiting your review; pick one to run
  // `start`, or mark it done to run `done`. Tokens {branch} {base} {number}
  // {repo} {title} {url} are substituted (shell-quoted) before the command runs
  // in your login shell (so aliases/functions resolve). Leave empty to disable.
  pr: {
    start: "", // e.g. "pr {branch}"      — checkout/worktree, spin up your session
    done: "", //  e.g. "pr-done {branch}"  — tear it down when you're finished
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
