// src/data/slfStations.test.mjs
// Fixtures are copied verbatim from live /public/api/imis responses so the
// shapes cannot drift out of sync with what the network actually sends.
//
// The case that matters most is absent-versus-zero. IMIS boxes sit above the
// tree line and routinely report partial rows; a missing snow depth must stay
// null, because 0 cm is a real, meaningful August reading and coercing one into
// the other would put a fictional "bare ground" measurement on the map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STATION_PRIMARY,
  SLF_STATION_TYPES,
  MAX_SNOW_STEM_M,
  MIN_SNOW_STEM_M,
  SNOW_DEPTH_BANDS,
  SNOW_STEM_ALTITUDE_FRACTION,
  SNOW_STEM_REFERENCE_CM,
  snowStemHeightM,
  describeStation,
  joinStations,
  latestByStation,
  msToKmh,
  normalizeMeasurement,
  normalizeStation,
  snowDepthBand,
  stationCardCopy,
  summarizeStations,
  windCompass,
} from './slfStations.js';

/** Verbatim from /public/api/imis/stations. */
const STATION = Object.freeze({
  code: 'DAV2',
  label: 'Bärentälli',
  lon: 9.8194108372,
  lat: 46.6988884749,
  elevation: 2558,
  country_code: 'CH',
  canton_code: 'GR',
  type: 'SNOW_FLAT',
});

/** Verbatim from /public/api/imis/measurements. */
const MEASUREMENT = Object.freeze({
  station_code: 'DAV2',
  measure_date: '2026-08-24T18:30:00Z',
  HS: 0,
  TA_30MIN_MEAN: 11.55,
  RH_30MIN_MEAN: 63.02,
  TSS_30MIN_MEAN: 7.634,
  TS0_30MIN_MEAN: 9.49,
  RSWR_30MIN_MEAN: 0.06,
  VW_30MIN_MEAN: 3.208,
  VW_30MIN_MAX: 10.7,
  DW_30MIN_MEAN: 114.9,
  DW_30MIN_SD: 34.62,
});

test('normalizeStation maps the live station shape', () => {
  const s = normalizeStation(STATION);
  assert.equal(s.code, 'DAV2');
  assert.equal(s.label, 'Bärentälli');
  assert.equal(s.elevationM, 2558);
  assert.equal(s.canton, 'GR');
  assert.equal(s.type, 'SNOW_FLAT');
  assert.equal(s.primary, 'snow');
  assert.equal(s.typeLabel, SLF_STATION_TYPES.SNOW_FLAT.label);
});

test('normalizeStation rejects a station it could not place', () => {
  assert.equal(normalizeStation({ ...STATION, lat: null }), null);
  assert.equal(normalizeStation({ ...STATION, lon: undefined }), null);
  assert.equal(normalizeStation({ ...STATION, code: '  ' }), null);
  assert.equal(normalizeStation(null), null);
});

test('normalizeStation falls back for an unmodelled station type', () => {
  const s = normalizeStation({ ...STATION, type: 'SOMETHING_NEW' });
  assert.equal(s.primary, DEFAULT_STATION_PRIMARY);
  assert.equal(s.typeLabel, 'Station');
  assert.equal(normalizeStation({ ...STATION, type: null }).type, null);
});

test('normalizeStation does not treat a type name as an own-property lookup', () => {
  // Guards against `Object.hasOwn` being replaced by a bare `in` / index read.
  const s = normalizeStation({ ...STATION, type: 'constructor' });
  assert.equal(s.primary, DEFAULT_STATION_PRIMARY);
  assert.equal(s.typeLabel, 'Station');
});

test('normalizeStation defaults the country but keeps a stated one', () => {
  assert.equal(normalizeStation({ ...STATION, country_code: null }).country, 'CH');
  assert.equal(normalizeStation({ ...STATION, country_code: 'IT' }).country, 'IT');
});

test('normalizeMeasurement maps every documented field', () => {
  const m = normalizeMeasurement(MEASUREMENT);
  assert.equal(m.code, 'DAV2');
  assert.equal(m.snowDepthCm, 0);
  assert.equal(m.airTempC, 11.55);
  assert.equal(m.snowSurfaceTempC, 7.634);
  assert.equal(m.humidityPct, 63.02);
  assert.equal(m.windSpeedMs, 3.208);
  assert.equal(m.windGustMs, 10.7);
  assert.equal(m.windDirDeg, 114.9);
});

