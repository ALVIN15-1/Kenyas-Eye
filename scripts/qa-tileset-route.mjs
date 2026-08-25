/**
 * QA: proves which upstream the photorealistic tileset is requested from.
 *
 * CesiumJS routes `createGooglePhotorealistic3DTileset` to an ion-hosted copy
 * whenever `GoogleMaps.defaultApiKey` is undefined. That is the whole basis of
 * the keyless-Google path, and it is invisible in the UI, so this asserts it at
 * the network layer.
 *
 * The discriminator is which host AUTHORIZES the tileset. Observed against a
 * real ion token, the ion route is:
 *
 *   1. api.cesium.com/v1/assets/2275207/endpoint?access_token=<ion token>
 *   2. tile.googleapis.com/v1/3dtiles/root.json?key=<key ION SUPPLIED>
 *   3. tile.googleapis.com/v1/3dtiles/datasets/... (the tile payloads)
 *
 * So ion resells access by brokering a Google key; the bytes come from Google's
 * CDN on BOTH routes, and step 2 is identical either way. Only the ion asset
 * request in step 1 tells the routes apart.
 *
 * Two earlier versions of this check got that wrong, both because they were
 * validated with a DUMMY ion token — which fails at step 1, so Google is never
 * reached and any "Google was not contacted" assertion passes for the wrong
 * reason. Do not reintroduce one.
 *
 *   CESIUM_ION_TOKEN=dummy npx vite --port 4176 --host localhost
 *   GEV_URL=http://localhost:4176 node scripts/qa-tileset-route.mjs
 *
 * Env: GEV_URL, EXPECT (ion | google | none).
 */
import puppeteer from 'puppeteer';

const URL_BASE = process.env.GEV_URL || 'http://localhost:4176';
const EXPECT = process.env.EXPECT || 'ion';

const failures = [];
const check = (label, condition, detail = '') => {
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
};

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage();

const hosts = new Set();
const urls = new Set();
const initLogs = [];
page.on('request', (req) => {
  const u = req.url();
  urls.add(u);
  try { hosts.add(new URL(u).host); } catch { /* data: urls */ }
});
page.on('console', (msg) => { if (msg.text().includes('[Init]')) initLogs.push(msg.text()); });

try {
  console.log(`\nTileset route QA — ${URL_BASE} (expecting: ${EXPECT})\n`);
  await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60_000 });
  // Give the tileset request time to be issued even if it then fails.
  await page.waitForFunction(() => true, { timeout: 1000 }).catch(() => {});

  // Cesium is an ES module import and is NOT on window, so GoogleMaps.defaultApiKey
  // cannot be probed from the page: an earlier version of this script read
  // undefined in BOTH routes and passed for the wrong reason. The network
  // evidence below is the real proof, and the source-level invariant is pinned
  // in src/mapCredentials.test.mjs instead.
  const runtime = await page.evaluate(() => ({
    geocodingGlobal: typeof window.__GOOGLE_MAPS_API_KEY__ !== 'undefined',
    loaderText: document.querySelector('#loading-screen .loader-status')?.textContent || '',
  }));

  // Root-request discriminators, not mere host contact.
  const googleRootRequest = [...urls].some((u) => u.includes('tile.googleapis.com/v1/3dtiles/root.json'));
  const ionAssetRequest = [...urls].some((u) => /api\.cesium\.com\/v1\/assets\/\d+\/endpoint/.test(u));
  const hitCesium = [...hosts].some((h) => h.includes('cesium.com'));

  console.log(`  upstream hosts contacted: ${[...hosts].filter((h) => !h.includes('localhost')).join(', ') || 'none'}`);
  console.log(`  init log: ${initLogs.join(' | ') || 'none'}`);

  if (EXPECT === 'ion') {
    check('the tileset was authorized through Cesium ion', ionAssetRequest);
    check('Cesium ion was contacted', hitCesium);
    // Deliberately NOT asserted: absence of tile.googleapis.com. ion hands back
    // a Google key, so the tiles come from Google on this route too.
    check('geocoding global left unset', !runtime.geocodingGlobal);
    check('init log names the ion route', initLogs.some((l) => /Cesium ion/.test(l)));
    check('init log warns geocoding is unavailable', initLogs.some((l) => /geocoding are unavailable/i.test(l)));
  } else if (EXPECT === 'google') {
    check('the tileset root was requested from Google', googleRootRequest);
    check('ion did not broker the tileset', !ionAssetRequest,
      'the ion asset endpoint is the only thing separating the two routes');
    check('geocoding global was set', runtime.geocodingGlobal);
    check('init log names the Google route', initLogs.some((l) => /Google Map Tiles API/.test(l)));
  } else {
    check('startup refused with a credential error', /credentials/i.test(runtime.loaderText), runtime.loaderText);
    check('the error names both ways out',
      /GOOGLE_MAPS_API_KEY/.test(runtime.loaderText) && /CESIUM_ION_TOKEN/.test(runtime.loaderText));
    check('no tileset request was made at all', !googleRootRequest && !ionAssetRequest);
  }
} finally {
  await browser.close();
}

console.log(failures.length ? `\nFAILED (${failures.length}): ${failures.join(', ')}\n` : '\nALL CHECKS PASSED\n');
process.exit(failures.length ? 1 : 0);
