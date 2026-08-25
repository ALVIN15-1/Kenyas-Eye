// src/mapCredentials.js
// Decides how the photorealistic globe is authorized at boot.
//
// There are two routes to the same Google mesh. The direct one uses a Google
// Maps key against the Map Tiles API. The other goes through Cesium ion, which
// resells access: CesiumJS requests an ion asset whenever
// `GoogleMaps.defaultApiKey` is undefined, ion authorizes it and returns a
// Google key of its own, and the tiles then stream from Google either way.
// ion's free Community tier includes an allowance of those root requests.
//
// So "the ion route" means ion brokered the authorization, NOT that Google went
// uncontacted — the tile payloads come from tile.googleapis.com on both paths.
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
    // Geocoding is reported from the resolved route, not assumed from it: after
    // a retry the Google key is still configured for the Geocoding API even
    // though it was withheld from the tile request, so claiming search is gone
    // would be simply untrue.
    const geocoding = resolved.geocodingAvailable
      ? 'Place-name search still uses the configured Google key. '
      : 'Place-name search and reverse geocoding are unavailable on this route. ';
    return `Photorealistic 3D Tiles via Cesium ion. ${geocoding}`
      + 'ion applies its own monthly root-tile allowance.';
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

/**
 * Whether a failed Google tileset load is worth retrying through Cesium ion.
 *
 * A Google key can be valid for one API and blocked for another: enabling the
 * Map Tiles API but leaving it off a key's API-restrictions list yields
 * `API_KEY_SERVICE_BLOCKED`, which is indistinguishable from a missing key as
 * far as the globe is concerned. Observed in the field with a key that
 * geocoded perfectly while every tile request 403'd.
 *
 * Without this the app drops to the plain Cesium globe even when a working ion
 * token is sitting right there, so adding a Google key could make the globe
 * WORSE than having none at all.
 *
 * @param {object} resolved Result of resolveTilesetRoute.
 * @returns {boolean} True when the ion route is available and untried.
 */
export function shouldRetryViaIon(resolved) {
  return resolved?.route === TILESET_ROUTE.GOOGLE && Boolean(resolved.cesiumToken);
}

/**
 * The route to use for that retry.
 *
 * Drops the Google key so `GoogleMaps.defaultApiKey` can be cleared, which is
 * the only thing that makes CesiumJS take the ion path. Geocoding is unaffected
 * — it reads its own global, which the caller leaves in place.
 *
 * @param {object} resolved Result of resolveTilesetRoute.
 * @returns {object} An ion-route descriptor.
 */
export function ionRetryRoute(resolved) {
  return {
    route: TILESET_ROUTE.ION,
    googleApiKey: null,
    cesiumToken: resolved?.cesiumToken ?? null,
    // Geocoding survives the retry: the Google key stays configured for the
    // Geocoding API even though it is withheld from the tile request.
    geocodingAvailable: Boolean(resolved?.googleApiKey),
  };
}
