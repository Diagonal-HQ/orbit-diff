import React, { useState, useEffect } from "react";
import { Text } from "ink";

// A tiny braille spinner, shared by the AI-review header and the PR manager's
// "provisioning…" indicator.
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ color }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return <Text color={color}>{SPINNER_FRAMES[i]}</Text>;
}
