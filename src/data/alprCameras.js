import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from './contextStore.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';
import { ALPR_FALLBACK_ELEMENTS } from './alprCamerasFallback.js';

/**
 * @file Public ALPR / Flock Safety camera layer.
 *
 * Data source: OpenStreetMap, tagged by the crowdsourced DeFlock project
 * (`man_made=surveillance` + `surveillance:type=ALPR`) — see
 * https://wiki.openstreetmap.org/wiki/Tag:surveillance:type=ALPR and
 * https://deflock.me. Fetched viewport-bounded through the existing generic
 * `/api/overpass` proxy (same one `traffic.js` and `militaryInstallations.js`
 * use) — no new server route needed for a single narrow tag pair.
 *
 * This is mapped surveillance infrastructure, not a live camera feed: no
 * plate records, no vendor accounts, nothing beyond what a contributor chose
 * to publish to OSM. See issue #5.
 *
 * @module data/alprCameras
 */

const LAYER_ID = 'alpr-cameras';
const OVERPASS_URL = '/api/overpass';
const REQUEST_DEBOUNCE_MS = 500;
/**
 * Half-size of the Overpass bbox when the camera frustum is too wide (oblique
 * fly-ins, 25 km start) or wrapping. ~0.07° is ~8 km — similar to the Lannon
 * corridor query that public mirrors and the disk cache already handle. A 0.8°
 * Milwaukee-metro dump 502s those mirrors.
 */
export const ALPR_QUERY_HALF_SPAN_DEG = 0.07;
export const ALPR_QUERY_HALF_LON_DEG = 0.10;
/** Snap bbox edges so nearby pans share the Overpass cache and do not abort in-flight fetches. */
export const ALPR_BBOX_QUANTUM_DEG = 0.05;
/**
 * Exact bbox of the Lannon / US-45 Overpass extract already on disk.
 * The live client must send this bbox or nearby variants 502 while mirrors are down.
 */
export const ALPR_HOME_BOX = Object.freeze({
  south: 43.10,
  west: -88.28,
  north: 43.24,
  east: -88.08,
});
/** Overpass `out body N;` cap — also used to detect a truncated (saturated) response. */
const QUERY_LIMIT = 600;
const MAX_RENDERED = 500;
/** Meters — length of the facing-direction indicator line, when a camera reports one. */
const DIRECTION_CONE_M = 25;
const EARTH_MEAN_RADIUS_M = 6371008.8;
const FLOCK_COLOR = '#ff5a5a';
const OTHER_ALPR_COLOR = '#5ab0ff';

const state = {
  viewer: null,
  dataSource: null,
  enabled: false,
  records: [],
  recordById: new Map(),
  selectedId: null,
  lastUpdate: null,
  error: null,
  status: 'idle',
  stale: false,
  /** Whether the query hit QUERY_LIMIT — the view likely holds more cameras than shown. */
  saturated: false,
  loading: false,
  abort: null,
  queryBox: null,
  retryTimer: null,
  retryDelayMs: 0,
  moveEndRemove: null,
  clickHandler: null,
};

function textTag(value) {
  const t = String(value ?? '').trim();
  return t || null;
}

function numTag(value) {
  // `Number('')` is 0, not NaN — a blank tag value must read as missing.
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Flock Safety cameras get their own color; every other tagged ALPR shares another. */
export function isFlockOperated(tags) {
  const haystack = [tags?.operator, tags?.manufacturer, tags?.brand].join(' ').toLowerCase();
  return haystack.includes('flock');
}

function colorFor(record) {
  return Cesium.Color.fromCssColorString(record.flock ? FLOCK_COLOR : OTHER_ALPR_COLOR);
}

/**
 * Great-circle destination point — used only to draw the short
 * facing-direction line when a node carries `camera:direction`/`direction`.
 * @param {number} latDeg @param {number} lonDeg
 * @param {number} bearingDeg Compass bearing, degrees clockwise from north.
 * @param {number} distanceM
 * @returns {{latitude:number, longitude:number}}
 */
export function destinationPointDeg(latDeg, lonDeg, bearingDeg, distanceM) {
  const angularDistance = distanceM / EARTH_MEAN_RADIUS_M;
  const bearing = Cesium.Math.toRadians(bearingDeg);
  const lat1 = Cesium.Math.toRadians(latDeg);
  const lon1 = Cesium.Math.toRadians(lonDeg);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance)
    + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
  );
  return { latitude: Cesium.Math.toDegrees(lat2), longitude: Cesium.Math.toDegrees(lon2) };
}

/**
 * Backoff progression for the unavailable-state retry: 30 s, doubling to a
 * 240 s ceiling. Pure so the progression is pinnable without booting the layer.
 */
