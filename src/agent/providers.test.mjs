// src/agent/providers.test.mjs
// The provider registry is a security boundary twice over: `resolveProvider`
// is what stops an arbitrary querystring becoming a fetch target, and
// `describeProviders` is what stops an API key reaching the browser. The
// context gate is pinned here too, because the failure it prevents (Ollama's
// 4096 default silently truncating the 11.3k tool prefix) is invisible at
// runtime and presents as an incompetent model rather than a config error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_PROMPT_PREFIX_TOKENS,
  AGENT_PROVIDERS,
  AGENT_PROVIDER_IDS,
  DEFAULT_AGENT_PROVIDER,
  MIN_TOOL_CONTEXT_TOKENS,
  MODEL_REJECTION,
  UNKNOWN_CONTEXT_TOKENS,
  describeProviders,
  estimateCommandCostUsd,
  formatCommandCostUsd,
  gateModels,
  isKnownProvider,
  isProviderConfigured,
  normalizeOllamaModel,
  normalizeOpenAiModel,
  normalizeOpenRouterModel,
  ollamaNativeRoot,
  providerApiKey,
  providerBaseUrl,
  resolveConfiguredModel,
  resolveConfiguredProvider,
  resolveProvider,
  sortModelsForPicker,
} from './providers.js';

/** A representative OpenRouter catalog entry with full capability metadata. */
const OPENROUTER_ENTRY = Object.freeze({
  id: 'openai/gpt-5-mini',
  name: 'OpenAI: GPT-5 Mini',
  context_length: 400000,
  supported_parameters: ['tools', 'temperature', 'structured_outputs'],
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  pricing: { prompt: '0.00000025', completion: '0.000002' },
});

test('resolveProvider accepts known ids case-insensitively', () => {
  for (const id of AGENT_PROVIDER_IDS) {
    assert.equal(resolveProvider(id)?.id, id);
    assert.equal(resolveProvider(id.toUpperCase())?.id, id);
    assert.equal(resolveProvider(` ${id} `)?.id, id);
  }
});

test('resolveProvider rejects unknown and hostile values without throwing', () => {
  for (const hostile of ['', '   ', 'evil', 'http://attacker.test', '__proto__', 'constructor', 'toString']) {
    assert.equal(resolveProvider(hostile), null, `expected null for ${JSON.stringify(hostile)}`);
  }
  for (const nonString of [null, undefined, 42, {}, [], true]) {
    assert.equal(resolveProvider(nonString), null);
  }
});

test('isKnownProvider mirrors resolveProvider', () => {
  assert.equal(isKnownProvider('ollama'), true);
  assert.equal(isKnownProvider('__proto__'), false);
});

test('providerBaseUrl honours the env override and strips trailing slashes', () => {
  const ollama = resolveProvider('ollama');
  assert.equal(providerBaseUrl(ollama, {}), 'http://localhost:11434/v1');
  assert.equal(providerBaseUrl(ollama, { OLLAMA_BASE_URL: 'http://ollama:11434/v1/' }), 'http://ollama:11434/v1');
  assert.equal(providerBaseUrl(ollama, { OLLAMA_BASE_URL: '   ' }), 'http://localhost:11434/v1');
});

test('providerBaseUrl ignores overrides for providers that define none', () => {
  const openai = resolveProvider('openai');
  assert.equal(providerBaseUrl(openai, { OLLAMA_BASE_URL: 'http://attacker.test' }), 'https://api.openai.com/v1');
});

test('providerBaseUrl refuses to run without a provider', () => {
  assert.throws(() => providerBaseUrl(null, {}), TypeError);
});

test('providerApiKey trims, and returns null for keyless providers', () => {
  assert.equal(providerApiKey(resolveProvider('openai'), { OPENAI_API_KEY: '  sk-test  ' }), 'sk-test');
  assert.equal(providerApiKey(resolveProvider('openai'), { OPENAI_API_KEY: '   ' }), null);
  assert.equal(providerApiKey(resolveProvider('openai'), {}), null);
  assert.equal(providerApiKey(resolveProvider('ollama'), { OPENAI_API_KEY: 'sk-test' }), null);
});

