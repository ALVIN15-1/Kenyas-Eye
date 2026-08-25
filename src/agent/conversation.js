// src/agent/conversation.js
// Shapes the message array that crosses the wire on every command.
//
// The browser owns the transcript and resends it, which keeps the server
// stateless like every other proxy in this project. That also means the server
// must treat the incoming history as untrusted: an over-long transcript is a
// cost problem, an unknown role is an upstream 400, and a `tool` message whose
// originating `assistant` call has been trimmed away is a hard API error rather
// than a degraded answer.

/** Roles the chat-completions surface accepts from us. */
export const AGENT_ROLES = Object.freeze(['system', 'user', 'assistant', 'tool']);

/**
 * Turns of history retained before trimming.
 *
 * The prefix already costs ~11,300 tokens per request, so history is the one
 * part of the payload we can bound without breaking tool calling.
 */
export const MAX_HISTORY_MESSAGES = 40;

/** Per-message content ceiling. Tool results are the usual offender. */
export const MAX_CONTENT_CHARS = 8000;

/** Characters per token used for the panel's rough budget readout. */
const CHARS_PER_TOKEN = 4;

/** Clamp a string, marking the truncation so the model knows it is partial. */
function clampContent(text, maxChars) {
  if (typeof text !== 'string') return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} characters]`;
}

/**
 * Normalize one tool call from an assistant message.
 *
 * Arguments stay a string here: they are validated against the tool schema at
 * dispatch time, not on the way through.
 */
function sanitizeToolCall(raw) {
  const id = typeof raw?.id === 'string' && raw.id ? raw.id : null;
  const name = typeof raw?.function?.name === 'string' ? raw.function.name.trim() : '';
  if (!id || !name) return null;
  const args = raw.function.arguments;
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    },
  };
}

/**
 * Normalize one message, dropping anything the upstream API would reject.
 *
 * @param {unknown} raw
 * @param {{maxContentChars?: number}} [options]
 * @returns {object|null} A wire-safe message, or null when unusable.
 */
export function sanitizeMessage(raw, { maxContentChars = MAX_CONTENT_CHARS } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const role = typeof raw.role === 'string' ? raw.role.trim() : '';
  if (!AGENT_ROLES.includes(role)) return null;

  if (role === 'tool') {
    const toolCallId = typeof raw.tool_call_id === 'string' && raw.tool_call_id ? raw.tool_call_id : null;
    if (!toolCallId) return null;
    return {
      role: 'tool',
      tool_call_id: toolCallId,
      content: clampContent(typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content ?? null), maxContentChars),
    };
  }

  if (role === 'assistant') {
    const toolCalls = Array.isArray(raw.tool_calls)
      ? raw.tool_calls.map(sanitizeToolCall).filter(Boolean)
      : [];
    const content = typeof raw.content === 'string' ? clampContent(raw.content, maxContentChars) : '';
    // An assistant turn with neither content nor a tool call carries nothing.
    if (!content && !toolCalls.length) return null;
    const message = { role: 'assistant', content };
    if (toolCalls.length) message.tool_calls = toolCalls;
    return message;
  }

  const content = typeof raw.content === 'string' ? clampContent(raw.content, maxContentChars) : '';
  if (!content) return null;
  return { role, content };
}

/**
 * Normalize a whole transcript.
 *
 * @param {unknown} raw
 * @param {{maxContentChars?: number}} [options]
 * @returns {object[]}
 */
export function sanitizeMessages(raw, options = {}) {
  if (!Array.isArray(raw)) return [];
  return raw.map((message) => sanitizeMessage(message, options)).filter(Boolean);
}

/**
 * Drop `tool` messages that no longer answer an assistant tool call.
 *
 * Sending one is not a degraded request, it is a 400 from every provider, so
 * this runs after any trim that could have removed the originating call.
 */
export function dropOrphanToolMessages(messages) {
  const answered = new Set();
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) answered.add(call.id);
    }
  }
  return messages.filter((message) => message.role !== 'tool' || answered.has(message.tool_call_id));
}

/**
 * Trim history to a bounded number of messages, keeping the newest.
 *
 * Trimming walks backwards and refuses to cut between an assistant tool call
 * and its results, so a trim never splits a pair; the cap is therefore a target
 * rather than a hard ceiling.
 *
 * @param {object[]} messages
 * @param {{maxMessages?: number}} [options]
 * @returns {object[]}
 */
export function trimHistory(messages, { maxMessages = MAX_HISTORY_MESSAGES } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= maxMessages) return dropOrphanToolMessages([...list]);

  let start = list.length - maxMessages;
  // Never begin on a tool result: its originating call sits earlier.
  while (start > 0 && list[start].role === 'tool') start -= 1;
  return dropOrphanToolMessages(list.slice(start));
}

/**
 * Assemble the final request payload: instructions first, then bounded history.
 *
 * Any `system` message arriving from the client is discarded. The instructions
 * are the app's contract with the model and are not client-supplied.
 *
 * @param {{instructions: string, messages: object[], maxMessages?: number, maxContentChars?: number}} options
 * @returns {object[]}
 */
export function buildRequestMessages({
  instructions,
  messages,
  maxMessages = MAX_HISTORY_MESSAGES,
  maxContentChars = MAX_CONTENT_CHARS,
}) {
  const sanitized = sanitizeMessages(messages, { maxContentChars })
    .filter((message) => message.role !== 'system');
  const trimmed = trimHistory(sanitized, { maxMessages });
  return [{ role: 'system', content: String(instructions ?? '') }, ...trimmed];
}

/**
 * Rough prompt size for the panel's budget readout.
 *
 * Deliberately approximate: it exists to warn before a context overrun, not to
 * reconcile with a provider's billed token count.
 */
export function estimatePromptTokens(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let chars = 0;
  for (const message of list) {
    chars += typeof message?.content === 'string' ? message.content.length : 0;
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
      chars += (call.function?.name?.length ?? 0) + (call.function?.arguments?.length ?? 0);
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Build the tool result message answering one call.
 *
 * The action runner returns plain objects; JSON is what the model reads best,
 * and it keeps the `ok` flag legible so the model can honour the "never claim
 * an action without ok=true" directive.
 */
export function toolResultMessage(toolCallId, result) {
  return {
    role: 'tool',
    tool_call_id: String(toolCallId),
    content: clampContent(JSON.stringify(result ?? { ok: false }), MAX_CONTENT_CHARS),
  };
}
