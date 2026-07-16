import React from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import { highlightLine } from "./highlight.mjs";
import { wrapRows, lineRows, maxScroll, contentWidth as lineContentW, prefixWidth } from "./wrap.mjs";

const LINE_STYLE = {
  add: { sign: "+", color: "green", bg: undefined },
  del: { sign: "-", color: "red", bg: undefined },
  context: { sign: " ", color: undefined, bg: undefined },
  hunk: { sign: " ", color: "cyan", bg: undefined },
};

const pad = (used, width) => " ".repeat(Math.max(0, width - used));

// Right pane: the diff of the selected file with a scroll window. Renders a
// unified diff by default, or a side-by-side view when `split` is set (old on
// the left, new on the right, context mirrored). Either way each visible row
// still maps 1:1 to a `file.lines` index, so the cursor, scroll, annotations,
// search and selection all key off the same indices in both modes.
// `scroll` is the first visible line; `cursor` is the current line (marked with
// ▸); `matchLines` are search hits and `currentLine` is the focused one.
// `activeBg`/`selectBg` are subtle off-shades of the terminal background (see
// theme.mjs). A parent Text's background shows through its child fg colors (fg
// resets don't clear it), so the whole line — syntax-highlighted content and
// all — sits on the band, filled to the edge by a trailing pad.
export function DiffPanel({ file, scroll, cursor, focused, width, height, query, matchLines, currentLine, annotatedLines, selectionRange, activeBg, selectBg, addBg, delBg, split, wrap }) {
  const inner = Math.max(1, height - 3); // border (2) + title (1)

  if (!file) {
    return (
      <Panel focused={focused} width={width} height={height} title="Diff">
        <Text dimColor>no file selected</Text>
      </Panel>
    );
  }

  const total = file.lines.length;
  const numW = String(Math.max(1, total)).length;
  const rowW = Math.max(1, width - 4); // content width inside border + padding
  // Split view: marker (1) + two equal columns + a 1-char divider between them.
  const colW = Math.max(4, Math.floor((rowW - 2) / 2));

  // Wrapping only applies to the unified view (two-column wrapping is a separate
  // problem). With it on, one line can span several rows so the viewport becomes
  // variable-height — see renderWrapped and wrap.mjs.
  const wrapOn = wrap && !split;
  if (wrapOn) {
    return renderWrapped({
      file, scroll, cursor, focused, width, height, inner, total, numW, rowW,
      query, matchLines, currentLine, annotatedLines, selectionRange,
      activeBg, selectBg, addBg, delBg,
    });
  }

  const start = Math.max(0, Math.min(scroll, Math.max(0, total - inner)));
  const visible = file.lines.slice(start, start + inner);

  const title = `${file.name}  (${start + 1}-${Math.min(start + inner, total)}/${total})${split ? "  ⇆" : ""}`;

  return (
    <Panel focused={focused} width={width} height={height} title={title}>
      {visible.map((l, i) => {
        const idx = start + i;
        const onCursor = idx === cursor;
        const inSel = selectionRange && idx >= selectionRange.lo && idx <= selectionRange.hi;
        const annotated = annotatedLines && annotatedLines.has(idx);
        // Every added/removed row gets a subtle green/red background band so the
        // diff reads at a glance; the cursor and selection bands take priority
        // when they land on a row.
        const typeBg = l.type === "add" ? addBg : l.type === "del" ? delBg : undefined;
        const bg = onCursor ? activeBg : inSel ? selectBg : typeBg;
        const fill = bg !== undefined; // pad to width so the band spans the row
        // Marker column: the cursor (▸) wins the cell; otherwise a ● flags an
        // annotated line. An annotated line tints the marker green either way.
        const marker = onCursor ? "▸" : annotated ? "●" : " ";
        const markerColor = annotated ? "green" : "cyan";
        const st = LINE_STYLE[l.type] || LINE_STYLE.context;

        if (l.type === "hunk") {
          return (
            <Text key={idx} wrap="truncate" backgroundColor={bg}>
              <Text color={markerColor} bold>{marker}</Text>
              <Text color="cyan">{l.content}</Text>
              {fill && <Text>{pad(1 + [...l.content].length, rowW)}</Text>}
            </Text>
          );
        }

        const isMatch = matchLines && matchLines.has(idx);
        const isCurrent = idx === currentLine;

        // Side-by-side: the old text goes in the left column, the new text in
        // the right. Context shows in both; a deletion blanks the right cell and
        // an addition blanks the left, so changes read as two columns.
        if (split) {
          const leftLine = l.type === "add" ? null : l;
          const rightLine = l.type === "del" ? null : l;
          return (
            <Text key={idx} wrap="truncate" backgroundColor={bg}>
              <Text color={markerColor} bold>{marker}</Text>
              <SplitCell l={leftLine} side="left" numW={numW} colW={colW} onCursor={onCursor} />
              <Text dimColor>│</Text>
              <SplitCell l={rightLine} side="right" numW={numW} colW={colW} onCursor={onCursor} />
              {fill && <Text>{pad(1 + colW + 1 + colW, rowW)}</Text>}
            </Text>
          );
        }

        const gutter =
          `${l.oldNum ?? ""}`.padStart(numW) + " " + `${l.newNum ?? ""}`.padStart(numW);
        const body = l.content.length > 0 ? l.content : " ";
        // On a matched line we highlight just the matched substring(s) — cyan on
        // the focused match, yellow elsewhere — with the rest in its base add/del
        // color. Non-matches get full syntax highlighting. Either way, the active
        // line's background shows through and a trailing pad fills it to the edge.
        const hl = isMatch ? null : highlightLine(l, file.lang);
        const used = 1 + gutter.length + 1 + 1 + [...body].length; // marker+gutter+sp+sign+body
        return (
          <Text key={idx} wrap="truncate" backgroundColor={bg}>
            <Text color={markerColor} bold>{marker}</Text>
            <Text dimColor={!onCursor} color={onCursor ? "cyan" : undefined}>{gutter} </Text>
            <Text color={st.color}>{st.sign}</Text>
            {isMatch ? (
              splitMatches(body, query).map((seg, k) =>
                seg.hit ? (
                  <Text key={k} backgroundColor={isCurrent ? "cyan" : "yellow"} color="black">
                    {seg.text}
                  </Text>
                ) : (
                  <Text key={k} color={st.color}>{seg.text}</Text>
                ),
              )
            ) : hl != null ? (
              <Text>{hl}</Text>
            ) : (
              <Text color={st.color}>{body}</Text>
            )}
            {fill && <Text>{pad(used, rowW)}</Text>}
          </Text>
        );
      })}
    </Panel>
  );
}

