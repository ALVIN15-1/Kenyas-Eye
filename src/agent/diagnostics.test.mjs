// src/agent/diagnostics.test.mjs
// Every case here is drawn from a real failure observed against Ollama 0.18.2
// on an 8 GB card. At the stock context window the request SUCCEEDS: HTTP 200,
// a plausible-looking answer, no error anywhere. The only evidence is
// prompt_tokens coming back at 4096 and the model writing <function-call> as
// prose. Both signals are pinned so that failure can never be silent again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_PROMPT_PREFIX_TOKENS, resolveProvider } from './providers.js';
import {
  PREFIX_SURVIVAL_RATIO,
  detectPrefixTruncation,
  diagnoseTextTurn,
  diagnoseTurn,
  looksLikeReasoningOverflow,
  looksLikeDefaultWindow,
  looksLikeTextualToolCall,
} from './diagnostics.js';

const OLLAMA = resolveProvider('ollama');
const OPENROUTER = resolveProvider('openrouter');

/** The exact usage block returned by the truncating run. */
const TRUNCATED_USAGE = Object.freeze({ prompt_tokens: 4096, completion_tokens: 2418, total_tokens: 6514 });

/** The usage block from the same command once the window was raised to 16384. */
const HEALTHY_USAGE = Object.freeze({ prompt_tokens: 9782, completion_tokens: 823, total_tokens: 10605 });

/** The literal content the truncated model produced. */
const TEXTUAL_CALL = '<function-call>\n{\n  "name": "move_camera",\n  "arguments": {"motion": "pan"}\n}\n</function-call>';

test('detectPrefixTruncation flags the observed 4096-token window', () => {
  const result = detectPrefixTruncation(TRUNCATED_USAGE);
  assert.equal(result.truncated, true);
  assert.equal(result.promptTokens, 4096);
  assert.equal(result.expected, AGENT_PROMPT_PREFIX_TOKENS);
});

test('detectPrefixTruncation accepts the observed healthy window', () => {
  assert.equal(detectPrefixTruncation(HEALTHY_USAGE).truncated, false);
});

test('detectPrefixTruncation abstains when usage is absent', () => {
  for (const usage of [null, undefined, {}, { prompt_tokens: 'many' }, { prompt_tokens: 0 }]) {
    assert.equal(detectPrefixTruncation(usage).truncated, false, `should abstain for ${JSON.stringify(usage)}`);
  }
});

test('detectPrefixTruncation tolerates tokenizer variance around the threshold', () => {
  const threshold = AGENT_PROMPT_PREFIX_TOKENS * PREFIX_SURVIVAL_RATIO;
  assert.equal(detectPrefixTruncation({ prompt_tokens: Math.ceil(threshold) + 1 }).truncated, false);
  assert.equal(detectPrefixTruncation({ prompt_tokens: Math.floor(threshold) - 1 }).truncated, true);
});

test('detectPrefixTruncation honours an explicit expected size', () => {
  assert.equal(detectPrefixTruncation({ prompt_tokens: 900 }, { expectedPrefixTokens: 1000 }).truncated, false);
  assert.equal(detectPrefixTruncation({ prompt_tokens: 400 }, { expectedPrefixTokens: 1000 }).truncated, true);
});

test('looksLikeDefaultWindow recognises stock context sizes', () => {
  assert.equal(looksLikeDefaultWindow(4096), true);
  assert.equal(looksLikeDefaultWindow(2048), true);
  assert.equal(looksLikeDefaultWindow(9782), false);
});

test('looksLikeTextualToolCall catches the observed prose call', () => {
  assert.equal(looksLikeTextualToolCall(TEXTUAL_CALL), true);
});

test('looksLikeTextualToolCall catches the other improvised formats', () => {
  assert.equal(looksLikeTextualToolCall('<tool_call>{"name":"x"}</tool_call>'), true);
  assert.equal(looksLikeTextualToolCall('```json\n{"name": "fly_to_location", "arguments": {}}\n```'), true);
  assert.equal(looksLikeTextualToolCall('{"name":"fly_to_location","arguments":{"query":"Tokyo"}}'), true);
});

test('looksLikeTextualToolCall does not fire on ordinary prose', () => {
  for (const content of [
    'Flying to Tokyo.',
    'I framed fourteen aircraft, labels on.',
    'The function call you asked about is not something I can run.',
    '',
    null,
    undefined,
  ]) {
    assert.equal(looksLikeTextualToolCall(content), false, `false positive on ${JSON.stringify(content)}`);
  }
});

test('diagnoseTurn passes a healthy local turn', () => {
  const verdict = diagnoseTurn({
    usage: HEALTHY_USAGE,
    message: { role: 'assistant', content: 'Flying to Tokyo' },
    provider: OLLAMA,
    model: 'qwen3:4b',
  });
  assert.deepEqual(verdict, { ok: true });
});

