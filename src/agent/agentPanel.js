// src/agent/agentPanel.js
// The typed-command console: a provider picker, a transcript, and an input.
//
// It reuses the existing panel chrome ([data-panel-id] gives it drag, collapse,
// and position persistence for free) and the voice widget's header idiom, where
// a model selector and a live cost readout sit beside the title.
//
// Formatting and selection logic are exported separately from the DOM wiring so
// they can be tested without a browser; `mountAgentPanel` is the only part that
// touches the document.

import { createAgentSession } from './agentLoop.js';
import { estimateCommandCostUsd, formatCommandCostUsd } from './providers.js';

/** Where the provider and model choice persist between sessions. */
export const AGENT_SELECTION_STORAGE_KEY = 'godsEyeView.agent.selection.v1';

/** Transcript entry kinds, which map to CSS classes. */
export const ENTRY_KIND = Object.freeze({
  USER: 'user',
  AGENT: 'agent',
  TOOL: 'tool',
  ERROR: 'error',
});

/** Status strings shown under the input. */
export const AGENT_STATUS = Object.freeze({
  READY: 'READY',
  THINKING: 'THINKING',
  RUNNING: 'RUNNING',
  UNAVAILABLE: 'UNAVAILABLE',
});

/**
 * Render a tool call as a compact one-liner.
 *
 * The manual tells the model not to narrate its own tool use, so without this
 * the panel would sit silent through a multi-tool turn. Arguments are
 * summarized rather than dumped: a full JSON blob buries the useful word.
 */
export function describeToolCall(name, args) {
  const values = args && typeof args === 'object' ? Object.entries(args) : [];
  if (!values.length) return name;
  const summary = values
    .slice(0, 3)
    .map(([key, value]) => {
      if (Array.isArray(value)) return `${key}=[${value.length}]`;
      if (value !== null && typeof value === 'object') return `${key}={…}`;
      return `${key}=${String(value).slice(0, 32)}`;
    })
    .join(' ');
  const omitted = values.length - 3;
  return omitted > 0 ? `${name} ${summary} +${omitted}` : `${name} ${summary}`;
}

/**
 * Reduce an action result to a short status suffix.
 *
 * The model is instructed never to claim an action without `ok: true`, so the
 * panel shows the same signal the model is reading.
 */
export function describeToolResult(result) {
  if (!result || typeof result !== 'object') return 'done';
  if (result.ok === false) return result.error ? `failed: ${String(result.error).slice(0, 80)}` : 'failed';
  if (result.partial) return 'partial';
  return 'ok';
}

/** Option label for a provider, marking the ones that need configuration. */
export function providerOptionLabel(provider) {
  if (provider.configured) return provider.label;
  return `${provider.label} (needs ${provider.apiKeyEnv})`;
}

/**
 * Option label for a model: identity, then the two facts that decide whether it
 * is a good choice here, which are price and whether it can see images.
 */
export function modelOptionLabel(model) {
  const parts = [model.label];
  if (model.pricing) {
    parts.push(model.pricing.promptPerMTok === 0 ? 'free' : `$${model.pricing.promptPerMTok}/1M`);
  }
  if (model.supportsVision) parts.push('vision');
  return parts.length > 1 ? `${parts[0]}  ·  ${parts.slice(1).join(' · ')}` : parts[0];
}

/** Per-command cost estimate for the footer readout. */
export function modelCostLabel(model) {
  if (!model) return 'n/a';
  return formatCommandCostUsd(estimateCommandCostUsd(model));
}

/**
 * Read the persisted provider and model choice.
 *
 * Storage can throw outright in privacy modes, so every access is guarded and
 * a failure degrades to "no preference" rather than breaking the panel.
 */
export function readStoredSelection(storage) {
  try {
    const store = storage ?? globalThis.localStorage;
    const raw = store?.getItem(AGENT_SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      provider: typeof parsed.provider === 'string' ? parsed.provider : null,
      model: typeof parsed.model === 'string' ? parsed.model : null,
    };
  } catch {
    return null;
  }
}

