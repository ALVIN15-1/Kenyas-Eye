// src/data/alprCameras.test.mjs
// Focused tests for the pure helpers — no viewer/DOM needed; imported directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPR_HOME_BOX,
  alprBoxesEqual,
  alprQueryBoxFromView,
  alprRetryDelayMs,
  destinationPointDeg,
  fallbackAlprElementsInBox,
  formatAlprBboxCoord,
  isFlockOperated,
  normalizeAlprNode,
  quantizeAlprBox,
} from './alprCameras.js';

test('isFlockOperated: matches on operator or manufacturer, case-insensitively', () => {
  assert.equal(isFlockOperated({ operator: 'Flock Safety' }), true);
  assert.equal(isFlockOperated({ manufacturer: 'flock safety inc' }), true);
  assert.equal(isFlockOperated({ brand: 'Flock Safety' }), true);
  assert.equal(isFlockOperated({ operator: 'City of Springfield PD' }), false);
  assert.equal(isFlockOperated({}), false);
  assert.equal(isFlockOperated(undefined), false);
});

test('normalizeAlprNode: maps a full OSM node to a plain record', () => {
  const record = normalizeAlprNode({
    type: 'node',
    id: 12345,
    lat: 30.2672,
    lon: -97.7431,
    tags: {
      man_made: 'surveillance',
      'surveillance:type': 'ALPR',
      operator: 'Flock Safety',
      'camera:type': 'fixed',
      'surveillance:zone': 'traffic',
      'camera:direction': '270',
      ref: 'ATX-001',
      check_date: '2026-06-01',
    },
  });
  assert.deepEqual(record, {
    id: 'alpr:12345',
    osmId: 12345,
    latitude: 30.2672,
    longitude: -97.7431,
    flock: true,
    operator: 'Flock Safety',
    manufacturer: null,
    cameraType: 'fixed',
    zone: 'traffic',
    directionDeg: 270,
    ref: 'ATX-001',
    lastVerified: '2026-06-01',
    source: null,
  });
});

test('normalizeAlprNode: rejects non-node elements and missing coordinates', () => {
  assert.equal(normalizeAlprNode(null), null);
  assert.equal(normalizeAlprNode({ type: 'way', id: 1, tags: {} }), null);
  assert.equal(normalizeAlprNode({ type: 'node', id: 1, lat: NaN, lon: 1, tags: {} }), null);
});

test('normalizeAlprNode: a present-but-blank direction tag reads as missing, not zero', () => {
  const record = normalizeAlprNode({
    type: 'node',
    id: 1,
    lat: 30,
    lon: -97,
    tags: { man_made: 'surveillance', 'surveillance:type': 'ALPR', 'camera:direction': '' },
  });
  assert.equal(record.directionDeg, null);
});

test('destinationPointDeg: due-north offset increases latitude, keeps longitude', () => {
  const dest = destinationPointDeg(30, -97, 0, 100);
  assert.ok(dest.latitude > 30);
  assert.ok(Math.abs(dest.longitude - -97) < 1e-6);
});

test('alprRetryDelayMs: doubles from a 30s floor to a 240s ceiling', () => {
  assert.equal(alprRetryDelayMs(0), 30000);
  assert.equal(alprRetryDelayMs(30000), 60000);
  assert.equal(alprRetryDelayMs(200000), 240000);
  assert.equal(alprRetryDelayMs(240000), 240000);
});

test('alprQueryBoxFromView: Lannon look-at uses the disk-cached home bbox', () => {
  const lookAt = { lat: 43.2134, lon: -88.1480 };
  const huge = { south: 40, west: -92, north: 46, east: -86 };
  const tiny = { south: 43.21, west: -88.15, north: 43.22, east: -88.14 };
  assert.deepEqual(alprQueryBoxFromView(huge, lookAt), { ...ALPR_HOME_BOX });
  assert.deepEqual(alprQueryBoxFromView(tiny, lookAt), { ...ALPR_HOME_BOX });
  assert.equal(formatAlprBboxCoord(ALPR_HOME_BOX.south), '43.10');
});

test('alprQueryBoxFromView: clamps a too-wide frustum away from home to a look-at window', () => {
  const lookAt = { lat: 43.05, lon: -89.40 };
  const huge = { south: 40, west: -92, north: 46, east: -86 };
  const box = alprQueryBoxFromView(huge, lookAt);
  assert.ok(box.north - box.south <= 0.4);
  assert.ok(box.east - box.west <= 0.4);
  assert.ok(box.south < lookAt.lat && lookAt.lat < box.north);
  assert.ok(box.west < lookAt.lon && lookAt.lon < box.east);
});

test('fallbackAlprElementsInBox: Lannon home extract includes mapped cameras', () => {
  const hits = fallbackAlprElementsInBox(ALPR_HOME_BOX);
  assert.ok(hits.length >= 30);
  assert.equal(fallbackAlprElementsInBox({ south: 0, west: 0, north: 1, east: 1 }).length, 0);
});

test('quantizeAlprBox: nearby pans share a cache cell', () => {
  const a = quantizeAlprBox({ south: 43.211, west: -88.149, north: 43.219, east: -88.141 });
  const b = quantizeAlprBox({ south: 43.213, west: -88.147, north: 43.221, east: -88.139 });
  assert.equal(alprBoxesEqual(a, b), true);
});

test('quantizeAlprBox: a tiny frustum still has area after snapping', () => {
  const box = quantizeAlprBox({ south: 43.2134, west: -88.1480, north: 43.2135, east: -88.1479 });
  assert.ok(box.north > box.south);
  assert.ok(box.east > box.west);
});
