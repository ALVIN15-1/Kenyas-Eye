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
import {
  TILESET_ROUTE,
  canLoadPhotorealistic,
  describeTilesetRoute,
  missingCredentialsError,
  resolveTilesetRoute,
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

test('the ion route warns that geocoding is gone', () => {
  const text = describeTilesetRoute(resolveTilesetRoute({ cesiumToken: 'ion-test' }));
  assert.match(text, /Cesium ion/);
  assert.match(text, /geocoding are unavailable/i);
  assert.match(text, /allowance/i);
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
  assert.doesNotMatch(
    source,
    /^\s*Cesium\.GoogleMaps\.defaultApiKey = (?!mapRoute\.googleApiKey)/m,
    'no other assignment path may set the key',
  );
});