/** Persist the provider and model choice, best-effort. */
export function writeStoredSelection(selection, storage) {
  try {
    const store = storage ?? globalThis.localStorage;
    store?.setItem(AGENT_SELECTION_STORAGE_KEY, JSON.stringify({
      provider: selection?.provider ?? null,
      model: selection?.model ?? null,
    }));
  } catch {
    // A panel preference is never worth breaking the app over.
  }
}

/**
 * Choose which model to preselect.
 *
 * Order: the operator's remembered choice, then the server's configured
 * default, then the first model the gate approved.
 */
export function pickInitialModel(models, { remembered, configuredDefault } = {}) {
  if (!Array.isArray(models) || !models.length) return null;
  const byId = new Map(models.map((model) => [model.id, model]));
  if (remembered && byId.has(remembered)) return byId.get(remembered);
  if (configuredDefault && byId.has(configuredDefault)) return byId.get(configuredDefault);
  return models[0];
}

/**
 * Mount the agent panel against an existing DOM subtree.
 *
 * @param {{
 *   root?: Document,
 *   runAction: (name: string, args: object) => Promise<object>,
 *   fetchImpl?: typeof fetch,
 *   storage?: Storage,
 * }} options
 * @returns {{destroy: () => void, session: object}|null} Null when the markup is absent.
 */
