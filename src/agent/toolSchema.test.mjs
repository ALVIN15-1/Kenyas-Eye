// src/agent/toolSchema.test.mjs
// This validator is the only thing standing between a local model's improvised
// tool call and the live action runner. Ollama's OpenAI-compatible endpoint
// does not support `tool_choice`, so a malformed call cannot be prevented, only
// caught and fed back. Every malformation pinned here is one observed from
// small models in practice: fenced JSON, invented parameters, enum drift,
// wrong scalar types, and arguments arriving as an array.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeValidationErrors,
  indexToolsByName,
  parseToolArguments,
  prepareToolCall,
  toChatCompletionTools,
  validateToolArguments,
} from './toolSchema.js';

/**
 * A faithful reduction of the real `fly_to_location` schema: the enum, the
 * bounded coordinates, and the sealed property set are exactly the features
 * small models get wrong.
 */
const FLY_TO_LOCATION = Object.freeze({
  type: 'function',
  name: 'fly_to_location',
  description: 'Fly the camera to a place.',
  parameters: Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: {
      locationId: { type: 'string', enum: ['austin', 'sf', 'nyc', 'tokyo'] },
      query: { type: 'string', maxLength: 120 },
      latitude: { type: 'number', minimum: -90, maximum: 90 },
      longitude: { type: 'number', minimum: -180, maximum: 180 },
      viewMode: { type: 'string', enum: ['close', 'overview'] },
    },
  }),
});

const ANNOTATE_MAP = Object.freeze({
  type: 'function',
  name: 'annotate_map',
  description: 'Draw annotations.',
  parameters: Object.freeze({
    type: 'object',
    required: ['annotations'],
    additionalProperties: false,
    properties: {
      annotations: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: {
          type: 'object',
          required: ['kind'],
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['outline', 'mark', 'route'] },
            label: { type: 'string' },
            persist: { type: 'boolean' },
          },
        },
      },
    },
  }),
});

const TOOLS = Object.freeze([FLY_TO_LOCATION, ANNOTATE_MAP]);
const TOOL_INDEX = indexToolsByName(TOOLS);

test('toChatCompletionTools nests the Realtime shape without altering schemas', () => {
  const [flyTo] = toChatCompletionTools(TOOLS);
  assert.equal(flyTo.type, 'function');
  assert.equal(flyTo.function.name, 'fly_to_location');
  assert.equal(flyTo.function.description, 'Fly the camera to a place.');
  assert.equal(flyTo.function.parameters, FLY_TO_LOCATION.parameters);
});

test('toChatCompletionTools converts every tool it is given', () => {
  assert.equal(toChatCompletionTools(TOOLS).length, TOOLS.length);
});

test('toChatCompletionTools drops entries without a name and tolerates junk', () => {
  assert.deepEqual(toChatCompletionTools(null), []);
  assert.deepEqual(toChatCompletionTools([null, {}, { name: '' }]), []);
});

test('toChatCompletionTools substitutes an empty schema when parameters are absent', () => {
  const [tool] = toChatCompletionTools([{ name: 'stop_tracking' }]);
  assert.deepEqual(tool.function.parameters, { type: 'object', properties: {} });
  assert.equal(tool.function.description, '');
});

test('indexToolsByName provides O(1) lookup and ignores malformed entries', () => {
  assert.equal(TOOL_INDEX.get('fly_to_location'), FLY_TO_LOCATION);
  assert.equal(TOOL_INDEX.size, 2);
  assert.equal(indexToolsByName([null, { name: '' }]).size, 0);
  assert.equal(indexToolsByName(null).size, 0);
});

