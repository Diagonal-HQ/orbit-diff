import React from "react";
import { render } from "ink-testing-library";
import { loadDiff, parseDiff } from "./src/git.mjs";
import { App } from "./src/App.jsx";

const files = parseDiff(loadDiff(["HEAD~3", "HEAD"]));
// `handoff` is how App signals `r` (apply with Claude Code): it stashes the
// change-request doc here and exits, and index.jsx runs claude on it. We pass a
// bag so the smoke test can assert the handoff fires without launching claude.
const handoff = { doc: null };
const { lastFrame, stdin } = render(<App files={files} source="HEAD~3..HEAD" handoff={handoff} />);

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

// ---- Annotation flow: select a range, comment, review, copy ----
stdin.write("\t"); await tick(); // focus diff
await type("gjj");                // cursor to an early changed line
await type("v");                  // start selection
console.log("selecting    ", (strip(lastFrame()).match(/SEL \d+L/) || ["(no sel)"])[0]);
await type("jj");                 // extend selection down
await type("c");                  // open comment editor
console.log("comment mode ", strip(lastFrame()).includes("New note") ? "editor open" : "(not open)");
await type("please refactor this block");
await type("\r");                 // save
const marked = strip(lastFrame()).split("\n").some((l) => l.includes("●"));
console.log("after save   ", statusL(), "| ● marker:", marked,
  "| count:", (strip(lastFrame()).match(/\d+✎/) || ["0✎"])[0]);
await type("a");                  // jump the rail cursor to the first annotation
console.log("notes focus  ", strip(lastFrame()).includes("▸notes") ? "in notes section" : "(not focused)",
  "| listed:", strip(lastFrame()).includes("Annotations (1)"));
await type("\r");                 // enter jumps to the annotation in the diff
console.log("after jump   ", statusL(), "| ▸diff:", strip(lastFrame()).includes("▸diff"));
await type("y");                  // copy to clipboard (+ .orbit fallback)
console.log("after copy   ", (strip(lastFrame()).match(/request.*clipboard|request.*\.orbit/) || ["(no toast)"])[0].slice(0, 50));

await type("r");                  // open the submit-target picker
await tick();
console.log("submit menu  ", strip(lastFrame()).includes("Submit 1 annotation") ? "picker open" : "(not open)",
  "| Claude row:", strip(lastFrame()).includes("Apply via Claude Code"));
await type("\r");                 // pick the first row (Apply via Claude) → hands off & exits
await tick();
console.log("after choose  handoff doc set:", handoff.doc != null,
  "| has request:", (handoff.doc || "").includes("please refactor this block"));

process.exit(0);
