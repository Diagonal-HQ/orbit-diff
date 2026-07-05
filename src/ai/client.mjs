// Thin wrapper over the Pi SDK (@earendil-works/pi-coding-agent). Keeps all the
// SDK wiring — auth storage, model registry, resource loader, in-memory session —
// in one place, and exposes two verbs the viewer needs:
//
//   reviewFile(file, config)            → raw parsed findings for one file's diff
//   ask(question, context, config, cb)  → streamed answer to a question
//
// Reviews run with NO tools (single-shot over the diff we hand it). Q&A runs with
// READ-ONLY tools (read/grep/find/ls) so the model can explore the repo to answer,
// but can never edit, write, or run shell commands. Credentials are resolved by
// Pi from its own env vars / ~/.pi/agent/auth.json — orbit-diff never sees a key.

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

const ASK_SYSTEM_PROMPT = `You are a code assistant embedded in a terminal diff viewer.
Answer the user's question about the diff under review and the surrounding codebase.
You have read-only tools (read, grep, find, ls) — use them to check the actual code
before answering rather than guessing. Be concise and concrete; cite file paths and
line numbers where useful. You cannot edit files or run commands.`;

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
// the final assistant text.
async function runPrompt(session, promptText, onDelta) {
  let text = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta;
      text += delta;
      if (onDelta) onDelta(delta);
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

// Ask a question about the diff/codebase. `context` is prepended (the diff summary
// / current file), `onDelta` streams the answer as it arrives. Returns final text.
export async function ask(question, context, config, onDelta) {
  let session;
  try {
    session = await makeSession(config, { systemPrompt: ASK_SYSTEM_PROMPT, tools: ["read", "grep", "find", "ls"] });
    const prompt = context ? `${context}\n\nQuestion: ${question}` : question;
    return await runPrompt(session, prompt, onDelta);
  } catch (err) {
    throw asAiError(err, config);
  } finally {
    session?.dispose();
  }
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
