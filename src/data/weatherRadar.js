import * as Cesium from 'cesium';

const RAINVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
const TILE_URL = 'https://tilecache.rainviewer.com/v2/radar/{nowcastTime}/{z}/{x}/{y}/2/1_1.png';
const REFRESH_MS = 600_000; // 10 minutes

export function createWeatherRadarLayer() {
  let _enabled = false;
  let _imageryLayer = null;
  let _lastUpdate = null;
  let _error = null;
  let _destroyed = false;
  let _refreshTimer = null;

  async function fetchLatestTimestamp() {
    const response = await fetch(RAINVIEWER_API);
    if (!response.ok) throw new Error(`RainViewer API returned ${response.status}`);
    const data = await response.json();
    if (data.radar && data.radar.past && data.radar.past.length > 0) {
      return data.radar.past[data.radar.past.length - 1].time;
    }
    throw new Error('No radar frames available');
  }

  async function loadTileLayer(viewer) {
    const timestamp = await fetchLatestTimestamp();
    const url = TILE_URL.replace('{nowcastTime}', String(timestamp));

    if (_imageryLayer) {
      viewer.imageryLayers.remove(_imageryLayer, true);
      _imageryLayer = null;
    }

    const provider = new Cesium.UrlTemplateImageryProvider({
      url,
      maximumLevel: 10,
      credit: 'RainViewer',
    });

    _imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
    _imageryLayer.alpha = 0.45;
    _lastUpdate = Date.now();
    _error = null;
  }

  function scheduleRefresh(viewer) {
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(() => {
      _refreshTimer = null;
      if (!_enabled || _destroyed) return;
      loadTileLayer(viewer).catch((e) => {
        _error = e.message;
        console.warn('[WeatherRadar] refresh failed:', e);
      });
    }, REFRESH_MS);
  }

  return {
    id: 'weather-radar',
    name: 'Weather Radar',
    icon: '\u2601', // ☁
    source: 'RainViewer \u00B7 LIVE',
    updateInterval: 0,
    statsRefreshInterval: 1000,

    init: async (_viewer) => {},

    update: async (_viewer) => {},

    getStats: () => ({
      count: _imageryLayer ? 1 : 0,
      lastUpdate: _lastUpdate,
      error: _error,
    }),

    enable: async (viewer) => {
      if (_destroyed) return;
      _enabled = true;
      try {
        await loadTileLayer(viewer);
        scheduleRefresh(viewer);
      } catch (e) {
        _error = e.message;
      }
    },

    disable: (viewer) => {
      _enabled = false;
      if (_refreshTimer) {
        clearTimeout(_refreshTimer);
        _refreshTimer = null;
      }
      if (_imageryLayer && !viewer.isDestroyed()) {
        viewer.imageryLayers.remove(_imageryLayer, true);
        _imageryLayer = null;
      }
    },

    destroy: (viewer) => {
      _destroyed = true;
      this.disable(viewer);
    },
  };
}