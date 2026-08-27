import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';
import { cachedGroundFloor } from './groundFloor.js';
import { warmFireAnchorFloors } from './fireAnchors.js';
import { snowStemHeightM, stationCardCopy, summarizeStations } from './slfStations.js';

/**
 * WSL/SLF IMIS Alpine stations — the Swiss avalanche-warning measurement grid.
 *
 * ~205 automatic stations, mostly above the tree line between 2,000 and 3,000 m,
 * reporting snow depth, wind, and temperature every 30 minutes. CC BY 4.0 and
 * keyless.
 *
 * Fetched through `/api/slf/stations` rather than directly, because
 * measurement-api.slf.ch sends no CORS headers. That proxy also performs the
 * station-to-measurement join, so this layer receives ready-to-render records
 * instead of ~9,400 raw rows.
 *
 * Rendering follows the earthquakes layer's hard-won rule: geometry is STATIC,
 * redefined only when a poll brings new data. No `CallbackProperty`, so the
 * layer needs no continuous-render hold.
 *
 * Snow depth is drawn as a vertical stem rising from each station, in the
 * spirit of the dam stems — but where a dam stem is a fixed-height locator,
 * this one encodes a real measurement. Snow tops out near 3 m against Alpine
 * relief of 2,000 m or more, so the stem carries a stated vertical
 * exaggeration; the card always shows the true figure in centimetres.
 *
 * Station detail goes through the world overlay as `variant: 'card'` entries,
 * the same path the local infrastructure layers use. Cesium's own `description`
 * InfoBox is NOT available here: the viewer is constructed with
 * `infoBox: false`, so an entity description would render nowhere at all.
 */

export const SLF_OVERLAY_SOURCE_ID = 'slf-alpine-stations';

const API_URL = '/api/slf/stations';

/** Point size in pixels for a station with no snow, and the deepest band. */
const MIN_POINT_PX = 7;
const MAX_POINT_PX = 18;
/** Snow depth (cm) at which a point reaches MAX_POINT_PX. */
const POINT_SCALE_CEILING_CM = 250;
/** Beyond this the cards are noise; the points still render. */
const SLF_OVERLAY_MAX_DISTANCE_M = 900000;
/** Stem radius in metres. Wide enough to read at Alpine viewing distances. */
const STEM_RADIUS_M = 45;
/** Render-governor hold identity and window for the async geometry build. */
const STEM_BUILD_HOLD_ID = 'slf-alpine-stations';
const STEM_BUILD_HOLD_MS = 4000;

/** A station that has stopped reporting. Dim, still present. */
const OFFLINE_COLOR = Cesium.Color.fromCssColorString('#4a545c');

/**
 * Pixel size for a station, scaled by snow depth.
 *
 * Wind masts and silent stations sit at the floor: size encodes snow, and a
 * station that measures no snow should not imply a reading it does not have.
 */
export function stationPointSize(station) {
  const cm = station?.snowDepthCm;
  if (!Number.isFinite(cm) || cm <= 0) return MIN_POINT_PX;
  const t = Math.min(1, cm / POINT_SCALE_CEILING_CM);
  return Math.round(MIN_POINT_PX + t * (MAX_POINT_PX - MIN_POINT_PX));
}

/** Colour for a station: its snow band, or the offline grey. */
export function stationColor(station) {
  if (!station?.reporting || !station.band) return OFFLINE_COLOR;
  return Cesium.Color.fromCssColorString(station.band.accent);
}

/**
 * Build one world-overlay card entry for a station.
 *
 * `interactive: false` matches the local infrastructure cards: these are
 * ambient readouts that surface by proximity, not click targets.
 */
