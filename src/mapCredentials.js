// src/mapCredentials.js
// Decides how the photorealistic globe is authorized at boot.
//
// There are two routes to the same Google mesh. The direct one uses a Google
// Maps key against the Map Tiles API. The other goes through Cesium ion, which
// resells it: CesiumJS falls back to an ion-hosted tileset whenever
// `GoogleMaps.defaultApiKey` is undefined, and ion's free Community tier
// includes an allowance of those root tiles.
//
// That second route matters because it removes the project's only hard
// requirement for a billing-enabled Google Cloud account. It only works if we
// leave `GoogleMaps.defaultApiKey` UNSET — setting it to any value, including
// an empty string, sends the request to Google directly instead.

/** How the photorealistic tileset will be authorized. */
export const TILESET_ROUTE = Object.freeze({
  /** Direct to the Map Tiles API with a Google Maps key. */
  GOOGLE: 'google',
  /** Through Cesium ion's resold tileset, using only an ion token. */
  ION: 'ion',
  /** Neither credential present; the globe cannot load. */
  NONE: 'none',
});

/** Trim a credential, treating blank strings as absent. */
function presentCredential(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Resolve which route the photorealistic tileset should take.
 *
 * A Google key wins when both are present: it is the direct path, it carries
 * the operator's own quota rather than ion's smaller allowance, and it is the
 * only one that also enables geocoding.
 *
 * @param {{googleApiKey?: string, cesiumToken?: string}} credentials
 * @returns {{
 *   route: string,
 *   googleApiKey: string|null,
 *   cesiumToken: string|null,
 *   geocodingAvailable: boolean,
 * }}
 */
export function resolveTilesetRoute({ googleApiKey, cesiumToken } = {}) {
  const google = presentCredential(googleApiKey);
  const ion = presentCredential(cesiumToken);
  let route = TILESET_ROUTE.NONE;
  if (google) route = TILESET_ROUTE.GOOGLE;
  else if (ion) route = TILESET_ROUTE.ION;
  return {
    route,
    googleApiKey: google,
    cesiumToken: ion,
    // Geocoding is Google's Geocoding API, which ion does not resell. Search by
    // place name and reverse geocoding are unavailable on the ion route; the
    // bundled city presets use fixed coordinates and still work.
    geocodingAvailable: google !== null,
  };
}

/** Whether a resolved route can load the photorealistic globe at all. */
export function canLoadPhotorealistic(resolved) {
  return resolved?.route === TILESET_ROUTE.GOOGLE || resolved?.route === TILESET_ROUTE.ION;
}

/**
 * Operator-facing explanation of a resolved route.
 *
 * Returned rather than logged so the caller decides where it belongs, and so
 * the wording is pinned by tests instead of drifting in a console call.
 */
export function describeTilesetRoute(resolved) {
  if (resolved?.route === TILESET_ROUTE.GOOGLE) {
    return 'Photorealistic 3D Tiles via the Google Map Tiles API.';
  }
  if (resolved?.route === TILESET_ROUTE.ION) {
    return 'Photorealistic 3D Tiles via Cesium ion (no Google Maps key set). '
      + 'Place-name search and reverse geocoding are unavailable on this route, '
      + 'and ion applies its own monthly root-tile allowance.';
  }
  return 'No photorealistic globe: set GOOGLE_MAPS_API_KEY, or CESIUM_ION_TOKEN to route through Cesium ion.';
}

/** The startup error raised when neither credential is configured. */
export function missingCredentialsError() {
  return new Error(
    'No map credentials found. Set GOOGLE_MAPS_API_KEY for the Google Map Tiles API, '
    + 'or CESIUM_ION_TOKEN to stream the same tiles through Cesium ion.',
  );
}