test('validateToolArguments accepts a well-formed call', () => {
  const { valid, errors } = validateToolArguments(FLY_TO_LOCATION.parameters, {
    locationId: 'tokyo',
    viewMode: 'close',
  });
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test('validateToolArguments rejects a value outside an enum', () => {
  const { valid, errors } = validateToolArguments(FLY_TO_LOCATION.parameters, { locationId: 'atlantis' });
  assert.equal(valid, false);
  assert.equal(errors[0].path, 'locationId');
  assert.match(errors[0].message, /must be one of: austin, sf, nyc, tokyo/);
});

test('validateToolArguments rejects an invented parameter when the schema is sealed', () => {
  const { valid, errors } = validateToolArguments(FLY_TO_LOCATION.parameters, { city: 'Tokyo' });
  assert.equal(valid, false);
  assert.equal(errors[0].path, 'city');
  assert.match(errors[0].message, /not a recognized parameter/);
});

test('validateToolArguments enforces numeric bounds', () => {
  const tooFarNorth = validateToolArguments(FLY_TO_LOCATION.parameters, { latitude: 120 });
  assert.equal(tooFarNorth.valid, false);
  assert.match(tooFarNorth.errors[0].message, /must be <= 90/);

  const tooFarSouth = validateToolArguments(FLY_TO_LOCATION.parameters, { latitude: -120 });
  assert.match(tooFarSouth.errors[0].message, /must be >= -90/);
});

test('validateToolArguments rejects a stringified number, the classic local-model slip', () => {
  const { valid, errors } = validateToolArguments(FLY_TO_LOCATION.parameters, { latitude: '51.5' });
  assert.equal(valid, false);
  assert.match(errors[0].message, /expected number, received string/);
});

test('validateToolArguments enforces maxLength on strings', () => {
  const { valid } = validateToolArguments(FLY_TO_LOCATION.parameters, { query: 'x'.repeat(121) });
  assert.equal(valid, false);
});

test('validateToolArguments reports a missing required property', () => {
  const { valid, errors } = validateToolArguments(ANNOTATE_MAP.parameters, {});
  assert.equal(valid, false);
  assert.equal(errors[0].path, 'annotations');
  assert.match(errors[0].message, /is required/);
});

test('validateToolArguments walks into array items', () => {
  const { valid, errors } = validateToolArguments(ANNOTATE_MAP.parameters, {
    annotations: [{ kind: 'outline' }, { kind: 'scribble' }],
  });
  assert.equal(valid, false);
  assert.equal(errors[0].path, 'annotations[1].kind');
});

test('validateToolArguments enforces array bounds', () => {
  const empty = validateToolArguments(ANNOTATE_MAP.parameters, { annotations: [] });
  assert.match(empty.errors[0].message, /at least 1 items/);

  const overfull = validateToolArguments(ANNOTATE_MAP.parameters, {
    annotations: Array.from({ length: 9 }, () => ({ kind: 'mark' })),
  });
  assert.match(overfull.errors[0].message, /at most 8 items/);
});

test('validateToolArguments detects an array supplied where an object belongs', () => {
  const { valid, errors } = validateToolArguments(ANNOTATE_MAP.parameters, { annotations: [['outline']] });
  assert.equal(valid, false);
  assert.match(errors[0].message, /expected object, received array/);
});

test('validateToolArguments abstains when no schema is supplied', () => {
  assert.deepEqual(validateToolArguments(undefined, { anything: true }), { valid: true, errors: [] });
  assert.deepEqual(validateToolArguments(null, {}), { valid: true, errors: [] });
});

test('validateToolArguments treats an explicit undefined as absent', () => {
  const { valid } = validateToolArguments(FLY_TO_LOCATION.parameters, { locationId: undefined });
  assert.equal(valid, true);
});

test('parseToolArguments accepts the no-argument forms', () => {
  for (const empty of [undefined, null, '', '   ']) {
    assert.deepEqual(parseToolArguments(empty), { ok: true, args: {} });
  }
});

test('parseToolArguments recovers JSON wrapped in a Markdown fence', () => {
  const fenced = '```json\n{"locationId":"tokyo"}\n```';
  assert.deepEqual(parseToolArguments(fenced), { ok: true, args: { locationId: 'tokyo' } });
  assert.deepEqual(parseToolArguments('```\n{"a":1}\n```'), { ok: true, args: { a: 1 } });
});

test('parseToolArguments passes through an already-parsed object', () => {
  assert.deepEqual(parseToolArguments({ locationId: 'sf' }), { ok: true, args: { locationId: 'sf' } });
});

test('parseToolArguments refuses arrays and scalars', () => {
  assert.equal(parseToolArguments(['a']).ok, false);
  assert.equal(parseToolArguments('[1,2]').ok, false);
  assert.equal(parseToolArguments('"just a string"').ok, false);
  assert.equal(parseToolArguments('42').ok, false);
  assert.equal(parseToolArguments(42).ok, false);
});

test('parseToolArguments reports unparseable JSON without throwing', () => {
  const result = parseToolArguments('{locationId: tokyo}');
  assert.equal(result.ok, false);
  assert.match(result.error, /not valid JSON/);
});

test('describeValidationErrors renders a compact correction', () => {
  const text = describeValidationErrors([
    { path: 'latitude', message: 'must be <= 90' },
    { path: 'city', message: 'is not a recognized parameter' },
  ]);
  assert.equal(text, 'latitude must be <= 90; city is not a recognized parameter');
});

test('describeValidationErrors caps its own length to protect the context budget', () => {
  const many = Array.from({ length: 10 }, (_, index) => ({ path: `p${index}`, message: 'bad' }));
  const text = describeValidationErrors(many, { maxErrors: 3 });
  assert.match(text, /and 7 more$/);
});

test('describeValidationErrors returns empty for no errors', () => {
  assert.equal(describeValidationErrors([]), '');
  assert.equal(describeValidationErrors(null), '');
});

test('prepareToolCall returns dispatch-ready arguments for a valid call', () => {
  const result = prepareToolCall(
    { name: 'fly_to_location', arguments: '{"locationId":"tokyo"}' },
    TOOL_INDEX,
  );
  assert.deepEqual(result, { ok: true, name: 'fly_to_location', args: { locationId: 'tokyo' } });
});

test('prepareToolCall rejects a hallucinated tool name', () => {
  const result = prepareToolCall({ name: 'launch_missiles', arguments: '{}' }, TOOL_INDEX);
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown tool "launch_missiles"/);
});

test('prepareToolCall rejects a call with no name', () => {
  assert.equal(prepareToolCall({}, TOOL_INDEX).ok, false);
  assert.equal(prepareToolCall(null, TOOL_INDEX).ok, false);
});

test('prepareToolCall surfaces schema violations as correctable text', () => {
  const result = prepareToolCall(
    { name: 'fly_to_location', arguments: '{"locationId":"atlantis"}' },
    TOOL_INDEX,
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid arguments for fly_to_location/);
  assert.match(result.error, /must be one of/);
});

test('prepareToolCall surfaces malformed JSON as correctable text', () => {
  const result = prepareToolCall({ name: 'fly_to_location', arguments: '{oops' }, TOOL_INDEX);
  assert.equal(result.ok, false);
  assert.match(result.error, /not valid JSON/);
});

test('prepareToolCall tolerates a missing index rather than throwing', () => {
  assert.equal(prepareToolCall({ name: 'fly_to_location' }, null).ok, false);
});

test('prepareToolCall accepts a no-argument tool call', () => {
  const index = indexToolsByName([{ name: 'stop_tracking' }]);
  assert.deepEqual(prepareToolCall({ name: 'stop_tracking', arguments: '' }, index), {
    ok: true,
    name: 'stop_tracking',
    args: {},
  });
});
