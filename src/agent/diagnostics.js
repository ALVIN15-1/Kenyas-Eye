// src/agent/diagnostics.js
// Turns the two silent failures of local tool calling into loud, actionable ones.
//
// Both were observed on real hardware, not imagined. Running qwen3:4b through
// Ollama at its default context produced `prompt_tokens: 4096` against a
// ~11,300-token prefix, and the model answered "fly to Tokyo" by writing a
// literal <function-call> block naming move_camera. Nothing errored. The
// request looked successful and the answer was nonsense.
//
// The capability gate in providers.js cannot catch this: Ollama's /api/show
// reports the model's ARCHITECTURAL context (262144 for that model), while the
// runtime window is whatever OLLAMA_CONTEXT_LENGTH allocated. The only reliable
// signal is the prompt token count that comes back after the fact.

import { AGENT_PROMPT_PREFIX_TOKENS } from './providers.js';

/**
 * Fraction of the expected prefix that must survive for a turn to be trusted.
 *
 * Token counting differs between tokenizers, so this is deliberately loose: it
 * is distinguishing "roughly the whole manual arrived" from "the window is a
 * quarter of what we sent".
 */
export const PREFIX_SURVIVAL_RATIO = 0.7;

/** Context windows an operator is likely to have left at a default. */
const COMMON_TRUNCATION_WINDOWS = Object.freeze([2048, 4096, 8192]);

/**
 * Detect that the upstream silently truncated our prompt.
 *
 * @param {object|null} usage Upstream usage block.
 * @param {{expectedPrefixTokens?: number}} [options]
 * @returns {{truncated: boolean, promptTokens: number|null, expected: number}}
 */
export function detectPrefixTruncation(usage, { expectedPrefixTokens = AGENT_PROMPT_PREFIX_TOKENS } = {}) {
  const promptTokens = Number(usage?.prompt_tokens);
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) {
    return { truncated: false, promptTokens: null, expected: expectedPrefixTokens };
  }
  return {
    truncated: promptTokens < expectedPrefixTokens * PREFIX_SURVIVAL_RATIO,
    promptTokens,
    expected: expectedPrefixTokens,
  };
}

/**
 * Whether a prompt-token count lands exactly on a familiar default window,
 * which makes the remedy specific rather than speculative.
 */
export function looksLikeDefaultWindow(promptTokens) {
  return COMMON_TRUNCATION_WINDOWS.includes(promptTokens);
}

/**
 * Detect a tool call written as prose instead of issued as a tool call.
 *
 * A model whose tool schemas were truncated away still knows it is supposed to
 * call something, so it improvises a format. Catching this distinguishes a
 * configuration fault from a model that is merely weak.
 */
export function looksLikeTextualToolCall(content) {
  if (typeof content !== 'string' || !content) return false;
  const patterns = [
    /<\s*function[_-]?call\s*>/i,
    /<\s*tool[_-]?call\s*>/i,
    /^\s*```(?:json)?\s*\{\s*"(?:name|function|tool_name)"\s*:/i,
    /^\s*\{\s*"(?:name|tool_name)"\s*:\s*"[a-z_]+"\s*,\s*"(?:arguments|parameters)"\s*:/i,
  ];
  return patterns.some((pattern) => pattern.test(content.trim()));
}

/**
 * Assess one completed turn before its answer is trusted.
 *
 * @param {{usage: object|null, message: object|null, provider: object|null, model?: string, expectedPrefixTokens?: number}} turn
 * @returns {{ok: true} | {ok: false, error: string, remedy: string, promptTokens: number|null}}
 */
export function diagnoseTurn({ usage, message, provider, model, expectedPrefixTokens }) {
  const truncation = detectPrefixTruncation(usage, { expectedPrefixTokens });
  const textualCall = looksLikeTextualToolCall(message?.content);
  if (!truncation.truncated && !textualCall) return { ok: true };

  const isLocal = provider?.kind === 'local';
  const window = truncation.promptTokens;
  const windowNote = window
    ? ` The provider processed only ${window.toLocaleString()} prompt tokens against the ~${truncation.expected.toLocaleString()} this app sends${looksLikeDefaultWindow(window) ? ', which is a stock default window' : ''}.`
    : '';

  if (truncation.truncated) {
    return {
      ok: false,
      promptTokens: window,
      error: `${provider?.label || 'The provider'} truncated the tool prefix, so ${model || 'the model'} never saw the full tool list.${windowNote}`,
      remedy: isLocal
        ? 'Raise the runtime context window: set OLLAMA_CONTEXT_LENGTH=16384 on the Ollama server (or PARAMETER num_ctx 16384 in a Modelfile) and restart it.'
        : 'Select a model with a larger context window.',
    };
  }

  return {
    ok: false,
    promptTokens: window,
    error: `${model || 'The model'} wrote a tool call as text instead of issuing one, which usually means its tool definitions were truncated or it does not support tool calling.`,
    remedy: isLocal
      ? 'Confirm the model reports the "tools" capability, and raise OLLAMA_CONTEXT_LENGTH to at least 16384.'
      : 'Select a model that supports tool calling.',
  };
}
