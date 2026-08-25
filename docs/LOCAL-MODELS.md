# Local Models

Running the text agent on your own hardware through [Ollama](https://ollama.com).
No key, no signup, no per-command cost, and nothing leaving the machine.

Every figure here was measured on an **RTX 3070 (8 GB)** with **Ollama 0.18.2**.
Treat them as one hardware point, not a specification.

- [Quick start](#quick-start)
- [The context-length trap](#the-context-length-trap)
- [Choosing models](#choosing-models)
- [The HUD summary](#the-hud-summary)
- [VRAM budgeting](#vram-budgeting)
- [What stays remote](#what-stays-remote)

Related: [TEXT-AGENT.md](TEXT-AGENT.md), [DOCKER.md](DOCKER.md).

---

## Quick start

```bash
docker run -d --gpus all -p 11434:11434 \
  -e OLLAMA_CONTEXT_LENGTH=16384 \
  -e OLLAMA_KEEP_ALIVE=24h \
  --name gev-ollama ollama/ollama

docker exec gev-ollama ollama pull qwen3:4b       # agent, needs tool calling
docker exec gev-ollama ollama pull llama3.2:3b    # HUD summary, needs instruct
```

Then set `OLLAMA_BASE_URL=http://localhost:11434/v1` and pick **Ollama** in the
panel. [DOCKER.md](DOCKER.md) runs both services together instead.

`OLLAMA_CONTEXT_LENGTH` is not optional. Read the next section before skipping it.

---

## The context-length trap

**This is the single most important thing on this page.**

The app sends a **~11,300-token prefix** on every request — the 50-directive
operating manual plus 28 tool schemas. Ollama's stock context window is **4096**.

When the window is too small, Ollama does not error. It silently truncates,
**returns HTTP 200**, and the model — having lost most of its tool list —
improvises. Measured with `qwen3:4b` at the stock window, "fly to Tokyo"
produced this:

```
prompt_tokens: 4096          ← the prefix was cut to a third

content: "<function-call>
{ "name": "move_camera", "arguments": { "direction": "right", ... } }
</function-call>"
```

A fake tool call, written as prose, naming the wrong tool. Nothing failed. It
looks like a stupid model, not a configuration error.

### The fix

Set it **on the Ollama server**, not in the app's `.env`:

```bash
docker run -e OLLAMA_CONTEXT_LENGTH=16384 ... ollama/ollama
```

Or `PARAMETER num_ctx 16384` in a Modelfile.

### Measured on 8 GB with qwen3:4b

| `OLLAMA_CONTEXT_LENGTH` | VRAM | Placement | Result |
|---|---|---|---|
| 4096 (stock) | — | — | ❌ prefix truncated, tool calling broken |
| **16384** | 5.4 GB | 100% GPU | ✅ correct tool calls, ~50 s/command |
| 32768 | 8.0 GB | 18% CPU | ⚠️ spills, unusably slow |

16384 is the floor the app enforces (`MIN_TOOL_CONTEXT_TOKENS`) and about the
ceiling 8 GB can hold for a 4B model. More VRAM lets you raise both.

### Why the capability gate cannot catch it

The model picker filters on context length, but Ollama's `/api/show` reports the
model's **architectural** context — 262144 for `qwen3:4b` — not the runtime
window. The gate sees a huge number and approves a model that will truncate.

So the app detects it **after the fact**, from the prompt token count that comes
back, and says so:

> Ollama truncated the tool prefix, so qwen3:4b never saw the full tool list.
> The provider processed only 4,096 prompt tokens against the ~11,300 this app
> sends, which is a stock default window.
> **Remedy:** set `OLLAMA_CONTEXT_LENGTH=16384` on the Ollama server and restart it.

---

## Choosing models

Two different jobs with **opposite** requirements.

| Job | Needs | Good choices |
|---|---|---|
| **Agent** | tool calling, ≥16k context | `qwen3:4b`, `qwen3:8b`, `llama3.1:8b` |
| **HUD summary** | short instruct output, **no reasoning** | `llama3.2:3b`, `qwen2.5:3b` |

### Do not use a reasoning model for the HUD summary

A reasoning model spends its entire output budget thinking about a five-word
answer and returns nothing. Measured with `qwen3:4b`:

| `max_tokens` | Time | Result |
|---|---|---|
| 100 | — | `finish_reason: length`, `content: ""`, 456 chars of reasoning |
| 512 | 39 s | same, empty |
| 1024 | 86 s | same, empty |

**Raising the ceiling does not help** — it thinks past any of them. Nor does
suppression: `chat_template_kwargs.enable_thinking=false` and `think=false` were
both ignored, and `reasoning_effort=none` is actively harmful because it merges
the thinking *into* `content`, which would put "Hmm the user has given" on your
HUD.

The fix is the model. `llama3.2:3b` answers in one shot:

```json
{ "summary": "Austin Texas City Sky View", "provider": "ollama", "model": "llama3.2:3b" }
```

The app diagnoses the overflow rather than showing a blank readout:

> qwen3:4b spent its entire output budget on internal reasoning and returned no answer.
> **Remedy:** Use a non-reasoning instruct model for this readout.

### Tool-calling quality

28 tools with strict enums and sealed schemas is a demanding workload. Small
models produce malformed arguments; the server validates every call and feeds
errors back for up to two corrections, but correction cannot rescue a model that
picks the wrong tool. If commands land on the wrong action, size up before
suspecting the app.

---

## The HUD summary

The five-word `SUMMARY` readout uses the same providers. It defaults to
`GEV_AGENT_PROVIDER`, because an operator who moved the agent local has not
really gone local while the HUD posts live coordinates, street names, and active
layers to a hosted provider **every 15 seconds**.

```bash
GEV_HUD_PROVIDER=            # overrides the agent provider
GEV_HUD_MODEL=               # applies to every provider
GEV_HUD_MODEL_OLLAMA=llama3.2:3b
```

Resolution order: `GEV_HUD_MODEL_<PROVIDER>` → `GEV_HUD_MODEL` →
`OPENAI_HUD_SUMMARY_MODEL` (OpenAI only, legacy) → the provider default. An
unconfigured install behaves exactly as it always did: OpenAI, `gpt-5-nano`.

Without a configured provider the readout falls back to a deterministic non-AI
line, so the HUD is never blank.

---

## VRAM budgeting

8 GB is less than 8 GB. On a desktop, measured:

| Consumer | VRAM |
|---|---|
| Xorg + desktop shell | ~0.9 GB |
| Browser rendering the globe | 1–2 GB |
| `qwen3:4b` @ 16k context | 5.4 GB |

That is already over budget with a browser open, and Ollama silently spills to
CPU when it does not fit — the model still answers, several times slower.

Check placement whenever things feel slow:

```bash
docker exec gev-ollama ollama ps
# PROCESSOR column: "100% GPU" is what you want.
# "77%/23% CPU/GPU" means it spilled.
```

Options when it spills: a smaller model, a lower `OLLAMA_CONTEXT_LENGTH` (not
below 16384 for the agent), or run Ollama on another machine and point
`OLLAMA_BASE_URL` at it.

Also set `OLLAMA_KEEP_ALIVE=24h`. A cold load costs many seconds on the first
command, and the app gives local providers a 300 s budget precisely because of
it.

---

## What stays remote

"Local models" means the **agent** is local. It does not make the app offline.

| | Local | Remote |
|---|---|---|
| Agent commands, tool calls | ✅ | |
| HUD summary | ✅ (with a local model) | |
| Voice | | ❌ OpenAI Realtime only |
| Photorealistic globe | | Google or Cesium ion |
| Every live layer | | their own upstreams |

Caching map tiles locally is explicitly prohibited by Google's terms, so there is
no offline mode for the globe. The accurate claim is **zero LLM cost and no
prompts or screenshots leaving the box**, which is still a strong position.

Voice cannot move: nothing open source implements the OpenAI Realtime WebRTC
protocol with native speech-to-speech plus tool calling.
