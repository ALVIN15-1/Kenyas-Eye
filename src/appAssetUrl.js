/**
 * Root-relative asset paths, resolved against wherever the app was published.
 *
 * Source keeps writing `/models/airplane.glb` and `/logo.svg` — those strings
 * are identity keys in several registries (and are pinned by unit tests), so
 * they must stay stable. What changes is the moment the string becomes a URL:
 * a build served from a sub-path (a GitHub Pages *project* site lives at
 * `https://<user>.github.io/<repo>/`) would 404 on a leading `/`, because that
 * resolves to the domain root rather than the app root.
 *
 * Vite rewrites the references it can see itself — `<img src>` in index.html,
 * `url()` in CSS, anything imported through the module graph. It cannot see a
 * path assembled at runtime, which is what this helper covers.
 */

/**
 * The directory the current document was served from, always with a trailing
 * slash: `/` at a domain root, `/gods-eye-view/` on a Pages project site.
 *
 * `document.baseURI` (not `location.href`) so an explicit `<base href>` wins,
 * and so a deep link with a query string or hash still resolves to the folder.
 */
const APP_BASE = (() => {
  if (typeof document === 'undefined') return '/';
  try {
    return new URL('.', document.baseURI).pathname || '/';
  } catch {
    return '/';
  }
})();

/** Already-absolute forms that must be handed through untouched. */
const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Resolve an app-relative asset path for the current deployment.
 *
 * @param {string} path Root-relative path (`/models/jet.glb`) or absolute URL.
 * @returns {string} A URL valid from the document, or `path` unchanged when it
 *   is already absolute (http:, data:, blob:, protocol-relative) or not a
 *   non-empty string.
 */
export function appAssetUrl(path) {
  if (typeof path !== 'string' || path === '') return path;
  if (ABSOLUTE_URL.test(path)) return path;
  return APP_BASE + path.replace(/^\/+/, '');
}

/** The resolved app root, exported for callers that build their own URLs. */
export function appBaseUrl() {
  return APP_BASE;
}