test('isProviderConfigured treats keyless providers as always available', () => {
  assert.equal(isProviderConfigured(resolveProvider('ollama'), {}), true);
  assert.equal(isProviderConfigured(resolveProvider('openai'), {}), false);
  assert.equal(isProviderConfigured(resolveProvider('openai'), { OPENAI_API_KEY: 'sk-test' }), true);
  assert.equal(isProviderConfigured(null, {}), false);
});

test('describeProviders never leaks a key or a hosted base URL', () => {
  const env = { OPENAI_API_KEY: 'sk-secret', OPENROUTER_API_KEY: 'or-secret' };
  const serialized = JSON.stringify(describeProviders(env));
  assert.equal(serialized.includes('sk-secret'), false);
  assert.equal(serialized.includes('or-secret'), false);
  assert.equal(serialized.includes('api.openai.com'), false);
});

test('describeProviders reports configuration state per provider', () => {
  const described = describeProviders({ OPENAI_API_KEY: 'sk-test' });
  const byId = Object.fromEntries(described.map((entry) => [entry.id, entry]));
  assert.equal(byId.openai.configured, true);
  assert.equal(byId.openrouter.configured, false);
  assert.equal(byId.ollama.configured, true);
  assert.equal(byId.ollama.requiresKey, false);
  assert.equal(byId.openrouter.apiKeyEnv, 'OPENROUTER_API_KEY');
});

test('resolveConfiguredModel prefers the per-provider override', () => {
  const ollama = resolveProvider('ollama');
  assert.equal(resolveConfiguredModel(ollama, {}), null);
  assert.equal(resolveConfiguredModel(ollama, { GEV_AGENT_MODEL: 'shared:8b' }), 'shared:8b');
  assert.equal(
    resolveConfiguredModel(ollama, { GEV_AGENT_MODEL: 'shared:8b', GEV_AGENT_MODEL_OLLAMA: 'qwen3:8b' }),
    'qwen3:8b',
  );
  assert.equal(resolveConfiguredModel(resolveProvider('openai'), {}), 'gpt-5-mini');
});

test('resolveConfiguredProvider falls back when unset or unrecognized', () => {
  assert.equal(resolveConfiguredProvider({}).id, DEFAULT_AGENT_PROVIDER);
  assert.equal(resolveConfiguredProvider({ GEV_AGENT_PROVIDER: 'nonsense' }).id, DEFAULT_AGENT_PROVIDER);
  assert.equal(resolveConfiguredProvider({ GEV_AGENT_PROVIDER: 'ollama' }).id, 'ollama');
});

test('ollamaNativeRoot strips only a trailing /v1', () => {
  assert.equal(ollamaNativeRoot('http://ollama:11434/v1'), 'http://ollama:11434');
  assert.equal(ollamaNativeRoot('http://ollama:11434/v1/'), 'http://ollama:11434');
  assert.equal(ollamaNativeRoot('http://ollama:11434'), 'http://ollama:11434');
  assert.equal(ollamaNativeRoot('http://host/v1/v1'), 'http://host/v1');
});

test('normalizeOpenRouterModel reads capabilities and converts pricing per million', () => {
  const model = normalizeOpenRouterModel(OPENROUTER_ENTRY);
  assert.equal(model.id, 'openai/gpt-5-mini');
  assert.equal(model.label, 'OpenAI: GPT-5 Mini');
  assert.equal(model.provider, 'openrouter');
  assert.equal(model.contextLength, 400000);
  assert.equal(model.supportsTools, true);
  assert.equal(model.supportsVision, true);
  assert.equal(model.pricing.promptPerMTok, 0.25);
  assert.equal(model.pricing.completionPerMTok, 2);
});

