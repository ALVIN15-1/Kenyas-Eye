/**
 * Static-hosting support (GitHub Pages, Netlify, any plain file server).
 *
 * Every live feed in this app is brokered by middleware that lives in
 * `vite.config.js` and only runs under `vite dev` — the proxies hold the
 * server-side keys (OpenSky, TomTom, FIRMS, AISStream, OpenAI…) so they never
 * reach the browser. A built bundle served from a static host has no such
 * middleware, so `/api/*` simply is not there.
 *
 * That is a deployment fact, not a bug, and the app is still worth hosting: the
 * globe, the visual styles, the camera/scene work, share links, the bundled
 * datasets (submarine cables, data centres, dams, regions) and the feeds that
 * are CORS-open direct from the browser (USGS earthquakes, GBFS bikeshare) all
 * work with no server at all.
 *
 * This module makes that split explicit instead of leaving it to look broken:
 *
 *  - `installStaticApiStub()` answers `/api/*` with a 503 carrying a plain
 *    explanation, so each layer's existing error surface shows the reason
 *    rather than choking on a host's 404 HTML page.
 *  - `showStaticDeploymentNotice()` explains it once, and lets a visitor paste
 *    their own client-side keys so a fork works without rebuilding.
 */

import { appAssetUrl } from './appAssetUrl.js';

/**
 * True when this bundle was produced by `vite build` without a declared API
 * backend. Set from `vite.config.js`; see `GEV_STATIC_BUILD` in `.env.example`
 * for the escape hatch when `dist/` is served behind a real proxy.
 */
export const IS_STATIC_BUILD = import.meta.env.GEV_STATIC_BUILD === true;

/** Same-origin path prefix owned by the dev-server proxies. */
const API_PREFIX = '/api/';

/** Shown by each layer's own status readout when it polls a missing backend. */
export const NO_BACKEND_MESSAGE =
  'Live feed needs the local server — run npm run dev';

/** localStorage namespace, matching the app's existing `godsEyeView.` keys. */
const CREDENTIAL_PREFIX = 'godsEyeView.credentials.';

/** Keys the browser is *supposed* to hold (see SECURITY.md); no others. */
const CLIENT_CREDENTIALS = Object.freeze({
  GOOGLE_MAPS_API_KEY: {
    label: 'Google Maps API key',
    hint: 'Map Tiles API enabled — unlocks the photorealistic 3D globe',
  },
  CESIUM_ION_TOKEN: {
    label: 'Cesium ion token',
    hint: 'Optional — adds the Bing aerial basemap stacks',
  },
});

/**
 * Build-time values, read STATICALLY on purpose.
 *
 * These are injected by `define` in `vite.config.js`, which is a literal text
 * substitution of `import.meta.env.NAME`. A computed lookup like
 * `import.meta.env[name]` is not rewritten and would read undefined in a
 * build — only `VITE_`-prefixed vars survive dynamic access.
 */
const BUILD_CREDENTIALS = Object.freeze({
  GOOGLE_MAPS_API_KEY: import.meta.env.GOOGLE_MAPS_API_KEY,
  CESIUM_ION_TOKEN: import.meta.env.CESIUM_ION_TOKEN,
});

const NOTICE_DISMISSED_KEY = 'godsEyeView.staticNoticeDismissed.v1';

/** @returns {Storage|null} localStorage, or null where it is unavailable. */
function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Private mode / blocked storage — the app still runs, keys just don't persist.
    return null;
  }
}

/**
 * Read a client-side credential, preferring one the visitor supplied here.
 *
 * A build-time value (repo secret injected by CI) is the normal path; the
 * localStorage override exists so someone can point a public deployment at
 * their own quota without forking and rebuilding.
 *
 * @param {keyof typeof CLIENT_CREDENTIALS} name
 * @returns {string} the credential, or '' when unset.
 */
export function readClientCredential(name) {
  if (!(name in CLIENT_CREDENTIALS)) return '';
  const stored = storage()?.getItem(CREDENTIAL_PREFIX + name);
  if (typeof stored === 'string' && stored.trim()) return stored.trim();
  const built = BUILD_CREDENTIALS[name];
  return typeof built === 'string' && built.trim() ? built.trim() : '';
}

/**
 * Persist (or clear, with an empty value) a visitor-supplied credential.
 *
 * @param {keyof typeof CLIENT_CREDENTIALS} name
 * @param {string} value
 * @returns {boolean} whether the write landed.
 */
export function writeClientCredential(name, value) {
  if (!(name in CLIENT_CREDENTIALS)) return false;
  const store = storage();
  if (!store) return false;
  try {
    const trimmed = String(value ?? '').trim();
    if (trimmed) store.setItem(CREDENTIAL_PREFIX + name, trimmed);
    else store.removeItem(CREDENTIAL_PREFIX + name);
    return true;
  } catch {
    return false;
  }
}

let _stubInstalled = false;

/**
 * Answer same-origin `/api/*` requests locally with an explanatory 503.
 *
 * Layers already treat a non-ok response as an upstream outage and surface
 * `body.error` in their status line, so this reuses that path instead of
 * touching any layer. Without it, a static host answers those polls with its
 * own 404 HTML, which reads as a parse error rather than a missing backend.
 *
 * @returns {boolean} whether the stub was installed by this call.
 */
