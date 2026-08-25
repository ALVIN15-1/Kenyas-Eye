// src/agent/upstream.test.mjs
// `fetch` is injected here so the whole upstream surface runs offline. Two
// behaviours matter beyond the happy path: error text must never carry a
// credential back to the browser, and an unreachable local daemon must produce
// operator guidance rather than a stack trace, because a stopped Ollama
// container is the most likely failure this feature has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider } from './providers.js';
import {
  CAPABILITY_PROBE_LIMIT,
  COMPLETION_TIMEOUT_MS,
  LOCAL_COMPLETION_TIMEOUT_MS,
  completionTimeoutFor,
  authHeaders,
  chatCompletionsUrl,
  describeTransportError,
  fetchModels,
  fetchOllamaCapabilities,
  modelsUrl,
  normalizeUpstreamError,
  requestChatCompletion,
} from './upstream.js';

const OPENAI = resolveProvider('openai');
const OPENROUTER = resolveProvider('openrouter');
const OLLAMA = resolveProvider('ollama');

/** Build a fetch stub that answers by URL substring. */
function stubFetch(routes, { calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    const match = Object.keys(routes).find((key) => url.includes(key));
    if (!match) throw Object.assign(new Error('connect ECONNREFUSED'), { cause: { code: 'ECONNREFUSED' } });
    const entry = routes[match];
    const value = typeof entry === 'function' ? await entry(url, init) : entry;
    return {
      ok: value.status >= 200 && value.status < 300,
      status: value.status,
      text: async () => (typeof value.body === 'string' ? value.body : JSON.stringify(value.body)),
    };
  };
}

test('modelsUrl preserves a provider filter query', () => {
  assert.equal(
    modelsUrl(OPENROUTER, 'https://openrouter.ai/api/v1'),
    'https://openrouter.ai/api/v1/models?supported_parameters=tools',
  );
  assert.equal(modelsUrl(OLLAMA, 'http://ollama:11434/v1'), 'http://ollama:11434/v1/models');
});

test('chatCompletionsUrl appends the standard path', () => {
  assert.equal(chatCompletionsUrl('http://ollama:11434/v1'), 'http://ollama:11434/v1/chat/completions');
});

test('authHeaders attaches a bearer token only when there is a key', () => {
  assert.equal(authHeaders(OPENAI, 'sk-test').Authorization, 'Bearer sk-test');
  assert.equal(authHeaders(OLLAMA, null).Authorization, undefined);
  assert.equal(authHeaders(OLLAMA, null)['Content-Type'], 'application/json');
});

test('authHeaders identifies the project to OpenRouter but not to others', () => {
  assert.equal(authHeaders(OPENROUTER, 'or-key')['X-Title'], "God's Eye View");
  assert.equal(authHeaders(OPENAI, 'sk-test')['X-Title'], undefined);
});

test('normalizeUpstreamError never echoes a credential back', () => {
  const leaky = 'Invalid key sk-proj-SECRETVALUE supplied in Authorization header';
  assert.equal(normalizeUpstreamError(401, leaky).includes('SECRETVALUE'), false);
  assert.equal(normalizeUpstreamError(403, leaky).includes('SECRETVALUE'), false);
});

test('normalizeUpstreamError maps the statuses an operator can act on', () => {
  assert.match(normalizeUpstreamError(401, ''), /credentials/i);
  assert.match(normalizeUpstreamError(404, ''), /model id/i);
  assert.match(normalizeUpstreamError(429, ''), /rate limit/i);
  assert.match(normalizeUpstreamError(503, ''), /provider error/i);
});

test('normalizeUpstreamError bounds an oversized upstream body', () => {
  const message = normalizeUpstreamError(400, 'x'.repeat(5000));
  assert.ok(message.length < 400, `error text grew to ${message.length} chars`);
});

test('normalizeUpstreamError collapses whitespace from a multi-line body', () => {
  assert.match(normalizeUpstreamError(400, 'line one\n\n   line two'), /line one line two/);
});

test('describeTransportError names a stopped local daemon', () => {
  const error = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const message = describeTransportError(error, { provider: OLLAMA, baseUrl: 'http://ollama:11434/v1' });
  assert.match(message, /Cannot reach Ollama at http:\/\/ollama:11434\/v1/);
  assert.match(message, /daemon running/);
});

