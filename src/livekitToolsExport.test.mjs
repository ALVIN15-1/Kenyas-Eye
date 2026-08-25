import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { extractRealtimeTools } from '../scripts/export-realtime-tools.mjs';

const root = new URL('..', import.meta.url).pathname;
const viteConfigPath = join(root, 'vite.config.js');
const exportedToolsPath = join(root, 'livekit-voice', 'tools.json');

test('LiveKit tools export stays in sync with the Realtime tool literal', () => {
  const source = readFileSync(viteConfigPath, 'utf8');
  const tools = extractRealtimeTools(source);

  assert.ok(Array.isArray(tools), 'tools must be an array');
  assert.ok(tools.length >= 20, `expected the full voice tool registry, got ${tools.length}`);
  assert.ok(tools.some((tool) => tool.name === 'fly_to_location'));
  assert.ok(tools.some((tool) => tool.name === 'annotate_map'));

  assert.ok(existsSync(exportedToolsPath), 'livekit-voice/tools.json must be generated and committed');
  const exported = JSON.parse(readFileSync(exportedToolsPath, 'utf8'));
  assert.deepEqual(exported, tools);
});
