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

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

// Human-friendly path shown in "where do I configure this?" messages.
export const CONFIG_HINT = "~/.config/orbit-diff/config.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

export const DEFAULTS = {
  provider: "anthropic",
  model: "claude-opus-4-8",
  thinkingLevel: "medium",
  review: { concurrency: 4 },
};

// The base config directory ($XDG_CONFIG_HOME, else ~/.config) and the resolved
// global config path.
export function configHome() {
  return process.env.XDG_CONFIG_HOME || `${homedir()}/.config`;
}
export function globalConfigPath() {
  return `${configHome()}/orbit-diff/config.js`;
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
  };

  if (!THINKING_LEVELS.includes(merged.thinkingLevel)) {
    warning = warning || `unknown thinkingLevel "${merged.thinkingLevel}"; using "${DEFAULTS.thinkingLevel}"`;
    merged.thinkingLevel = DEFAULTS.thinkingLevel;
  }
  const conc = Number(merged.review.concurrency);
  merged.review.concurrency = Number.isFinite(conc) && conc > 0 ? Math.min(8, Math.floor(conc)) : DEFAULTS.review.concurrency;

  return { ...merged, source, configPath, warning };
}
