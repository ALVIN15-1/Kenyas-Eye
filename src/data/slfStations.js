// src/data/slfStations.js
// Normalization for the WSL/SLF IMIS network — the Swiss avalanche-warning
// station grid, CC BY 4.0 and keyless.
//
// Pure by design: no Cesium, no fetch. The Vite proxy imports it to shape its
// response and the layer imports it to render, so the join and the banding are
// exercised under `node --test` rather than only in a browser.
//
// Units come from the published OpenAPI schema at
// measurement-api.slf.ch/openapi.json and are NOT guessed:
//   HS               snow height, cm
//   HN_1D            new snow over 24 h, cm
//   TA_30MIN_MEAN    air temperature, °C
//   TSS_30MIN_MEAN   snow surface temperature, °C
//   VW_30MIN_MEAN    wind speed, vectorial mean, m/s
//   VW_30MIN_MAX     wind speed, 5 s maximum, m/s
//   DW_30MIN_MEAN    wind direction, degrees
//   RH_30MIN_MEAN    relative humidity, %
//   elevation        metres above sea level, WGS84 lon/lat

/** Station types the IMIS network reports, with how each should read. */
export const SLF_STATION_TYPES = Object.freeze({
  SNOW_FLAT: { label: 'Snow (flat field)', primary: 'snow' },
  SNOW_SLOPE: { label: 'Snow (slope)', primary: 'snow' },
  WIND: { label: 'Wind', primary: 'wind' },
  FLOWCAPT: { label: 'Blowing snow', primary: 'wind' },
});

/** Station type assumed when the network reports one we do not model. */
export const DEFAULT_STATION_PRIMARY = 'snow';

/**
 * Snow-depth bands, deepest first so the first match wins.
 *
 * Thresholds are presentation, not avalanche advice: this layer visualises
 * measurements and must never read as a danger rating. The SLF bulletin is the
 * only authority on danger, and it is a separate product.
 */
export const SNOW_DEPTH_BANDS = Object.freeze([
  Object.freeze({ id: 'deep', minCm: 200, label: 'Deep', accent: '#ffffff' }),
  Object.freeze({ id: 'substantial', minCm: 100, label: 'Substantial', accent: '#cfe8ff' }),
  Object.freeze({ id: 'moderate', minCm: 30, label: 'Moderate', accent: '#8ec9f0' }),
  Object.freeze({ id: 'thin', minCm: 1, label: 'Thin', accent: '#4a90c2' }),
  Object.freeze({ id: 'bare', minCm: 0, label: 'Bare', accent: '#6b7a86' }),
]);

/** Coerce to a finite number, treating null/'' /NaN alike as absent. */
function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Trim to a non-empty string, or null. */
function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Normalize one IMIS station record.
 *
 * @param {object} raw Entry from /public/api/imis/stations.
 * @returns {object|null} Null when it lacks the identity or position to render.
 */
export function normalizeStation(raw) {
  const code = text(raw?.code);
  const lat = finite(raw?.lat);
  const lon = finite(raw?.lon);
  if (!code || lat === null || lon === null) return null;

  const type = text(raw?.type) || '';
  const known = Object.hasOwn(SLF_STATION_TYPES, type) ? SLF_STATION_TYPES[type] : null;
  return {
    code,
    label: text(raw?.label) || code,
    lat,
    lon,
    elevationM: finite(raw?.elevation),
    canton: text(raw?.canton_code),
    country: text(raw?.country_code) || 'CH',
    type: type || null,
    typeLabel: known?.label || 'Station',
    primary: known?.primary || DEFAULT_STATION_PRIMARY,
  };
}

/**
 * Normalize one 30-minute measurement row.
 *
 * Every field is optional: IMIS stations are unheated boxes above the tree line
 * and routinely report partial rows. An absent value stays null rather than
 * becoming zero, because zero is a real snow depth.
 */
export function normalizeMeasurement(raw) {
  const code = text(raw?.station_code);
  if (!code) return null;
  return {
    code,
    measuredAt: text(raw?.measure_date),
    snowDepthCm: finite(raw?.HS),
    airTempC: finite(raw?.TA_30MIN_MEAN),
    snowSurfaceTempC: finite(raw?.TSS_30MIN_MEAN),
    humidityPct: finite(raw?.RH_30MIN_MEAN),
    windSpeedMs: finite(raw?.VW_30MIN_MEAN),
    windGustMs: finite(raw?.VW_30MIN_MAX),
    windDirDeg: finite(raw?.DW_30MIN_MEAN),
  };
}

