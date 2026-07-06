// Thin wrapper over the Pi SDK (@earendil-works/pi-coding-agent). Keeps all the
// SDK wiring — auth storage, model registry, resource loader, in-memory session —
// in one place, and exposes two verbs the viewer needs:
//
//   reviewFile(file, config)     → raw parsed findings for one file's diff
//   startConversation(config)    → a live multi-turn chat that can edit the tree
//
// Reviews run with NO tools (single-shot over the diff we hand it). The chat runs
// with the full read/write tool set (read/grep/find/ls/edit/write/bash) so it can
// both explore the repo and apply changes the user asks for. Tools execute with no
// approval gate — that's by design here. Credentials are resolved by Pi from its
// own env vars / ~/.pi/agent/auth.json — orbit-diff never sees a key.

import { getModel } from "@earendil-works/pi-ai/compat";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_HINT } from "./config.mjs";
import {
  buildReviewPrompt,
  parseFindings,
  REVIEW_SYSTEM_PROMPT,
} from "./review.mjs";

// A user-actionable error (bad config, missing key, unknown model). The UI toasts
// its message verbatim; anything unexpected keeps its original message.
export class AiError extends Error {}

// The conversation ("chat") system prompt — this session can edit the working
// tree, so it's told to. It runs with the full read/write tool set below.
const CHAT_SYSTEM_PROMPT = `You are a coding assistant embedded in a terminal diff viewer.
The user is reviewing a diff and may ask questions about it or ask you to make changes.
You have full read/write tools (read, edit, write, bash, grep, find, ls): use them to
inspect the code and to apply any changes the user asks for. Keep edits focused and
minimal, then briefly explain what you changed, citing file paths and line numbers.`;

// Tools the chat session may use, and the subset that mutates the working tree — a
// call to any of these means the on-disk diff changed and the viewer should reload.
const CHAT_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"];
const MUTATING_TOOLS = new Set(["edit", "write", "bash"]);

let _registry; // { authStorage, modelRegistry } — built once per process
function registry() {
  if (!_registry) {
    const authStorage = AuthStorage.create();
    _registry = { authStorage, modelRegistry: ModelRegistry.create(authStorage) };
  }
  return _registry;
}

function resolveModel(config) {
  const { modelRegistry } = registry();
  try {
    const m = modelRegistry.find(config.provider, config.model); // includes custom models.json
    if (m) return m;
  } catch {
    /* fall through to built-ins */
  }
  try {
    return getModel(config.provider, config.model) || null;
  } catch {
    return null;
  }
}

// Cheap check before firing an action, so `A`/`?` can toast a helpful message
// instead of spinning. Returns { ok } or { ok:false, message }.
export async function preflight(config) {
  const model = resolveModel(config);
  if (!model) {
    return { ok: false, message: `model "${config.provider}/${config.model}" not found — check ${CONFIG_HINT}` };
  }
  try {
    const available = await registry().modelRegistry.getAvailable();
    if (available.length && !available.some((m) => m.provider === model.provider)) {
      return { ok: false, message: `no credentials for "${model.provider}" — set its API key env var, or run \`pi\` then /login` };
    }
  } catch {
    // Availability probe failed — don't block; the real call will surface auth errors.
  }
  return { ok: true };
}

async function makeSession(config, { systemPrompt, tools }) {
  const model = resolveModel(config);
  if (!model) throw new AiError(`model "${config.provider}/${config.model}" not found — check ${CONFIG_HINT}`);

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [], // don't append project APPEND_SYSTEM.md
  });
  await loader.reload();

  const opts = {
    model,
    thinkingLevel: config.thinkingLevel,
    authStorage: registry().authStorage,
    modelRegistry: registry().modelRegistry,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    }),
  };
  if (tools) opts.tools = tools;
  else opts.noTools = "all";

  const { session } = await createAgentSession(opts);
  return session;
}

// Drive one prompt to completion, streaming text deltas to `onDelta`, and return
// the final assistant text. `onMutate(toolName)` fires the first time a working-
// tree-mutating tool (edit/write/bash) runs, so callers can reload afterwards.
async function runPrompt(session, promptText, onDelta, onMutate) {
  let text = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta;
      text += delta;
      if (onDelta) onDelta(delta);
    } else if (event.type === "tool_execution_start" && MUTATING_TOOLS.has(event.toolName)) {
      onMutate?.(event.toolName);
    }
  });
  try {
    await session.prompt(promptText);
  } finally {
    unsubscribe();
  }
  return session.getLastAssistantText() ?? text;
}

// Review one file's diff. Returns the RAW parsed findings (line numbers + text),
// which are cache-safe (no session-specific indices) — the caller anchors them to
// the current diff via makeFindings().
export async function reviewFile(file, config) {
  let session;
  try {
    session = await makeSession(config, { systemPrompt: REVIEW_SYSTEM_PROMPT, tools: null });
    const text = await runPrompt(session, buildReviewPrompt(file));
    return parseFindings(text);
  } catch (err) {
    throw asAiError(err, config);
  } finally {
    session?.dispose();
  }
}

// Start a multi-turn chat about the diff/codebase. The session is kept alive so
// each `send` remembers the previous turns (and any files it read), and it runs
// with write tools, so it can edit the working tree when asked. Each
// `send` resolves to `{ text, changed }` — `changed` is true when the turn ran a
// mutating tool, the signal for the caller to reload the diff. Call `dispose` when
// the chat is closed. Session creation is deferred to the first `send` so
// config/auth errors surface there. Synchronous: it just returns the handle; the
// async work happens in `send`.
export function startConversation(config) {
  let session;
  return {
    async send(text, onDelta) {
      try {
        if (!session) {
          session = await makeSession(config, { systemPrompt: CHAT_SYSTEM_PROMPT, tools: CHAT_TOOLS });
        }
        let changed = false;
        const out = await runPrompt(session, text, onDelta, () => {
          changed = true;
        });
        return { text: out, changed };
      } catch (err) {
        throw asAiError(err, config);
      }
    },
    dispose() {
      session?.dispose();
      session = null;
    },
  };
}

function asAiError(err, config) {
  if (err instanceof AiError) return err;
  const msg = err?.message || String(err);
  if (/api[_ ]?key|auth|credential|unauthor|401|403/i.test(msg)) {
    return new AiError(`no credentials for "${config.provider}" — set its API key env var, or run \`pi\` then /login`);
  }
  if (/not found|unknown model|no model|unsupported model/i.test(msg)) {
    return new AiError(`model "${config.provider}/${config.model}" not available — check ${CONFIG_HINT}`);
  }
  return new AiError(msg);
}
