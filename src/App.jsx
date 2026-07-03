import React, { useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Sidebar } from "./Sidebar.jsx";
import { DiffPanel } from "./DiffPanel.jsx";
import { useDimensions } from "./useDimensions.mjs";

// Modes: "normal" | "files" (filter sidebar) | "lines" (find in changed lines)
export function App({ files, source }) {
  const { exit } = useApp();
  const { cols, rows } = useDimensions();

  const [mode, setMode] = useState("normal");
  const [focus, setFocus] = useState("sidebar");
  const [fileQuery, setFileQuery] = useState("");
  const [lineQuery, setLineQuery] = useState("");
  const [scope, setScope] = useState("all"); // "all" whole diff · "file" focused file
  const [selected, setSelected] = useState(0);
  const [scroll, setScroll] = useState(0); // first visible diff line
  const [cursor, setCursor] = useState(0); // current diff line (the indicator)
  const [matchIdx, setMatchIdx] = useState(0);
  const [sideW, setSideW] = useState(null); // null = responsive default
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const filtered = useMemo(() => filterFiles(files, fileQuery), [files, fileQuery]);
  const selectedFile = filtered[Math.min(selected, filtered.length - 1)];

  // Every line hit for the active query. Scope "all" searches the whole diff;
  // "file" restricts to the focused file. Both cover context as well as changes.
  const matches = useMemo(
    () => findLines(filtered, lineQuery, scope, selected),
    [filtered, lineQuery, scope, selected],
  );
  const matchLines = useMemo(() => {
    const set = new Set();
    for (const m of matches) if (m.fi === selected) set.add(m.li);
    return set;
  }, [matches, selected]);

  // The one match `n`/`N` currently points at — highlighted distinctly from the
  // rest so you can see which hit you're focused on. Null when it's off-screen
  // in another file.
  const current = matches.length
    ? matches[((matchIdx % matches.length) + matches.length) % matches.length]
    : null;
  const currentLine = current && current.fi === selected ? current.li : null;

  // Sidebar width: a responsive default until the user adjusts it with [ / ],
  // then their value, always clamped so the diff keeps room even on resize.
  const sideMax = Math.max(20, cols - 24);
  const sidebarW = sidebarOpen ? clamp(sideW ?? Math.floor(cols * 0.32), 16, sideMax) : 0;
  const diffW = cols - sidebarW;
  // Panels + status bar total rows-1, leaving one spare terminal row. Rendering
  // the *full* height makes the terminal scroll each frame, which drops Ink out
  // of its in-place-update path into a full erase/redraw — the scroll flicker.
  const bodyH = Math.max(3, rows - 2);
  const inner = Math.max(1, bodyH - 3); // visible diff rows (border + title)
  const page = Math.max(1, inner - 2);
  const total = selectedFile ? selectedFile.lines.length : 0;

  const selectFile = (i) => {
    const next = clamp(i, 0, Math.max(0, filtered.length - 1));
    setSelected(next);
    setScroll(0);
    setCursor(0);
  };

  // Move the current-line indicator and let the viewport follow it, keeping a
  // few lines of margin above/below so context stays visible (editor-style).
  const moveCursor = (nextRaw) => {
    if (total === 0) return;
    const next = clamp(nextRaw, 0, total - 1);
    setCursor(next);
    setScroll((s) => followScroll(s, next, inner, total));
  };

  const jumpToMatch = (i) => {
    if (matches.length === 0) return;
    const wrapped = (i + matches.length) % matches.length;
    setMatchIdx(wrapped);
    const m = matches[wrapped];
    const t = filtered[m.fi] ? filtered[m.fi].lines.length : 0;
    setSelected(m.fi);
    setCursor(m.li);
    setScroll(clamp(m.li - Math.floor(inner / 2), 0, Math.max(0, t - inner)));
    setFocus("diff");
  };

  useInput((input, key) => {
    // ---- Search input handling (files / lines) ----
    if (mode !== "normal") {
      const isFiles = mode === "files";
      const q = isFiles ? fileQuery : lineQuery;
      const setQ = isFiles ? setFileQuery : setLineQuery;

      if (key.escape) {
        setQ("");
        setMode("normal");
        return;
      }
      if (key.tab) {
        // Toggle line-search scope between the whole diff and the focused file.
        if (!isFiles) setScope((s) => (s === "all" ? "file" : "all"));
        return;
      }
      if (key.return) {
        if (!isFiles) jumpToMatch(0);
        setMode("normal");
        return;
      }
      if (key.backspace || key.delete) {
        setQ(q.slice(0, -1));
        if (isFiles) setSelected(0);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setQ(q + input);
        if (isFiles) setSelected(0);
      }
      return;
    }

    // ---- Normal mode ----
    if (input === "q" || (key.ctrl && input === "c")) return exit();
    // Esc clears an applied search/filter without reopening it — keeping you on
    // the file you're viewing as the sidebar un-narrows.
    if (key.escape) {
      if (!fileQuery && !lineQuery) return;
      const keep = selectedFile;
      setFileQuery("");
      setLineQuery("");
      const idx = keep ? files.indexOf(keep) : -1;
      if (idx >= 0) setSelected(idx);
      return;
    }
    if (key.tab) return setFocus((f) => (f === "sidebar" ? "diff" : "sidebar"));
    if (input === "s") {
      const next = !sidebarOpen;
      setSidebarOpen(next);
      if (!next) setFocus("diff"); // nowhere to focus in a hidden rail
      return;
    }
    if (input === "[") return setSideW(clamp(sidebarW - 2, 16, sideMax));
    if (input === "]") return setSideW(clamp(sidebarW + 2, 16, sideMax));
    if (input === "/") {
      setSidebarOpen(true); // filtering files implies you want to see them
      setFileQuery("");
      setSelected(0);
      return setMode("files");
    }
    if (input === "f") {
      setLineQuery("");
      return setMode("lines");
    }
    if (input === "n") return jumpToMatch(matchIdx + 1);
    if (input === "N") return jumpToMatch(matchIdx - 1);

    // Diff paging works from either pane, so you can skim a file's diff while
    // keeping the file rail focused for quick file switches.
    if (key.pageUp || (key.ctrl && input === "u")) return moveCursor(cursor - page);
    if (key.pageDown || (key.ctrl && input === "d")) return moveCursor(cursor + page);
    if (input === "g") return moveCursor(0);
    if (input === "G") return moveCursor(total - 1);

    // Line-granular ↑↓/jk are pane-sensitive: move files vs. move the cursor.
    if (focus === "sidebar") {
      if (key.upArrow || input === "k") return selectFile(selected - 1);
      if (key.downArrow || input === "j") return selectFile(selected + 1);
      if (key.return) return setFocus("diff");
    } else {
      if (key.upArrow || input === "k") return moveCursor(cursor - 1);
      if (key.downArrow || input === "j") return moveCursor(cursor + 1);
    }
  });

  return (
    <Box flexDirection="column" width={cols} height={rows - 1}>
      <Box>
        {sidebarOpen && (
          <Sidebar
            files={filtered}
            selected={selected}
            focused={focus === "sidebar" && mode !== "lines"}
            width={sidebarW}
            height={bodyH}
          />
        )}
        <DiffPanel
          file={selectedFile}
          scroll={scroll}
          focused={focus === "diff" && mode !== "files"}
          width={diffW}
          height={bodyH}
          query={lineQuery}
          matchLines={matchLines}
          currentLine={currentLine}
          cursor={cursor}
        />
      </Box>
      <StatusBar
        mode={mode}
        source={source}
        fileQuery={fileQuery}
        lineQuery={lineQuery}
        scope={scope}
        matches={matches}
        matchIdx={matchIdx}
        focus={focus}
        line={cursor + 1}
        lineTotal={total}
      />
    </Box>
  );
}

