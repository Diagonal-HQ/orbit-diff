// Orchestration between the UI and the Pi client: caching, bounded-concurrency
// review fan-out, and Q&A context assembly. App.jsx calls into here so it never
// touches the SDK or the cache directly.

import { createHash } from "node:crypto";
import { ask, reviewFile } from "./client.mjs";
import {
  answerKey,
  fileDigest,
  readAnswer,
  readReview,
  reviewKey,
  writeAnswer,
  writeReview,
} from "./cache.mjs";
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

// Answer a question about the diff/codebase, cache-first. `files` is the full
// parsed diff (for building context + the cache fingerprint), `focused` the file
// currently in view. `onDelta` streams the fresh answer; on a cache hit it's
// replayed in one shot so the UI path is uniform.
export async function answerQuestion(question, files, focused, config, onDelta) {
  const digest = diffDigest(files);
  const key = answerKey(question, digest, config);
  const cached = readAnswer(key);
  if (cached != null) {
    onDelta?.(cached);
    return { answer: cached, cached: true };
  }
  const context = buildContext(files, focused);
  const answer = await ask(question, context, config, onDelta);
  writeAnswer(key, answer);
  return { answer, cached: false };
}

// Fingerprint of the whole diff — an answer is reused only while the diff is
// byte-identical to when it was produced.
function diffDigest(files) {
  const h = createHash("sha256");
  for (const f of files) h.update(fileDigest(f)).update("|");
  return h.digest("hex");
}

// Compact grounding context: the list of changed files, plus the focused file's
// numbered diff (capped — the model can read more via its read-only tools).
function buildContext(files, focused) {
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
  return `Files changed in the diff under review:\n${list}${focusBlock}`;
}
