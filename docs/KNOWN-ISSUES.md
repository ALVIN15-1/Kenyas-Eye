# KNOWN ISSUES

Updated: August 27, 2026

This file tracks active runtime issues only.

This file records current known issues; historical planning material is not part
of the public release.

---

## Open

### Street traffic can be slow/uneven when panning across dense city blocks
Status: Open (partially mitigated)

Context:
- Current traffic loader fetches one clamped viewport tile at a time (major pass, then full pass).
- In dense cores, some visible roads can appear late after city jumps or fast pans.
- Zooming into adjacent streets does not always immediately trigger higher-detail coverage for all visible roads.

Current mitigation in runtime:
- Fair per-road dot budget allocation (reduces hard starvation under global `MAX_DOTS` cap).
- Center-shift threshold (reduces stale overlap lock while panning).

Next iteration candidates:
- Prioritize currently visible road segments inside the active viewport before off-center segments.
- Add neighbor prefetch ring for nearby tiles after jump-to-city actions.
- Add adaptive dot cap by frame time (coverage first, density second).
- Promote sync chip from loading indicator to true multi-phase progress.

---

### CCTV panel can appear "missing" after layout refactors
Status: Open (workaround available)

Context:
- Panel positions are persisted in local storage and can restore off-screen after UI changes.

Workaround:
- In browser console:
  - `localStorage.removeItem('godsEyeView.v6.panelPos.cctv-panel');`
  - `localStorage.removeItem('godsEyeView.v6.panelCollapsed.cctv-panel');`
  - `location.reload();`

Related keys (current versions):
- Panel positions: `godsEyeView.v7.panelPos.<panel-id>` (re-versioned 2026-06-10)
- Panel collapsed state: `godsEyeView.v6.panelCollapsed.<panel-id>`
- CCTV calibration: `godsEyeView.cctv.calibration.v2`

---

### Height-datum residuals
Status: Open (accepted 2026-07-08, documented)

- **Cold-start floor latency:** at a freshly-visited airport, grounded/low aircraft
  float low for ~1–2 poll cycles (30–60 s) and rise as terrain floors resolve;
  a few stragglers take one more poll.
- **Born-grounded first poll:** a contact first seen on the ground with no altitude
  data renders at the geoid for ≤1 poll until its floor cell warms.
- Full context, improvement ideas, and the verification oracle
  (`scripts/qa-floor-verify.mjs`):
  the height-datum section in `docs/CURRENT-STATE.md`.

---

## Phones and small tablets

The app is built for a desktop GPU. On a phone it now runs a lighter
rendering profile (`src/mobileProfile.js`), which is why the picture is a bit
softer there: CSS-pixel resolution instead of 2x or 3x, a smaller photoreal
tile cache with coarser detail, and none of the visual
styles or the sharpen/bloom/scope passes. That is the trade for a globe that
keeps running instead of stalling or, on iOS, reloading the tab when WebGL
memory goes past roughly 1 to 1.5 GB.

- Want desktop quality on a tablet? Add `?gevMobile=0` to the URL.
  `?gevMobile=1` forces the phone profile on a desktop, useful to test it.
- Something looks wrong on your phone? Open the site with `?gevFlags=diag`
  and attach a screenshot of the green box in the top-left corner to your
  issue. It lists browser, GPU, device pixel ratio, canvas and drawing-buffer
  sizes and GL limits, which is what is needed to tell an app problem from a
  browser or driver problem.
- Known case, not fixable in the app: on a Galaxy S24 (Samsung Xclipse 940
  GPU) Edge 151 for Android draws vertical streaks over the whole map. Chrome
  on the same phone is fine, and the `diag` box shows the same GPU and Vulkan
  backend in both, so it is Edge's default graphics backend, not Cesium. The
  fix is on the phone: open `edge://flags` in Edge, search for "ANGLE",
  set "Choose ANGLE graphics backend" to **Vulkan** (not OpenGL ES, that one
  stays broken), tap Restart, and reload the site. Setting it back to Default
  brings the streaks back.
- The HUD layout itself is still a desktop layout; panels overlap on a
  narrow screen. Not addressed by the profile.

## Closed / Intentional (for clarity)

### Proxy SSRF and error-surface hardening gaps
Status: Closed as fixed on `main`

Context:
- Proxy middleware previously allowed broader error/internal surface area and looser upstream handling.
- Current `main` includes hardened proxy behavior in `vite.config.js`:
  - CCTV upstream URL no longer accepted from client query params.
  - Error payloads are sanitized.
  - OpenSky cache stores successful responses only.
  - OpenSky token refresh is coalesced.
  - GBFS/CCTV memory growth is bounded.

Validation target:
- `vite.config.js`

---

### NVG vignette edge color bleed
Status: Closed as fixed in current shader composite

Context:
- Earlier builds leaked original scene colors near the NVG tube edge.
- Current composite now masks NVG output with tube falloff before final blend, removing the color edge bleed.

Validation target:
- `src/styles/surveillance.js`

---

### Wildfires layer unavailable / static bundled snapshot
Status: Closed — live FIRMS integration shipped (2026-07-16)

Context:
- Wildfires (NASA FIRMS) were removed from runtime in v0.5.3, returned June 2026 as a
  bundled-snapshot layer (`local-firms`, 2026-05-25 data, ~58 MB in-repo), and were
  converted to **live NASA FIRMS data** on 2026-07-16: the `/api/firms` proxy merges
  three VIIRS NRT sources (trailing 24 h, 30 min cache, serve-stale-on-failure) and the
  bundled snapshot was deleted. Requires a free server-side `FIRMS_MAP_KEY`; without it
  the layer shows a KEY REQUIRED state.
- Weather radar is still held out of OSS v1 after QA found the previous overlay did not provide reliable visible value.