test('normalizeOpenRouterModel marks missing capabilities as absent', () => {
  const model = normalizeOpenRouterModel({ id: 'x/y', context_length: 8192 });
  assert.equal(model.supportsTools, false);
  assert.equal(model.supportsVision, false);
  assert.equal(model.pricing, null);
  assert.equal(model.label, 'x/y');
});

test('normalizeOpenRouterModel rejects entries without a usable id', () => {
  assert.equal(normalizeOpenRouterModel({}), null);
  assert.equal(normalizeOpenRouterModel({ id: '   ' }), null);
  assert.equal(normalizeOpenRouterModel(null), null);
});

test('normalizeOpenAiModel reports unknown context so the gate abstains', () => {
  const model = normalizeOpenAiModel({ id: 'gpt-5-mini' });
  assert.equal(model.contextLength, UNKNOWN_CONTEXT_TOKENS);
  assert.equal(model.supportsTools, true);
  assert.equal(model.pricing, null);
  assert.equal(normalizeOpenAiModel({}), null);
});

test('normalizeOllamaModel reads capabilities and context from /api/show', () => {
  const model = normalizeOllamaModel(
    { id: 'qwen3:8b' },
    { capabilities: ['completion', 'tools'], model_info: { 'qwen3.context_length': 32768 } },
  );
  assert.equal(model.contextLength, 32768);
  assert.equal(model.supportsTools, true);
  assert.equal(model.supportsVision, false);
  assert.deepEqual(model.pricing, { promptPerMTok: 0, completionPerMTok: 0 });
});

test('normalizeOllamaModel detects vision capability', () => {
  const model = normalizeOllamaModel(
    { id: 'llama3.2-vision:11b' },
    { capabilities: ['completion', 'tools', 'vision'], model_info: { 'mllama.context_length': 131072 } },
  );
  assert.equal(model.supportsVision, true);
});

test('normalizeOllamaModel assumes tools when the daemon reports nothing', () => {
  const model = normalizeOllamaModel({ id: 'qwen3:8b' }, null);
  assert.equal(model.supportsTools, true);
  assert.equal(model.contextLength, UNKNOWN_CONTEXT_TOKENS);
});

test('normalizeOllamaModel honours a daemon that reports no tool capability', () => {
  const model = normalizeOllamaModel({ id: 'embed-only' }, { capabilities: ['embedding'] });
  assert.equal(model.supportsTools, false);
});

test('gateModels rejects models that cannot hold the tool prefix', () => {
  const tiny = normalizeOllamaModel({ id: 'tiny' }, { capabilities: ['tools'], model_info: { 'x.context_length': 4096 } });
  const roomy = normalizeOpenRouterModel(OPENROUTER_ENTRY);
  const { usable, rejected } = gateModels([tiny, roomy]);
  assert.deepEqual(usable.map((m) => m.id), ['openai/gpt-5-mini']);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, MODEL_REJECTION.CONTEXT_TOO_SMALL);
});

test('gateModels rejects models without tool support', () => {
  const noTools = normalizeOpenRouterModel({ id: 'x/y', context_length: 200000 });
  const { usable, rejected } = gateModels([noTools]);
  assert.equal(usable.length, 0);
  assert.equal(rejected[0].reason, MODEL_REJECTION.NO_TOOLS);
});

test('gateModels lets unreported context through rather than guessing', () => {
  const { usable } = gateModels([normalizeOpenAiModel({ id: 'gpt-5-mini' })]);
  assert.equal(usable.length, 1);
});

test('gateModels tolerates junk input', () => {
  assert.deepEqual(gateModels(null), { usable: [], rejected: [] });
  assert.deepEqual(gateModels([null, undefined]), { usable: [], rejected: [] });
});

test('the context gate sits above the measured prefix', () => {
  assert.ok(
    MIN_TOOL_CONTEXT_TOKENS > AGENT_PROMPT_PREFIX_TOKENS,
    'the gate must exceed the prefix or it cannot prevent truncation',
  );
});

