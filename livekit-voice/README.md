# Self-hosted LiveKit voice backend

This is an optional replacement for the OpenAI Realtime voice path. The browser still runs all God's Eye View map tools locally; the LiveKit agent only handles voice, LLM reasoning, and tool-call orchestration.

## Architecture

```text
browser mic/audio
  ↕ LiveKit WebRTC
livekit-server
  ↕ LiveKit Agents worker
Whisper-compatible STT → OpenAI-compatible LLM → OpenAI-compatible TTS
  ↕ reliable LiveKit data packets on topic gev.tools
browser tool runner (src/voice/gevActions.js)
```

The tool schemas are exported from the existing `GEV_REALTIME_TOOLS` literal in `vite.config.js`:

```bash
npm run livekit:tools
```

That writes `livekit-voice/tools.json`, which the Python worker loads at startup.

## Quick start

```bash
cp .env.example .env
cp livekit-voice/.env.example livekit-voice/.env   # optional; edit for your model endpoints
npm run livekit:tools

docker compose -f docker-compose.yml -f docker-compose.livekit.yml up -d --build
```

Open `http://localhost:4173`, then use the mic button. The overlay sets `VITE_VOICE_BACKEND=livekit` for the app container.

## Models and hardware

Default env targets a 12 GB GPU-friendly local stack:

- LLM: Ollama OpenAI-compatible API, `qwen3:8b`
- STT: `onerahmet/openai-whisper-asr-webservice`, `small`, faster-whisper
- TTS: `ghcr.io/matatonic/openedai-speech`, OpenAI-compatible TTS backed by local voices

Pull the Ollama model once:

```bash
docker compose -f docker-compose.yml -f docker-compose.livekit.yml exec ollama ollama pull qwen3:8b
```

For a vLLM server instead of Ollama, set:

```bash
GEV_LIVEKIT_LLM_PROVIDER=vllm
GEV_LIVEKIT_LLM_BASE_URL=http://vllm:8000/v1
GEV_LIVEKIT_LLM_MODEL=Qwen/Qwen3-8B
GEV_LIVEKIT_LLM_API_KEY=local
```

The worker uses OpenAI-compatible APIs for LLM/STT/TTS, so you can replace each service independently.

## Browser tool bridge

The Python agent publishes tool calls over LiveKit data packets:

```json
{"type":"gev.tool_call","call_id":"...","name":"fly_to_location","arguments":{"query":"Tokyo"}}
```

The browser runs the existing `runner(name, args, { signal, isCurrent })` contract and returns:

```json
{"type":"gev.tool_result","call_id":"...","result":{"ok":true}}
```

No map credentials or globe state leave the browser through the Python worker except explicit tool arguments/results.

## Latency expectations

On a 12 GB RTX 3060, expect conversational turns to be near sub-second only when the model is already warm and the tool path is simple. Globe actions often take longer because tool execution, map loading, and the follow-up narration are real work.

Tune:

- `GEV_LIVEKIT_STT_MODEL=tiny|base|small` for STT latency/accuracy.
- `GEV_LIVEKIT_LLM_MODEL=qwen3:4b|qwen3:8b` for LLM latency/quality.
- LiveKit agent endpointing is set to 0.25–0.8s in `livekit_voice/agent.py`.

## Security notes

The demo config uses `devkey` / `secret`. Change `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` before exposing beyond localhost or a trusted LAN.

The app container is still a key-brokering server for Google Maps, Cesium, OpenSky, and other APIs. Do not publish it directly to the internet without authentication/rate limiting.
