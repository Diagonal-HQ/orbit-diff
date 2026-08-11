import { expect, test } from "bun:test";
import { htmlToText, oneLine, decodeEntities } from "./html-text.mjs";

// PR prose is markdown *plus* arbitrary HTML. These cover the shapes that
// actually turn up — the dependabot description being the worst of them.

test("plain markdown passes through untouched", () => {
  expect(htmlToText("## Heading\n\n- one\n- two")).toBe("## Heading\n\n- one\n- two");
});

test("HTML comments vanish — PR templates are full of them", () => {
  expect(htmlToText("before<!-- reviewers: please ignore -->after")).toBe("beforeafter");
  expect(htmlToText("a\n<!--\nmulti\nline\n-->\nb")).toBe("a\n\nb");
});

// GitHub renders <details> collapsed, so showing the contents is less faithful
// than hiding them — and it's the bulk of a dependabot body.
test("a details block collapses to its summary", () => {
  const html = "<details>\n<summary>Release notes</summary>\n<p>lots and lots of text</p>\n</details>";
  const out = htmlToText(html);
  expect(out).toBe("▸ Release notes (collapsed)");
  expect(out).not.toContain("lots and lots");
});

test("a details block with no summary still collapses", () => {
  expect(htmlToText("<details><p>hidden</p></details>")).toBe("▸ details (collapsed)");
});

test("nested details collapse to the outer one", () => {
  const html = "<details><summary>Outer</summary><details><summary>Inner</summary>x</details></details>";
  expect(htmlToText(html)).toBe("▸ Outer (collapsed)");
});

test("block tags become line breaks and list items become bullets", () => {
  expect(htmlToText("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
  expect(htmlToText("<p>one</p><p>two</p>")).toBe("one\n\ntwo");
  expect(htmlToText("a<br>b")).toBe("a\nb");
});

test("links and inline code keep their text, lose their markup", () => {
  expect(htmlToText('<a href="https://x.test">the label</a>')).toBe("the label");
  expect(htmlToText("<code>npm test</code>")).toBe("`npm test`");
});

test("images become a short marker rather than a URL wall", () => {
  expect(htmlToText('<img src="https://x/y.png" alt="a chart">')).toBe("[image: a chart]");
  expect(htmlToText('<img src="https://x/y.png">')).toBe("[image]");
});

test("unknown tags are dropped but their text survives", () => {
  expect(htmlToText("<blockquote><h2>Title</h2>body</blockquote>")).toBe("Title\nbody");
  expect(htmlToText("<span data-x='1'>kept</span>")).toBe("kept");
});

test("entities decode, including the zero-width space in bot @-mentions", () => {
  expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot;")).toBe('a & b <c> "d"');
  expect(decodeEntities("@&#8203;dependabot")).toBe("@dependabot");
  expect(decodeEntities("&#x2014;")).toBe("—");
  // Anything we don't know is left as written rather than mangled.
  expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;");
});

// The markdown renderer treats fenced blocks as literal, so nothing in here may
// be rewritten on the way past.
test("fenced code is left completely alone", () => {
  const src = "before\n```\n<div>not html</div>\n&amp;\n```\nafter";
  expect(htmlToText(src)).toBe(src);
});

test("runs of blank lines collapse", () => {
  expect(htmlToText("a\n\n\n\n\nb")).toBe("a\n\nb");
});

test("a realistic dependabot body reduces to a few readable lines", () => {
  const body = [
    "Bumps [pkg](https://x/pkg) from 1.0 to 1.1.",
    "<details>",
    "<summary>Release notes</summary>",
    "<p><em>Sourced from <a href=\"https://x\">releases</a>.</em></p>",
    "<blockquote><h2>v1.1</h2><ul><li>a change by <a href=\"https://x\"><code>@​someone</code></a></li></ul></blockquote>",
    "</details>",
    "<details><summary>Commits</summary><ul><li>abc123 a commit</li></ul></details>",
    "",
    "Dependabot will resolve conflicts automatically.",
  ].join("\n");

  const out = htmlToText(body);
  expect(out.split("\n").filter((l) => l.trim()).length).toBe(4);
  expect(out).toContain("▸ Release notes (collapsed)");
  expect(out).toContain("▸ Commits (collapsed)");
  expect(out).not.toContain("<");
  expect(out).not.toContain("blockquote");
});

// ---- one-line excerpts ----

test("oneLine flattens to a single row and truncates", () => {
  expect(oneLine("first line\nsecond line")).toBe("first line second line");
  expect(oneLine("a".repeat(50), 10)).toBe("aaaaaaaaa…");
  expect(oneLine("<p>html <b>too</b></p>")).toBe("html **too**");
});

test("empty and nullish input is empty, not a crash", () => {
  for (const v of [null, undefined, ""]) {
    expect(htmlToText(v)).toBe("");
    expect(oneLine(v, 10)).toBe("");
  }
});