export function alprRetryDelayMs(prevDelayMs) {
  const RETRY_MIN_MS = 30000;
  const RETRY_CEIL_MS = 240000;
  if (!Number.isFinite(prevDelayMs) || prevDelayMs <= 0) return RETRY_MIN_MS;
  return Math.min(prevDelayMs * 2, RETRY_CEIL_MS);
}

/** Map one raw Overpass node element to a plain camera record. Null for anything unusable. */
export function normalizeAlprNode(el) {
  if (!el || el.type !== 'node' || !Number.isFinite(el.lat) || !Number.isFinite(el.lon)) return null;
  const tags = el.tags || {};
  return {
    id: `alpr:${el.id}`,
    osmId: el.id,
    latitude: el.lat,
    longitude: el.lon,
    flock: isFlockOperated(tags),
    operator: textTag(tags.operator),
    manufacturer: textTag(tags.manufacturer),
    cameraType: textTag(tags['camera:type']),
    zone: textTag(tags['surveillance:zone']),
    // ponytail: only numeric bearings are parsed; compass-word directions
    // ("N"/"NE") are rare on this tag and just render with no cone.
    directionDeg: numTag(tags['camera:direction'] ?? tags.direction),
    ref: textTag(tags.ref),
    lastVerified: textTag(tags.check_date) || textTag(tags['survey:date']),
    source: textTag(tags.source),
  };
}

export function formatAlprBboxCoord(value) {
  return Number(value).toFixed(2);
}

function buildOverpassQuery(south, west, north, east) {
  return `[out:json][timeout:20];node["man_made"="surveillance"]["surveillance:type"="ALPR"]`
    + `(${formatAlprBboxCoord(south)},${formatAlprBboxCoord(west)},${formatAlprBboxCoord(north)},${formatAlprBboxCoord(east)});out body ${QUERY_LIMIT};`;
}

export function lookAtInAlprBox(lookAt, box) {
  return Boolean(lookAt && box
    && Number.isFinite(lookAt.lat) && Number.isFinite(lookAt.lon)
    && lookAt.lat >= box.south && lookAt.lat <= box.north
    && lookAt.lon >= box.west && lookAt.lon <= box.east);
}

export function fallbackAlprElementsInBox(box) {
  if (!box) return [];
  return ALPR_FALLBACK_ELEMENTS.filter((el) => (
    el.lat >= box.south && el.lat <= box.north
    && el.lon >= box.west && el.lon <= box.east
  ));
}

export function quantizeAlprCoord(value, quantum = ALPR_BBOX_QUANTUM_DEG, mode = 'nearest') {
  if (!Number.isFinite(value) || !Number.isFinite(quantum) || quantum <= 0) return value;
  const n = value / quantum;
  let snapped;
  if (mode === 'floor') snapped = Math.floor(n) * quantum;
  else if (mode === 'ceil') snapped = Math.ceil(n) * quantum;
  else snapped = Math.round(n) * quantum;
  return Number(snapped.toFixed(6));
}

export function quantizeAlprBox(box, quantum = ALPR_BBOX_QUANTUM_DEG) {
  if (!box) return null;
  let south = quantizeAlprCoord(box.south, quantum, 'floor');
  let west = quantizeAlprCoord(box.west, quantum, 'floor');
  let north = quantizeAlprCoord(box.north, quantum, 'ceil');
  let east = quantizeAlprCoord(box.east, quantum, 'ceil');
  if (north <= south) north = south + quantum;
  if (east <= west) east = west + quantum;
  return { south, west, north, east };
}

export function alprBoxesEqual(a, b) {
  return Boolean(a && b
    && a.south === b.south
    && a.west === b.west
    && a.north === b.north
    && a.east === b.east);
}

/**
 * Always query a small, stable window. A "valid" 1–3° frustum still 502s
 * public Overpass (dense ALPR). Nearby unique tiny frustums miss the disk
 * cache. If the camera is inside the home extract, send that exact bbox.
 */
export function alprQueryBoxFromView(viewBox, lookAt) {
  const lat = Number.isFinite(lookAt?.lat)
    ? lookAt.lat
    : (Number.isFinite(viewBox?.south + viewBox?.north) ? (viewBox.south + viewBox.north) / 2 : NaN);
  const lon = Number.isFinite(lookAt?.lon)
    ? lookAt.lon
    : (Number.isFinite(viewBox?.west + viewBox?.east) ? (viewBox.west + viewBox.east) / 2 : NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lookAtInAlprBox({ lat, lon }, ALPR_HOME_BOX)) return { ...ALPR_HOME_BOX };
  return quantizeAlprBox({
    south: lat - ALPR_QUERY_HALF_SPAN_DEG,
    north: lat + ALPR_QUERY_HALF_SPAN_DEG,
    west: lon - ALPR_QUERY_HALF_LON_DEG,
    east: lon + ALPR_QUERY_HALF_LON_DEG,
  });
}

