// src/agent/agentLoop.js
// Drives one typed command to completion in the browser.
//
// The tools mutate the Cesium viewer, so they can only run here; the server
// holds the credentials, so the model can only be reached there. That splits a
// single logical turn into a loop: ask the server, run whatever tools come
// back, hand the results forward, ask again. The loop ends when the model
// answers with prose instead of a call.
//
// `fetchImpl` and `runAction` are both injected so the whole loop is testable
// without a network or a globe.

import { toolResultMessage } from './conversation.js';

/** Endpoint the loop posts to. */
export const AGENT_COMMAND_ENDPOINT = '/api/agent/command';

/**
 * Tool rounds allowed for one typed command.
 *
 * The manual encourages multi-tool turns ("call ALL the corresponding tools"),
 * so this is not 1; it is a runaway guard for a model that keeps calling tools
 * and never answers.
 */
export const MAX_TOOL_ROUNDS = 8;

/** Lifecycle events emitted for the panel to render. */
export const AGENT_EVENTS = Object.freeze({
  REQUEST: 'request',
  TOOL_START: 'tool-start',
  TOOL_RESULT: 'tool-result',
  MESSAGE: 'message',
  ERROR: 'error',
  DONE: 'done',
});

/**
 * Accumulated token usage across a session.
 *
 * Providers vary in which fields they populate, so absent counters stay zero
 * rather than being inferred.
 */
function addUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return total;
  return {
    promptTokens: total.promptTokens + (Number(usage.prompt_tokens) || 0),
    completionTokens: total.completionTokens + (Number(usage.completion_tokens) || 0),
    requests: total.requests + 1,
  };
}

/** A zeroed usage accumulator. */
export function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, requests: 0 };
}

/**
 * Run one action and reduce whatever it throws into a tool result.
 *
 * A thrown action must not abort the loop: the model is told to report partial
 * failure honestly, and it can only do that if the failure reaches it as a
 * result rather than as a dead session.
 */
async function runActionSafely(runAction, name, args) {
  try {
    const result = await runAction(name, args);
    return result === undefined ? { ok: true, action: name } : result;
  } catch (error) {
    return { ok: false, action: name, error: error?.message || 'Action threw an unexpected error' };
  }
}

/**
 * Create a stateful agent session.
 *
 * @param {{
 *   runAction: (name: string, args: object) => Promise<object>,
 *   fetchImpl?: typeof fetch,
 *   endpoint?: string,
 *   maxToolRounds?: number,
 * }} options
 */
export function createAgentSession({
  runAction,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  endpoint = AGENT_COMMAND_ENDPOINT,
  maxToolRounds = MAX_TOOL_ROUNDS,
}) {
  if (typeof runAction !== 'function') {
    throw new TypeError('createAgentSession requires a runAction function');
  }

  let messages = [];
  let usage = emptyUsage();
  let inFlight = null;

  /** POST one turn to the relay. */
  async function postTurn({ provider, model, signal }) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model, messages }),
      signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      throw new Error(data?.error || `Agent request failed (HTTP ${response.status})`);
    }
    return data;
  }

  return {
    /** The transcript, for rendering. Callers must not mutate it. */
    get transcript() {
      return messages;
    },

    /** Cumulative token usage for this session. */
    get usage() {
      return { ...usage };
    },

    /** Whether a command is currently running. */
    get busy() {
      return inFlight !== null;
    },

    /** Discard the transcript and usage, e.g. when the provider changes. */
    reset() {
      messages = [];
      usage = emptyUsage();
    },

    /** Abort the running command, if any. */
    abort() {
      inFlight?.abort();
    },

    /**
     * Send one typed command and run it to completion.
     *
     * @param {string} text
     * @param {{provider?: string, model?: string, onEvent?: (event: object) => void}} [options]
     * @returns {Promise<{ok: boolean, content: string, rounds: number, error?: string}>}
     */
    async send(text, { provider, model, onEvent = () => {} } = {}) {
      const command = typeof text === 'string' ? text.trim() : '';
      if (!command) return { ok: false, content: '', rounds: 0, error: 'Empty command' };
      if (inFlight) return { ok: false, content: '', rounds: 0, error: 'A command is already running' };

      const controller = new AbortController();
      inFlight = controller;
      messages.push({ role: 'user', content: command });
      onEvent({ type: AGENT_EVENTS.MESSAGE, message: { role: 'user', content: command } });

      try {
        for (let round = 0; round < maxToolRounds; round += 1) {
          onEvent({ type: AGENT_EVENTS.REQUEST, round });

          const data = await postTurn({ provider, model, signal: controller.signal });
          usage = addUsage(usage, data.usage);
          messages.push(data.message);

          const toolCalls = Array.isArray(data.toolCalls) ? data.toolCalls : [];
          if (!toolCalls.length) {
            const content = data.message?.content || '';
            onEvent({ type: AGENT_EVENTS.MESSAGE, message: { role: 'assistant', content } });
            onEvent({ type: AGENT_EVENTS.DONE, rounds: round + 1 });
            return { ok: !data.toolCallFailed, content, rounds: round + 1 };
          }

          // The model may narrate alongside a call; surface it so the panel is
          // not silent while several tools run.
          if (data.message?.content) {
            onEvent({ type: AGENT_EVENTS.MESSAGE, message: { role: 'assistant', content: data.message.content } });
          }

          for (const call of toolCalls) {
            onEvent({ type: AGENT_EVENTS.TOOL_START, name: call.name, args: call.args });
            const result = await runActionSafely(runAction, call.name, call.args);
            onEvent({ type: AGENT_EVENTS.TOOL_RESULT, name: call.name, result });
            messages.push(toolResultMessage(call.id, result));
          }
        }

        const error = `Stopped after ${maxToolRounds} tool rounds without a final answer.`;
        onEvent({ type: AGENT_EVENTS.ERROR, error });
        return { ok: false, content: '', rounds: maxToolRounds, error };
      } catch (error) {
        const message = error?.name === 'AbortError'
          ? 'Command cancelled.'
          : error?.message || 'Agent request failed';
        onEvent({ type: AGENT_EVENTS.ERROR, error: message });
        return { ok: false, content: '', rounds: 0, error: message };
      } finally {
        inFlight = null;
      }
    },
  };
}
