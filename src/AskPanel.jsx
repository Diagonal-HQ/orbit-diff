import React from "react";
import { Box, Text } from "ink";

// Left-column panel (mode === "ask"): a back-and-forth chat about the diff /
// codebase. The transcript of prior turns scrolls above a persistent input line;
// each answer streams into the last turn. `messages` is [{role, text}] with role
// "user" | "assistant"; the final assistant turn is the one currently streaming
// while `asking` is true. `draft` is the follow-up being typed.
export function AskPanel({ messages, draft, asking, width, height }) {
  const inner = Math.max(1, height - 2); // borders
  const bodyH = Math.max(1, inner - 3); // title + input + footer
  const textW = Math.max(1, width - 4); // borders + paddingX

  // Flatten the transcript into role-tagged visual lines (wrapped to the panel
  // width) so we can show exactly the last `bodyH` of them — the newest text,
  // including the streaming answer, always stays in view without overflowing.
  const rows = [];
  messages.forEach((m, i) => {
    if (i > 0) rows.push({ role: "gap", text: "" });
    const streaming = asking && i === messages.length - 1 && m.role === "assistant";
    if (m.role === "user") {
      for (const ln of wrapLines(`You: ${m.text}`, textW)) rows.push({ role: "user", text: ln });
    } else {
      const body = m.text || (streaming ? "thinking…" : "");
      const role = !m.text ? "dim" : "assistant";
      for (const ln of wrapLines(body, textW)) rows.push({ role, text: ln });
    }
  });
  const shown = rows.slice(Math.max(0, rows.length - bodyH));

  const footer = asking ? "asking… · esc close" : "enter send · esc close";
  const promptText = tail(draft, Math.max(1, textW - 2));

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta" wrap="truncate">Ask about this diff / codebase</Text>
      <Box height={bodyH} flexDirection="column">
        {messages.length === 0 ? (
          <Text dimColor wrap="wrap">Type a question below. Follow-ups keep the conversation going.</Text>
        ) : (
          shown.map((r, i) =>
            r.role === "user" ? (
              <Text key={i} color="cyan" wrap="truncate">{r.text}</Text>
            ) : r.role === "dim" ? (
              <Text key={i} dimColor wrap="truncate">{r.text}</Text>
            ) : (
              <Text key={i} wrap="truncate">{r.text || " "}</Text>
            ),
          )
        )}
      </Box>
      <Text wrap="truncate">
        <Text color="magenta">{"› "}</Text>
        {promptText}
        <Text inverse> </Text>
      </Text>
      <Text dimColor wrap="truncate">{footer}</Text>
    </Box>
  );
}

// Word-wrap one logical line to `width` columns, breaking at spaces where it can
// and hard-breaking any word longer than the width. Blank input yields [""].
function wrapLines(text, width) {
  if (!text) return [""];
  const out = [];
  for (const raw of text.split("\n")) {
    let line = raw;
    if (line === "") {
      out.push("");
      continue;
    }
    while (line.length > width) {
      let brk = line.lastIndexOf(" ", width);
      if (brk <= 0) brk = width;
      out.push(line.slice(0, brk));
      line = line.slice(brk).replace(/^ /, "");
    }
    out.push(line);
  }
  return out;
}

// Keep the end of a string visible when it's wider than the space for it.
function tail(s, max) {
  if (!s) return "";
  return s.length <= max ? s : "…" + s.slice(s.length - max + 1);
}
