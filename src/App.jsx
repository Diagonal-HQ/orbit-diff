import React, { useEffect, useMemo, useRef, useState } from "react";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Box, Text, useApp, useInput } from "ink";
import { changeRequestPath, tildeify } from "./paths.mjs";
import { Sidebar } from "./Sidebar.jsx";
import { DiffPanel } from "./DiffPanel.jsx";
import { ReviewPanel } from "./ReviewPanel.jsx";
import { AskPanel } from "./AskPanel.jsx";
import { useDimensions } from "./useDimensions.mjs";
import { copyViaOSC52 } from "./clipboard.mjs";
import { FALLBACK } from "./theme.mjs";
import { detectPR, submitAnnotations } from "./github.mjs";
import { findingToAnnotation } from "./ai/findings.mjs";
import {
  makeAnnotation,
  annotationAt,
  buildChangeRequest,
} from "./annotations.mjs";

// Modes: "normal" | "files" (filter sidebar) | "lines" (find in changed lines)
//        "comment" (type an annotation) | "submit" (choose where annotations go)
//        "review" (AI findings panel) | "ask" (ask the model a question)
export function App({ files: initialFiles, reloadDiff, source, handoff, activeBg = FALLBACK.activeBg, selectBg = FALLBACK.selectBg, addBg = FALLBACK.addBg, delBg = FALLBACK.delBg }) {
  const { exit } = useApp();
  const { cols, rows } = useDimensions();

  // The parsed diff, seeded from the prop. Held in state so the chat can edit the
  // working tree and we can reload it in place (see reloadAfterEdit).
  const [files, setFiles] = useState(initialFiles);
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

  // ---- Annotations (ephemeral, in-memory for this session) ----
  const [annotations, setAnnotations] = useState([]);
  const [selectAnchor, setSelectAnchor] = useState(null); // line idx or null (range start)
  const [commentDraft, setCommentDraft] = useState("");
  const [commentTarget, setCommentTarget] = useState(null); // {startIdx,endIdx,editingId}
  const [railSection, setRailSection] = useState("files"); // sidebar focus: "files" | "annotations"
  const [annSel, setAnnSel] = useState(0); // selected annotation index within the rail
  const [toast, setToast] = useState(null); // transient status message

  // ---- Submit target picker ----
  const [pr, setPr] = useState(null); // open PR for this branch, once detected
  const [submitSel, setSubmitSel] = useState(0); // highlighted picker row
  const [posting, setPosting] = useState(false); // a GitHub submit is in flight

  // ---- AI reviewer + Q&A ----
  const [findings, setFindings] = useState([]); // AI review findings across files
  const [reviewSel, setReviewSel] = useState(0); // highlighted finding in the panel
  const [reviewing, setReviewing] = useState(false); // a review pass is in flight
  const [reviewProgress, setReviewProgress] = useState({ done: 0, total: 0 });
  const [reviewError, setReviewError] = useState(null); // first error of the pass, shown in-panel
  const [askDraft, setAskDraft] = useState(""); // question currently being typed
  const [askMessages, setAskMessages] = useState([]); // chat transcript: {role, text}
  const [asking, setAsking] = useState(false); // an answer is streaming
  const aiRef = useRef(null); // memoized { config, orchestrator, preflight } once loaded
  const reviewToken = useRef(0); // guards stale async review callbacks
  const askToken = useRef(0); // guards stale async ask callbacks
  const askConvo = useRef(null); // live multi-turn Q&A session, or null

  // Look up the branch's PR once on mount so the picker can offer "post to PR"
  // only when one actually exists. Best-effort and off the critical path — a
  // missing `gh`, no PR, or a non-GitHub remote just leaves the option hidden.
  useEffect(() => {
    let live = true;
    detectPR().then((found) => {
      if (live) setPr(found);
    });
    return () => {
      live = false;
    };
  }, []);

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

  // Line indices of the focused file carrying an annotation (for gutter marks).
  const annotatedLines = useMemo(() => {
    const set = new Set();
    if (!selectedFile) return set;
    for (const a of annotations) {
      if (a.file !== selectedFile.path) continue;
      for (let i = a.startIdx; i <= a.endIdx; i++) set.add(i);
    }
    return set;
  }, [annotations, selectedFile]);

  // The live visual selection (anchor..cursor), or null when not selecting.
  const selectionRange =
    selectAnchor != null && selectedFile
      ? { lo: Math.min(selectAnchor, cursor), hi: Math.max(selectAnchor, cursor) }
      : null;

  // Real-file line label for the note editor's title (e.g. "lines 42–48").
  const commentLabel =
    commentTarget && selectedFile
      ? lineLabel(selectedFile, commentTarget.startIdx, commentTarget.endIdx)
      : "";

  // Which sidebar section the rail's cursor is in. Falls back to files whenever
  // there are no annotations, so a stale "annotations" section can't strand you.
  const activeSection = railSection === "annotations" && annotations.length > 0 ? "annotations" : "files";
  const annCursor = clamp(annSel, 0, Math.max(0, annotations.length - 1));

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
  // While typing a note, an editor takes over the left column so the diff on the
  // right stays visible. It reuses the rail's width when the rail is open (no
  // layout jump), else opens at a comfortable default with room to type.
  const editorW = clamp(sideW ?? Math.floor(cols * 0.34), 28, sideMax);
  // The AI panels (review list / streamed answer) want a bit more room to read.
  const aiW = clamp(sideW ?? Math.floor(cols * 0.42), 34, sideMax);
  const isAiPanel = mode === "review" || mode === "ask";
  const leftW = mode === "comment" || mode === "submit" ? editorW : isAiPanel ? aiW : sidebarW;
  const diffW = cols - leftW;
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
    setSelectAnchor(null); // a range can't span files
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

  // ---- Annotation actions ----

  // Open the comment editor for the current selection, or the cursor line. On a
  // line that already carries an annotation (and no active selection), edit it.
  const startComment = () => {
    if (!selectedFile || total === 0) return;
    let startIdx = cursor;
    let endIdx = cursor;
    let editingId = null;
    let draft = "";
    if (selectAnchor != null) {
      startIdx = Math.min(selectAnchor, cursor);
      endIdx = Math.max(selectAnchor, cursor);
    } else {
      const existing = annotationAt(annotations, selectedFile.path, cursor);
      if (existing) {
        startIdx = existing.startIdx;
        endIdx = existing.endIdx;
        editingId = existing.id;
        draft = existing.text;
      }
    }
    setCommentTarget({ startIdx, endIdx, editingId });
    setCommentDraft(draft);
    setMode("comment");
  };

  const commitComment = () => {
    const text = commentDraft.trim();
    const t = commentTarget;
    setMode("normal");
    setCommentDraft("");
    setCommentTarget(null);
    setSelectAnchor(null);
    if (!t || !selectedFile) return;
    if (t.editingId != null) {
      if (!text) {
        setAnnotations((as) => as.filter((a) => a.id !== t.editingId));
        setToast("annotation deleted");
      } else {
        setAnnotations((as) => as.map((a) => (a.id === t.editingId ? { ...a, text } : a)));
        setToast("annotation updated");
      }
      return;
    }
    if (!text) return; // empty new comment: nothing to add
    setAnnotations((as) => [...as, makeAnnotation(selectedFile.path, t.startIdx, t.endIdx, text)]);
    const span = t.endIdx - t.startIdx + 1;
    setToast(span > 1 ? `annotated ${span} lines` : "annotated line");
  };

  const deleteAtCursor = () => {
    if (!selectedFile) return;
    const existing = annotationAt(annotations, selectedFile.path, cursor);
    if (!existing) return;
    setAnnotations((as) => as.filter((a) => a.id !== existing.id));
    setToast("annotation deleted");
  };

  const jumpToAnnotation = (ann) => {
    if (!ann) return;
    const fi = filtered.findIndex((f) => f.path === ann.file);
    if (fi < 0) {
      setToast("that file is filtered out");
      return;
    }
    const t = filtered[fi].lines.length;
    setSelected(fi);
    setSelectAnchor(null);
    setCursor(ann.startIdx);
    setScroll(clamp(ann.startIdx - Math.floor(inner / 2), 0, Math.max(0, t - inner)));
    setFocus("diff");
  };

  const deleteSelectedAnnotation = () => {
    const ann = annotations[annCursor];
    if (!ann) return;
    setAnnotations((as) => as.filter((a) => a.id !== ann.id));
    setAnnSel((s) => clamp(s, 0, Math.max(0, annotations.length - 2)));
    setToast("annotation deleted");
  };

  // Assemble every annotation into a change-request doc, push it to the local
  // clipboard via OSC 52, and always drop a copy at .orbit/change-request.md so
  // there's a recoverable artifact even when the terminal ignores OSC 52.
  const copyRequests = () => {
    const withText = annotations.filter((a) => a.text.trim());
    if (withText.length === 0) {
      setToast("no annotations to copy");
      return;
    }
    const doc = buildChangeRequest(annotations, files, source);
    let copied = false;
    let copyErr = null;
    try {
      copyViaOSC52(doc);
      copied = true;
    } catch (e) {
      copyErr = e;
    }
    let savedPath = null;
    try {
      const path = changeRequestPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, doc);
      savedPath = tildeify(path);
    } catch {
      // best-effort; the clipboard may still have it
    }
    const n = withText.length;
    const label = `${n} request${n === 1 ? "" : "s"}`;
    if (copied) {
      setToast(`${label} → clipboard${savedPath ? ` (+ ${savedPath})` : ""}`);
    } else if (savedPath) {
      setToast(`${label} → ${savedPath}${copyErr ? ` (clipboard: ${copyErr.message})` : ""}`);
    } else {
      setToast(`could not copy: ${copyErr ? copyErr.message : "unknown error"}`);
    }
  };

  // Hand the whole annotation set to Claude Code so it can apply the edits, then
  // reload the diff — the review loop closed without leaving orbit-diff. We can't
  // do this in place: Ink owns the terminal, and an interactive `claude` needs it
  // to show its window and ask you questions. So we stash the prompt and quit the
  // viewer; index.jsx tears down Ink, runs `claude` on the bare terminal (you see
  // its full session and answer normally), then re-launches the viewer on the
  // reloaded diff. Annotations don't survive the round-trip — their line anchors
  // no longer point at the same code once the files change.
  const runChangeRequest = () => {
    const withText = annotations.filter((a) => a.text.trim());
    if (withText.length === 0) {
      setToast("no annotations to run");
      return;
    }
    const doc = buildChangeRequest(annotations, files, source);
    // Also drop a copy on disk so there's a record of what was handed off.
    try {
      const path = changeRequestPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, doc);
    } catch {
      // best-effort; the prompt still reaches Claude via the handoff
    }
    if (handoff) handoff.doc = doc; // index.jsx picks this up after we exit
    exit();
  };

  // The submit picker's rows. "Post to GitHub PR" only appears once a PR has
  // been found for the branch — otherwise the option is simply absent.
  const submitOptions = useMemo(() => {
    const opts = [{ key: "claude", label: "Apply via Claude Code", hint: "hands off to an interactive session" }];
    if (pr) {
      opts.push({
        key: "github",
        label: `Post to GitHub PR #${pr.number}`,
        hint: "inline review comments on the PR",
      });
    }
    opts.push({ key: "clipboard", label: "Copy to clipboard", hint: "+ saved under ~/.cache/orbit-diff/" });
    return opts;
  }, [pr]);

  // Open the picker — but only when there's something to submit, matching the
  // old direct-action behaviour of toasting on an empty set.
  const openSubmit = () => {
    if (posting) {
      setToast("still posting to the PR…");
      return;
    }
    const withText = annotations.filter((a) => a.text.trim());
    if (withText.length === 0) {
      setToast("no annotations to submit");
      return;
    }
    setSubmitSel(0);
    setMode("submit");
  };

  // Post the annotations to the PR as inline review comments. Outward-facing and
  // hard to undo, so it only runs on an explicit pick in the submit menu. Async:
  // we drop back to normal mode with a "posting…" toast, then report the tally.
  const postToGitHub = () => {
    if (!pr) return;
    setMode("normal");
    setPosting(true);
    setToast(`posting to PR #${pr.number}…`);
    submitAnnotations(pr, annotations, files)
      .then(({ posted, skipped, failed, url }) => {
        const parts = [`posted ${posted} comment${posted === 1 ? "" : "s"} → PR #${pr.number}`];
        if (skipped) parts.push(`${skipped} unmappable`);
        if (failed) parts.push(`${failed} rejected (line not on PR head?)`);
        setToast(parts.join(" · "));
      })
      .catch((e) => setToast(`PR submit failed: ${e.message}`))
      .finally(() => setPosting(false));
  };

  // Run whatever the picker's highlighted row is.
  const chooseSubmit = () => {
    const opt = submitOptions[clamp(submitSel, 0, submitOptions.length - 1)];
    setMode("normal");
    if (!opt) return;
    if (opt.key === "claude") return runChangeRequest();
    if (opt.key === "github") return postToGitHub();
    if (opt.key === "clipboard") return copyRequests();
  };

  // ---- AI actions ----

  // Lazily import the AI subsystem (which pulls in the Pi SDK) and load config on
  // first use, so the viewer starts fast and users without AI configured never pay
  // the cost. Cached on aiRef for the rest of the session.
  const loadAi = async () => {
    if (aiRef.current) return aiRef.current;
    try {
      const [{ loadConfig }, orchestrator, client] = await Promise.all([
        import("./ai/config.mjs"),
        import("./ai/orchestrator.mjs"),
        import("./ai/client.mjs"),
      ]);
      const config = await loadConfig();
      aiRef.current = { config, orchestrator, preflight: client.preflight, warning: config.warning };
      return aiRef.current;
    } catch (e) {
      return { error: `AI unavailable: ${e.message || e}` };
    }
  };

  // Kick off an AI review of the whole diff. Per-file, cache-first, bounded
  // concurrency; findings stream into the panel as each file completes. Async and
  // non-blocking, mirroring the GitHub submit path.
  const runAiReview = async () => {
    if (reviewing) {
      setMode("review");
      return;
    }
    const ai = await loadAi();
    if (ai.error) return setToast(ai.error);
    const pf = await ai.preflight(ai.config);
    if (!pf.ok) return setToast(pf.message);

    const token = ++reviewToken.current;
    let firstErr = null;
    setFindings([]);
    setReviewSel(0);
    setReviewError(null);
    setReviewing(true);
    setReviewProgress({ done: 0, total: files.length });
    setMode("review");
    ai.orchestrator
      .reviewFiles(files, ai.config, {
        onFileDone: (file, fs, err) => {
          if (token !== reviewToken.current) return;
          if (fs && fs.length) setFindings((prev) => [...prev, ...fs]);
          if (err && !firstErr) {
            firstErr = err;
            setReviewError(err); // surfaced in the panel (toasts are hidden in review mode)
          }
        },
        onProgress: (done, total) => {
          if (token !== reviewToken.current) return;
          setReviewProgress({ done, total });
        },
      })
      .then((all) => {
        if (token !== reviewToken.current) return;
        setReviewing(false);
        setToast(all.length === 0 && firstErr ? `review failed: ${firstErr}` : `review complete · ${all.length} finding${all.length === 1 ? "" : "s"}`);
      })
      .catch((e) => {
        if (token !== reviewToken.current) return;
        setReviewing(false);
        setReviewError(e.message || String(e));
        setToast(`review failed: ${e.message || e}`);
      });
  };

  // Move the diff cursor to a finding's location (leaves the review panel open so
  // you can keep triaging). Reuses the annotation-jump scroll math.
  const jumpToFinding = (f) => {
    if (!f) return;
    const fi = filtered.findIndex((x) => x.path === f.file);
    if (fi < 0) return setToast("that file is filtered out");
    const t = filtered[fi].lines.length;
    const idx = f.anchored ? f.startIdx : 0;
    setSelected(fi);
    setSelectAnchor(null);
    setCursor(idx);
    setScroll(clamp(idx - Math.floor(inner / 2), 0, Math.max(0, t - inner)));
  };

  // Promote the highlighted finding into a real annotation, so the user controls
  // exactly what feeds the submit pipelines (GitHub PR / apply / clipboard).
  const promoteFinding = () => {
    const f = findings[clamp(reviewSel, 0, Math.max(0, findings.length - 1))];
    if (!f) return;
    if (f.promoted) return setToast("already promoted");
    if (!f.anchored) return setToast("finding has no line anchor to promote");
    const file = files.find((x) => x.path === f.file);
    const ann = file && findingToAnnotation(f, file);
    if (!ann) return setToast("couldn't anchor finding");
    setAnnotations((as) => [...as, ann]);
    setFindings((fs) => fs.map((x) => (x.id === f.id ? { ...x, promoted: true } : x)));
    setToast("finding → annotation (r to submit)");
  };

  // Tear down the live Q&A session (if any) and forget its handle.
  const closeAsk = () => {
    askToken.current++; // ignore any in-flight answer deltas
    askConvo.current?.dispose();
    askConvo.current = null;
  };

  const openAsk = () => {
    closeAsk();
    setAskDraft("");
    setAskMessages([]);
    setAsking(false);
    setMode("ask");
  };

  // Append `delta` to the last (assistant) message — the one currently streaming.
  const appendToLastMessage = (delta) =>
    setAskMessages((ms) => {
      if (!ms.length) return ms;
      const last = ms[ms.length - 1];
      return [...ms.slice(0, -1), { ...last, text: last.text + delta }];
    });

  // The chat just edited the working tree — re-parse the diff and swap it in so the
  // viewer reflects the new state. selectedFile clamps itself against the reloaded
  // list; we reset the diff cursor/scroll since line indices may have moved.
  const reloadAfterEdit = () => {
    if (!reloadDiff) return;
    let next;
    try {
      next = reloadDiff();
    } catch (e) {
      return setToast(`reload failed: ${e.message || e}`);
    }
    setFiles(next);
    setCursor(0);
    setScroll(0);
    setToast(next.length === 0 ? "changes applied — nothing left to review" : "changes applied — diff reloaded");
  };

  // Send the typed question into the conversation and stream the answer. The
  // session is created on the first turn and reused for follow-ups, so the model
  // remembers the earlier exchange.
  const sendAsk = async () => {
    const q = askDraft.trim();
    if (!q || asking) return;
    const ai = await loadAi();
    if (ai.error) {
      setMode("normal");
      return setToast(ai.error);
    }
    const pf = await ai.preflight(ai.config);
    if (!pf.ok) {
      setMode("normal");
      return setToast(pf.message);
    }
    if (!askConvo.current) {
      askConvo.current = ai.orchestrator.startConversation(files, selectedFile, ai.config);
    }
    const token = ++askToken.current;
    setAskDraft("");
    setAsking(true);
    setAskMessages((ms) => [...ms, { role: "user", text: q }, { role: "assistant", text: "" }]);
    askConvo.current
      .ask(q, (delta) => {
        if (token !== askToken.current) return;
        appendToLastMessage(delta);
      })
      .then((res) => {
        if (token !== askToken.current) return;
        setAsking(false);
        if (res?.changed) reloadAfterEdit();
      })
      .catch((e) => {
        if (token !== askToken.current) return;
        setAsking(false);
        appendToLastMessage(`\n\n[error: ${e.message || e}]`);
      });
  };

  useInput((input, key) => {
    // ---- Submit target picker ----
    if (mode === "submit") {
      if (key.escape) return setMode("normal");
      if (key.return) return chooseSubmit();
      if (key.upArrow || input === "k") return setSubmitSel((s) => clamp(s - 1, 0, submitOptions.length - 1));
      if (key.downArrow || input === "j") return setSubmitSel((s) => clamp(s + 1, 0, submitOptions.length - 1));
      return;
    }

    // ---- AI review findings panel ----
    if (mode === "review") {
      if (key.escape) return setMode("normal");
      if (findings.length === 0) return; // nothing to navigate yet
      if (key.upArrow || input === "k") return setReviewSel((s) => clamp(s - 1, 0, findings.length - 1));
      if (key.downArrow || input === "j") return setReviewSel((s) => clamp(s + 1, 0, findings.length - 1));
      if (key.return) return jumpToFinding(findings[clamp(reviewSel, 0, findings.length - 1)]);
      if (input === "p") return promoteFinding();
      return;
    }

    // ---- Ask a question (multi-turn chat) ----
    if (mode === "ask") {
      if (key.escape) {
        closeAsk();
        return setMode("normal");
      }
      if (key.return) return sendAsk(); // send the follow-up (no-op while streaming)
      if (key.backspace || key.delete) return setAskDraft((d) => d.slice(0, -1));
      if (input && !key.ctrl && !key.meta) return setAskDraft((d) => d + input);
      return;
    }

    // ---- Comment text entry ----
    if (mode === "comment") {
      if (key.escape) {
        setMode("normal");
        setCommentDraft("");
        setCommentTarget(null);
        setSelectAnchor(null);
        return;
      }
      if (key.return) return commitComment();
      if (key.backspace || key.delete) return setCommentDraft((d) => d.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setCommentDraft((d) => d + input);
      return;
    }

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
    if (toast) setToast(null); // any action dismisses the last toast
    if (input === "q" || (key.ctrl && input === "c")) return exit();
    // Esc cancels a live selection, else clears an applied search/filter without
    // reopening it — keeping you on the file you're viewing as the rail un-narrows.
    if (key.escape) {
      if (selectAnchor != null) return setSelectAnchor(null);
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

    // ---- Annotation keys (operate on the cursor line / current selection) ----
    if (input === "v") {
      if (total === 0) return;
      return setSelectAnchor((a) => (a == null ? cursor : null));
    }
    if (input === "c") return startComment();
    if (input === "x") {
      // In the rail's annotations section `x` deletes the highlighted note;
      // elsewhere it deletes whatever note sits on the diff cursor line.
      if (focus === "sidebar" && activeSection === "annotations") return deleteSelectedAnnotation();
      return deleteAtCursor();
    }
    if (input === "a") {
      // Jump the rail's cursor to the first annotation (no separate overlay).
      if (annotations.length === 0) return setToast("no annotations yet");
      setSidebarOpen(true);
      setFocus("sidebar");
      setRailSection("annotations");
      setAnnSel(0);
      return;
    }
    if (input === "y") return copyRequests();
    if (input === "r") return openSubmit();
    if (input === "A") return runAiReview();
    if (input === "?") return openAsk();

    // Diff paging works from either pane, so you can skim a file's diff while
    // keeping the file rail focused for quick file switches.
    if (key.pageUp || (key.ctrl && input === "u")) return moveCursor(cursor - page);
    if (key.pageDown || (key.ctrl && input === "d")) return moveCursor(cursor + page);
    if (input === "g") return moveCursor(0);
    if (input === "G") return moveCursor(total - 1);

    // Line-granular ↑↓/jk are pane-sensitive: move files vs. move the cursor.
    // In the rail they walk the files list, then flow down into the annotations
    // list beneath it (and back up), so the whole rail is one continuous column.
    if (focus === "sidebar") {
      if (activeSection === "annotations") {
        if (key.upArrow || input === "k") {
          if (annCursor > 0) return setAnnSel(annCursor - 1);
          return setRailSection("files"); // cross back up into the file list
        }
        if (key.downArrow || input === "j") {
          return setAnnSel(clamp(annCursor + 1, 0, annotations.length - 1));
        }
        if (key.return) return jumpToAnnotation(annotations[annCursor]);
        return;
      }
      if (key.upArrow || input === "k") return selectFile(selected - 1);
      if (key.downArrow || input === "j") {
        if (selected < filtered.length - 1) return selectFile(selected + 1);
        if (annotations.length > 0) {
          setRailSection("annotations"); // cross down into the annotations list
          return setAnnSel(0);
        }
        return;
      }
      if (key.return) return setFocus("diff");
    } else {
      if (key.upArrow || input === "k") return moveCursor(cursor - 1);
      if (key.downArrow || input === "j") return moveCursor(cursor + 1);
    }
  });

  return (
    <Box flexDirection="column" width={cols} height={rows - 1}>
      <Box>
        {mode === "comment" ? (
          <CommentEditor
            draft={commentDraft}
            editing={commentTarget != null && commentTarget.editingId != null}
            label={commentLabel}
            width={leftW}
            height={bodyH}
          />
        ) : mode === "submit" ? (
          <SubmitMenu
            options={submitOptions}
            selected={clamp(submitSel, 0, submitOptions.length - 1)}
            count={annotations.filter((a) => a.text.trim()).length}
            width={leftW}
            height={bodyH}
          />
        ) : mode === "review" ? (
          <ReviewPanel
            findings={findings}
            selected={clamp(reviewSel, 0, Math.max(0, findings.length - 1))}
            reviewing={reviewing}
            progress={reviewProgress}
            error={reviewError}
            width={leftW}
            height={bodyH}
          />
        ) : mode === "ask" ? (
          <AskPanel
            draft={askDraft}
            messages={askMessages}
            asking={asking}
            width={leftW}
            height={bodyH}
          />
        ) : (
          sidebarOpen && (
            <Sidebar
              files={filtered}
              selected={selected}
              focused={focus === "sidebar" && mode !== "lines"}
              width={sidebarW}
              height={bodyH}
              annotations={annotations}
              allFiles={files}
              section={activeSection}
              annSelected={annCursor}
            />
          )
        )}
        <DiffPanel
          file={selectedFile}
          scroll={scroll}
          focused={focus === "diff" && mode !== "files" && mode !== "comment" && mode !== "submit" && mode !== "review" && mode !== "ask"}
          width={diffW}
          height={bodyH}
          query={lineQuery}
          matchLines={matchLines}
          currentLine={currentLine}
          cursor={cursor}
          annotatedLines={annotatedLines}
          selectionRange={selectionRange}
          activeBg={activeBg}
          selectBg={selectBg}
          addBg={addBg}
          delBg={delBg}
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
        section={activeSection}
        line={cursor + 1}
        lineTotal={total}
        annCount={annotations.length}
        commentTarget={commentTarget}
        selectionRange={selectionRange}
        toast={toast}
      />
    </Box>
  );
}

function StatusBar({
  mode, source, fileQuery, lineQuery, scope, matches, matchIdx, focus, section,
  line, lineTotal, annCount, commentTarget, selectionRange, toast,
}) {
  if (mode === "files") {
    return <Bar><Text color="cyan">filter files</Text> <Text>{fileQuery}</Text><Text inverse> </Text><Dim> · enter to apply · esc to clear</Dim></Bar>;
  }
  if (mode === "lines") {
    const count = matches.length ? `${matches.length} matches` : "no matches";
    const where = scope === "all" ? "whole diff" : "this file";
    return <Bar><Text color="magenta">find</Text> <Text>{lineQuery}</Text><Text inverse> </Text><Dim> · </Dim><Text color="yellow">{where}</Text><Dim> (tab) · {count} · enter jump · esc cancel</Dim></Bar>;
  }
  if (mode === "comment") {
    const editing = commentTarget && commentTarget.editingId != null;
    return <Bar><Text color="green">{editing ? "editing note" : "typing note"}</Text><Dim> · type your change request in the panel · enter save{editing ? " · empty deletes" : ""} · esc cancel</Dim></Bar>;
  }
  if (mode === "submit") {
    return <Bar><Text color="cyan">submit</Text><Dim> · choose a target in the panel · ↑↓ move · enter choose · esc cancel</Dim></Bar>;
  }
  if (mode === "review") {
    return <Bar><Text color="blueBright">AI review</Text><Dim> · ↑↓ move · enter jump · p promote · esc close</Dim></Bar>;
  }
  if (mode === "ask") {
    return <Bar><Text color="blueBright">chat</Text><Dim> · ask or request changes · enter send · esc close</Dim></Bar>;
  }
  if (toast) {
    return <Bar><Text color="green">✓ </Text><Text>{toast}</Text></Bar>;
  }
  const nav = matches.length
    ? ` · match ${((matchIdx % matches.length) + 1)}/${matches.length} (n/N)`
    : "";
  const sel = selectionRange ? ` · SEL ${selectionRange.hi - selectionRange.lo + 1}L (c note)` : "";
  const ann = annCount ? <><Text color="green">{annCount}✎</Text><Dim> · </Dim><Text color="yellow">r</Text><Dim> submit · </Dim></> : null;
  // In the rail's annotations section the row-level keys change: enter jumps to
  // the note's diff location, x deletes it. Elsewhere they create notes.
  const inNotes = focus === "sidebar" && section === "annotations";
  const where = focus === "diff" ? "▸diff" : section === "annotations" ? "▸notes" : "▸files";
  return (
    <Bar>
      <Text color="cyan">L{line}</Text><Dim>/{lineTotal} · </Dim>
      {ann}
      <Dim>{where} · </Dim>
      {inNotes ? (
        <><Text color="green">enter</Text><Dim> jump · </Dim><Text color="green">x</Text><Dim> del · </Dim></>
      ) : (
        <><Text color="green">c</Text><Dim> note · </Dim><Text color="green">v</Text><Dim> sel · </Dim></>
      )}
      <Text color="green">a</Text><Dim> notes · </Dim>
      <Text color="blueBright">A</Text><Dim> ai · </Dim>
      <Text color="blueBright">?</Text><Dim> ask · </Dim>
      <Text color="cyan">/</Text><Dim> files · </Dim>
      <Text color="magenta">f</Text><Dim> find · q quit{sel}{nav} · {source}</Dim>
    </Bar>
  );
}

// Left-column note editor (mode === "comment"), replacing the file rail so the
// diff stays visible on the right. A block cursor trails the wrapped draft; the
// hint pins to the bottom of the box.
function CommentEditor({ draft, editing, label, width, height }) {
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="green" paddingX={1}>
      <Text bold color="green" wrap="truncate">
        {editing ? "Edit note" : "New note"}
        {label ? `  ${label}` : ""}
      </Text>
      <Box marginTop={1} flexGrow={1}>
        <Text wrap="wrap">
          {draft}
          <Text inverse> </Text>
        </Text>
      </Box>
      <Text dimColor wrap="truncate">enter save · {editing ? "empty deletes · " : ""}esc cancel</Text>
    </Box>
  );
}

