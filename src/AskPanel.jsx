import React from "react";
import { Box, Text } from "ink";

// The panel's inner geometry, shared with the key handler so it can compute
// the same row layout `AskPanel` renders (for clamping the scroll offset).
export function askPanelMetrics(width, height) {
  const inner = Math.max(1, height - 2); // borders
  const bodyH = Math.max(1, inner - 3); // title + input + footer
  const textW = Math.max(1, width - 4); // borders + paddingX
  return { bodyH, textW };
}

// Flatten the transcript into role-tagged visual lines (wrapped to `textW`),
// one row per rendered terminal line, so the panel and the key handler agree
// on where a given scroll offset lands.
export function flattenAskRows(messages, asking, textW) {
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
  return rows;
}

// Left-column panel (mode === "ask"): a back-and-forth chat about the diff /
// codebase. The transcript of prior turns scrolls above a persistent input line;
// each answer streams into the last turn. `messages` is [{role, text}] with role
// "user" | "assistant"; the final assistant turn is the one currently streaming
// while `asking` is true. `draft` is the follow-up being typed. `scroll` is how
// many rows up from the bottom the view sits (0 = pinned to the newest text,
// so streaming tokens stay in view; Ctrl-u/Ctrl-d in App.jsx page it).
//
// `historyMode` swaps the transcript for a list of past conversations (Tab
// toggles it in App.jsx) — `history` is [{id, title, messages}], newest first.
export function AskPanel({ messages, draft, asking, scroll = 0, width, height, historyMode = false, history = [], historySelected = 0 }) {
  const { bodyH, textW } = askPanelMetrics(width, height);

  if (historyMode) {
    return (
      <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="magenta" paddingX={1}>
        <Text bold color="magenta" wrap="truncate">Past conversations ({history.length})</Text>
        <Box marginTop={1} flexDirection="column" flexGrow={1}>
          {history.length === 0 ? (
            <Text dimColor>no saved conversations yet</Text>
          ) : (
            history.map((c, i) => {
              const on = i === historySelected;
              const turns = c.messages.filter((m) => m.role === "user").length;
              return (
                <Text key={c.id} inverse={on} wrap="truncate">
                  {on ? "❯ " : "  "}
                  {truncate(c.title || "(untitled)", Math.max(4, textW - 12))}
                  <Text dimColor>{`  ${turns} turn${turns === 1 ? "" : "s"}`}</Text>
                </Text>
              );
            })
          )}
        </Box>
        <Text dimColor wrap="truncate">↑↓ move · enter open · tab back to chat · esc close</Text>
      </Box>
    );
  }
  const rows = flattenAskRows(messages, asking, textW);

  // `end` is fixed by the scroll offset (rows hidden below); reserve a row for
  // each hint that ends up showing, mirroring the PR overview's description
  // scroll so the count of visible rows never overflows `bodyH`.
  const maxScroll = Math.max(0, rows.length - bodyH);
  const clampedScroll = Math.max(0, Math.min(scroll, maxScroll));
  const end = rows.length - clampedScroll;
  const below = rows.length - end;
  let budget = bodyH - (below > 0 ? 1 : 0);
  let start = Math.max(0, end - budget);
  const above = start;
  if (above > 0) {
    budget -= 1;
    start = Math.max(0, end - budget);
  }
  const shown = rows.slice(start, end);

  const footer = asking ? "asking… · esc close" : "enter send · esc close · ^u/^d scroll";
  const promptText = tail(draft, Math.max(1, textW - 2));

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta" wrap="truncate">Chat about this diff / codebase</Text>
      <Box height={bodyH} flexDirection="column">
        {messages.length === 0 ? (
          <Text dimColor wrap="wrap">Ask about the diff, or ask for changes — this chat can edit files. Follow-ups keep the conversation going.</Text>
        ) : (
          <>
            {above > 0 && <Text dimColor>↑ {above} more line{above === 1 ? "" : "s"}</Text>}
            {shown.map((r, i) =>
              r.role === "user" ? (
                <Text key={i} color="cyan" wrap="truncate">{r.text}</Text>
              ) : r.role === "dim" ? (
                <Text key={i} dimColor wrap="truncate">{r.text}</Text>
              ) : (
                <Text key={i} wrap="truncate">{r.text || " "}</Text>
              ),
            )}
            {below > 0 && <Text dimColor>↓ {below} more line{below === 1 ? "" : "s"}</Text>}
          </>
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

function truncate(s, max) {
  s = String(s ?? "");
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
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
