import React from "react";
import { render } from "ink-testing-library";
import { loadDiff, parseDiff } from "./src/git.mjs";
import { App } from "./src/App.jsx";

const files = parseDiff(loadDiff(["HEAD~3", "HEAD"]));
const { lastFrame, stdin } = render(<App files={files} source="HEAD~3..HEAD" />);

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = () => new Promise((r) => setTimeout(r, 20));
const type = async (s) => { for (const c of s) { stdin.write(c); await tick(); } };

const cursorLine = () =>
  strip(lastFrame()).split("\n").find((l) => l.includes("▸") && !l.includes("tab")) || "(none)";
const statusL = () => (strip(lastFrame()).match(/L\d+\/\d+/) || ["(none)"])[0];

// Focus the diff pane, then walk the cursor down and page down.
await tick(); // let Ink subscribe to stdin before the first keypress
stdin.write("\t"); await tick();
console.log("focus diff  ", statusL(), "|", cursorLine().trim().slice(-40));
await type("jjj");
console.log("after jjj    ", statusL(), "|", cursorLine().trim().slice(-40));
await type("\x04"); // Ctrl-d
console.log("after ^d     ", statusL(), "|", cursorLine().trim().slice(-40));
await type("G");
console.log("after G      ", statusL(), "|", cursorLine().trim().slice(-40));
await type("g");
console.log("after g      ", statusL(), "|", cursorLine().trim().slice(-40));

// Cursor indicator should also move when scrolling from the FILES pane.
stdin.write("\t"); await tick(); // back to files pane
await type("\x04");
console.log("^d from files", statusL(), "| ▸files still focused:",
  strip(lastFrame()).includes("▸files"));

process.exit(0);