test('a measured zero survives as zero, and an absent value stays null', () => {
  // The whole point: 0 cm in August is a real reading, not missing data.
  assert.equal(normalizeMeasurement({ ...MEASUREMENT, HS: 0 }).snowDepthCm, 0);
  for (const absent of [null, undefined, '']) {
    assert.equal(normalizeMeasurement({ ...MEASUREMENT, HS: absent }).snowDepthCm, null,
      `HS=${JSON.stringify(absent)} must be null, never 0`);
  }
});

test('normalizeMeasurement requires a station code', () => {
  assert.equal(normalizeMeasurement({ ...MEASUREMENT, station_code: '' }), null);
  assert.equal(normalizeMeasurement(null), null);
});

test('latestByStation keeps only the newest row per station', () => {
  const rows = [
    { ...MEASUREMENT, measure_date: '2026-08-24T18:00:00Z', HS: 5 },
    { ...MEASUREMENT, measure_date: '2026-08-24T19:00:00Z', HS: 7 },
    { ...MEASUREMENT, measure_date: '2026-08-24T18:30:00Z', HS: 6 },
    { ...MEASUREMENT, station_code: 'ADE2', measure_date: '2026-08-24T17:00:00Z', HS: 1 },
  ];
  const latest = latestByStation(rows);
  assert.equal(latest.size, 2);
  assert.equal(latest.get('DAV2').snowDepthCm, 7);
  assert.equal(latest.get('ADE2').snowDepthCm, 1);
});

test('latestByStation prefers a dated row over an undated one', () => {
  const latest = latestByStation([
    { ...MEASUREMENT, measure_date: null, HS: 99 },
    { ...MEASUREMENT, measure_date: '2026-08-24T18:30:00Z', HS: 4 },
  ]);
  assert.equal(latest.get('DAV2').snowDepthCm, 4);
});

test('latestByStation tolerates junk', () => {
  assert.equal(latestByStation(null).size, 0);
  assert.equal(latestByStation([null, {}, { station_code: '' }]).size, 0);
});

test('snowDepthBand separates a measured zero from no reading', () => {
  assert.equal(snowDepthBand(0).id, 'bare');
  assert.equal(snowDepthBand(null), null, 'no reading must not become a bare-ground band');
  assert.equal(snowDepthBand(undefined), null);
  assert.equal(snowDepthBand(Number.NaN), null);
});

test('snowDepthBand picks the deepest matching band', () => {
  assert.equal(snowDepthBand(1).id, 'thin');
  assert.equal(snowDepthBand(29.9).id, 'thin');
  assert.equal(snowDepthBand(30).id, 'moderate');
  assert.equal(snowDepthBand(99).id, 'moderate');
  assert.equal(snowDepthBand(100).id, 'substantial');
  assert.equal(snowDepthBand(250).id, 'deep');
});

test('snowDepthBand clamps a negative sensor glitch to bare', () => {
  assert.equal(snowDepthBand(-3).id, 'bare');
});

test('the bands are ordered deepest first so the first match wins', () => {
  const mins = SNOW_DEPTH_BANDS.map((b) => b.minCm);
  assert.deepEqual(mins, [...mins].sort((a, b) => b - a));
});

test('windCompass maps degrees to eight points and wraps', () => {
  assert.equal(windCompass(0), 'N');
  assert.equal(windCompass(90), 'E');
  assert.equal(windCompass(180), 'S');
  assert.equal(windCompass(270), 'W');
  assert.equal(windCompass(360), 'N');
  // 114.9 sits past the 112.5 midpoint between E and SE, so SE is correct.
  assert.equal(windCompass(114.9), 'SE');
  assert.equal(windCompass(-90), 'W', 'negative bearings must wrap, not go undefined');
  assert.equal(windCompass(null), null);
});

test('msToKmh converts and rounds', () => {
  assert.equal(msToKmh(10), 36);
  assert.equal(msToKmh(3.208), 11.5);
  assert.equal(msToKmh(0), 0);
  assert.equal(msToKmh(null), null);
});

test('joinStations attaches the newest reading to its station', () => {
  const [s] = joinStations([STATION], [MEASUREMENT]);
  assert.equal(s.code, 'DAV2');
  assert.equal(s.reporting, true);
  assert.equal(s.snowDepthCm, 0);
  assert.equal(s.band.id, 'bare');
  assert.equal(s.elevationM, 2558);
});