test('sortModelsForPicker puts free first, then cheapest, then unpriced', () => {
  const models = [
    { id: 'paid-expensive', pricing: { promptPerMTok: 5, completionPerMTok: 15 } },
    { id: 'unpriced', pricing: null },
    { id: 'local', pricing: { promptPerMTok: 0, completionPerMTok: 0 } },
    { id: 'paid-cheap', pricing: { promptPerMTok: 0.25, completionPerMTok: 2 } },
  ];
  assert.deepEqual(
    sortModelsForPicker(models).map((m) => m.id),
    ['local', 'paid-cheap', 'paid-expensive', 'unpriced'],
  );
});

test('sortModelsForPicker does not mutate its input', () => {
  const models = [{ id: 'b', pricing: null }, { id: 'a', pricing: null }];
  sortModelsForPicker(models);
  assert.deepEqual(models.map((m) => m.id), ['b', 'a']);
});

test('estimateCommandCostUsd bills the prefix twice at the cached rate', () => {
  const model = { pricing: { promptPerMTok: 1, completionPerMTok: 0 } };
  const usd = estimateCommandCostUsd(model, { roundTrips: 2, newInputTokens: 0, outputTokens: 0, cacheDiscount: 0.1 });
  const expected = (AGENT_PROMPT_PREFIX_TOKENS * 2 * 0.1) / 1_000_000;
  assert.ok(Math.abs(usd - expected) < 1e-12, `${usd} != ${expected}`);
});

test('estimateCommandCostUsd charges the full rate on a cold prefix', () => {
  const model = { pricing: { promptPerMTok: 1, completionPerMTok: 0 } };
  const cold = estimateCommandCostUsd(model, { roundTrips: 1, newInputTokens: 0, outputTokens: 0, warm: false });
  assert.ok(Math.abs(cold - AGENT_PROMPT_PREFIX_TOKENS / 1_000_000) < 1e-12);
});

test('estimateCommandCostUsd returns zero for a local model and null when unpriced', () => {
  assert.equal(estimateCommandCostUsd({ pricing: { promptPerMTok: 0, completionPerMTok: 0 } }), 0);
  assert.equal(estimateCommandCostUsd({ pricing: null }), null);
  assert.equal(estimateCommandCostUsd(null), null);
});

test('estimateCommandCostUsd tracks the gpt-5-mini figure quoted to the operator', () => {
  const usd = estimateCommandCostUsd(normalizeOpenRouterModel(OPENROUTER_ENTRY));
  assert.ok(usd > 0.0005 && usd < 0.001, `expected roughly $0.0008 per command, got ${usd}`);
});

test('formatCommandCostUsd distinguishes free, sub-cent, and unpriced', () => {
  assert.equal(formatCommandCostUsd(0), 'free');
  assert.equal(formatCommandCostUsd(null), 'n/a');
  assert.equal(formatCommandCostUsd(Number.NaN), 'n/a');
  assert.equal(formatCommandCostUsd(0.00008), '~$0.00008');
  assert.equal(formatCommandCostUsd(0.0008), '~$0.00080');
  assert.equal(formatCommandCostUsd(0.004), '~$0.0040');
  assert.equal(formatCommandCostUsd(2.5), '~$2.50');
});

test('every provider definition is frozen and internally consistent', () => {
  for (const id of AGENT_PROVIDER_IDS) {
    const provider = AGENT_PROVIDERS[id];
    assert.equal(Object.isFrozen(provider), true, `${id} must be frozen`);
    assert.equal(provider.id, id);
    assert.ok(provider.defaultBaseUrl.startsWith('http'), `${id} needs an absolute base URL`);
    assert.ok(provider.modelsPath.startsWith('/'), `${id} models path must be root-relative`);
    assert.ok(['hosted', 'local'].includes(provider.kind));
  }
});
