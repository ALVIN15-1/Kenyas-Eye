// src/agent/providers.js
// Provider registry for the text agent. Three back ends reach the same
// OpenAI-compatible `/v1/chat/completions` surface, so the only real
// differences are the base URL, whether a key is required, and how each one
// reports what its models can do.
//
// Everything here is pure so it can be imported by BOTH vite.config.js (the
// key-brokering server) and the browser bundle, and exercised under
// `node --test` without a network. Network calls live in the caller.

/**
 * Serialized instructions plus the 28 tool schemas resent on every request.
 * Measured from the live session config, not estimated. A model whose context
 * cannot comfortably hold this will silently truncate its own tool list and
 * then appear to be too stupid to call tools, so this number is the basis for
 * MIN_TOOL_CONTEXT_TOKENS rather than a comment.
 */
export const AGENT_PROMPT_PREFIX_TOKENS = 11300;

/**
 * Smallest context window we will offer for tool use.
 *
 * Ollama in particular defaults `num_ctx` to 4096, which is well under the
 * prefix above; without this gate the failure presents as malformed tool calls
 * rather than as the configuration problem it actually is.
 */
export const MIN_TOOL_CONTEXT_TOKENS = 16384;

/** Context window assumed when a provider reports none. Deliberately below the gate. */
export const UNKNOWN_CONTEXT_TOKENS = 0;

/**
 * Provider definitions. `apiKeyEnv: null` means the provider is reachable
 * without a credential, which is what makes Ollama usable with no signup.
 */
export const AGENT_PROVIDERS = Object.freeze({
  openai: Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    kind: 'hosted',
    defaultBaseUrl: 'https://api.openai.com/v1',
    baseUrlEnv: null,
    apiKeyEnv: 'OPENAI_API_KEY',
    modelsPath: '/models',
    defaultModel: 'gpt-5-mini',
    reportsCapabilities: false,
  }),
  openrouter: Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'hosted',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    baseUrlEnv: 'OPENROUTER_BASE_URL',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    // Server-side filter: OpenRouter lists 300+ tool-capable models out of a
    // much larger catalog, so filtering upstream keeps the payload small.
    modelsPath: '/models?supported_parameters=tools',
    defaultModel: 'openai/gpt-5-mini',
    reportsCapabilities: true,
  }),
  ollama: Object.freeze({
    id: 'ollama',
    label: 'Ollama',
    kind: 'local',
    defaultBaseUrl: 'http://localhost:11434/v1',
    baseUrlEnv: 'OLLAMA_BASE_URL',
    apiKeyEnv: null,
    modelsPath: '/models',
    defaultModel: null,
    reportsCapabilities: false,
  }),
});

/** Every provider id the command and model endpoints accept. */
export const AGENT_PROVIDER_IDS = Object.freeze(Object.keys(AGENT_PROVIDERS));

/** Provider used when configuration names none. */
export const DEFAULT_AGENT_PROVIDER = 'openai';

/**
 * Resolve a provider id to its definition.
 *
 * Total by design: this is the boundary that stops an arbitrary querystring
 * value reaching `fetch` as a base URL, so an unknown id returns null rather
 * than throwing or falling through to a default.
 *
 * @param {string} id
 * @returns {Readonly<object>|null}
 */
export function resolveProvider(id) {
  if (typeof id !== 'string') return null;
  const key = id.trim().toLowerCase();
  return Object.hasOwn(AGENT_PROVIDERS, key) ? AGENT_PROVIDERS[key] : null;
}

/** Whether an id names a known provider. */
export function isKnownProvider(id) {
  return resolveProvider(id) !== null;
}

/**
 * Base URL for a provider, honouring its env override.
 *
 * @param {Readonly<object>} provider
 * @param {Record<string,string|undefined>} env
 * @returns {string} Base URL with any trailing slash removed.
 */
export function providerBaseUrl(provider, env = {}) {
  if (!provider) throw new TypeError('providerBaseUrl requires a provider definition');
  const override = provider.baseUrlEnv ? env[provider.baseUrlEnv] : null;
  const raw = typeof override === 'string' && override.trim() ? override.trim() : provider.defaultBaseUrl;
  return raw.replace(/\/+$/, '');
}