// Left-column picker (mode === "submit") for choosing where the annotations
// go: apply via Claude, post to the GitHub PR (when one exists), or copy. The
// diff stays visible on the right, mirroring the note editor's layout.
function SubmitMenu({ options, selected, count, width, height }) {
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan" wrap="truncate">
        Submit {count} annotation{count === 1 ? "" : "s"}
      </Text>
      <Box marginTop={1} flexDirection="column" flexGrow={1}>
        {options.map((o, i) => {
          const on = i === selected;
          return (
            <Box key={o.key} flexDirection="column" marginBottom={1}>
              <Text color={on ? "cyan" : undefined} inverse={on} wrap="truncate">
                {on ? "❯ " : "  "}
                {o.label}
              </Text>
              <Text dimColor wrap="truncate">{"    " + o.hint}</Text>
            </Box>
          );
        })}
      </Box>
      <Text dimColor wrap="truncate">↑↓ move · enter choose · esc cancel</Text>
    </Box>
  );
}

// Real-file line-number label for an index range: "line 42" or "lines 42–48".
// Prefers the new side; falls back to the old side for pure deletions.
function lineLabel(file, startIdx, endIdx) {
  let lo = null;
  let hi = null;
  for (let i = startIdx; i <= endIdx && i < file.lines.length; i++) {
    const n = file.lines[i].newNum ?? file.lines[i].oldNum;
    if (n == null) continue;
    if (lo == null) lo = n;
    hi = n;
  }
  if (lo == null) return "";
  return lo === hi ? `line ${lo}` : `lines ${lo}–${hi}`;
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
