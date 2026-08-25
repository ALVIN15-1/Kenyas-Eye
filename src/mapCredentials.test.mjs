// src/mapCredentials.test.mjs
// The whole point of this module is one CesiumJS behaviour: inside
// `createGooglePhotorealistic3DTileset`, an undefined `GoogleMaps.defaultApiKey`
// routes the request to an ion-hosted copy of the same tileset. Assigning ANY
// value — including an empty string — sends it to Google instead.
//
// So the contract pinned hardest here is that the ion route yields
// `googleApiKey: null`, never an empty string. A blank credential leaking
// through as `''` would silently disable the fallback and the failure would
// look like an unrelated tile error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TILESET_ROUTE,
  canLoadPhotorealistic,
  describeTilesetRoute,
  ionRetryRoute,
  missingCredentialsError,
  resolveTilesetRoute,
  shouldRetryViaIon,
} from './mapCredentials.js';

test('a Google key takes the direct route', () => {
  const resolved = resolveTilesetRoute({ googleApiKey: 'AIza-test' });
  assert.equal(resolved.route, TILESET_ROUTE.GOOGLE);
  assert.equal(resolved.googleApiKey, 'AIza-test');
  assert.equal(resolved.geocodingAvailable, true);
});

test('an ion token alone routes through Cesium ion', () => {
  const resolved = resolveTilesetRoute({ cesiumToken: 'ion-test' });
  assert.equal(resolved.route, TILESET_ROUTE.ION);
  assert.equal(resolved.cesiumToken, 'ion-test');
  assert.equal(resolved.geocodingAvailable, false);
});

test('the ion route reports a null Google key, never an empty string', () => {
  // An empty string assigned to GoogleMaps.defaultApiKey defeats the fallback.
  for (const blank of [undefined, null, '', '   ']) {
    const resolved = resolveTilesetRoute({ googleApiKey: blank, cesiumToken: 'ion-test' });
    assert.equal(resolved.route, TILESET_ROUTE.ION, `blank ${JSON.stringify(blank)} must not take the Google route`);
    assert.strictEqual(resolved.googleApiKey, null, 'must be null so the caller skips the assignment entirely');
  }
});

test('a Google key wins when both are configured', () => {
  const resolved = resolveTilesetRoute({ googleApiKey: 'AIza-test', cesiumToken: 'ion-test' });
  assert.equal(resolved.route, TILESET_ROUTE.GOOGLE);
  // The ion token is still reported: World Terrain and the Bing stacks use it.
  assert.equal(resolved.cesiumToken, 'ion-test');
  assert.equal(resolved.geocodingAvailable, true);
});

test('credentials are trimmed', () => {
  assert.equal(resolveTilesetRoute({ googleApiKey: '  AIza-test  ' }).googleApiKey, 'AIza-test');
  assert.equal(resolveTilesetRoute({ cesiumToken: '  ion-test  ' }).cesiumToken, 'ion-test');
});

test('neither credential leaves the globe unloadable', () => {
  const resolved = resolveTilesetRoute({});
  assert.equal(resolved.route, TILESET_ROUTE.NONE);
  assert.equal(canLoadPhotorealistic(resolved), false);
  assert.equal(resolveTilesetRoute().route, TILESET_ROUTE.NONE);
});

test('canLoadPhotorealistic accepts both working routes', () => {
  assert.equal(canLoadPhotorealistic(resolveTilesetRoute({ googleApiKey: 'k' })), true);
  assert.equal(canLoadPhotorealistic(resolveTilesetRoute({ cesiumToken: 't' })), true);
  assert.equal(canLoadPhotorealistic(null), false);
  assert.equal(canLoadPhotorealistic(undefined), false);
});

test('the ion route warns that geocoding is gone when it really is', () => {
  const text = describeTilesetRoute(resolveTilesetRoute({ cesiumToken: 'ion-test' }));
  assert.match(text, /Cesium ion/);
  assert.match(text, /geocoding are unavailable/i);
  assert.match(text, /allowance/i);
});

test('after an ion retry it does NOT claim search is gone, because it is not', () => {
  const retry = ionRetryRoute(resolveTilesetRoute({ googleApiKey: 'k', cesiumToken: 't' }));
  const text = describeTilesetRoute(retry);
  assert.match(text, /Cesium ion/);
  assert.match(text, /still uses the configured Google key/i);
  assert.doesNotMatch(text, /unavailable/i, 'the key still geocodes; only tiles were blocked');
});