/**
 * Reduce a measurement series to the newest row per station.
 *
 * The endpoint returns a rolling window for every station in one response
 * (~9,400 rows for ~205 stations), so this is the join's hot path.
 *
 * @param {object[]} rows Raw measurement rows.
 * @returns {Map<string, object>} Station code to its newest normalized row.
 */
export function latestByStation(rows) {
  const latest = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = normalizeMeasurement(raw);
    if (!row) continue;
    const held = latest.get(row.code);
    // String compare is safe and allocation-free here: measure_date is ISO 8601
    // UTC, which sorts lexicographically. A malformed date loses to a valid one.
    if (!held || (row.measuredAt || '') > (held.measuredAt || '')) {
      latest.set(row.code, row);
    }
  }
  return latest;
}

/**
 * Classify a snow depth into a presentation band.
 *
 * @param {number|null} cm
 * @returns {object|null} Null when the station reported no snow depth at all,
 *   which is distinct from a measured zero.
 */
export function snowDepthBand(cm) {
  if (cm === null || cm === undefined || !Number.isFinite(cm)) return null;
  const clamped = Math.max(0, cm);
  return SNOW_DEPTH_BANDS.find((band) => clamped >= band.minCm) || null;
}

/** Compass point for a wind direction in degrees. */
export function windCompass(deg) {
  if (deg === null || !Number.isFinite(deg)) return null;
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/** Metres per second to kilometres per hour, rounded to one decimal. */
export function msToKmh(ms) {
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.round(ms * 3.6 * 10) / 10;
}

/**
 * Join stations to their newest measurement.
 *
 * A station with no measurement is still returned, marked `reporting: false`,
 * so the map shows the network as it really is rather than silently hiding
 * boxes that are down.
 *
 * @param {object[]} stations Raw station records.
 * @param {object[]} measurements Raw measurement rows.
 * @returns {object[]} Renderable station records.
 */
export function joinStations(stations, measurements) {
  const latest = latestByStation(measurements);
  const joined = [];
  for (const raw of Array.isArray(stations) ? stations : []) {
    const station = normalizeStation(raw);
    if (!station) continue;
    const reading = latest.get(station.code) || null;
    joined.push({
      ...station,
      reporting: reading !== null,
      measuredAt: reading?.measuredAt ?? null,
      snowDepthCm: reading?.snowDepthCm ?? null,
      airTempC: reading?.airTempC ?? null,
      snowSurfaceTempC: reading?.snowSurfaceTempC ?? null,
      humidityPct: reading?.humidityPct ?? null,
      windSpeedMs: reading?.windSpeedMs ?? null,
      windGustMs: reading?.windGustMs ?? null,
      windDirDeg: reading?.windDirDeg ?? null,
      band: snowDepthBand(reading?.snowDepthCm ?? null),
    });
  }
  return joined;
}

/**
 * One-line summary for a station's map label.
 *
 * Leads with whatever the station exists to measure, so a wind mast does not
 * announce a snow depth it is not really there for.
 */
export function describeStation(station) {
  if (!station) return '';
  if (!station.reporting) return `${station.label} · no data`;

  const parts = [];
  const snow = station.snowDepthCm;
  const wind = msToKmh(station.windSpeedMs);
  const compass = windCompass(station.windDirDeg);

  if (station.primary === 'wind') {
    if (wind !== null) parts.push(`${wind} km/h${compass ? ` ${compass}` : ''}`);
    if (snow !== null) parts.push(`${Math.round(snow)} cm`);
  } else {
    if (snow !== null) parts.push(`${Math.round(snow)} cm`);
    if (wind !== null) parts.push(`${wind} km/h${compass ? ` ${compass}` : ''}`);
  }
  if (station.airTempC !== null) parts.push(`${Math.round(station.airTempC)}°C`);
  return parts.length ? `${station.label} · ${parts.join(' · ')}` : station.label;
}

/**
 * Summary counts for the layer's stats row.
 *
 * `reporting` is the honest denominator: it is normal for part of a
 * high-Alpine network to be offline, and the panel should say so.
 */
export function summarizeStations(stations) {
  const list = Array.isArray(stations) ? stations : [];
  const reporting = list.filter((s) => s.reporting);
  const withSnow = reporting.filter((s) => Number.isFinite(s.snowDepthCm) && s.snowDepthCm > 0);
  const depths = reporting
    .map((s) => s.snowDepthCm)
    .filter((cm) => Number.isFinite(cm));
  return {
    total: list.length,
    reporting: reporting.length,
    withSnow: withSnow.length,
    maxSnowCm: depths.length ? Math.max(...depths) : null,
  };
}

/**
 * Card lines for a station, as the world overlay renders them.
 *
 * Every figure carries its unit and an absent reading is simply omitted, so a
 * line is never printed for a measurement the station did not make.
 *
 * @param {object} station Joined station record.
 * @returns {{title: string, details: string[]}}
 */
export function stationCardCopy(station) {
  if (!station) return { title: '', details: [] };
  const details = [];

  const place = [
    station.typeLabel,
    station.canton,
    Number.isFinite(station.elevationM) ? `${Math.round(station.elevationM)} m` : null,
  ].filter(Boolean).join(' · ');
  if (place) details.push(place);

  if (!station.reporting) {
    details.push('No current data');
    return { title: station.label, details };
  }

  if (Number.isFinite(station.snowDepthCm)) {
    const fresh = Number.isFinite(station.snowSurfaceTempC)
      ? ` · surface ${station.snowSurfaceTempC.toFixed(1)}°C`
      : '';
    details.push(`Snow ${Math.round(station.snowDepthCm)} cm${fresh}`);
  }

  const kmh = msToKmh(station.windSpeedMs);
  if (kmh !== null) {
    const compass = windCompass(station.windDirDeg);
    const gust = msToKmh(station.windGustMs);
    details.push(`Wind ${kmh} km/h${compass ? ` ${compass}` : ''}${gust !== null ? ` · gust ${gust}` : ''}`);
  }

  if (Number.isFinite(station.airTempC)) {
    const rh = Number.isFinite(station.humidityPct) ? ` · ${Math.round(station.humidityPct)}% RH` : '';
    details.push(`Air ${station.airTempC.toFixed(1)}°C${rh}`);
  }

  return { title: station.label, details };
}

/**
 * Snow depth, in cm, that draws a full-length stem.
 *
 * Roughly the deepest pack the IMIS network records, so a stem at this depth
 * uses the whole budget and everything else is a readable fraction of it.
 */
export const SNOW_STEM_REFERENCE_CM = 300;

/**
 * Full-length stem as a fraction of camera altitude.
 *
 * Stem length MUST scale with viewing distance. A fixed exaggeration cannot
 * work: snow tops out near 3 m, and the dam stems — the one thing in this app
 * that visibly renders a stem — are 46 km long when viewed from 26 km up, for
 * exactly this reason. A fixed 1,500 m stem is invisible from 26 km and absurd
 * from 3 km.
 *
 * Scaling by altitude keeps every stem legible at any zoom while preserving the
 * ratios between them, so a 200 cm pack always draws twice the stem of a
 * 100 cm pack in the same frame. The card carries the true centimetres.
 */
export const SNOW_STEM_ALTITUDE_FRACTION = 0.22;

/** Floor and ceiling in metres, so a stem is neither invisible nor absurd. */
export const MIN_SNOW_STEM_M = 90;
export const MAX_SNOW_STEM_M = 60000;

/** Fraction of a full stem given to a station measuring zero snow. */
export const ZERO_SNOW_STEM_FRACTION = 0.06;

/**
 * Stem height in metres, scaled to the current viewing altitude.
 *
 * Returns null ONLY when the station gave no snow reading at all. A measured
 * zero draws a short stub, which is the absent-versus-zero distinction this
 * module exists to preserve.
 *
 * @param {object} station Joined station record.
 * @param {number} cameraAltitudeM Camera height above the ellipsoid.
 * @param {{referenceCm?: number, fraction?: number}} [options]
 * @returns {number|null}
 */
export function snowStemHeightM(station, cameraAltitudeM = 20000, {
  referenceCm = SNOW_STEM_REFERENCE_CM,
  fraction = SNOW_STEM_ALTITUDE_FRACTION,
} = {}) {
  const cm = station?.snowDepthCm;
  if (!Number.isFinite(cm)) return null;
  const altitude = Number.isFinite(cameraAltitudeM) && cameraAltitudeM > 0 ? cameraAltitudeM : 20000;
  const full = altitude * fraction;
  const depthRatio = Math.min(1, Math.max(0, cm) / referenceCm);
  const raw = cm > 0 ? full * depthRatio : full * ZERO_SNOW_STEM_FRACTION;
  return Math.min(MAX_SNOW_STEM_M, Math.max(MIN_SNOW_STEM_M, raw));
}
