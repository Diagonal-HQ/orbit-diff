// AI review of a single file's diff: prompt construction, tolerant JSON parsing,
// and anchoring each finding back to a line range in the parsed diff so it can be
// jumped to and (optionally) promoted to an annotation.
//
// Bump PROMPT_VERSION whenever the prompt or finding shape changes — it's part of
// the cache key, so bumping it invalidates stale cached reviews.

export const PROMPT_VERSION = "r1";

const SEVERITIES = ["high", "medium", "low", "info"];

// The reviewer persona + strict output contract. Passed to the Pi session as the
// system-prompt override so the model returns machine-parseable findings.
export const REVIEW_SYSTEM_PROMPT = `You are a precise, senior code reviewer embedded in a terminal diff viewer.
You review ONE file's git diff at a time and report concrete, actionable findings.

Rules:
- Only report real issues introduced or affected by THIS diff: bugs, correctness,
  security, resource/error handling, concurrency, API misuse, obvious perf traps,
  and clear maintainability problems. Do not restate what the code does.
- Anchor each finding to specific line numbers shown in the diff. Prefer the NEW
  (right-hand) line numbers; use OLD numbers only for pure deletions.
- If the diff looks fine, return an empty list. Do not invent nitpicks.
- Keep "title" to a short imperative phrase and "body" to 1-3 sentences that a
  developer could act on.

Output ONLY a JSON array (no prose, no markdown fences) of objects with fields:
  { "lineStart": number, "lineEnd": number, "side": "new" | "old",
    "severity": "high" | "medium" | "low" | "info",
    "title": string, "body": string }
Return [] when there is nothing worth reporting.`;

// The per-file user message: the diff rendered with real line numbers + markers so
// the model can cite exact lines, plus the path for context.
export function buildReviewPrompt(file) {
  return `File: ${file.path} (${file.status})\n\nDiff (real line numbers shown; \`+\` added, \`-\` removed, space unchanged):\n\n${renderNumberedDiff(file)}\n\nReview this diff and return the JSON array of findings.`;
}

function renderNumberedDiff(file) {
  const rows = [];
  for (const l of file.lines) {
    if (l.type === "hunk") {
      rows.push(`        ${l.content}`);
      continue;
    }
    const sign = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
    const num = l.newNum ?? l.oldNum ?? "";
    rows.push(`${String(num).padStart(6)} ${sign} ${l.content}`);
  }
  return rows.join("\n");
}

// Parse the model's response into raw finding objects, tolerant of prose or
// ```json fences around the array. Returns [] if nothing parseable is found.
export function parseFindings(text) {
  const jsonText = extractJsonArray(text);
  if (!jsonText) return [];
  let arr;
  try {
    arr = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((o) => o && typeof o === "object")
    .map((o) => ({
      lineStart: toInt(o.lineStart ?? o.line),
      lineEnd: toInt(o.lineEnd ?? o.lineStart ?? o.line),
      side: o.side === "old" ? "old" : "new",
      severity: SEVERITIES.includes(o.severity) ? o.severity : "info",
      title: String(o.title ?? "").trim() || "Finding",
      body: String(o.body ?? o.description ?? "").trim(),
    }));
}

// Pull the first JSON array out of a possibly-noisy response: prefer a fenced
// ```json block, else scan for the first balanced [...] (string-aware so brackets
// inside strings don't fool the matcher).
function extractJsonArray(text) {
  if (!text) return null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const hay = fence ? fence[1] : text;
  const start = hay.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < hay.length; i++) {
    const c = hay[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return hay.slice(start, i + 1);
    }
  }
  return null;
}

// Resolve a real file line number (on the given side) to an index into
// file.lines. Reverse of the anchoring done for GitHub comments in github.mjs.
export function indexForLine(file, lineNo, side) {
  if (lineNo == null) return -1;
  const key = side === "old" ? "oldNum" : "newNum";
  for (let i = 0; i < file.lines.length; i++) {
    if (file.lines[i][key] === lineNo) return i;
  }
  // Fall back to the other side (the model may have picked the wrong one).
  const alt = side === "old" ? "newNum" : "oldNum";
  for (let i = 0; i < file.lines.length; i++) {
    if (file.lines[i][alt] === lineNo) return i;
  }
  return -1;
}

// Map a parsed finding's line span to an index range into file.lines. Returns
// { startIdx, endIdx } when at least one endpoint anchors, else null.
export function anchorFinding(file, f) {
  let a = indexForLine(file, f.lineStart, f.side);
  let b = indexForLine(file, f.lineEnd, f.side);
  if (a < 0 && b < 0) return null;
  if (a < 0) a = b;
  if (b < 0) b = a;
  return { startIdx: Math.min(a, b), endIdx: Math.max(a, b) };
}

function toInt(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
