// Reading a keypress chunk that may hold more than one keypress.
//
// Ink hands `useInput` whatever arrived in a single stdin read. Usually that's
// one keystroke, so `input === "j"` works — but when keys arrive faster than the
// read loop (a held-down key, a fast typist, a pasted burst, a `send-keys` from
// a script) two or three land in ONE string and `"jj" === "j"` is false. The
// keypresses are silently dropped.
//
// That's a cosmetic annoyance while scrolling a diff and a genuine hazard in a
// menu whose rows do irreversible things: press `j` `j` quickly to reach the
// third row, and if neither registers, Enter fires the FIRST row instead of the
// one you were looking at.
//
// `navStep` reads a whole chunk and returns the net movement in it.

// Net rows to move for a chunk of vim-style navigation keys: +1 per `j`, -1 per
// `k`, arrow keys counted once (Ink reports those through `key`, and an escape
// sequence isn't repeated in the same chunk in a way we can count reliably).
//
// Returns 0 for a chunk that isn't navigation at all, so callers can fall
// through to their other bindings.
export function navStep(input, key = {}) {
  if (key.downArrow) return 1;
  if (key.upArrow) return -1;
  const text = String(input || "");
  // Only a run of pure j/k is treated as repeated navigation. Anything else in
  // the chunk means it isn't a scroll burst, and guessing would be worse than
  // ignoring it.
  if (!text || !/^[jk]+$/.test(text)) return 0;
  let step = 0;
  for (const ch of text) step += ch === "j" ? 1 : -1;
  return step;
}
