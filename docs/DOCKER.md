# Docker

Running God's Eye View in containers, optionally with a local model sidecar on
the GPU.

- [Quick start](#quick-start)
- [Why it runs the dev server](#why-it-runs-the-dev-server)
- [Where the GPU goes](#where-the-gpu-goes)
- [Volumes](#volumes)
- [Networking and exposure](#networking-and-exposure)
- [Troubleshooting](#troubleshooting)

Related: [LOCAL-MODELS.md](LOCAL-MODELS.md), [TEXT-AGENT.md](TEXT-AGENT.md).

---

## Quick start

```bash
cp .env.example .env          # set GOOGLE_MAPS_API_KEY (or CESIUM_ION_TOKEN)
docker compose up -d

docker compose exec ollama ollama pull qwen3:4b       # agent
docker compose exec ollama ollama pull llama3.2:3b    # HUD summary
```

Open **http://localhost:4173**.

The stack is two services: `gev` (the app) and `ollama` (local inference). Drop
the sidecar if you only use hosted providers — the app runs fine without it and
simply reports Ollama unreachable.

---

## Why it runs the dev server

The image runs `vite`, not a production build. That is deliberate.

**Ten of the nineteen upstream proxies register only on `configureServer`** —
CelesTrak, TomTom, FIRMS, OpenSky, Overpass, CCTV, adsb.lol, GBFS, adsbdb, and
terrain heights. A `vite build` + `vite preview` container starts cleanly and
silently loses all of them. The dev server *is* the backend for this project.

Because it is a dev server, `compose.yaml` bind-mounts the source read-only:

```yaml
- ./src:/app/src:ro
- ./index.html:/app/index.html:ro
- ./style.css:/app/style.css:ro
- ./vite.config.js:/app/vite.config.js:ro
- /app/node_modules      # keep the image's own
```

Without those mounts every edit needs a full image rebuild and hot reload cannot
work at all. `node_modules` deliberately stays the image's copy: the host tree
may be absent or built for another platform.

> [!NOTE]
> This is a hackable exploration stack, not a hardened production deployment.
> The project describes itself the same way.

---

## Where the GPU goes

**On the `ollama` service, not on `gev`.**

The app container renders nothing. All WebGL happens in the viewer's browser, on
the viewer's machine. Attaching a GPU to `gev` buys exactly nothing.

```yaml
ollama:
  image: ollama/ollama
  gpus: all
  environment:
    OLLAMA_CONTEXT_LENGTH: 16384
    OLLAMA_KEEP_ALIVE: 24h
```

Requires the [NVIDIA Container Toolkit](https://github.com/NVIDIA/nvidia-container-toolkit)
on the host. An LLM needs only the default `compute,utility` driver
capabilities — **not** the `graphics,display` capabilities in-container WebGL
would require, which makes this far simpler than GPU-accelerated headless Chrome.

Verify:

```bash
docker compose exec ollama nvidia-smi --query-gpu=name --format=csv,noheader
docker compose exec ollama ollama ps      # PROCESSOR should read 100% GPU
```

`OLLAMA_CONTEXT_LENGTH` defaults to 16384 here for a reason —
see [the context-length trap](LOCAL-MODELS.md#the-context-length-trap).

---

## Volumes

| Volume | Holds | Why it persists |
|---|---|---|
| `gev-cache` → `/app/.gev-cache` | TomTom daily tile budget, cached TLEs, FIRMS, Overpass | losing it re-spends an API allowance on every restart |
| `ollama` → `/root/.ollama` | pulled models | a re-pull is gigabytes |

The TomTom budget counter is the important one: it is a persistent per-UTC-day
counter that keeps the proxy serving stale cache instead of hitting upstream once
you cross the cap.

---

## Networking and exposure

The app port publishes to **loopback only**:

```yaml
ports:
  - "127.0.0.1:4173:4173"
```

> [!WARNING]
> The server brokers every configured API key. Anyone who can reach this port can
> spend your quota. Only change this to `"4173:4173"` on a network you trust, and
> set the `GEV_RATELIMIT_*` throttles when you do. Those are app-level guards, not
> billing caps — set provider-side budgets too.

Ollama is not published to the host at all; the app reaches it over the compose
network at `http://ollama:11434/v1`. **Use the service name, not `localhost`** —
inside a container `localhost` is that container.

Since the text agent needs no microphone, there is no secure-context requirement.
Plain HTTP over a LAN is fine, unlike voice, which needs HTTPS or `localhost` for
`getUserMedia`.

---

## Troubleshooting

**Port already in use**
Something else holds 4173. `ss -ltnp | grep 4173`, stop it, and note that a
container created during a failed bind keeps no port mapping — recreate it:

```bash
docker compose up -d --force-recreate gev
```

**Code changes not taking effect**
Confirm the bind mounts are present (`docker compose config`). Changes to
`package.json` or dependencies still need `docker compose up -d --build`.

**`env file .env not found`**
`env_file` is marked optional, so `docker compose config` works without it, but
the app still needs `GOOGLE_MAPS_API_KEY` or `CESIUM_ION_TOKEN` to start.

**Ollama unreachable from the app**
Check `OLLAMA_BASE_URL` uses the service name. From inside the app container:

```bash
docker compose exec gev node -e "fetch('http://ollama:11434/v1/models').then(r=>console.log(r.status))"
```

**Model spilling to CPU**
See [VRAM budgeting](LOCAL-MODELS.md#vram-budgeting). Both the browser and the
model want the same card.

### Verifying the stack

```bash
GEV_URL=http://localhost:4173 npm run qa:agent-panel
```

Drives the real panel in headless Chromium: mount, provider and model
population, then one typed command through the tool loop to a real state change.
