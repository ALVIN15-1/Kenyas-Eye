// src/agent/agentLoop.test.mjs
// The loop is where a typed command becomes real camera movement, so the cases
// that matter are the ones that would strand the user: a tool that throws must
// reach the model as a failed result rather than killing the session, a model
// that never stops calling tools must be cut off, and a transcript must stay
// well-formed enough for the next turn to be accepted upstream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_EVENTS, MAX_TOOL_ROUNDS, createAgentSession, emptyUsage } from './agentLoop.js';

/**
 * Build a fetch stub that replies with a scripted sequence of turns.
 *
 * @param {object[]} turns Successive JSON bodies for /api/agent/command.
 */
function scriptedFetch(turns, { calls = [] } = {}) {
  let index = 0;
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const turn = turns[Math.min(index, turns.length - 1)];
    index += 1;
    return {
      ok: turn.status === undefined || turn.status === 200,
      status: turn.status ?? 200,
      json: async () => turn.body,
    };
  };
}

/** A turn where the model answers in prose. */
const plainAnswer = (content) => ({
  body: { message: { role: 'assistant', content }, toolCalls: [], usage: { prompt_tokens: 9782, completion_tokens: 10 } },
});

/** A turn where the model calls one tool. */
const toolTurn = (name, args, id = 'call_1') => ({
  body: {
    message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    toolCalls: [{ id, name, args }],
    usage: { prompt_tokens: 9782, completion_tokens: 20 },
  },
});

test('createAgentSession requires an action runner', () => {
  assert.throws(() => createAgentSession({}), TypeError);
  assert.throws(() => createAgentSession({ runAction: 'nope' }), TypeError);
});

test('a prose answer completes in one round', async () => {
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: scriptedFetch([plainAnswer('Tokyo is the capital of Japan.')]),
  });
  const result = await session.send('what is Tokyo?');
  assert.deepEqual(result, { ok: true, content: 'Tokyo is the capital of Japan.', rounds: 1 });
});

test('a tool call is executed and its result fed back', async () => {
  const ran = [];
  const session = createAgentSession({
    runAction: async (name, args) => {
      ran.push({ name, args });
      return { ok: true, action: name };
    },
    fetchImpl: scriptedFetch([toolTurn('fly_to_location', { locationId: 'tokyo' }), plainAnswer('Flying to Tokyo')]),
  });

  const result = await session.send('fly to Tokyo');
  assert.equal(result.ok, true);
  assert.equal(result.content, 'Flying to Tokyo');
  assert.equal(result.rounds, 2);
  assert.deepEqual(ran, [{ name: 'fly_to_location', args: { locationId: 'tokyo' } }]);

  const toolMessage = session.transcript.find((m) => m.role === 'tool');
  assert.equal(toolMessage.tool_call_id, 'call_1');
  assert.deepEqual(JSON.parse(toolMessage.content), { ok: true, action: 'fly_to_location' });
});

test('the transcript stays in a shape the upstream will accept', async () => {
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: scriptedFetch([toolTurn('zoom_to_globe', {}), plainAnswer('Zoomed out')]),
  });
  await session.send('zoom out');
  assert.deepEqual(session.transcript.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  // Every tool result answers a call that precedes it.
  const callIds = new Set(session.transcript.filter((m) => m.tool_calls).flatMap((m) => m.tool_calls.map((c) => c.id)));
  for (const message of session.transcript.filter((m) => m.role === 'tool')) {
    assert.ok(callIds.has(message.tool_call_id));
  }
});

test('a thrown action becomes a failed tool result rather than ending the session', async () => {
  const session = createAgentSession({
    runAction: async () => { throw new Error('Cesium viewer is not ready'); },
    fetchImpl: scriptedFetch([toolTurn('fly_to_location', { locationId: 'sf' }), plainAnswer('I could not fly there')]),
  });

  const result = await session.send('fly to SF');
  assert.equal(result.ok, true, 'the session must survive a throwing action');
  const toolMessage = session.transcript.find((m) => m.role === 'tool');
  assert.deepEqual(JSON.parse(toolMessage.content), {
    ok: false, action: 'fly_to_location', error: 'Cesium viewer is not ready',
  });
});

test('an action returning undefined is reported as a bare success', async () => {
  const session = createAgentSession({
    runAction: async () => undefined,
    fetchImpl: scriptedFetch([toolTurn('stop_tracking', {}), plainAnswer('Stopped')]),
  });
  await session.send('stop tracking');
  assert.deepEqual(JSON.parse(session.transcript.find((m) => m.role === 'tool').content), {
    ok: true, action: 'stop_tracking',
  });
});

