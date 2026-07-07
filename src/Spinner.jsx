import React, { useState, useEffect } from "react";
import { Text } from "ink";

// A tiny braille spinner, shared by the AI-review header and the PR manager's
// "provisioning / tearing down" indicators.
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// One shared clock drives every Spinner on screen, so N spinners cause ONE
// re-render per tick (all advancing to the same frame) instead of N independent
// 80ms timers each triggering their own full-frame repaint — the difference
// between a smooth spin and a flashing screen when several are visible.
let frame = 0;
const listeners = new Set();
let timer = null;

function subscribe(cb) {
  listeners.add(cb);
  if (!timer) {
    timer = setInterval(() => {
      frame = (frame + 1) % SPINNER_FRAMES.length;
      for (const l of listeners) l(frame);
    }, 100);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function Spinner({ color }) {
  const [i, setI] = useState(frame);
  useEffect(() => subscribe(setI), []);
  return <Text color={color}>{SPINNER_FRAMES[i]}</Text>;
}
