// src/agent/agentPanel.test.mjs
// Panel formatting is pinned separately from the DOM wiring because it is what
// the operator actually reads while a multi-tool turn runs. The manual tells the
// model NOT to narrate its own tool use, so if these lines are wrong or absent
// the panel simply sits silent and the app looks hung.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_SELECTION_STORAGE_KEY,
  describeToolCall,
  describeToolResult,
  modelCostLabel,
  modelOptionLabel,
  pickInitialModel,
  providerOptionLabel,
  readStoredSelection,
  writeStoredSelection,
} from './agentPanel.js';
import { normalizeOllamaModel, normalizeOpenRouterModel } from './providers.js';

/** In-memory Storage stand-in. */
function memoryStorage(initial = null) {
  const values = new Map(initial ? [[AGENT_SELECTION_STORAGE_KEY, initial]] : []);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    read: () => values.get(AGENT_SELECTION_STORAGE_KEY) ?? null,
  };
}

/** Storage that throws on every access, as in a locked-down privacy mode. */
const hostileStorage = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('SecurityError'); },
};

const LOCAL_MODEL = normalizeOllamaModel(
  { id: 'qwen3:4b' },
  { capabilities: ['tools'], model_info: { 'qwen3.context_length': 262144 } },
);

const HOSTED_MODEL = normalizeOpenRouterModel({
  id: 'openai/gpt-5-mini',
  name: 'GPT-5 Mini',
  context_length: 400000,
  supported_parameters: ['tools'],
  architecture: { input_modalities: ['text', 'image'] },
  pricing: { prompt: '0.00000025', completion: '0.000002' },
});

test('describeToolCall summarizes arguments instead of dumping JSON', () => {
  assert.equal(
    describeToolCall('fly_to_location', { locationId: 'tokyo', viewMode: 'close' }),
    'fly_to_location locationId=tokyo viewMode=close',
  );
});

test('describeToolCall handles a tool with no arguments', () => {
  assert.equal(describeToolCall('zoom_to_globe', {}), 'zoom_to_globe');
  assert.equal(describeToolCall('stop_tracking', null), 'stop_tracking');
});

test('describeToolCall collapses nested and array values', () => {
  const text = describeToolCall('annotate_map', { annotations: [1, 2, 3], options: { a: 1 } });
  assert.match(text, /annotations=\[3\]/);
  assert.match(text, /options=\{…\}/);
});

test('describeToolCall caps the number of arguments shown', () => {
  const text = describeToolCall('set_detection', { a: 1, b: 2, c: 3, d: 4, e: 5 });
  assert.match(text, /\+2$/);
});

test('describeToolCall truncates a long value rather than wrapping the panel', () => {
  const text = describeToolCall('annotate_map', { label: 'x'.repeat(200) });
  assert.ok(text.length < 100, `tool line grew to ${text.length} chars`);
});

test('describeToolResult reflects the ok flag the model is told to honour', () => {
  assert.equal(describeToolResult({ ok: true }), 'ok');
  assert.equal(describeToolResult({ ok: false }), 'failed');
  assert.equal(describeToolResult({ ok: true, partial: true }), 'partial');
  assert.equal(describeToolResult({ ok: false, error: 'Nothing matched UAL999' }), 'failed: Nothing matched UAL999');
  assert.equal(describeToolResult(null), 'done');
});

test('describeToolResult bounds a long upstream error', () => {
  const label = describeToolResult({ ok: false, error: 'e'.repeat(400) });
  assert.ok(label.length < 100);
});

test('providerOptionLabel names the missing variable for an unconfigured provider', () => {
  assert.equal(providerOptionLabel({ label: 'OpenAI', configured: false, apiKeyEnv: 'OPENAI_API_KEY' }),
    'OpenAI (needs OPENAI_API_KEY)');
  assert.equal(providerOptionLabel({ label: 'Ollama', configured: true }), 'Ollama');
});

test('modelOptionLabel surfaces price and vision support', () => {
  assert.equal(modelOptionLabel(HOSTED_MODEL), 'GPT-5 Mini  ·  $0.25/1M · vision');
  assert.equal(modelOptionLabel(LOCAL_MODEL), 'qwen3:4b  ·  free');
});

test('modelOptionLabel degrades to the bare id when nothing is known', () => {
  assert.equal(modelOptionLabel({ label: 'gpt-5-mini', pricing: null, supportsVision: false }), 'gpt-5-mini');
});

test('modelCostLabel reports free for a local model and a figure for a hosted one', () => {
  assert.equal(modelCostLabel(LOCAL_MODEL), 'free');
  assert.match(modelCostLabel(HOSTED_MODEL), /^~\$0\.000/);
  assert.equal(modelCostLabel(null), 'n/a');
});

test('pickInitialModel prefers the remembered choice', () => {
  const models = [HOSTED_MODEL, LOCAL_MODEL];
  assert.equal(pickInitialModel(models, { remembered: 'qwen3:4b' }).id, 'qwen3:4b');
});

test('pickInitialModel falls back to the server default, then the first entry', () => {
  const models = [HOSTED_MODEL, LOCAL_MODEL];
  assert.equal(pickInitialModel(models, { configuredDefault: 'qwen3:4b' }).id, 'qwen3:4b');
  assert.equal(pickInitialModel(models, { remembered: 'gone', configuredDefault: 'also-gone' }).id, HOSTED_MODEL.id);
  assert.equal(pickInitialModel(models).id, HOSTED_MODEL.id);
});

test('pickInitialModel returns null when the gate approved nothing', () => {
  assert.equal(pickInitialModel([], { remembered: 'x' }), null);
  assert.equal(pickInitialModel(null), null);
});

test('selection round-trips through storage', () => {
  const storage = memoryStorage();
  writeStoredSelection({ provider: 'ollama', model: 'qwen3:4b' }, storage);
  assert.deepEqual(readStoredSelection(storage), { provider: 'ollama', model: 'qwen3:4b' });
});

test('readStoredSelection tolerates absent and corrupt values', () => {
  assert.equal(readStoredSelection(memoryStorage()), null);
  assert.equal(readStoredSelection(memoryStorage('not json')), null);
  assert.equal(readStoredSelection(memoryStorage('"a string"')), null);
  assert.deepEqual(readStoredSelection(memoryStorage('{"provider":42}')), { provider: null, model: null });
});

test('storage that throws never breaks the panel', () => {
  assert.equal(readStoredSelection(hostileStorage), null);
  assert.doesNotThrow(() => writeStoredSelection({ provider: 'ollama', model: 'x' }, hostileStorage));
});

test('writeStoredSelection normalizes a partial selection', () => {
  const storage = memoryStorage();
  writeStoredSelection({ provider: 'ollama' }, storage);
  assert.deepEqual(JSON.parse(storage.read()), { provider: 'ollama', model: null });
  writeStoredSelection(null, storage);
  assert.deepEqual(JSON.parse(storage.read()), { provider: null, model: null });
});
