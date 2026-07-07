// Orchestration between the UI and the Pi client: caching, bounded-concurrency
// review fan-out, and Q&A context assembly. App.jsx calls into here so it never
// touches the SDK or the cache directly.

import { reviewFile, startConversation as startClientConversation } from "./client.mjs";
import { readReview, reviewKey, writeReview } from "./cache.mjs";
import { makeFindings } from "./findings.mjs";

// Review every file, cache-first, at most `concurrency` in flight. `onFileDone`
// fires as each file's findings land (cache hit or fresh) so the panel can fill
// in progressively. Returns all findings across files.
export async function reviewFiles(files, config, { onFileDone, onProgress } = {}) {
  const conc = Math.max(1, config.review?.concurrency || 4);
  const all = [];
  let done = 0;
  let idx = 0;

  const worker = async () => {
    while (idx < files.length) {
      const file = files[idx++];
      let findings;
      try {
        findings = await reviewOne(file, config);
      } catch (err) {
        findings = { error: err.message || String(err), file };
      }
      done++;
      if (Array.isArray(findings)) {
        all.push(...findings);
        onFileDone?.(file, findings);
      } else {
        onFileDone?.(file, [], findings.error);
      }
      onProgress?.(done, files.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(conc, files.length) }, worker));
  return all;
}

// Review a single file: cached raw findings if the diff is unchanged, else call
// the model and cache the result. Always re-anchors the raw findings to the
// current file so line indices are correct for this session.
async function reviewOne(file, config) {
  const key = reviewKey(file, config);
  const cached = readReview(key);
  let raw;
  if (cached && Array.isArray(cached.findings)) {
    raw = cached.findings;
  } else {
    raw = await reviewFile(file, config);
    writeReview(key, raw);
  }
  return makeFindings(file, raw);
}

// Start a multi-turn chat about the diff/codebase. The first question is grounded
// with the diff context (changed-file list + focused file); follow-ups go straight
// to the live session, which already remembers the context and prior turns. The
// session can edit the working tree when asked. `priorMessages` (from a reopened,
// previously-saved conversation) is folded into that same grounding, since this is
// a fresh model session with no memory of those turns. Returns a handle:
// `ask(question, onDelta)` streams each answer and resolves to `{ text, changed }`
// (`changed` true when the turn edited files, so the caller can reload);
// `dispose()` ends it.
export function startConversation(files, focused, config, priorMessages = []) {
  const convo = startClientConversation(config);
  const context = buildContext(files, focused, priorMessages);
  let first = true;
  return {
    ask(question, onDelta) {
      const prompt = first ? `${context}\n\nQuestion: ${question}` : question;
      first = false;
      return convo.send(prompt, onDelta);
    },
    dispose: () => convo.dispose(),
  };
}

// Compact grounding context: the list of changed files, the focused file's
// numbered diff (capped — the model can read more via its read-only tools), and
// — when reopening a saved conversation — the prior turns, since this session
// has never seen them.
function buildContext(files, focused, priorMessages = []) {
  const list = files.map((f) => `- ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`).join("\n");
  let focusBlock = "";
  if (focused) {
    const body = focused.lines
      .map((l) => {
        if (l.type === "hunk") return `        ${l.content}`;
        const sign = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
        const num = l.newNum ?? l.oldNum ?? "";
        return `${String(num).padStart(6)} ${sign} ${l.content}`;
      })
      .join("\n")
      .slice(0, 8000);
    focusBlock = `\n\nCurrently viewing ${focused.path}:\n${body}`;
  }
  let historyBlock = "";
  if (priorMessages.length) {
    const transcript = priorMessages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n\n");
    historyBlock = `\n\nContinuing an earlier conversation:\n${transcript}`;
  }
  return `Files changed in the diff under review:\n${list}${focusBlock}${historyBlock}`;
}
