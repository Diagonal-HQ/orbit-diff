// The `orbit-diff prs` driver: load the review-worthy PRs for this repo, run the
// PrApp picker, and whenever it hands back a "start"/"done" action, release the
// terminal to the configured command (like the diff viewer's Claude handoff),
// then re-launch the picker on a refreshed list. Kept out of index.jsx so the
// entrypoint stays a thin argv switch.

import React from "react";
import { spawnSync } from "node:child_process";
import { render } from "ink";
import { PrApp } from "./PrApp.jsx";
import { inPlaceStdout } from "./inplace-stdout.mjs";
import { listReviewPRs, renderCommand } from "./pr.mjs";
import { loadConfig, CONFIG_HINT } from "./ai/config.mjs";

export async function runPrManager() {
  const config = await loadConfig();
  if (config.warning) console.error(`\x1b[2morbit-diff: ${config.warning}\x1b[0m`);

  // The list is fetched inside PrApp (so the shell boots instantly and the PRs
  // stream in), and refresh happens in-component — this loop only re-launches
  // the picker around the terminal handoffs for `start` / `done`.
  let selected = 0;
  while (true) {
    const handoff = { action: null, pr: null, selected };
    const app = render(
      <PrApp loadPRs={listReviewPRs} config={config} handoff={handoff} initialSelected={selected} />,
      { exitOnCtrlC: true, stdout: inPlaceStdout(process.stdout) },
    );
    await app.waitUntilExit();
    process.stdout.write("\x1b[2J\x1b[H"); // clear the viewer's last frame

    selected = handoff.selected ?? selected;

    if (!handoff.action) break; // plain quit

    // start / done: run the configured command with the terminal handed over.
    const template = handoff.action === "start" ? config.pr.start : config.pr.done;
    const cmd = renderCommand(template, handoff.pr);
    if (!cmd) {
      console.error(
        `orbit-diff: pr.${handoff.action} isn't configured. Set it in ${CONFIG_HINT} (e.g. ` +
          `pr.${handoff.action}: "${handoff.action === "start" ? "pr {branch}" : "pr-done {branch}"}").`,
      );
      // Fall back into the picker rather than exiting, so one missing command
      // doesn't end the session.
      continue;
    }

    const label = handoff.action === "start" ? "starting" : "finishing";
    console.log(`\x1b[2morbit-diff → ${label} #${handoff.pr.number} (${handoff.pr.headRefName}): ${cmd}\x1b[0m\n`);

    const shell = process.env.SHELL || "/bin/sh";
    // `-i` sources the interactive rc so shell aliases/functions (a `pr` function,
    // say) resolve; `-c` runs the rendered command. stdio inherit gives it the
    // real TTY so it can prompt / open an editor, and blocks until it exits.
    const res = spawnSync(shell, ["-ic", cmd], { stdio: "inherit" });
    if (res.error) {
      console.error(`\norbit-diff: couldn't run the command: ${res.error.message}`);
      process.exit(1);
    }

    // Loop back into the picker; PrApp refetches the (possibly changed) list on
    // mount, so the user lands on a fresh view.
  }
}
