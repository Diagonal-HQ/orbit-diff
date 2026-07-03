import { highlight, supportsLanguage } from "cli-highlight";

// Map file extensions to highlight.js language names.
const EXT_LANG = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  json: "json", jsonc: "json",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp",
  cs: "csharp", php: "php", swift: "swift", kt: "kotlin", scala: "scala",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  css: "css", scss: "scss", less: "less",
  html: "xml", xml: "xml", vue: "xml", svelte: "xml",
  md: "markdown", markdown: "markdown",
  sql: "sql", graphql: "graphql", gql: "graphql", dockerfile: "dockerfile",
};

// Resolve the highlight.js language for a path, or null if unsupported.
export function langFor(path) {
  if (!path) return null;
  const base = path.split("/").pop().toLowerCase();
  const ext = base.includes(".") ? base.split(".").pop() : base;
  const lang = EXT_LANG[ext];
  return lang && supportsLanguage(lang) ? lang : null;
}

// Highlight one line, memoized on the line object so scrolling doesn't
// re-tokenize. Per-line highlighting loses multi-line context (block comments,
// template strings) but keeps the diff's non-contiguous hunks tractable.
export function highlightLine(line, lang) {
  if (line.__hl !== undefined) return line.__hl;
  if (!lang || line.content.length === 0) {
    line.__hl = null;
    return null;
  }
  try {
    line.__hl = highlight(line.content, { language: lang, ignoreIllegals: true });
  } catch {
    line.__hl = null;
  }
  return line.__hl;
}