test('describeTransportError stays vague for hosted providers', () => {
  const error = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  assert.match(describeTransportError(error, { provider: OPENAI }), /Cannot reach OpenAI/);
});

test('describeTransportError reports a timeout distinctly', () => {
  const error = Object.assign(new Error('aborted'), { name: 'AbortError' });
  assert.match(describeTransportError(error, { provider: OPENROUTER }), /Timed out waiting for OpenRouter/);
});

test('fetchModels normalizes an OpenRouter catalog', async () => {
  const fetchImpl = stubFetch({
    '/models': {
      status: 200,
      body: {
        data: [
          {
            id: 'openai/gpt-5-mini',
            name: 'GPT-5 Mini',
            context_length: 400000,
            supported_parameters: ['tools'],
            architecture: { input_modalities: ['text', 'image'] },
            pricing: { prompt: '0.00000025', completion: '0.000002' },
          },
        ],
      },
    },
  });
  const result = await fetchModels({ provider: OPENROUTER, baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'or', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].supportsTools, true);
  assert.equal(result.models[0].pricing.promptPerMTok, 0.25);
});

test('fetchModels surfaces an upstream rejection as sanitized text', async () => {
  const fetchImpl = stubFetch({ '/models': { status: 401, body: 'bad key sk-SECRET' } });
  const result = await fetchModels({ provider: OPENAI, baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error.includes('SECRET'), false);
  assert.match(result.error, /credentials/i);
});

test('fetchModels reports an unreachable daemon rather than throwing', async () => {
  const fetchImpl = stubFetch({});
  const result = await fetchModels({ provider: OLLAMA, baseUrl: 'http://ollama:11434/v1', apiKey: null, fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /Is the daemon running/);
});

test('fetchModels probes Ollama capabilities through the native endpoint', async () => {
  const calls = [];
  const fetchImpl = stubFetch({
    '/v1/models': { status: 200, body: { data: [{ id: 'qwen3:8b' }] } },
    '/api/show': { status: 200, body: { capabilities: ['completion', 'tools'], model_info: { 'qwen3.context_length': 32768 } } },
  }, { calls });

  const result = await fetchModels({ provider: OLLAMA, baseUrl: 'http://ollama:11434/v1', apiKey: null, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.models[0].contextLength, 32768);
  assert.equal(result.models[0].supportsTools, true);
  // The probe must hit the native root, not the /v1 compatibility path.
  const probe = calls.find((call) => call.url.includes('/api/show'));
  assert.equal(probe.url, 'http://ollama:11434/api/show');
});

test('fetchModels degrades gracefully when the capability probe fails', async () => {
  const fetchImpl = stubFetch({
    '/v1/models': { status: 200, body: { data: [{ id: 'qwen3:8b' }] } },
    '/api/show': { status: 404, body: 'not found' },
  });
  const result = await fetchModels({ provider: OLLAMA, baseUrl: 'http://ollama:11434/v1', apiKey: null, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.models[0].supportsTools, true, 'an old daemon should not lose every model');
  assert.equal(result.models[0].contextLength, 0, 'unknown context must stay unknown, not be invented');
});

test('fetchModels bounds how many models it probes', async () => {
  const probes = [];
  const rows = Array.from({ length: CAPABILITY_PROBE_LIMIT + 10 }, (_, i) => ({ id: `m${i}` }));
  const fetchImpl = async (url, init) => {
    if (url.includes('/api/show')) probes.push(url);
    const body = url.includes('/api/show')
      ? { capabilities: ['tools'], model_info: { 'x.context_length': 32768 } }
      : { data: rows };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const result = await fetchModels({ provider: OLLAMA, baseUrl: 'http://o:11434/v1', apiKey: null, fetchImpl });
  assert.equal(probes.length, CAPABILITY_PROBE_LIMIT);
  assert.equal(result.models.length, rows.length, 'unprobed models still appear in the list');
});

test('fetchModels tolerates a listing that is not an array', async () => {
  const fetchImpl = stubFetch({ '/models': { status: 200, body: { data: 'nope' } } });
  const result = await fetchModels({ provider: OPENAI, baseUrl: 'https://api.openai.com/v1', apiKey: 'k', fetchImpl });
  assert.deepEqual(result, { ok: true, models: [] });
});

test('fetchOllamaCapabilities returns null instead of throwing', async () => {
  const result = await fetchOllamaCapabilities({
    baseUrl: 'http://ollama:11434/v1',
    modelId: 'x',
    fetchImpl: stubFetch({}),
  });
  assert.equal(result, null);
});

test('requestChatCompletion returns the assistant message and usage', async () => {
  const fetchImpl = stubFetch({
    '/chat/completions': {
      status: 200,
      body: {
        model: 'qwen3:8b',
        choices: [{ message: { role: 'assistant', content: 'Flying to Tokyo' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11300, completion_tokens: 12 },
      },
    },
  });
  const result = await requestChatCompletion({
    provider: OLLAMA, baseUrl: 'http://o:11434/v1', apiKey: null, model: 'qwen3:8b',
    messages: [{ role: 'user', content: 'fly to tokyo' }], tools: [], fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.message.content, 'Flying to Tokyo');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.prompt_tokens, 11300);
  assert.equal(result.model, 'qwen3:8b');
});

test('requestChatCompletion never sends tool_choice', async () => {
  const calls = [];
  const fetchImpl = stubFetch({
    '/chat/completions': { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } },
  }, { calls });
  await requestChatCompletion({
    provider: OLLAMA, baseUrl: 'http://o:11434/v1', apiKey: null, model: 'm',
    messages: [], tools: [{ type: 'function', function: { name: 'x', parameters: {} } }], fetchImpl,
  });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(Object.hasOwn(body, 'tool_choice'), false, 'Ollama rejects tool_choice; it must never be sent');
  assert.equal(body.tools.length, 1);
});

test('requestChatCompletion omits an empty tools array', async () => {
  const calls = [];
  const fetchImpl = stubFetch({
    '/chat/completions': { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } },
  }, { calls });
  await requestChatCompletion({
    provider: OPENAI, baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'm',
    messages: [], tools: [], fetchImpl,
  });
  assert.equal(Object.hasOwn(JSON.parse(calls[0].init.body), 'tools'), false);
});

test('requestChatCompletion preserves tool calls from the model', async () => {
  const fetchImpl = stubFetch({
    '/chat/completions': {
      status: 200,
      body: {
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fly_to_location', arguments: '{}' } }],
          },
        }],
      },
    },
  });
  const result = await requestChatCompletion({
    provider: OPENAI, baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'm', messages: [], tools: [], fetchImpl,
  });
  assert.equal(result.message.tool_calls[0].function.name, 'fly_to_location');
  assert.equal(result.finishReason, 'tool_calls');
});

test('requestChatCompletion reports a response with no choices', async () => {
  const fetchImpl = stubFetch({ '/chat/completions': { status: 200, body: { choices: [] } } });
  const result = await requestChatCompletion({
    provider: OPENAI, baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'm', messages: [], tools: [], fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /no message/i);
});

test('requestChatCompletion sanitizes an upstream rejection and keeps the status', async () => {
  const fetchImpl = stubFetch({ '/chat/completions': { status: 429, body: 'slow down' } });
  const result = await requestChatCompletion({
    provider: OPENROUTER, baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'or', model: 'm', messages: [], tools: [], fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.match(result.error, /rate limit/i);
});

test('completionTimeoutFor gives a local daemon room for a cold model load', () => {
  assert.equal(completionTimeoutFor(OLLAMA), LOCAL_COMPLETION_TIMEOUT_MS);
  assert.equal(completionTimeoutFor(OPENAI), COMPLETION_TIMEOUT_MS);
  assert.equal(completionTimeoutFor(null), COMPLETION_TIMEOUT_MS);
  assert.ok(LOCAL_COMPLETION_TIMEOUT_MS > COMPLETION_TIMEOUT_MS);
});

test('requestChatCompletion honours an explicit timeout over the provider default', async () => {
  // A zero-length budget aborts immediately, which proves the override is used
  // rather than the 300s local default silently applying.
  const result = await requestChatCompletion({
    provider: OLLAMA,
    baseUrl: 'http://o:11434/v1',
    apiKey: null,
    model: 'm',
    messages: [],
    tools: [],
    timeoutMs: 1,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Timed out waiting for Ollama/);
});