test('diagnoseTurn reproduces the real failure and names the fix', () => {
  const verdict = diagnoseTurn({
    usage: TRUNCATED_USAGE,
    message: { role: 'assistant', content: TEXTUAL_CALL },
    provider: OLLAMA,
    model: 'qwen3:4b',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.promptTokens, 4096);
  assert.match(verdict.error, /truncated the tool prefix/);
  assert.match(verdict.error, /4,096 prompt tokens/);
  assert.match(verdict.error, /stock default window/);
  assert.match(verdict.remedy, /OLLAMA_CONTEXT_LENGTH=16384/);
});

test('diagnoseTurn gives hosted providers a model-shaped remedy, not a daemon one', () => {
  const verdict = diagnoseTurn({
    usage: { prompt_tokens: 2048 },
    message: { role: 'assistant', content: 'hi' },
    provider: OPENROUTER,
    model: 'tiny/model',
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.remedy, /larger context window/);
  assert.doesNotMatch(verdict.remedy, /OLLAMA/);
});

test('diagnoseTurn catches a prose tool call even when the window looks fine', () => {
  const verdict = diagnoseTurn({
    usage: HEALTHY_USAGE,
    message: { role: 'assistant', content: TEXTUAL_CALL },
    provider: OLLAMA,
    model: 'qwen3:4b',
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /wrote a tool call as text/);
  assert.match(verdict.remedy, /"tools" capability/);
});

test('diagnoseTurn stays quiet when a provider reports no usage at all', () => {
  const verdict = diagnoseTurn({
    usage: null,
    message: { role: 'assistant', content: 'Flying to Tokyo' },
    provider: OLLAMA,
    model: 'qwen3:4b',
  });
  assert.deepEqual(verdict, { ok: true });
});

// ── Short text completions (the HUD summary) ────────────────────────────────
// Observed with qwen3:4b: a reasoning model spends its whole output budget on
// an internal trace and returns empty content with finish_reason "length".
// Raising the ceiling does not help — at 1024 tokens it was still thinking
// after 86 seconds. The remedy is a different model, so the diagnostic has to
// say that rather than reporting an empty result.

/** The exact shape returned by the reasoning-overflow run. */
const REASONING_OVERFLOW = Object.freeze({
  content: '',
  finishReason: 'length',
  reasoningLength: 456,
});

/** The shape returned by llama3.2:3b once the model was switched. */
const HEALTHY_TEXT = Object.freeze({
  content: 'Austin Texas City Sky View',
  finishReason: 'stop',
  reasoningLength: 0,
});

test('looksLikeReasoningOverflow identifies the observed failure', () => {
  assert.equal(looksLikeReasoningOverflow(REASONING_OVERFLOW), true);
});

test('looksLikeReasoningOverflow does not fire on a healthy answer', () => {
  assert.equal(looksLikeReasoningOverflow(HEALTHY_TEXT), false);
});

test('looksLikeReasoningOverflow needs all three signals together', () => {
  // Empty content alone is a different fault with a different remedy.
  assert.equal(looksLikeReasoningOverflow({ content: '', finishReason: 'stop', reasoningLength: 400 }), false);
  assert.equal(looksLikeReasoningOverflow({ content: '', finishReason: 'length', reasoningLength: 0 }), false);
  assert.equal(looksLikeReasoningOverflow({ content: 'answer', finishReason: 'length', reasoningLength: 400 }), false);
});

test('looksLikeReasoningOverflow treats whitespace-only content as empty', () => {
  assert.equal(looksLikeReasoningOverflow({ content: '   \n', finishReason: 'length', reasoningLength: 400 }), true);
});

test('diagnoseTextTurn passes a real five-word summary', () => {
  assert.deepEqual(diagnoseTextTurn({ ...HEALTHY_TEXT, provider: OLLAMA, model: 'llama3.2:3b' }), { ok: true });
});

test('diagnoseTextTurn names the model swap for a local reasoning model', () => {
  const verdict = diagnoseTextTurn({ ...REASONING_OVERFLOW, provider: OLLAMA, model: 'qwen3:4b' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /spent its entire output budget on internal reasoning/);
  assert.match(verdict.remedy, /non-reasoning instruct model/);
  assert.match(verdict.remedy, /llama3\.2:3b/);
});

test('diagnoseTextTurn gives hosted providers a remedy that is not an Ollama tag', () => {
  const verdict = diagnoseTextTurn({ ...REASONING_OVERFLOW, provider: OPENROUTER, model: 'some/reasoner' });
  assert.equal(verdict.ok, false);
  assert.doesNotMatch(verdict.remedy, /llama3\.2/);
  assert.match(verdict.remedy, /reasoning effort/);
});

test('diagnoseTextTurn distinguishes an empty answer from a reasoning overflow', () => {
  const verdict = diagnoseTextTurn({ content: '', finishReason: 'stop', provider: OLLAMA, model: 'm' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /returned no usable text/);
  assert.doesNotMatch(verdict.error, /internal reasoning/);
});