// Unified diff with soft-wrapping. `scroll` is still the top *logical* line — we
// scroll by whole lines — and from there we emit each line's wrapped rows until
// the row budget (`inner`) is spent, capping the last line so the panel never
// draws past its fixed height. A line's ▸ marker, gutter and sign sit on its
// first row; continuation rows blank that prefix so wrapped text stays aligned
// under the content column, and one background band spans all of a line's rows.
function renderWrapped({ file, scroll, cursor, focused, width, height, inner, total, numW, rowW, query, matchLines, currentLine, annotatedLines, selectionRange, activeBg, selectBg, addBg, delBg }) {
  const start = Math.max(0, Math.min(scroll, maxScroll(file.lines, inner, rowW, numW)));
  const contentW = lineContentW(rowW, numW);
  const preW = prefixWidth(numW);
  const gutterW = 2 * numW + 1;

  const out = [];
  let used = 0;
  let last = start;
  for (let idx = start; idx < total && used < inner; idx++) {
    const l = file.lines[idx];
    last = idx;
    const onCursor = idx === cursor;
    const inSel = selectionRange && idx >= selectionRange.lo && idx <= selectionRange.hi;
    const annotated = annotatedLines && annotatedLines.has(idx);
    const typeBg = l.type === "add" ? addBg : l.type === "del" ? delBg : undefined;
    const bg = onCursor ? activeBg : inSel ? selectBg : typeBg;
    const fill = bg !== undefined;
    const marker = onCursor ? "▸" : annotated ? "●" : " ";
    const markerColor = annotated ? "green" : "cyan";
    const st = LINE_STYLE[l.type] || LINE_STYLE.context;
    const isMatch = matchLines && matchLines.has(idx);
    const isCurrent = idx === currentLine;

    // Wrap this line's rendered text into visual rows. Highlighted content wraps
    // as an ANSI string (colors carry across the break); a match line wraps its
    // plain body so we can re-mark the query per row. Cap to the remaining
    // budget so a very tall line can't overflow the panel.
    const isHunk = l.type === "hunk";
    const hl = isHunk || isMatch ? null : highlightLine(l, file.lang);
    const body = l.content.length > 0 ? l.content : " ";
    let rows = isHunk
      ? wrapRows(l.content, Math.max(1, rowW - 1))
      : wrapRows(hl != null ? hl : body, contentW);
    const room = inner - used;
    if (rows.length > room) rows = rows.slice(0, room);
    used += rows.length;

    rows.forEach((rowStr, r) => {
      const first = r === 0;
      if (isHunk) {
        out.push(
          <Text key={`${idx}-${r}`} wrap="truncate" backgroundColor={bg}>
            <Text color={markerColor} bold>{first ? marker : " "}</Text>
            <Text color="cyan">{rowStr}</Text>
            {fill && <Text>{pad(1 + stringWidth(rowStr), rowW)}</Text>}
          </Text>,
        );
        return;
      }
      const gutter = first
        ? `${l.oldNum ?? ""}`.padStart(numW) + " " + `${l.newNum ?? ""}`.padStart(numW)
        : " ".repeat(gutterW);
      out.push(
        <Text key={`${idx}-${r}`} wrap="truncate" backgroundColor={bg}>
          <Text color={markerColor} bold>{first ? marker : " "}</Text>
          <Text dimColor={!onCursor} color={onCursor ? "cyan" : undefined}>{gutter} </Text>
          <Text color={st.color}>{first ? st.sign : " "}</Text>
          {isMatch ? (
            splitMatches(rowStr, query).map((seg, k) =>
              seg.hit ? (
                <Text key={k} backgroundColor={isCurrent ? "cyan" : "yellow"} color="black">{seg.text}</Text>
              ) : (
                <Text key={k} color={st.color}>{seg.text}</Text>
              ),
            )
          ) : hl != null ? (
            <Text>{rowStr}</Text>
          ) : (
            <Text color={st.color}>{rowStr}</Text>
          )}
          {fill && <Text>{pad(preW + stringWidth(rowStr), rowW)}</Text>}
        </Text>,
      );
    });
  }

  const shown = last - start + 1;
  const title = `${file.name}  (${start + 1}-${Math.min(start + shown, total)}/${total})  ↩`;
  return (
    <Panel focused={focused} width={width} height={height} title={title}>
      {out}
    </Panel>
  );
}

