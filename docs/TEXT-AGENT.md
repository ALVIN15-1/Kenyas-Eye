# Text Agent

The **AI AGENT** panel drives the same 28 tools as voice, over typed text and any
OpenAI-compatible chat endpoint. Voice is unchanged and the two run side by side.

- [Why it exists](#why-it-exists)
- [Providers](#providers)
- [How a command runs](#how-a-command-runs)
- [Configuration](#configuration)
- [Cost](#cost)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)

Related: [LOCAL-MODELS.md](LOCAL-MODELS.md) for running it on your own hardware,
[DOCKER.md](DOCKER.md) for the container stack.

---

## Why it exists

Voice is excellent and expensive. Audio tokens dominate the bill, the mic bills
for silence, and the OpenAI Realtime API has no open-source equivalent that
speaks its WebRTC protocol with native speech-to-speech plus tool calling.

Typing removes all three problems at once. The same agent, the same 28 tools,
roughly 50x cheaper, and reachable by providers that will never implement
Realtime — including a model running on your own GPU.

It is additive. Nothing about voice changed.

---

## Providers

All three speak OpenAI-compatible `/v1/chat/completions` with `tools`, so they
share one code path. The only differences are the base URL, whether a key is
required, and how each reports what its models can do.

| Provider | Compute | Key | Discovery endpoint |
|---|---|---|---|
| **OpenAI** | hosted | `OPENAI_API_KEY` (shared with voice) | `GET /v1/models` |
| **OpenRouter** | hosted | `OPENROUTER_API_KEY` | `GET /api/v1/models?supported_parameters=tools` |
| **Ollama** | local | none | `GET /v1/models` + native `/api/show` |

**OpenRouter is not routed through Ollama.** They are peers: OpenRouter is a
hosted aggregator reached over the internet and needs no container; Ollama is
local inference. Only Ollama has a sidecar.

### Model discovery

Models are not hardcoded. Each provider is queried at runtime, so pulling a
larger model into Ollama makes it appear in the picker with no config change.

Every model is normalized to one shape and then gated:

| Gate | Rule | Why |
|---|---|---|
| `supportsTools` | reject | the entire app is 28 tools |
| `contextLength >= 16384` | reject | the prompt prefix is ~11,300 tokens |
| `supportsVision` | soft | only disables screenshot grounding |

OpenRouter reports all of this directly (~330 tool-capable models, with live
pricing shown in the picker). OpenAI's listing carries no capability metadata,
so tool support is assumed and the context gate abstains. Ollama's
OpenAI-compatible listing is too thin, so capabilities come from its native
`/api/show`.

> [!WARNING]
> Ollama's `/api/show` reports the model's **architectural** context, not the
> runtime window `OLLAMA_CONTEXT_LENGTH` allocated. The gate therefore cannot
> catch a too-small runtime window; that is detected after the fact instead. See
> [LOCAL-MODELS.md](LOCAL-MODELS.md#the-context-length-trap).

---

## How a command runs

The tools mutate the browser's Cesium viewer, so they can only execute there.
The credentials live server-side, so the model can only be reached from there.
One logical turn is therefore a loop:

```
1. client  →  POST /api/agent/command   { provider, model, messages }
2. server  →  provider /v1/chat/completions  (tools: 28 schemas)
3. server  →  client                    { message, toolCalls }
4. client  →  await runGevAction(name, args)      ← the existing action runner
5. client  →  POST /api/agent/command   { ...messages, tool results }
6. server  →  provider                  → final text
7. client  →  render
```

The browser owns the transcript and resends it; the server stays stateless like
every other proxy in this project. History is bounded at 40 messages, and a trim
never splits an assistant tool call from its results because an orphaned `tool`
message is a hard 400 from every provider.

The loop stops after 8 tool rounds. That is a runaway guard, not a limit of one:
the operating manual explicitly asks the model to make *all* the calls a request
implies before answering.

### Malformed tool calls

Ollama's compatible endpoint does not support `tool_choice`, so a well-formed
call cannot be forced — only caught and corrected. Every tool call is validated
against its JSON Schema server-side before it reaches the browser. A rejected
call is answered with its own error so the model can restate it, up to two
corrections, and that exchange never appears in the transcript.

---

## Configuration

```bash
GEV_AGENT_PROVIDER=ollama          # openai | openrouter | ollama
GEV_AGENT_MODEL=                   # applies to every provider
GEV_AGENT_MODEL_OPENAI=gpt-5-mini
GEV_AGENT_MODEL_OPENROUTER=openai/gpt-5-mini
GEV_AGENT_MODEL_OLLAMA=qwen3:4b

OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OLLAMA_BASE_URL=http://localhost:11434/v1
```

Per-provider overrides win over the shared form. These only choose the initial
selection; the panel lists whatever the provider actually offers.

The AI HUD summary follows `GEV_AGENT_PROVIDER` by default and has its own
overrides — see [LOCAL-MODELS.md](LOCAL-MODELS.md#the-hud-summary).

### Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/agent/config` | providers, defaults, prefix size |
| `GET /api/agent/models?provider=X` | capability-gated model list |
| `POST /api/agent/command` | one model turn, tool calls pre-validated |

Keys never reach the browser. `describeProviders` deliberately omits both the
credential and the hosted base URL.

---

## Cost

Audio is what costs money, so removing it is most of the saving.

| | Per command |
|---|---|
| gpt-5-nano | ~$0.00015 |
| gpt-5-mini | ~$0.0008 |
| Ollama | free |

An intensive day of ~500 typed commands is well under a dollar on a hosted
model, against roughly $10–$60 for the equivalent day of open-mic voice.

The dominant cost is the **~11,300-token prefix** (the operating manual plus 28
tool schemas) resent on every request, so prompt caching is the entire cost
model — cached input bills at 10%.

---

## Architecture

```
src/agent/
├── providers.js      # registry, normalization, capability gating, cost
├── instructions.js   # the 50-directive operating manual, shared with voice
├── toolSchema.js     # Realtime→chat reshape, JSON Schema validation
├── conversation.js   # transcript sanitizing, bounded history
├── upstream.js       # provider HTTP, injectable fetch
├── diagnostics.js    # silent-failure detection
├── agentLoop.js      # the client-side tool loop
└── agentPanel.js     # the panel
```

Two things worth knowing:

**`gevActions.js` was already provider-agnostic.** All 3,455 lines of tool
implementations have zero LLM knowledge. The seam is
`async (name, args) => resultObject`, and the panel drives the same runner voice
does.

**The operating manual is shared verbatim.** All 50 directives live in
`instructions.js`; the voice modality emits a byte-identical string to the
original inline array, and text overrides only five channel-specific lines. A
shared line changes both transports on purpose.

The panel uses the existing `[data-panel-id]` chrome, so it inherits drag,
collapse, and position persistence.

---

## Troubleshooting

**"Cannot reach Ollama at … Is the daemon running?"**
The daemon is down or the URL is wrong. Inside a container, use the compose
service name, not `localhost`.

**"… truncated the tool prefix"**
The runtime context window is smaller than the prompt. See
[LOCAL-MODELS.md](LOCAL-MODELS.md#the-context-length-trap).

**"… wrote a tool call as text instead of issuing one"**
Usually truncated tool definitions; occasionally a model with no real tool
support. Confirm the model reports the `tools` capability.

**"I could not form a valid command for that."**
The model failed schema validation twice. Small models do this; try a larger
one or a hosted provider.

**No usable models listed**
Every model failed the gate. For Ollama that generally means the runtime context
window is below 16,384.

### Verifying

```bash
npm run qa:agent-panel     # drives the real panel end to end in headless Chromium
```

Defaults to the Ollama provider because it needs no credential. Set `GEV_URL`,
`GEV_AGENT_PROVIDER`, `GEV_AGENT_MODEL`, and `COMMAND` to vary it.