function StatusBar({ mode, source, fileQuery, lineQuery, scope, matches, matchIdx, focus, line, lineTotal }) {
  if (mode === "files") {
    return <Bar><Text color="cyan">filter files</Text> <Text>{fileQuery}</Text><Text inverse> </Text><Dim> · enter to apply · esc to clear</Dim></Bar>;
  }
  if (mode === "lines") {
    const count = matches.length ? `${matches.length} matches` : "no matches";
    const where = scope === "all" ? "whole diff" : "this file";
    return <Bar><Text color="magenta">find</Text> <Text>{lineQuery}</Text><Text inverse> </Text><Dim> · </Dim><Text color="yellow">{where}</Text><Dim> (tab) · {count} · enter jump · esc cancel</Dim></Bar>;
  }
  const nav = matches.length
    ? ` · match ${((matchIdx % matches.length) + 1)}/${matches.length} (n/N)`
    : "";
  return (
    <Bar>
      <Text color="cyan">L{line}</Text><Dim>/{lineTotal} · </Dim>
      <Dim>{focus === "sidebar" ? "▸files" : "▸diff"} · tab · ↑↓/jk move · </Dim>
      <Text color="cyan">s</Text><Dim> panel · </Dim>
      <Text color="cyan">[ ]</Text><Dim> width · </Dim>
      <Text color="cyan">/</Text><Dim> files · </Dim>
      <Text color="magenta">f</Text><Dim> find · ^u/^d g/G scroll · q quit{nav} · {source}</Dim>
    </Bar>
  );
}

const Bar = ({ children }) => (
  <Box height={1}>
    <Text wrap="truncate"> {children}</Text>
  </Box>
);
const Dim = ({ children }) => <Text dimColor>{children}</Text>;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(n, hi));
}

// Nudge the viewport so `cursor` stays visible with a small margin, moving as
// little as possible so the diff doesn't jump around under a 1-line step.
function followScroll(scroll, cursor, inner, total) {
  const off = Math.min(3, Math.floor((inner - 1) / 2));
  let s = scroll;
  if (cursor < s + off) s = cursor - off;
  else if (cursor > s + inner - 1 - off) s = cursor - (inner - 1) + off;
  return clamp(s, 0, Math.max(0, total - inner));
}

// Case-insensitive subsequence match on the path (fuzzy, order-preserving).
function filterFiles(files, query) {
  const q = query.trim().toLowerCase();
  if (!q) return files;
  return files.filter((f) => subseq(q, f.name.toLowerCase()));
}

function subseq(needle, hay) {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

// Every diff line containing the query, as {fi, li} into `files`. Scope "file"
// limits the scan to `selected`; "all" scans the whole diff. Context lines
// count too, so this searches the full diff contents, not just changes.
function findLines(files, query, scope, selected) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  const scan = (f, fi) => {
    f.lines.forEach((l, li) => {
      if (l.type !== "hunk" && l.content.toLowerCase().includes(q)) {
        out.push({ fi, li });
      }
    });
  };
  if (scope === "file") {
    const f = files[selected];
    if (f) scan(f, selected);
  } else {
    files.forEach(scan);
  }
  return out;
}