test('a model that never stops calling tools is cut off', async () => {
  let runs = 0;
  const session = createAgentSession({
    runAction: async () => { runs += 1; return { ok: true }; },
    fetchImpl: scriptedFetch([toolTurn('adjust_camera_zoom', { amount: 1 })]),
  });
  const result = await session.send('zoom in forever');
  assert.equal(result.ok, false);
  assert.match(result.error, new RegExp(`Stopped after ${MAX_TOOL_ROUNDS} tool rounds`));
  assert.equal(runs, MAX_TOOL_ROUNDS);
});

test('the round cap is configurable for tighter deployments', async () => {
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: scriptedFetch([toolTurn('adjust_camera_zoom', {})]),
    maxToolRounds: 2,
  });
  const result = await session.send('zoom');
  assert.match(result.error, /Stopped after 2 tool rounds/);
});

test('a server error surfaces its message verbatim', async () => {
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: scriptedFetch([{ status: 502, body: { error: 'Ollama truncated the tool prefix' } }]),
  });
  const result = await session.send('fly to Tokyo');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Ollama truncated the tool prefix');
});

test('a non-JSON server response still produces a usable error', async () => {
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } }),
  });
  const result = await session.send('hi');
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 500/);
});

test('an empty command is rejected without a request', async () => {
  const calls = [];
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: scriptedFetch([plainAnswer('x')], { calls }),
  });
  assert.equal((await session.send('   ')).error, 'Empty command');
  assert.equal((await session.send(null)).error, 'Empty command');
  assert.equal(calls.length, 0);
});

test('a second command is refused while one is running', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: async () => {
      await gate;
      return { ok: true, status: 200, json: async () => plainAnswer('done').body };
    },
  });

  const first = session.send('one');
  assert.equal(session.busy, true);
  const second = await session.send('two');
  assert.equal(second.error, 'A command is already running');
  release();
  await first;
  assert.equal(session.busy, false);
});

test('the provider and model are forwarded on every turn', async () => {
  const calls = [];
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: scriptedFetch([toolTurn('zoom_to_globe', {}), plainAnswer('ok')], { calls }),
  });
  await session.send('zoom out', { provider: 'ollama', model: 'qwen3:4b' });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.body.provider, 'ollama');
    assert.equal(call.body.model, 'qwen3:4b');
  }
});

test('usage accumulates across turns and resets with the session', async () => {
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: scriptedFetch([toolTurn('zoom_to_globe', {}), plainAnswer('ok')]),
  });
  await session.send('zoom out');
  assert.equal(session.usage.requests, 2);
  assert.equal(session.usage.promptTokens, 9782 * 2);
  assert.equal(session.usage.completionTokens, 30);

  session.reset();
  assert.deepEqual(session.usage, emptyUsage());
  assert.deepEqual(session.transcript, []);
});

test('events narrate the turn in order', async () => {
  const events = [];
  const session = createAgentSession({
    runAction: async () => ({ ok: true, action: 'fly_to_location' }),
    fetchImpl: scriptedFetch([toolTurn('fly_to_location', { locationId: 'sf' }), plainAnswer('Flying to San Francisco')]),
  });
  await session.send('fly to SF', { onEvent: (event) => events.push(event.type) });
  assert.deepEqual(events, [
    AGENT_EVENTS.MESSAGE,
    AGENT_EVENTS.REQUEST,
    AGENT_EVENTS.TOOL_START,
    AGENT_EVENTS.TOOL_RESULT,
    AGENT_EVENTS.REQUEST,
    AGENT_EVENTS.MESSAGE,
    AGENT_EVENTS.DONE,
  ]);
});

test('narration alongside a tool call still reaches the panel', async () => {
  const messages = [];
  const withNarration = toolTurn('fly_to_location', { locationId: 'sf' });
  withNarration.body.message.content = 'Heading there now';
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: scriptedFetch([withNarration, plainAnswer('Arrived')]),
  });
  await session.send('fly to SF', {
    onEvent: (event) => { if (event.type === AGENT_EVENTS.MESSAGE) messages.push(event.message.content); },
  });
  assert.deepEqual(messages, ['fly to SF', 'Heading there now', 'Arrived']);
});

test('a turn the server marked as a tool-call failure is reported as not ok', async () => {
  const failed = plainAnswer('I could not form a valid command for that.');
  failed.body.toolCallFailed = true;
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: scriptedFetch([failed]),
  });
  const result = await session.send('do something impossible');
  assert.equal(result.ok, false);
  assert.match(result.content, /could not form a valid command/);
});

test('abort ends the running command with a cancellation message', async () => {
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: async (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  const pending = session.send('fly to Tokyo');
  session.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Command cancelled.');
  assert.equal(session.busy, false);
});
