// Cross-session persistence for the reviewer's own work: the annotations you've
// written and the AI-review findings collected for this diff. Both anchor to
// line indices in a specific parse of a specific file, so an item is only
// meaningful while that file's diff is byte-for-byte unchanged. Each item carries
// the digest of its file captured at the moment it was anchored (see
// makeAnnotation / makeFindings), and `validAgainst` drops any item whose file
// has since changed or vanished — a changed file's stale anchors would silently
// point at the wrong code.
//
// Storage lives under the global, per-repo/branch dir (see paths.mjs), alongside
// the AI cache, so nothing is written into the repo you're reviewing. Keyed by
// branch, so each branch keeps its own review state.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { orbitDir } from "./paths.mjs";
import { fileDigest } from "./ai/cache.mjs";

const VERSION = 2;
const ANNOTATIONS_PATH = `${orbitDir()}/annotations.json`;
const FINDINGS_PATH = `${orbitDir()}/findings.json`;

export function saveAnnotations(annotations) {
  write(ANNOTATIONS_PATH, annotations);
}
export function loadAnnotations(files) {
  return validAgainst(read(ANNOTATIONS_PATH), files);
}
export function saveFindings(findings) {
  write(FINDINGS_PATH, findings);
}
export function loadFindings(files) {
  return validAgainst(read(FINDINGS_PATH), files);
}

// Keep only items whose file is still present and byte-for-byte identical to when
// the item was anchored (each item carries its file's digest from that moment).
// Also used when the diff reloads mid-session, to prune items on edited files.
export function validAgainst(items, files) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const cache = new Map();
  const digestOf = (p) => {
    if (cache.has(p)) return cache.get(p);
    const f = byPath.get(p);
    const d = f ? fileDigest(f) : null;
    cache.set(p, d);
    return d;
  };
  return items.filter((it) => it && it.file && it.digest && digestOf(it.file) === it.digest);
}

function write(path, items) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: VERSION, items }));
  } catch {
    // Best-effort: an unwritable dir shouldn't break the session.
  }
}

function read(path) {
  try {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    if (!payload || payload.version !== VERSION || !Array.isArray(payload.items)) return [];
    return payload.items;
  } catch {
    return []; // absent or unreadable — start clean
  }
}
