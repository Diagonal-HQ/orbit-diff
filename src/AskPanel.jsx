import React from "react";
import { Box, Text } from "ink";

// Left-column panel (mode === "ask"): a question input that turns into a streamed
// answer. Before sending, it's an editor (draft + block cursor) like CommentEditor.
// After sending, the question pins to the top and the answer streams below; the
// answer area shows the tail so the latest text stays visible as it arrives.
export function AskPanel({ question, answer, asking, sent, width, height }) {
  const contentH = Math.max(3, height - 2);

  if (!sent) {
    return (
      <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="magenta" paddingX={1}>
        <Text bold color="magenta" wrap="truncate">Ask about this diff / codebase</Text>
        <Box marginTop={1} flexGrow={1}>
          <Text wrap="wrap">
            {question}
            <Text inverse> </Text>
          </Text>
        </Box>
        <Text dimColor wrap="truncate">enter ask · esc cancel</Text>
      </Box>
    );
  }

  const answerH = Math.max(1, contentH - 3); // question(1) + spacer(1) + footer(1)
  const capacity = answerH * Math.max(1, width - 4);
  const shown = tail(answer, capacity);

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta" wrap="truncate">Q: {question}</Text>
      <Box marginTop={1} height={answerH} flexDirection="column">
        {answer ? (
          <Text wrap="wrap">{shown}</Text>
        ) : (
          <Text dimColor>{asking ? "thinking…" : "(no answer)"}</Text>
        )}
      </Box>
      <Text dimColor wrap="truncate">{asking ? "asking… · esc close" : "esc close · ? ask another"}</Text>
    </Box>
  );
}

// Keep the end of the answer visible as it streams past the box height.
function tail(s, max) {
  if (!s) return "";
  return s.length <= max ? s : "…" + s.slice(s.length - max + 1);
}