export function installStaticApiStub() {
  if (_stubInstalled || !IS_STATIC_BUILD) return false;
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return false;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = function gevStaticFetch(input, init) {
    let target;
    try {
      const raw = typeof input === 'string' ? input : (input?.url ?? '');
      target = new URL(raw, document.baseURI);
    } catch {
      return nativeFetch(input, init);
    }
    if (target.origin !== window.location.origin) return nativeFetch(input, init);
    if (!target.pathname.startsWith(API_PREFIX)) return nativeFetch(input, init);

    return Promise.resolve(new Response(
      JSON.stringify({ error: NO_BACKEND_MESSAGE, staticBuild: true }),
      {
        status: 503,
        statusText: 'Service Unavailable',
        headers: {
          'Content-Type': 'application/json',
          'X-Gev-Static-Build': '1',
        },
      },
    ));
  };
  _stubInstalled = true;
  return true;
}

/** Feeds that reach their upstream straight from the browser — no proxy needed. */
const WORKS_WITHOUT_BACKEND = [
  'the 3D globe, visual styles, camera and scene director',
  'earthquakes (USGS) and bikeshare (GBFS), fetched straight from source',
  'the bundled datasets: submarine cables, data centres, dams, regions',
  'share links and the annotation tools',
];

/** Feeds brokered by the dev-server proxies, so unavailable on a static host. */
const NEEDS_BACKEND = [
  'aircraft and military flights',
  'satellites, rocket launches, active fires',
  'street traffic, CCTV, radio, live vessels',
  'voice control',
];

function noticeDismissed() {
  try {
    return storage()?.getItem(NOTICE_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Show the one-time static-deployment explainer.
 *
 * Deliberately not a blocking modal: the globe behind it is the point, and the
 * banner is dismissible for good. It is also the only place a visitor can add
 * their own client-side keys, which is what makes a forked Pages deployment
 * usable without a rebuild.
 *
 * @param {object} [options]
 * @param {boolean} [options.hasGoogleKey] Whether the photoreal globe came up.
 * @param {boolean} [options.force] Show even if previously dismissed.
 * @returns {HTMLElement|null} the banner element, or null when not shown.
 */
export function showStaticDeploymentNotice({ hasGoogleKey = false, force = false } = {}) {
  if (!IS_STATIC_BUILD) return null;
  if (typeof document === 'undefined') return null;
  if (!force && noticeDismissed()) return null;
  if (document.getElementById('static-build-notice')) return null;

  const banner = document.createElement('aside');
  banner.id = 'static-build-notice';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-label', 'Static deployment notice');

  const list = (items) => items.map((item) => `<li>${item}</li>`).join('');
  const keyRows = Object.entries(CLIENT_CREDENTIALS).map(([name, meta]) => `
    <label class="static-build-key">
      <span class="static-build-key-name">${meta.label}</span>
      <input type="password" name="${name}" autocomplete="off" spellcheck="false"
             placeholder="${readClientCredential(name) ? '•••••• stored' : 'paste to enable'}" />
      <small>${meta.hint}</small>
    </label>`).join('');

  banner.innerHTML = `
    <div class="static-build-head">
      <img class="static-build-logo" src="${appAssetUrl('/logo.svg')}" alt="" />
      <div>
        <h2>Running without a local server</h2>
        <p>This is the static build. Everything below works right now${
          hasGoogleKey ? '' : ', on the OpenStreetMap globe'
        } — the live intelligence feeds need the dev server, which brokers their keys.</p>
      </div>
      <button type="button" class="static-build-close" aria-label="Dismiss">&times;</button>
    </div>
    <div class="static-build-cols">
      <section>
        <h3>Works here</h3>
        <ul>${list(WORKS_WITHOUT_BACKEND)}</ul>
      </section>
      <section>
        <h3>Needs <code>npm run dev</code></h3>
        <ul>${list(NEEDS_BACKEND)}</ul>
      </section>
    </div>
    <form class="static-build-keys">
      <p>Optional — use your own browser-side keys on this deployment. They stay
         in this browser's local storage and are never sent anywhere but the
         mapping provider.</p>
      ${keyRows}
      <div class="static-build-actions">
        <button type="submit">Save and reload</button>
        <button type="button" class="static-build-dismiss">Not now</button>
      </div>
    </form>
  `;

  const close = () => {
    try {
      storage()?.setItem(NOTICE_DISMISSED_KEY, '1');
    } catch {
      // Dismissal just won't persist; closing still works.
    }
    banner.remove();
  };

  banner.querySelector('.static-build-close')?.addEventListener('click', close);
  banner.querySelector('.static-build-dismiss')?.addEventListener('click', close);
  banner.querySelector('form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    let changed = false;
    for (const name of Object.keys(CLIENT_CREDENTIALS)) {
      const field = banner.querySelector(`input[name="${name}"]`);
      const value = field?.value?.trim();
      if (value) changed = writeClientCredential(name, value) || changed;
    }
    close();
    if (changed) window.location.reload();
  });

  document.body.appendChild(banner);
  return banner;
}