// One column of a side-by-side row. Renders `${num} ${sign} ${content}` for the
// requested side (old numbers/`-` on the left, new numbers/`+` on the right),
// truncated and padded to exactly `colW` so the divider and right column line
// up. A null line is an empty cell (a blank the row band shows through).
function SplitCell({ l, side, numW, colW, onCursor }) {
  if (!l) return <Text>{" ".repeat(colW)}</Text>;
  const num = side === "left" ? l.oldNum : l.newNum;
  const sign = l.type === "del" ? "-" : l.type === "add" ? "+" : " ";
  const color = l.type === "add" ? "green" : l.type === "del" ? "red" : undefined;
  const numStr = `${num ?? ""}`.padStart(numW);
  const bodyW = Math.max(0, colW - numW - 3); // num + space + sign + space
  const chars = [...(l.content || "")];
  const body = chars.length > bodyW ? chars.slice(0, bodyW).join("") : l.content || "";
  const used = numW + 3 + [...body].length;
  return (
    <Text>
      <Text dimColor={!onCursor} color={onCursor ? "cyan" : undefined}>{numStr} </Text>
      <Text color={color}>{sign} {body}</Text>
      <Text>{" ".repeat(Math.max(0, colW - used))}</Text>
    </Text>
  );
}

// Split a line into alternating non-match / match segments for the active
// query. Case-insensitive and literal (indexOf, not regex), trimmed to match
// how findLines() decides a line is a hit.
function splitMatches(text, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const out = [];
  let i = 0;
  while (i < text.length) {
    const at = lower.indexOf(q, i);
    if (at === -1) {
      out.push({ text: text.slice(i), hit: false });
      break;
    }
    if (at > i) out.push({ text: text.slice(i, at), hit: false });
    out.push({ text: text.slice(at, at + q.length), hit: true });
    i = at + q.length;
  }
  return out.length ? out : [{ text, hit: false }];
}

function Panel({ focused, width, height, title, children }) {
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor={focused ? "cyan" : "gray"}
      paddingX={1}
    >
      <Text bold wrap="truncate">
        {title}
      </Text>
      {children}
    </Box>
  );
}