/**
 * API key for a provider, or null when it needs none.
 *
 * @returns {string|null}
 */
export function providerApiKey(provider, env = {}) {
  if (!provider?.apiKeyEnv) return null;
  const value = env[provider.apiKeyEnv];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Whether a provider can actually be used right now.
 *
 * A keyless provider is always "configured" in the sense that we can try it;
 * whether Ollama is actually running is a question only a request can answer,
 * and it is reported separately as a reachability error.
 */
export function isProviderConfigured(provider, env = {}) {
  if (!provider) return false;
  if (!provider.apiKeyEnv) return true;
  return providerApiKey(provider, env) !== null;
}

/**
 * Provider summaries safe to hand the browser: no keys, no base URLs for
 * hosted providers, just what the picker needs to render itself.
 */
export function describeProviders(env = {}) {
  return AGENT_PROVIDER_IDS.map((id) => {
    const provider = AGENT_PROVIDERS[id];
    return {
      id,
      label: provider.label,
      kind: provider.kind,
      configured: isProviderConfigured(provider, env),
      requiresKey: Boolean(provider.apiKeyEnv),
      apiKeyEnv: provider.apiKeyEnv,
      defaultModel: resolveConfiguredModel(provider, env),
    };
  });
}

/**
 * The model this provider should start on: explicit env override first, then
 * the provider's own default. Ollama has no sensible default because it
 * depends entirely on what the operator has pulled.
 */
export function resolveConfiguredModel(provider, env = {}) {
  if (!provider) return null;
  const perProvider = env[`GEV_AGENT_MODEL_${provider.id.toUpperCase()}`];
  if (typeof perProvider === 'string' && perProvider.trim()) return perProvider.trim();
  const shared = env.GEV_AGENT_MODEL;
  if (typeof shared === 'string' && shared.trim()) return shared.trim();
  return provider.defaultModel;
}

/**
 * Provider selected by configuration, falling back to the default when the
 * configured value is absent or unrecognised.
 */
export function resolveConfiguredProvider(env = {}) {
  const configured = resolveProvider(env.GEV_AGENT_PROVIDER);
  return configured || AGENT_PROVIDERS[DEFAULT_AGENT_PROVIDER];
}

/**
 * Ollama's OpenAI-compatible surface omits capability and context metadata, so
 * capability probing uses its native `/api/show`. That lives at the server
 * root rather than under `/v1`.
 *
 * @param {string} baseUrl - The OpenAI-compatible base, e.g. `http://ollama:11434/v1`.
 * @returns {string} The native root, e.g. `http://ollama:11434`.
 */
export function ollamaNativeRoot(baseUrl) {
  return String(baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * Normalized model shape shared by every provider.
 *
 * @typedef {object} AgentModel
 * @property {string} id            Wire id passed straight back as `model`.
 * @property {string} label         Human-facing name.
 * @property {string} provider      Owning provider id.
 * @property {number} contextLength Tokens, or UNKNOWN_CONTEXT_TOKENS.
 * @property {boolean} supportsTools
 * @property {boolean} supportsVision
 * @property {{promptPerMTok:number, completionPerMTok:number}|null} pricing
 */

/** Coerce a possibly-stringy numeric field without letting NaN escape. */
function finiteNumber(value, fallback = 0) {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * OpenRouter prices are per-token strings; the UI wants per-million numbers.
 * Returns null when a model reports no usable pricing so the picker can say
 * "unknown" rather than confidently showing $0.00.
 */
function openRouterPricing(raw) {
  const prompt = finiteNumber(raw?.prompt, Number.NaN);
  const completion = finiteNumber(raw?.completion, Number.NaN);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  return {
    promptPerMTok: prompt * 1_000_000,
    completionPerMTok: completion * 1_000_000,
  };
}

/**
 * Normalize one OpenRouter catalog entry.
 *
 * OpenRouter is the only provider that reports capabilities directly, via
 * `supported_parameters` and `architecture.input_modalities`.
 *
 * @param {object} raw
 * @returns {AgentModel|null} Null when the entry has no usable id.
 */
export function normalizeOpenRouterModel(raw) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const supported = Array.isArray(raw?.supported_parameters) ? raw.supported_parameters : [];
  const modalities = Array.isArray(raw?.architecture?.input_modalities)
    ? raw.architecture.input_modalities
    : [];
  return {
    id,
    label: typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
    provider: 'openrouter',
    contextLength: Math.max(0, Math.floor(finiteNumber(raw?.context_length, UNKNOWN_CONTEXT_TOKENS))),
    supportsTools: supported.includes('tools'),
    supportsVision: modalities.includes('image'),
    pricing: openRouterPricing(raw?.pricing),
  };
}

/**
 * Normalize one OpenAI `/v1/models` entry.
 *
 * OpenAI's listing carries no capability or context metadata at all, so tool
 * support is assumed and the context gate is skipped rather than guessed at.
 * Every current chat model there exceeds the prefix comfortably.
 */
export function normalizeOpenAiModel(raw) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  return {
    id,
    label: id,
    provider: 'openai',
    contextLength: UNKNOWN_CONTEXT_TOKENS,
    supportsTools: true,
    supportsVision: true,
    pricing: null,
  };
}

/**
 * Ollama reports capabilities only from its native `/api/show`, and reports
 * context length inside `model_info` under an architecture-prefixed key such
 * as `qwen3.context_length`. Both are probed defensively: an older daemon that
 * returns neither yields an entry that fails the context gate loudly instead
 * of a model that fails at tool-call time mysteriously.
 *
 * @param {object} raw   Entry from `/v1/models`.
 * @param {object|null} details Response from `/api/show`, when available.
 */
export function normalizeOllamaModel(raw, details = null) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const capabilities = Array.isArray(details?.capabilities) ? details.capabilities : null;
  const info = details?.model_info && typeof details.model_info === 'object' ? details.model_info : {};
  const contextKey = Object.keys(info).find((key) => key.endsWith('.context_length'));
  return {
    id,
    label: id,
    provider: 'ollama',
    contextLength: Math.max(0, Math.floor(finiteNumber(contextKey ? info[contextKey] : null, UNKNOWN_CONTEXT_TOKENS))),
    // A daemon too old to report capabilities gets the benefit of the doubt on
    // tools, because refusing every model there would be worse than a clear
    // downstream error from the model itself.
    supportsTools: capabilities ? capabilities.includes('tools') : true,
    supportsVision: capabilities ? capabilities.includes('vision') : false,
    pricing: { promptPerMTok: 0, completionPerMTok: 0 },
  };
}

/** Why a model was withheld from the picker. */
export const MODEL_REJECTION = Object.freeze({
  NO_TOOLS: 'no-tools',
  CONTEXT_TOO_SMALL: 'context-too-small',
});

/**
 * Split normalized models into those usable for tool calling and those that
 * are not, keeping the reason so the UI can explain itself.
 *
 * A reported context of UNKNOWN_CONTEXT_TOKENS is treated as "unverified" and
 * allowed through, because two of the three providers never report one; the
 * gate exists to catch Ollama's 4096 default, which IS reported.
 *
 * @param {AgentModel[]} models
 * @param {{minContextTokens?: number}} [options]
 * @returns {{usable: AgentModel[], rejected: Array<{model: AgentModel, reason: string}>}}
 */
export function gateModels(models, { minContextTokens = MIN_TOOL_CONTEXT_TOKENS } = {}) {
  const usable = [];
  const rejected = [];
  for (const model of Array.isArray(models) ? models : []) {
    if (!model) continue;
    if (!model.supportsTools) {
      rejected.push({ model, reason: MODEL_REJECTION.NO_TOOLS });
      continue;
    }
    if (model.contextLength !== UNKNOWN_CONTEXT_TOKENS && model.contextLength < minContextTokens) {
      rejected.push({ model, reason: MODEL_REJECTION.CONTEXT_TOO_SMALL });
      continue;
    }
    usable.push(model);
  }
  return { usable, rejected };
}

/**
 * Stable ordering for the picker: cheapest first so the least surprising
 * option is nearest the top, with free/local models ahead of priced ones and
 * unpriced models last.
 */
export function sortModelsForPicker(models) {
  const rank = (model) => {
    if (!model.pricing) return 2;
    return model.pricing.promptPerMTok === 0 ? 0 : 1;
  };
  return [...models].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const priceA = a.pricing?.promptPerMTok ?? Number.POSITIVE_INFINITY;
    const priceB = b.pricing?.promptPerMTok ?? Number.POSITIVE_INFINITY;
    if (priceA !== priceB) return priceA - priceB;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Per-command cost estimate in USD, used for the panel readout.
 *
 * Models the loop this app actually runs: two round trips per command, each
 * resending the full prefix, with cached input billed at the usual 10% once
 * the prefix is warm.
 *
 * @param {AgentModel} model
 * @param {{roundTrips?: number, newInputTokens?: number, outputTokens?: number, cacheDiscount?: number, warm?: boolean}} [options]
 * @returns {number|null} USD per command, or null when the model has no pricing.
 */
export function estimateCommandCostUsd(model, {
  roundTrips = 2,
  newInputTokens = 200,
  outputTokens = 70,
  cacheDiscount = 0.1,
  warm = true,
} = {}) {
  if (!model?.pricing) return null;
  const { promptPerMTok, completionPerMTok } = model.pricing;
  const prefixRate = warm ? promptPerMTok * cacheDiscount : promptPerMTok;
  const prefixCost = (AGENT_PROMPT_PREFIX_TOKENS * roundTrips * prefixRate) / 1_000_000;
  const newInputCost = (newInputTokens * promptPerMTok) / 1_000_000;
  const outputCost = (outputTokens * completionPerMTok) / 1_000_000;
  return prefixCost + newInputCost + outputCost;
}

/** Format a per-command estimate for the panel. Sub-cent values need more places. */
export function formatCommandCostUsd(usd) {
  if (usd === null || !Number.isFinite(usd)) return 'n/a';
  if (usd === 0) return 'free';
  if (usd < 0.001) return `~$${usd.toFixed(5)}`;
  if (usd < 1) return `~$${usd.toFixed(4)}`;
  return `~$${usd.toFixed(2)}`;
}

/**
 * Model used for the five-word HUD summary when nothing else is configured.
 *
 * The summary is a tiny, high-frequency text task (one call per 15s tick while
 * the view changes), so the cheapest capable model is the right default.
 */
export const HUD_SUMMARY_MODEL_DEFAULT = 'gpt-5-nano';

/**
 * Provider that answers the HUD summary.
 *
 * Defaults to whatever the agent uses, because "which LLM does this app talk
 * to" should have one answer: an operator who moved the agent to Ollama for
 * privacy has not meaningfully done so while the HUD still posts their live
 * coordinates to a hosted provider every fifteen seconds. GEV_HUD_PROVIDER
 * overrides when the two genuinely should differ.
 */
export function resolveHudProvider(env = {}) {
  return resolveProvider(env.GEV_HUD_PROVIDER) || resolveConfiguredProvider(env);
}

/**
 * Model for the HUD summary.
 *
 * Resolution order: per-provider override, shared override, the legacy
 * OPENAI_HUD_SUMMARY_MODEL (OpenAI only, kept working because it is documented
 * in .env.example and predates this indirection), then the provider's own
 * default. The net effect with no GEV_* variables set is the historical
 * behaviour: OpenAI and gpt-5-nano.
 */
export function resolveHudModel(provider, env = {}) {
  if (!provider) return null;
  const perProvider = env[`GEV_HUD_MODEL_${provider.id.toUpperCase()}`];
  if (typeof perProvider === 'string' && perProvider.trim()) return perProvider.trim();
  const shared = env.GEV_HUD_MODEL;
  if (typeof shared === 'string' && shared.trim()) return shared.trim();
  if (provider.id === 'openai') {
    const legacy = env.OPENAI_HUD_SUMMARY_MODEL;
    if (typeof legacy === 'string' && legacy.trim()) return legacy.trim();
    return HUD_SUMMARY_MODEL_DEFAULT;
  }
  return resolveConfiguredModel(provider, env);
}