function lookAtDeg(viewer) {
  const carto = viewer?.camera?.positionCartographic;
  if (!carto) return null;
  return {
    lat: Cesium.Math.toDegrees(carto.latitude),
    lon: Cesium.Math.toDegrees(carto.longitude),
  };
}

async function fetchAlprNodes(box, signal) {
  const query = buildOverpassQuery(box.south, box.west, box.north, box.east);
  const response = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
    signal,
  });
  if (!response.ok) throw new Error(`Overpass API returned ${response.status}`);
  const stale = response.headers.get('x-overpass-cache') === 'STALE';
  const payload = await response.json();
  return { elements: Array.isArray(payload?.elements) ? payload.elements : [], stale };
}

function setAlprStatus(status, error = null) {
  if (state.status === status && state.error === error) return;
  state.status = status;
  state.error = error;
  governorRequestRender('alpr-status');
}

function applyAlprElements(elements, stale) {
  const records = elements.map(normalizeAlprNode).filter(Boolean);
  state.records = records;
  state.recordById = new Map(records.map((r) => [r.id, r]));
  state.lastUpdate = Date.now();
  state.stale = stale;
  state.saturated = elements.length >= QUERY_LIMIT;
  setAlprStatus(
    records.length ? (stale ? 'stale' : 'ready') : 'empty',
    stale
      ? 'Serving cached ALPR camera locations'
      : (state.saturated ? 'Too many mapped cameras in view to list them all — zoom in' : null),
  );
  renderRecords();
}

function viewportBox(viewer) {
  const rectangle = viewer?.camera?.computeViewRectangle(viewer.scene.globe.ellipsoid);
  if (!rectangle) return null;
  const south = Cesium.Math.toDegrees(rectangle.south);
  const north = Cesium.Math.toDegrees(rectangle.north);
  const west = Cesium.Math.toDegrees(rectangle.west);
  const east = Cesium.Math.toDegrees(rectangle.east);
  if (!Number.isFinite(south + north + west + east)) return null;
  return { south, west, north, east };
}

function clearRendered() {
  if (state.dataSource?.entities) state.dataSource.entities.removeAll();
  removeEntityContextsForLayer(LAYER_ID);
}

function renderRecords() {
  governorRequestRender('alpr-render');
  clearRendered();
  for (const record of state.records.slice(0, MAX_RENDERED)) {
    const color = colorFor(record);
    const selected = record.id === state.selectedId;
    const position = Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude);
    const entityDef = {
      id: record.id,
      position,
      point: {
        pixelSize: selected ? 12 : 8,
        color: selected ? Cesium.Color.WHITE : color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    };
    if (Number.isFinite(record.directionDeg)) {
      const tip = destinationPointDeg(record.latitude, record.longitude, record.directionDeg, DIRECTION_CONE_M);
      entityDef.polyline = {
        positions: [position, Cesium.Cartesian3.fromDegrees(tip.longitude, tip.latitude)],
        width: 2,
        material: color.withAlpha(0.85),
        clampToGround: true,
      };
    }
    const entity = state.dataSource.entities.add(entityDef);
    entity.gevDisplayPosition = () => position;
    entity.gevLabelModel = {
      title: record.flock ? 'FLOCK SAFETY ALPR' : 'ALPR CAMERA',
      details: [record.operator, record.zone ? record.zone.toUpperCase() : null].filter(Boolean),
      accent: color.toCssColorString(),
    };
    registerEntityContext(entity, {
      id: record.id,
      layerId: LAYER_ID,
      layerName: 'ALPR / Flock Cameras',
      source: record.source || 'OpenStreetMap contributors / DeFlock (crowdsourced)',
      label: record.flock ? 'Flock Safety ALPR camera' : 'ALPR camera',
      latitude: record.latitude,
      longitude: record.longitude,
      properties: {
        operator: record.operator,
        manufacturer: record.manufacturer,
        cameraType: record.cameraType,
        zone: record.zone,
        directionDeg: record.directionDeg,
        ref: record.ref,
        lastVerified: record.lastVerified,
        osmId: record.osmId,
      },
    });
  }
  const selectedEntity = state.selectedId ? state.dataSource.entities.getById(state.selectedId) : null;
  if (selectedEntity) selectEntityContext(selectedEntity);
  else state.selectedId = null;
}

function selectRecord(id) {
  if (!state.recordById.has(id) || !state.dataSource) return false;
  state.selectedId = id;
  renderRecords();
  return state.selectedId === id;
}