test('joinStations keeps a silent station instead of hiding it', () => {
  const [s] = joinStations([STATION], []);
  assert.equal(s.reporting, false);
  assert.equal(s.snowDepthCm, null);
  assert.equal(s.band, null);
  assert.equal(s.label, 'Bärentälli', 'a down station is still a real station');
});

test('joinStations drops unplaceable stations but keeps the rest', () => {
  const joined = joinStations([STATION, { code: 'X' }, null], [MEASUREMENT]);
  assert.deepEqual(joined.map((s) => s.code), ['DAV2']);
});

test('joinStations tolerates junk on both sides', () => {
  assert.deepEqual(joinStations(null, null), []);
  assert.deepEqual(joinStations(undefined, [MEASUREMENT]), []);
});

test('describeStation leads with what the station is for', () => {
  const [snowStation] = joinStations([STATION], [{ ...MEASUREMENT, HS: 120 }]);
  assert.match(describeStation(snowStation), /^Bärentälli · 120 cm · 11\.5 km\/h SE · 12°C$/);

  const [windStation] = joinStations([{ ...STATION, type: 'WIND' }], [{ ...MEASUREMENT, HS: 120 }]);
  assert.match(describeStation(windStation), /^Bärentälli · 11\.5 km\/h SE · 120 cm/,
    'a wind mast should not announce snow first');
});

test('describeStation says so when a station is down', () => {
  const [s] = joinStations([STATION], []);
  assert.equal(describeStation(s), 'Bärentälli · no data');
  assert.equal(describeStation(null), '');
});

test('describeStation degrades to the bare label with no usable values', () => {
  const [s] = joinStations([STATION], [{ station_code: 'DAV2', measure_date: '2026-08-24T18:30:00Z' }]);
  assert.equal(describeStation(s), 'Bärentälli');
});

test('summarizeStations reports the honest reporting denominator', () => {
  const joined = joinStations(
    [STATION, { ...STATION, code: 'AAA1' }, { ...STATION, code: 'BBB1' }],
    [MEASUREMENT, { ...MEASUREMENT, station_code: 'AAA1', HS: 150 }],
  );
  assert.deepEqual(summarizeStations(joined), {
    total: 3,
    reporting: 2,
    withSnow: 1,
    maxSnowCm: 150,
  });
});

test('summarizeStations returns a null max when nothing reports a depth', () => {
  assert.deepEqual(summarizeStations(joinStations([STATION], [])), {
    total: 1, reporting: 0, withSnow: 0, maxSnowCm: null,
  });
  assert.equal(summarizeStations(null).total, 0);
});

// ── Card copy ───────────────────────────────────────────────────────────────
// These lines are what the operator actually reads on the globe. The viewer is
// built with `infoBox: false`, so Cesium's entity `description` renders
// nowhere: station detail reaches the screen only through world-overlay cards
// built from this copy.

test('stationCardCopy leads with place, then the readings', () => {
  const [s] = joinStations([STATION], [{ ...MEASUREMENT, HS: 137 }]);
  const { title, details } = stationCardCopy(s);
  assert.equal(title, 'Bärentälli');
  assert.equal(details[0], 'Snow (flat field) · GR · 2558 m');
  assert.match(details[1], /^Snow 137 cm · surface 7\.6°C$/);
  assert.match(details[2], /^Wind 11\.5 km\/h SE · gust 38\.5$/);
  assert.match(details[3], /^Air 11\.6°C · 63% RH$/);
});

test('stationCardCopy says a station is down rather than printing blanks', () => {
  const [s] = joinStations([STATION], []);
  const { details } = stationCardCopy(s);
  assert.equal(details.at(-1), 'No current data');
  assert.equal(details.some((d) => /Snow \d/.test(d)), false);
});

test('stationCardCopy omits a line for a measurement never taken', () => {
  const [s] = joinStations([STATION], [{
    station_code: 'DAV2', measure_date: '2026-08-24T18:30:00Z', TA_30MIN_MEAN: 4,
  }]);
  const { details } = stationCardCopy(s);
  // The place line legitimately starts "Snow (flat field)", so match a reading.
  assert.equal(details.some((d) => /^Snow \d/.test(d)), false, 'no snow sensor, no snow reading');
  assert.equal(details.some((d) => d.startsWith('Wind ')), false);
  assert.ok(details.some((d) => d.startsWith('Air 4.0°C')));
});