export function createStationOverlayEntry({ station, position, accent }) {
  const copy = stationCardCopy(station);
  return {
    id: `slf-${station.code}`,
    source: SLF_OVERLAY_SOURCE_ID,
    position,
    variant: 'card',
    title: copy.title,
    details: copy.details,
    accent,
    // Deeper snow and reporting stations win the collision budget.
    priority: (station.reporting ? 10000 : 0)
      + Math.round(Number.isFinite(station.snowDepthCm) ? station.snowDepthCm : 0),
    collisionGroup: 'ambient-card',
    zIndex: 30,
    interactive: false,
    minDistance: 0,
    maxDistance: SLF_OVERLAY_MAX_DISTANCE_M,
    edgeFade: 'keyhole',
    horizonCull: true,
  };
}

/**
 * Build the layer.
 *
 * @param {{fetchImpl?: typeof fetch}} [options] Injected for tests.
 */
const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

export function createSwissAlpineStationsLayer({
  fetchImpl = null,
  overlayHost = DEFAULT_OVERLAY_HOST,
} = {}) {
  let _dataSource = null;
  let _enabled = false;
  let _stations = [];
  let _summary = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stemHoldTimer = null;
  let _viewer = null;
  let _moveEndRemove = null;
  let _warmingFloors = false;

  const doFetch = (...args) => (fetchImpl || globalThis.fetch)(...args);

  const layer = {
    id: 'slf-alpine-stations',
    name: 'Alpine Stations (SLF)',
    icon: '🏔️',
    source: 'WSL/SLF',
    // The network reports every 30 minutes and the proxy caches for five, so
    // polling faster than this only spends the server's cache.
    updateInterval: 300000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('slf-alpine-stations');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _stations = [];
      _summary = null;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _viewer = viewer;
      // Stem length is a function of camera altitude, so it has to be redrawn
      // when the camera settles. moveEnd, not preRender: this is a static
      // station field and a per-frame rebuild would be pure waste.
      _moveEndRemove = viewer.camera.moveEnd.addEventListener(() => {
        if (_enabled && _stations.length) this.render();
      });
      overlayHost.setVisible(SLF_OVERLAY_SOURCE_ID, false);
      console.log('[Data:SLF] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(SLF_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      _enabled = false;
      if (_stemHoldTimer) {
        clearTimeout(_stemHoldTimer);
        _stemHoldTimer = null;
      }
      releaseContinuousRender(STEM_BUILD_HOLD_ID);
      if (_dataSource) _dataSource.show = false;
      overlayHost.setVisible(SLF_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      try {
        const response = await doFetch(API_URL);
        if (!response.ok) {
          _lastError = `SLF HTTP ${response.status}`;
          console.warn(`[Data:SLF] proxy returned ${response.status}`);
          return false;
        }
        const data = await response.json();
        if (!data || !Array.isArray(data.stations)) {
          _lastError = 'Malformed SLF response';
          return false;
        }

        _stations = data.stations;
        _summary = data.summary || summarizeStations(_stations);
        _lastError = data.error || null;
        _lastUpdate = Date.now();
        this.render();
        return true;
      } catch (error) {
        _lastError = error?.message || 'SLF request failed';
        console.warn('[Data:SLF] update error:', _lastError);
        return false;
      }
    },

    /**
     * Rebuild entities and overlay cards. Static geometry only.
     *
     * The point is the map glyph; the card is the readout. Cesium labels are
     * deliberately not used, because the overlay owns collision and fade for
     * every ambient card in the app and two competing label systems over the
     * same dense cluster fight each other.
     */
    render() {
      if (!_dataSource) return;
      // Stems scale with viewing altitude, so the height in play is a render
      // input, not a constant.
      const cameraAltitudeM = _viewer?.camera?.positionCartographic?.height ?? 20000;
      _dataSource.entities.removeAll();
      const entries = [];

      for (const station of _stations) {
        const color = stationColor(station);
        // Recipe copied from the dam stems in localGeojson.js, which are the
        // one thing in this app that demonstrably renders a stem. The details
        // that matter, learned the hard way: the polyline and the point live on
        // ONE entity, that entity carries a `position`, the graphics are built
        // with the explicit PolylineGraphics/PointGraphics constructors, and no
        // arcType is set. Separate stem entities with no position never reached
        // the GPU on either software or hardware renderers.
        const stemM = snowStemHeightM(station, cameraAltitudeM);
        // Anchor on the RENDERED mesh, not the station's official altitude.
        // The two disagree by enough that a stem pinned to the published
        // elevation sits inside the mountain, surfacing only as a nub where the
        // mesh happens to dip into a valley. Same trap the dam stems document.
        const meshFloor = cachedGroundFloor(station.lat, station.lon);
        const baseH = Number.isFinite(meshFloor)
          ? meshFloor
          : (Number.isFinite(station.elevationM) ? station.elevationM : 0);
        const base = Cesium.Cartesian3.fromDegrees(station.lon, station.lat, baseH);
        const tip = stemM === null
          ? base
          : Cesium.Cartesian3.fromDegrees(station.lon, station.lat, baseH + stemM);

        const entity = _dataSource.entities.add({
          id: `slf-${station.code}`,
          position: tip,
          point: new Cesium.PointGraphics({
            pixelSize: stationPointSize(station),
            color: color.withAlpha(station.reporting ? 0.95 : 0.45),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            // Never depth-cull the anchor against the photoreal mesh.
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          }),
        });
        if (stemM !== null) {
          entity.polyline = new Cesium.PolylineGraphics({
            positions: [base, tip],
            width: 3.5,
            material: new Cesium.ColorMaterialProperty(color),
          });
        }

        entries.push(createStationOverlayEntry({
          station,
          position: tip,
          accent: station.band?.accent || '#6b7a86',
        }));
      }

      // Ask for any floors we could not resolve, and redraw once they arrive.
      const cold = _stations
        .filter((st) => cachedGroundFloor(st.lat, st.lon) == null)
        .map((st) => ({ lat: st.lat, lon: st.lon }));
      if (cold.length && !_warmingFloors) {
        _warmingFloors = true;
        warmFireAnchorFloors(cold).then(() => {
          _warmingFloors = false;
          if (_enabled && _stations.length) this.render();
        }).catch(() => { _warmingFloors = false; });
      }

      overlayHost.setEntries(SLF_OVERLAY_SOURCE_ID, entries);
      overlayHost.setVisible(SLF_OVERLAY_SOURCE_ID, _enabled);

      // The scene runs in requestRenderMode. Point primitives are ready in the
      // frame after a mutation, but GeometryVisualizer — which owns the stems —
      // builds its primitives ASYNCHRONOUSLY across many frames. On demand
      // rendering never supplies those frames, so the stems were created with
      // valid geometry and silently never reached the GPU. Hold continuous
      // rendering until the build has settled, then let the scene go idle
      // again; a static station field has nothing to animate afterwards.
      governorRequestRender('slf-stations');
      holdContinuousRender(STEM_BUILD_HOLD_ID);
      if (_stemHoldTimer) clearTimeout(_stemHoldTimer);
      _stemHoldTimer = setTimeout(() => {
        _stemHoldTimer = null;
        releaseContinuousRender(STEM_BUILD_HOLD_ID);
        governorRequestRender('slf-stations-settled');
      }, STEM_BUILD_HOLD_MS);
    },

    destroy(viewer) {
      if (_dataSource) {
        _dataSource.entities.removeAll();
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      if (_stemHoldTimer) {
        clearTimeout(_stemHoldTimer);
        _stemHoldTimer = null;
      }
      releaseContinuousRender(STEM_BUILD_HOLD_ID);
      if (_moveEndRemove) {
        _moveEndRemove();
        _moveEndRemove = null;
      }
      _viewer = null;
      overlayHost.clearSource(SLF_OVERLAY_SOURCE_ID);
      _stations = [];
      _summary = null;
      _enabled = false;
    },

    getStats() {
      return {
        count: _summary?.reporting ?? _stations.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        total: _summary?.total ?? _stations.length,
        withSnow: _summary?.withSnow ?? 0,
        maxSnowCm: _summary?.maxSnowCm ?? null,
      };
    },
  };

  return layer;
}

const swissAlpineStationsLayer = createSwissAlpineStationsLayer();

export default swissAlpineStationsLayer;