export function mountAgentPanel({
  root = globalThis.document,
  runAction,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  storage,
} = {}) {
  const panel = root?.getElementById?.('agent-panel');
  if (!panel) return null;

  const providerSelect = root.getElementById('agent-provider');
  const modelSelect = root.getElementById('agent-model');
  const transcript = root.getElementById('agent-transcript');
  const form = root.getElementById('agent-form');
  const input = root.getElementById('agent-input');
  const sendButton = root.getElementById('agent-send');
  const statusEl = root.getElementById('agent-status');
  const costEl = root.getElementById('agent-cost');

  const session = createAgentSession({ runAction, fetchImpl });
  let providers = [];
  let models = [];
  let selection = readStoredSelection(storage) || { provider: null, model: null };

  function append(kind, text) {
    const entry = root.createElement('div');
    entry.className = `agent-entry agent-entry-${kind}`;
    entry.textContent = text;
    transcript.appendChild(entry);
    transcript.scrollTop = transcript.scrollHeight;
    return entry;
  }

  function setStatus(status, detail = '') {
    statusEl.textContent = detail ? `${status} · ${detail}` : status;
    panel.dataset.agentStatus = status.toLowerCase();
  }

  function currentModel() {
    return models.find((model) => model.id === modelSelect.value) || null;
  }

  function refreshCost() {
    costEl.textContent = modelCostLabel(currentModel());
  }

  function setBusy(busy) {
    input.disabled = busy;
    sendButton.disabled = busy;
    providerSelect.disabled = busy;
    modelSelect.disabled = busy;
  }

  async function loadModels(providerId) {
    modelSelect.innerHTML = '';
    models = [];
    refreshCost();

    // The select is empty from here until the listing lands. Submitting in that
    // window would send no model at all, so the input stays disabled until
    // there is something real to send.
    setBusy(true);
    providerSelect.disabled = false;

    if (!providerId) {
      setBusy(false);
      return;
    }

    const provider = providers.find((entry) => entry.id === providerId);
    if (provider && !provider.configured) {
      setStatus(AGENT_STATUS.UNAVAILABLE, `set ${provider.apiKeyEnv}`);
      providerSelect.disabled = false;
      return;
    }

    setStatus(AGENT_STATUS.THINKING, 'loading models');
    try {
      const response = await fetchImpl(`/api/agent/models?provider=${encodeURIComponent(providerId)}`);
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) throw new Error(data?.error || `HTTP ${response.status}`);

      models = Array.isArray(data.models) ? data.models : [];
      for (const model of models) {
        const option = root.createElement('option');
        option.value = model.id;
        option.textContent = modelOptionLabel(model);
        modelSelect.appendChild(option);
      }

      const initial = pickInitialModel(models, {
        remembered: selection.model,
        configuredDefault: data.defaultModel,
      });
      if (initial) modelSelect.value = initial.id;
      refreshCost();
      setStatus(models.length ? AGENT_STATUS.READY : AGENT_STATUS.UNAVAILABLE, models.length ? '' : 'no usable models');
      // Only a provider with a usable model may accept input.
      setBusy(models.length === 0);
      providerSelect.disabled = false;
    } catch (error) {
      setStatus(AGENT_STATUS.UNAVAILABLE);
      append(ENTRY_KIND.ERROR, error?.message || 'Could not list models');
      providerSelect.disabled = false;
    }
  }

  async function loadConfig() {
    try {
      const response = await fetchImpl('/api/agent/config');
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) throw new Error(data?.error || `HTTP ${response.status}`);

      providers = Array.isArray(data.providers) ? data.providers : [];
      for (const provider of providers) {
        const option = root.createElement('option');
        option.value = provider.id;
        option.textContent = providerOptionLabel(provider);
        providerSelect.appendChild(option);
      }

      const remembered = providers.find((entry) => entry.id === selection.provider && entry.configured);
      const chosen = remembered?.id
        || (providers.find((entry) => entry.id === data.defaultProvider && entry.configured)?.id)
        || providers.find((entry) => entry.configured)?.id
        || data.defaultProvider;
      if (chosen) providerSelect.value = chosen;
      await loadModels(providerSelect.value);
    } catch (error) {
      setStatus(AGENT_STATUS.UNAVAILABLE);
      append(ENTRY_KIND.ERROR, error?.message || 'Agent backend unavailable');
    }
  }

  function handleEvent(event) {
    if (event.type === 'message' && event.message.role === 'user') {
      append(ENTRY_KIND.USER, event.message.content);
    } else if (event.type === 'message') {
      append(ENTRY_KIND.AGENT, event.message.content);
    } else if (event.type === 'tool-start') {
      setStatus(AGENT_STATUS.RUNNING, event.name);
      append(ENTRY_KIND.TOOL, describeToolCall(event.name, event.args));
    } else if (event.type === 'tool-result') {
      const last = transcript.lastElementChild;
      if (last?.classList.contains('agent-entry-tool')) {
        last.dataset.outcome = describeToolResult(event.result);
      }
    } else if (event.type === 'request') {
      setStatus(AGENT_STATUS.THINKING);
    } else if (event.type === 'error') {
      append(ENTRY_KIND.ERROR, event.error);
    }
  }

  async function submit(submitEvent) {
    submitEvent?.preventDefault?.();
    const text = input.value.trim();
    if (!text || session.busy) return;
    if (!modelSelect.value) {
      append(ENTRY_KIND.ERROR, 'Select a model before sending a command.');
      return;
    }

    input.value = '';
    setBusy(true);
    setStatus(AGENT_STATUS.THINKING);
    try {
      const result = await session.send(text, {
        provider: providerSelect.value,
        model: modelSelect.value,
        onEvent: handleEvent,
      });
      if (!result.ok && result.error) append(ENTRY_KIND.ERROR, result.error);
    } finally {
      setBusy(false);
      setStatus(AGENT_STATUS.READY);
    }
  }

  async function onProviderChange() {
    selection = { provider: providerSelect.value, model: null };
    writeStoredSelection(selection, storage);
    // The transcript references tools the previous model called; a new back end
    // starts clean rather than inheriting a half-finished exchange.
    session.reset();
    await loadModels(providerSelect.value);
  }

  function onModelChange() {
    selection = { provider: providerSelect.value, model: modelSelect.value };
    writeStoredSelection(selection, storage);
    refreshCost();
  }

  form.addEventListener('submit', submit);
  providerSelect.addEventListener('change', onProviderChange);
  modelSelect.addEventListener('change', onModelChange);

  setStatus(AGENT_STATUS.THINKING, 'connecting');
  loadConfig();

  return {
    session,
    destroy() {
      form.removeEventListener('submit', submit);
      providerSelect.removeEventListener('change', onProviderChange);
      modelSelect.removeEventListener('change', onModelChange);
      session.abort();
    },
  };
}
