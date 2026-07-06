// Annotations: comments a reviewer attaches to diff lines, assembled into a
// change-request prompt for Claude Code.
//
// An annotation anchors to a *range* of indices into a file's flat `lines`
// array (a single-line comment is just start === end). Indices are stable for
// the life of a session (the diff isn't reparsed), which is all we need since
// annotations are ephemeral. For the exported prompt we translate those indices
// back to real file line numbers so Claude Code can locate the code without the
// diff in hand.

let nextId = 1;

// Create an annotation over the inclusive index range [startIdx, endIdx] of the
// given file path. Order-independent: callers may pass the range either way.
// `digest` is the file's content digest at anchor time; it lets persistence tell
// whether the annotation still lines up with the file on a later launch.
export function makeAnnotation(file, aIdx, bIdx, text, digest = null) {
  const startIdx = Math.min(aIdx, bIdx);
  const endIdx = Math.max(aIdx, bIdx);
  return { id: nextId++, file, startIdx, endIdx, text, digest };
}

// After restoring persisted annotations, advance the id counter past them so a
// newly created annotation can't reuse a restored one's id (which would collide
// as a React key and confuse edit/delete-by-id).
export function reserveAnnotationIds(annotations) {
  for (const a of annotations) if (a && a.id >= nextId) nextId = a.id + 1;
}

// Does an annotation cover this line index of this file path?
export function coversLine(ann, file, idx) {
  return ann.file === file && idx >= ann.startIdx && idx <= ann.endIdx;
}

// The annotation anchored on a given line, if any (first match wins).
export function annotationAt(annotations, file, idx) {
  return annotations.find((a) => coversLine(a, file, idx)) || null;
}

// A short "file:line" or "file:start-end" label for one annotation, using real
// file line numbers (new-side preferred, old-side for pure deletions).
export function annotationLabel(ann, files) {
  const file = files.find((f) => f.path === ann.file);
  if (!file) return ann.file;
  const [lo, hi] = lineNumberSpan(file, ann.startIdx, ann.endIdx);
  const loc = lo == null ? `${ann.startIdx}` : lo === hi ? `${lo}` : `${lo}-${hi}`;
  return `${ann.file}:${loc}`;
}

// The real-file line-number span for an index range: the first and last numbers
// we can attribute to actual file lines. Prefers the new side (newNum); for
// deleted lines there is no new number, so it falls back to the old side.
function lineNumberSpan(file, startIdx, endIdx) {
  let lo = null;
  let hi = null;
  for (let i = startIdx; i <= endIdx && i < file.lines.length; i++) {
    const n = file.lines[i].newNum ?? file.lines[i].oldNum;
    if (n == null) continue; // hunk header
    if (lo == null) lo = n;
    hi = n;
  }
  return [lo, hi];
}

// Render the annotated lines as a fenced snippet with a diff-style marker and
// the real line number on each row, so the request is self-contained.
function snippet(file, startIdx, endIdx) {
  const rows = [];
  for (let i = startIdx; i <= endIdx && i < file.lines.length; i++) {
    const l = file.lines[i];
    if (l.type === "hunk") continue;
    const sign = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
    const num = l.newNum ?? l.oldNum ?? "";
    rows.push(`${String(num).padStart(5)} ${sign} ${l.content}`);
  }
  return rows.join("\n");
}

// Assemble every annotation into a single change-request document, grouped by
// file and ordered top-to-bottom within each file. `source` labels what diff
// was under review. Returns markdown ready to hand to Claude Code.
export function buildChangeRequest(annotations, files, source) {
  const withText = annotations.filter((a) => a.text.trim());
  const header =
    "# Change requests from a diff review\n\n" +
    `These are review comments on the diff \`${source}\`. Each is anchored to ` +
    "specific lines (real file line numbers shown in the snippet). Please apply " +
    "the requested changes.\n";

  if (withText.length === 0) {
    return header + "\n_(no annotations)_\n";
  }

  const byFile = new Map();
  for (const a of withText) {
    if (!byFile.has(a.file)) byFile.set(a.file, []);
    byFile.get(a.file).push(a);
  }

  const sections = [];
  for (const [path, anns] of byFile) {
    const file = files.find((f) => f.path === path);
    anns.sort((x, y) => x.startIdx - y.startIdx);
    const blocks = anns.map((a) => {
      const [lo, hi] = file ? lineNumberSpan(file, a.startIdx, a.endIdx) : [null, null];
      const loc = lo == null ? "" : lo === hi ? ` (line ${lo})` : ` (lines ${lo}-${hi})`;
      const code = file ? snippet(file, a.startIdx, a.endIdx) : "";
      const fence = code ? `\n\`\`\`\n${code}\n\`\`\`\n` : "\n";
      return `### Request${loc}${fence}\n${a.text.trim()}\n`;
    });
    sections.push(`## ${path}\n\n${blocks.join("\n")}`);
  }

  return `${header}\n${sections.join("\n")}`;
}
