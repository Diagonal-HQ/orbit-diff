// `orbit-diff pr-status` — what runs in the review window's status pane. A
// small polling loop (no Ink; it's a plain pane, not an interactive view)
// that prints the worktree's branch, PR state, and provisioned env, then
// refreshes on a timer so checks/reviews catch up without a manual restart.

import { branchName, repoRoot } from "./paths.mjs";
import { prOverview } from "./pr.mjs";
import { sessionForWorktree } from "./session.mjs";

const REFRESH_MS = 30_000;

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function row(label, value) {
  return `${dim(label.padEnd(10))}${value}`;
}

// A GitHub reviewer entry is a user ({login}) or a team ({name}).
function names(list) {
  if (!Array.isArray(list) || list.length === 0) return dim("none");
  return list.map((x) => x.login || x.name).join(", ");
}

function reviewDecision(decision) {
  if (!decision) return dim("review required");
  if (decision === "APPROVED") return green("approved");
  if (decision === "CHANGES_REQUESTED") return red("changes requested");
  return decision.toLowerCase().replace(/_/g, " ");
}

function checksLine(checks) {
  if (!checks || checks.total === 0) return dim("no checks");
  const parts = [];
  if (checks.passing) parts.push(green(`✓ ${checks.passing}`));
  if (checks.failing) parts.push(red(`✗ ${checks.failing}`));
  if (checks.pending) parts.push(yellow(`… ${checks.pending}`));
  return parts.join("  ");
}

function envLine(sess) {
  if (sess?.envInstance != null || sess?.envUrl) {
    const inst = sess.envInstance != null ? `#${sess.envInstance}` : dim("?");
    return sess.envUrl ? `${inst}  ${sess.envUrl}` : inst;
  }
  if (sess?.status === "provisioning") return dim("provisioning…");
  if (sess?.status === "failed") return red(sess.error || "provisioning failed");
  return dim("none");
}

async function render() {
  const lines = [bold(branchName()), ""];

  const pr = await prOverview();
  if (pr.error) {
    lines.push(row("PR", dim(`no PR found (${pr.error})`)));
  } else {
    lines.push(row("PR", `#${pr.number} ${pr.state} · ${reviewDecision(pr.reviewDecision)}`));
    lines.push(row("Assignee", names(pr.assignees)));
    lines.push(row("Reviewers", names(pr.reviewRequests)));
    lines.push(row("Checks", checksLine(pr.checks)));
  }

  lines.push("");
  lines.push(row("Env", envLine(sessionForWorktree(repoRoot()))));

  process.stdout.write("\x1b[2J\x1b[H" + lines.join("\n") + "\n");
}

export async function runPrStatus() {
  while (true) {
    try {
      await render();
    } catch (err) {
      process.stdout.write(`\x1b[2J\x1b[H${dim(`status error: ${err.message}`)}\n`);
    }
    await sleep(REFRESH_MS);
  }
}