test('the Google route describes itself without warnings', () => {
  const text = describeTilesetRoute(resolveTilesetRoute({ googleApiKey: 'k' }));
  assert.match(text, /Google Map Tiles API/);
  assert.doesNotMatch(text, /unavailable/i);
});

test('the no-credential description names both ways out', () => {
  const text = describeTilesetRoute(resolveTilesetRoute({}));
  assert.match(text, /GOOGLE_MAPS_API_KEY/);
  assert.match(text, /CESIUM_ION_TOKEN/);
});

test('the startup error names both credentials', () => {
  const error = missingCredentialsError();
  assert.ok(error instanceof Error);
  assert.match(error.message, /GOOGLE_MAPS_API_KEY/);
  assert.match(error.message, /CESIUM_ION_TOKEN/);
});

test('main.js never assigns the Google key on the ion route', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  // The assignment must sit behind a truthiness guard. An unguarded assignment
  // of a possibly-empty value is the exact regression this module prevents.
  assert.match(
    source,
    /if \(mapRoute\.googleApiKey\) \{\s*\n\s*Cesium\.GoogleMaps\.defaultApiKey = mapRoute\.googleApiKey;/,
    'GoogleMaps.defaultApiKey must only be assigned when a real key exists',
  );
  // Exactly two assignments are legitimate: the real key, and `undefined` to
  // clear it for the ion retry. Anything else — notably an empty string —
  // silently sends tiles back to Google and defeats the fallback.
  const assignments = [...source.matchAll(/Cesium\.GoogleMaps\.defaultApiKey = ([^;]+);/g)]
    .map((match) => match[1].trim());
  assert.deepEqual(
    assignments.filter((value) => value !== 'mapRoute.googleApiKey' && value !== 'undefined'),
    [],
    'the key may only be set to the resolved key or cleared to undefined',
  );
});

// ── ion retry after a blocked Google key ────────────────────────────────────
// Observed in the field: a key that geocodes perfectly while every tile request
// returns 403 API_KEY_SERVICE_BLOCKED, because Map Tiles was enabled on the
// project but left off the key's API-restrictions list. Before this retry the
// app dropped to the plain globe, so ADDING a Google key made the globe worse
// than having none — with a working ion token sitting unused.

test('a blocked Google key retries through ion when a token exists', () => {
  const resolved = resolveTilesetRoute({ googleApiKey: 'AIza-blocked', cesiumToken: 'ion-test' });
  assert.equal(shouldRetryViaIon(resolved), true);
});

test('there is nothing to retry without an ion token', () => {
  assert.equal(shouldRetryViaIon(resolveTilesetRoute({ googleApiKey: 'AIza-blocked' })), false);
});

test('the ion route does not retry itself', () => {
  assert.equal(shouldRetryViaIon(resolveTilesetRoute({ cesiumToken: 'ion-test' })), false,
    'already on ion; a retry would loop');
  assert.equal(shouldRetryViaIon(resolveTilesetRoute({})), false);
  assert.equal(shouldRetryViaIon(null), false);
});

test('the retry route withholds the Google key so the ion path engages', () => {
  const resolved = resolveTilesetRoute({ googleApiKey: 'AIza-blocked', cesiumToken: 'ion-test' });
  const retry = ionRetryRoute(resolved);
  assert.equal(retry.route, TILESET_ROUTE.ION);
  assert.strictEqual(retry.googleApiKey, null, 'any value here sends tiles back to Google');
  assert.equal(retry.cesiumToken, 'ion-test');
});

test('geocoding survives the retry, because only the tile request is affected', () => {
  const resolved = resolveTilesetRoute({ googleApiKey: 'AIza-blocked', cesiumToken: 'ion-test' });
  assert.equal(ionRetryRoute(resolved).geocodingAvailable, true,
    'the key still works for the Geocoding API; only Map Tiles is blocked');
});

test('the retry describes itself as the ion route', () => {
  const retry = ionRetryRoute(resolveTilesetRoute({ googleApiKey: 'k', cesiumToken: 't' }));
  assert.match(describeTilesetRoute(retry), /Cesium ion/);
});

test('main.js clears the Google key before retrying, and only there', () => {
  const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /Cesium\.GoogleMaps\.defaultApiKey = undefined;/,
    'the retry must clear the key or CesiumJS will not take the ion path',
  );
  assert.match(source, /shouldRetryViaIon\(mapRoute\)/);
});
