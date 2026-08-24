# Hosting on GitHub Pages

God's Eye View can be published as a static site. This page explains what a
static deployment can and cannot do, how to set one up, and why the split falls
where it does.

---

## The one thing to understand first

Every **live** feed in this app is brokered by proxy middleware that lives in
`vite.config.js`. That middleware is registered through Vite's `configureServer`
hook, which means it runs under **`vite dev` and nowhere else** — not in a
build, and not under `vite preview` either.

That design is deliberate and it is the reason the app is safe to run: the
proxies hold the server-side keys (OpenSky, TomTom, FIRMS, AISStream, OpenAI…)
so those keys never reach a browser. See [SECURITY.md](../SECURITY.md).

A static host serves files. It cannot run that middleware, so `/api/*` does not
exist there. That is a property of static hosting, not a bug to fix — and it is
not a reason to skip deploying, because a large part of the app never needed a
backend at all.

---

## What works on Pages

🟢 **No key, no server, works immediately**

- the 3D globe, all visual styles, the camera and scene director
- share links, annotations, the measurement and framing tools
- the bundled datasets: submarine cables, data centres, dams, regions
- **earthquakes** (USGS) and **bikeshare** (GBFS) — both CORS-open, fetched
  straight from source by the browser

🔴 **With `GOOGLE_MAPS_API_KEY`**

- Google Photorealistic 3D Tiles — the photorealistic planet
- geocoding, place context, and the location search

🟡 **With `CESIUM_ION_TOKEN`**

- the Bing aerial basemap stacks and Cesium World Terrain

## What needs the local dev server

These poll `/api/*`, so they are unavailable on a static host:

- aircraft, military flights, satellites, rocket launches, active fires
- street traffic, CCTV, radio, live vessels, military installations
- voice control

The app does not leave you guessing about this. A static build:

- answers its own `/api/*` calls with an explanatory 503, so each layer's normal
  status line reads *"Live feed needs the local server"* instead of choking on
  the host's 404 HTML page;
- shows a one-time notice on first visit listing both halves of the split.

To get the live feeds, clone and run locally — see [Quick Start](../README.md#-quick-start).

---

## Deploying

The workflow at [`.github/workflows/deploy-pages.yml`](../.github/workflows/deploy-pages.yml)
does the whole job. On your fork:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. *(Optional, for the photorealistic globe)* **Settings → Secrets and variables
   → Actions → New repository secret**, and add either or both of:
   - `GOOGLE_MAPS_API_KEY` — Map Tiles API enabled
   - `CESIUM_ION_TOKEN` — a public `assets:read` token
3. Push to `main`, or run the workflow manually from the **Actions** tab.

The site lands at `https://<user>.github.io/<repo>/`.

### About those two keys

Both are **exposed to the browser by design** — they are used client-side, so
they appear in the bundle and in devtools. That is true of any deployment of
this app, local included. Restrict them at the provider rather than trying to
hide them:

- **Google:** an HTTP referrer restriction scoped to your Pages origin, plus an
  API restriction to the Map Tiles API. Set a quota and a budget alert.
- **Cesium ion:** a token with only `assets:read`, URL-restricted.

A public deployment is reachable by anyone, so **anyone who loads the page spends
your quota.** Referrer restrictions and provider-side budget caps are the
controls that matter here; treat them as required, not optional.

Every other key in `.env.example` stays server-side and is never read by a
build. Do not add them as Actions secrets — the build has no use for them.

### Letting visitors bring their own keys

The first-visit notice has fields for the Google key and the Cesium ion token. A
value entered there is kept in that browser's `localStorage` and takes
precedence over anything baked in at build time.

That makes a keyless deployment genuinely useful: publish it with no secrets at
all, and anyone who wants the photorealistic globe can point it at their own
quota without forking or rebuilding.

---

## Hosting somewhere else

Nothing here is Pages-specific. `npm run build` produces a `dist/` that works
from any static host and from any URL prefix — asset URLs are relative, so
`https://example.com/`, `https://example.com/gev/` and a plain file server all
work from the same artifact.

Two things the Pages workflow adds that you may want to replicate:

- `dist/404.html` as a copy of `index.html`, so deep links survive;
- `dist/.nojekyll`, which only matters on Pages.

### If you put a real backend behind it

If you serve `dist/` behind something that implements the same `/api` surface —
your own proxy, a Cloudflare Worker, a small Express app — build with
`GEV_STATIC_BUILD=0`. That drops the 503 stub and the notice, and the layers
poll normally.

```bash
GEV_STATIC_BUILD=0 npm run build
```

Reimplementing that surface is not a small job: the middleware in
`vite.config.js` handles auth, caching, rate limits, SSRF guards and response
sanitisation for each upstream. Read it before you copy it.
