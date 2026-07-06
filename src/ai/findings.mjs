// AI review findings: the in-memory model shown in the review panel, plus the
// bridge that promotes a finding into a regular annotation so it flows through the
// existing submit pipelines (GitHub PR, apply via Claude Code, clipboard).

import { makeAnnotation } from "../annotations.mjs";
import { anchorFinding } from "./review.mjs";
import { fileDigest } from "./cache.mjs";

let nextId = 1;

// Build display-ready findings for one file from the model's parsed output,
// anchoring each to a line-index range. Unanchored findings are kept (still worth
// reading) but can't be jumped to or promoted. Each carries the file's digest at
// review time so persistence can tell whether it still lines up on a later launch.
export function makeFindings(file, raw) {
  const digest = fileDigest(file);
  return raw.map((f) => {
    const anchor = anchorFinding(file, f);
    return {
      id: nextId++,
      file: file.path,
      title: f.title,
      body: f.body,
      severity: f.severity,
      side: f.side,
      lineStart: f.lineStart,
      lineEnd: f.lineEnd,
      startIdx: anchor ? anchor.startIdx : null,
      endIdx: anchor ? anchor.endIdx : null,
      anchored: !!anchor,
      promoted: false,
      digest,
    };
  });
}

// After restoring persisted findings, advance the id counter past them so a
// freshly reviewed finding can't reuse a restored one's id.
export function reserveFindingIds(findings) {
  for (const f of findings) if (f && f.id >= nextId) nextId = f.id + 1;
}

// Turn a finding into an annotation anchored to the same diff lines. Returns the
// annotation, or null if the finding never anchored. `file` is the parsed file
// object (needed by makeAnnotation for the path); it must match finding.file.
export function findingToAnnotation(finding, file) {
  if (!finding.anchored || file.path !== finding.file) return null;
  const text = finding.body ? `${finding.title}\n\n${finding.body}` : finding.title;
  // Reuse the finding's anchor-time digest so the promoted note validates the same.
  return makeAnnotation(finding.file, finding.startIdx, finding.endIdx, text, finding.digest);
}

// Ink color for a severity badge; also used to tint the finding row.
export function severityColor(severity) {
  switch (severity) {
    case "high":
      return "red";
    case "medium":
      return "yellow";
    case "low":
      return "cyan";
    default:
      return "gray";
  }
}

// A short one-line location label for a finding (real file line numbers).
export function findingLoc(finding) {
  const { lineStart, lineEnd } = finding;
  if (lineStart == null) return finding.file;
  const loc = lineEnd == null || lineEnd === lineStart ? `${lineStart}` : `${lineStart}-${lineEnd}`;
  return `${finding.file}:${loc}`;
}