function installInteraction(viewer) {
  if (state.clickHandler) return;
  state.clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  state.clickHandler.setInputAction((click) => {
    if (!state.enabled) return;
    const picked = viewer.scene.pick(click.position);
    const id = typeof picked?.id?.id === 'string' ? picked.id.id : null;
    if (id && state.recordById.has(id)) selectRecord(id);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function scheduleUnavailableRetry() {
  if (!state.enabled) return;
  clearTimeout(state.retryTimer);
  state.retryDelayMs = alprRetryDelayMs(state.retryDelayMs);
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    if (state.enabled && !state.loading) loadCameras();
  }, state.retryDelayMs);
}

function clearUnavailableRetry({ resetBackoff = true } = {}) {
  clearTimeout(state.retryTimer);
  state.retryTimer = null;
  if (resetBackoff) state.retryDelayMs = 0;
}

function scheduleLoad() {
  if (!state.enabled) return;
  clearUnavailableRetry({ resetBackoff: false });
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => { loadCameras(); }, REQUEST_DEBOUNCE_MS);
}

async function loadCameras() {
  if (!state.enabled || !state.viewer) return;
  const box = alprQueryBoxFromView(viewportBox(state.viewer), lookAtDeg(state.viewer));
  if (!box) {
    state.abort?.abort();
    state.abort = null;
    state.loading = false;
    clearUnavailableRetry();
    setAlprStatus('zoom-in', 'Zoom in to load mapped ALPR camera locations');
    return;
  }
  if (alprBoxesEqual(box, state.queryBox) && (state.loading || state.status === 'ready' || state.status === 'empty' || state.status === 'stale')) {
    return;
  }
  state.abort?.abort();
  const requestAbort = new AbortController();
  state.abort = requestAbort;
  state.queryBox = box;
  state.loading = true;
  try {
    const { elements, stale } = await fetchAlprNodes(box, requestAbort.signal);
    if (requestAbort.signal.aborted || state.abort !== requestAbort || !state.enabled) return;
    applyAlprElements(elements, stale);
    clearUnavailableRetry();
  } catch (error) {
    if (error?.name === 'AbortError') return;
    const fallback = fallbackAlprElementsInBox(box);
    if (fallback.length) {
      applyAlprElements(fallback, true);
      scheduleUnavailableRetry();
      return;
    }
    setAlprStatus('unavailable', error?.message || 'ALPR camera feed unavailable');
    scheduleUnavailableRetry();
  } finally {
    if (state.abort === requestAbort) {
      state.abort = null;
      state.loading = false;
    }
  }
}

const alprCamerasLayer = {
  id: LAYER_ID,
  name: 'ALPR / Flock Cameras',
  icon: '📷',
  source: 'OpenStreetMap / DeFlock (Overpass)',
  updateInterval: 0,
  statsRefreshInterval: 1000,
  init(viewer) {
    state.viewer = viewer;
    state.dataSource = new Cesium.CustomDataSource('alpr-cameras');
    viewer.dataSources.add(state.dataSource);
    state.moveEndRemove = viewer.camera.moveEnd.addEventListener(scheduleLoad);
    installInteraction(viewer);
  },
  enable() {
    state.enabled = true;
    registerPickOwner(LAYER_ID, (id) => state.recordById.has(id));
    state.dataSource.show = true;
    // DataLayerManager calls update() right after enable(); it owns the first fetch.
  },
  disable() {
    state.enabled = false;
    unregisterPickOwner(LAYER_ID);
    clearUnavailableRetry();
    clearTimeout(state.debounceTimer);
    state.abort?.abort();
    state.abort = null;
    state.loading = false;
    state.queryBox = null;
    if (state.dataSource) state.dataSource.show = false;
    clearSelectedEntityContextForLayer(LAYER_ID);
    state.selectedId = null;
  },
  update() { return loadCameras(); },
  destroy(viewer) {
    this.disable();
    state.moveEndRemove?.();
    state.moveEndRemove = null;
    state.clickHandler?.destroy();
    state.clickHandler = null;
    clearRendered();
    if (state.dataSource && viewer) viewer.dataSources.remove(state.dataSource, true);
    state.dataSource = null;
    state.records = [];
    state.recordById = new Map();
    state.queryBox = null;
    state.lastUpdate = null;
    state.error = null;
    state.status = 'idle';
  },
  getStats() {
    return {
      count: state.records.length,
      lastUpdate: state.lastUpdate,
      stale: state.stale,
      saturated: state.saturated,
      error: state.error,
      status: state.status,
      loading: state.loading,
      loadingLabel: state.loading ? 'loading ALPR camera locations' : '',
    };
  },
};

export default alprCamerasLayer;
