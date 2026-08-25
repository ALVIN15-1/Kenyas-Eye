# God's Eye View — dev-server image.
#
# This deliberately runs `vite` (the dev server), NOT a production build.
# Ten of the nineteen upstream proxies register only on `configureServer`, so a
# `vite build` + `vite preview` container silently loses CelesTrak, TomTom,
# FIRMS, OpenSky, Overpass, CCTV, adsb.lol, GBFS, adsbdb, and terrain heights.
# The dev server is the backend for this project.
#
# No GPU is needed here. The WebGL work happens in the viewer's browser, and
# local model inference happens in the Ollama sidecar (see compose.yaml).

FROM node:24-bookworm-slim

# Cesium ships prebuilt assets; nothing here needs a compiler toolchain.
WORKDIR /app

# Install dependencies against the lockfile first so the layer caches across
# source edits. `npm ci` needs both manifests present.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# `.gev-cache` holds the TomTom daily tile budget, cached TLEs, FIRMS and
# Overpass results. Declaring it a volume keeps an API allowance from being
# re-spent on every container restart.
RUN mkdir -p /app/.gev-cache
VOLUME ["/app/.gev-cache"]

ENV HOST=0.0.0.0
ENV PORT=4173
EXPOSE 4173

# Bind to every interface INSIDE the container. Reaching it from outside the
# host is still governed by the port publishing in compose.yaml, which defaults
# to loopback only.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "4173"]
