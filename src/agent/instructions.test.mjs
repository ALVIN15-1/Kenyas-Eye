// src/agent/instructions.test.mjs
// This manual was extracted from the Realtime session config so both transports
// could share it. The extraction is only safe if the voice modality still emits
// exactly what the inline array emitted, so the directive count and the precise
// set of overridden indices are pinned here: an accidental edit to a shared line
// changes voice behaviour, and that must be a deliberate, visible act.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GEV_MODALITY,
  GEV_DIRECTIVE_COUNT,
  GEV_MODALITIES,
  buildGevInstructions,
  gevDirectives,
  isKnownModality,
} from './instructions.js';

/** Indices the text modality is allowed to override. Everything else is shared. */
const EXPECTED_TEXT_OVERRIDES = Object.freeze([0, 1, 24, 26, 43]);

test('both modalities emit the full directive list', () => {
  assert.equal(gevDirectives({ modality: 'voice' }).length, GEV_DIRECTIVE_COUNT);
  assert.equal(gevDirectives({ modality: 'text' }).length, GEV_DIRECTIVE_COUNT);
  assert.equal(GEV_DIRECTIVE_COUNT, 50);
});

test('text overrides exactly the channel-specific directives', () => {
  const voice = gevDirectives({ modality: 'voice' });
  const text = gevDirectives({ modality: 'text' });
  const differing = voice.map((line, index) => (line === text[index] ? null : index)).filter((i) => i !== null);
  assert.deepEqual(differing, [...EXPECTED_TEXT_OVERRIDES]);
});

test('the operational manual is shared verbatim', () => {
  const voice = gevDirectives({ modality: 'voice' });
  const text = gevDirectives({ modality: 'text' });
  for (let index = 0; index < GEV_DIRECTIVE_COUNT; index += 1) {
    if (EXPECTED_TEXT_OVERRIDES.includes(index)) continue;
    assert.equal(text[index], voice[index], `directive ${index} must not diverge between transports`);
  }
});

test('the voice identity line survives unchanged', () => {
  assert.match(gevDirectives({ modality: 'voice' })[0], /^You are GEV Voice Control/);
});

test('the text modality never directs the model to produce speech', () => {
  const text = gevDirectives({ modality: 'text' });
  // Negations such as "there is no microphone" are correct and expected; what
  // must not survive is an imperative to speak, which yields stage directions
  // in the transcript instead of an answer.
  const speechImperative = /\b(?:speak|say)\s+(?:exactly|only|aloud|in|one)\b|\bspoken confirmations?\b|\bnatural spoken conversation\b/i;
  for (const index of EXPECTED_TEXT_OVERRIDES) {
    assert.doesNotMatch(text[index], speechImperative, `directive ${index}`);
  }
  assert.match(text[0], /^You are GEV Command/);
  assert.match(text[26], /\bwrite exactly one short confirmation\b/i);
  assert.match(text[43], /\bwritten confirmations\b/i);
});

test('the voice modality retains its speech imperatives', () => {
  const voice = gevDirectives({ modality: 'voice' });
  assert.match(voice[26], /speak exactly one short confirmation/i);
  assert.match(voice[43], /Keep spoken confirmations short/i);
  assert.match(voice[1], /natural spoken conversation/i);
});

test('the counting contract is present in both transports', () => {
  for (const modality of GEV_MODALITIES) {
    const joined = buildGevInstructions({ modality });
    assert.match(joined, /COUNTING CONTRACT/);
    assert.match(joined, /WHITEBOARD THE WORLD/);
    assert.match(joined, /NAMED VIEWS/);
  }
});

test('buildGevInstructions joins directives with newlines', () => {
  const joined = buildGevInstructions({ modality: 'text' });
  assert.equal(joined.split('\n').length, GEV_DIRECTIVE_COUNT);
});

test('an unknown or missing modality falls back to the default', () => {
  const fallback = buildGevInstructions({ modality: 'semaphore' });
  assert.equal(fallback, buildGevInstructions({ modality: DEFAULT_GEV_MODALITY }));
  assert.equal(buildGevInstructions(), buildGevInstructions({ modality: DEFAULT_GEV_MODALITY }));
  assert.equal(buildGevInstructions({}), buildGevInstructions({ modality: DEFAULT_GEV_MODALITY }));
});

test('isKnownModality is total', () => {
  assert.equal(isKnownModality('voice'), true);
  assert.equal(isKnownModality('text'), true);
  assert.equal(isKnownModality('semaphore'), false);
  assert.equal(isKnownModality(null), false);
  assert.equal(isKnownModality(42), false);
});

test('gevDirectives returns a fresh array callers cannot use to mutate shared state', () => {
  const first = gevDirectives({ modality: 'voice' });
  first[0] = 'tampered';
  assert.notEqual(gevDirectives({ modality: 'voice' })[0], 'tampered');
});

test('the prefix stays within the budget the context gate assumes', () => {
  // ~4 chars per token; the gate reserves 16,384 tokens for prompt plus tools.
  const approxTokens = Math.ceil(buildGevInstructions({ modality: 'text' }).length / 4);
  assert.ok(approxTokens < 6000, `instructions grew to ~${approxTokens} tokens; revisit MIN_TOOL_CONTEXT_TOKENS`);
});