test('stationCardCopy still prints a measured zero', () => {
  const [s] = joinStations([STATION], [{ ...MEASUREMENT, HS: 0 }]);
  assert.ok(stationCardCopy(s).details.some((d) => /^Snow 0 cm/.test(d)));
});

test('stationCardCopy is total', () => {
  assert.deepEqual(stationCardCopy(null), { title: '', details: [] });
});

// ── Snow-depth stem ─────────────────────────────────────────────────────────
// Stem length scales with viewing altitude. That is not a stylistic choice: the
// dam stems, the only thing in this app that visibly renders one, measure 46 km
// when viewed from 26 km up. A fixed-length stem sized for one altitude is
// invisible at another, which is exactly how these shipped invisible at first.
//
// What must survive the scaling is the RATIO between stations: in any single
// frame a 200 cm pack must draw twice the stem of a 100 cm pack, or the picture
// stops being a measurement.

test('stem length scales with viewing altitude', () => {
  const st = { snowDepthCm: 150 };
  const near = snowStemHeightM(st, 5000);
  const far = snowStemHeightM(st, 40000);
  assert.ok(far > near, 'a stem must grow with distance or it vanishes');
  assert.equal(far / near, 8, 'proportional to altitude');
});

test('relative depth survives the scaling, at every altitude', () => {
  for (const altitude of [4000, 20000, 90000]) {
    const shallow = snowStemHeightM({ snowDepthCm: 100 }, altitude);
    const deep = snowStemHeightM({ snowDepthCm: 200 }, altitude);
    assert.equal(deep / shallow, 2, `ratio must hold at ${altitude} m`);
  }
});

test('depth saturates at the reference, so one freak reading cannot dominate', () => {
  const atRef = snowStemHeightM({ snowDepthCm: SNOW_STEM_REFERENCE_CM }, 20000);
  const absurd = snowStemHeightM({ snowDepthCm: 5000 }, 20000);
  assert.equal(absurd, atRef);
});

test('a full stem is the configured fraction of altitude', () => {
  const full = snowStemHeightM({ snowDepthCm: SNOW_STEM_REFERENCE_CM }, 20000);
  assert.equal(full, 20000 * SNOW_STEM_ALTITUDE_FRACTION);
});

test('snowStemHeightM draws nothing when there was no reading at all', () => {
  assert.equal(snowStemHeightM({ snowDepthCm: null }, 20000), null, 'no sensor, no stem');
  assert.equal(snowStemHeightM({}, 20000), null);
  assert.equal(snowStemHeightM(null, 20000), null);
});

test('a measured zero draws a stub, clearly shorter than any real pack', () => {
  const zero = snowStemHeightM({ snowDepthCm: 0 }, 20000);
  const thinnest = snowStemHeightM({ snowDepthCm: 1 }, 20000);
  assert.ok(zero > 0, 'a reporting station never vanishes');
  assert.ok(zero < snowStemHeightM({ snowDepthCm: 60 }, 20000),
    'the stub must not read as a real snowpack');
  assert.ok(Number.isFinite(thinnest));
});

test('a negative sensor glitch clamps to the stub rather than inverting', () => {
  assert.equal(snowStemHeightM({ snowDepthCm: -5 }, 20000), snowStemHeightM({ snowDepthCm: 0 }, 20000));
});

test('stem length is bounded at both ends', () => {
  assert.equal(snowStemHeightM({ snowDepthCm: 300 }, 1), MIN_SNOW_STEM_M, 'never invisible');
  assert.equal(snowStemHeightM({ snowDepthCm: 300 }, 10_000_000), MAX_SNOW_STEM_M, 'never absurd');
});

test('a missing or nonsense altitude falls back instead of producing NaN', () => {
  for (const bad of [undefined, null, 0, -1, Number.NaN]) {
    const v = snowStemHeightM({ snowDepthCm: 150 }, bad);
    assert.ok(Number.isFinite(v) && v > 0, `altitude ${JSON.stringify(bad)} must still yield a stem`);
  }
});

test('a live August station still draws its stub', () => {
  const [s] = joinStations([STATION], [{ ...MEASUREMENT, HS: 0 }]);
  assert.ok(snowStemHeightM(s, 20000) > 0);
});
