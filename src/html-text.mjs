// GitHub prose → plain text.
//
// PR bodies and comments are markdown, but GitHub also accepts raw HTML and
// plenty of writers (and every bot) use it. A dependabot description is almost
// entirely `<details>`, `<blockquote>`, `<ul>`, `<a href>` — rendering that as
// literal source is unreadable, which is what the viewer's overview used to do.
//
// This isn't an HTML parser and doesn't want to be. It does the handful of
// things that make real PR text legible in a terminal:
//
//   * drops HTML comments outright (they're invisible on github.com too, and
//     PR templates are full of them)
//   * collapses `<details>` to a one-line marker — GitHub renders them
//     collapsed by default, so showing the contents is *less* faithful, not more
//   * turns block tags into line breaks and `<li>` into bullets, so structure
//     survives as whitespace
//   * unwraps `<a>` and `<code>` to their text, drops every other tag
//   * decodes the entities that actually turn up, including the zero-width
//     space GitHub injects into `@`-mentions to stop them notifying people

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", bull: "•", middot: "·",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", times: "×", copy: "©",
};

export function decodeEntities(s) {
  return String(s || "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      // Zero-width characters (GitHub's un-notify trick) would render as boxes.
      if (code === 0x200b || code === 0xfeff || code === 0x200c || code === 0x200d) return "";
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const hit = ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

// The text of a `<details>` block's `<summary>`, or a generic label.
function summaryOf(block) {
  const m = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(block);
  const text = m ? stripTags(m[1]).replace(/\s+/g, " ").trim() : "";
  return text || "details";
}

// Fenced code is pulled out before any rewriting and put back at the end.
// The marker is delimited by a control character rather than padded with
// spaces: the whitespace tidy-up strips trailing spaces, which would eat the
// padding and leave the marker unmatched — losing the fence instead of
// restoring it.
const SENTINEL = "\u0000";
const FENCE_RE = /\u0000(\d+)\u0000/g;

function stripTags(s) {
  return s.replace(/<[^>]*>/g, "");
}

export function htmlToText(input) {
  let s = String(input || "").replace(/\r/g, "");

  // Fenced code is literal — pull it out so nothing below rewrites it, and put
  // it back at the end.
  const fences = [];
  s = s.replace(/```[\s\S]*?```/g, (block) => {
    fences.push(block);
    return SENTINEL + (fences.length - 1) + SENTINEL;
  });

  s = s.replace(/<!--[\s\S]*?-->/g, "");

  // Collapse each `<details>` to its summary. Innermost first, so nested blocks
  // don't leave stray tags behind.
  for (let i = 0; i < 5; i++) {
    const next = s.replace(
      /<details[^>]*>((?:(?!<details[\s\S])[\s\S])*?)<\/details>/gi,
      (block) => `\n▸ ${summaryOf(block)} (collapsed)\n`,
    );
    if (next === s) break;
    s = next;
  }

  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr|blockquote|pre|table|section)>/gi, "\n")
    .replace(/<(p|div|h[1-6]|tr|blockquote|pre|table|section)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<\/?(ul|ol)[^>]*>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n")
    // Keep the visible text of links and inline code; drop the markup.
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<\/?(strong|b)>/gi, "**")
    .replace(/<\/?(em|i)>/gi, "*")
    .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, "[image: $1]")
    .replace(/<img\b[^>]*>/gi, "[image]");

  s = stripTags(s);
  s = decodeEntities(s);

  // Whitespace tidy-up: trailing blanks, runs of blank lines, and the empty
  // "``" left where an inline <code> wrapped nothing.
  s = s
    .replace(/``/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return s.replace(FENCE_RE, (_, i) => fences[Number(i)] ?? "");
}

// One line of plain text, for a list where each entry gets a single row.
export function oneLine(input, max = 0) {
  const s = htmlToText(input).replace(/\s+/g, " ").trim();
  if (!max || s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}
