# God's Eye View — container image
# Single service: `vite` dev server serves the SPA plus all 20 API proxy
# middlewares from vite.config.js. NOTE: run the DEV server, not `vite
# preview` — 18 of the 20 proxies only register via configureServer(),
# so preview would silently drop most data layers.
# Only 2 env vars are baked in at build time (client-exposed by design):
# GOOGLE_MAPS_API_KEY, CESIUM_ION_TOKEN. Everything else is read at runtime.

FROM node:24-slim

# QA scripts use puppeteer; the API proxies only need `ws` at runtime.
# Skip the ~170 MB Chrome download to keep the image lean.
ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app

# Lockfile first for layer caching
COPY package.json package-lock.json ./
RUN npm ci

# App source + config
COPY . .

# Disk cache dir for Overpass / military-installation proxies (mount a volume
# to persist across restarts)
VOLUME ["/app/.gev-cache"]

ENV HOST=0.0.0.0 \
    PORT=4173

EXPOSE 4173

# Dev server (see header comment) — HOST=0.0.0.0 is read by vite.config.js
CMD ["npm", "run", "dev"]
