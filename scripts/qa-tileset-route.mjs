/**
 * QA: proves which upstream the photorealistic tileset is requested from.
 *
 * CesiumJS routes `createGooglePhotorealistic3DTileset` to an ion-hosted copy
 * whenever `GoogleMaps.defaultApiKey` is undefined. That is the whole basis of
 * the keyless-Google path, and it is invisible in the UI, so this asserts it at
 * the network layer: with only CESIUM_ION_TOKEN set, nothing may be requested
 * from tile.googleapis.com.
 *
 * A valid ion token is NOT required. A dummy token still proves the routing:
 * the request reaches ion and is rejected there rather than going to Google.
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
const initLogs = [];
page.on('request', (req) => { try { hosts.add(new URL(req.url()).host); } catch { /* data: urls */ } });
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

  const hitGoogleTiles = [...hosts].some((h) => h.includes('tile.googleapis.com'));
  const hitCesium = [...hosts].some((h) => h.includes('cesium.com'));

  console.log(`  upstream hosts contacted: ${[...hosts].filter((h) => !h.includes('localhost')).join(', ') || 'none'}`);
  console.log(`  init log: ${initLogs.join(' | ') || 'none'}`);

  if (EXPECT === 'ion') {
    check('no request reached the Google Map Tiles API', !hitGoogleTiles);
    check('the tileset was requested from Cesium ion', hitCesium);
    check('geocoding global left unset', !runtime.geocodingGlobal);
    check('init log names the ion route', initLogs.some((l) => /Cesium ion/.test(l)));
    check('init log warns geocoding is unavailable', initLogs.some((l) => /geocoding are unavailable/i.test(l)));
  } else if (EXPECT === 'google') {
    check('the tileset was requested from Google', hitGoogleTiles);
    check('geocoding global was set', runtime.geocodingGlobal);
    check('init log names the Google route', initLogs.some((l) => /Google Map Tiles API/.test(l)));
  } else {
    check('startup refused with a credential error', /credentials/i.test(runtime.loaderText), runtime.loaderText);
    check('the error names both ways out',
      /GOOGLE_MAPS_API_KEY/.test(runtime.loaderText) && /CESIUM_ION_TOKEN/.test(runtime.loaderText));
    check('nothing was requested from Google', !hitGoogleTiles);
  }
} finally {
  await browser.close();
}

console.log(failures.length ? `\nFAILED (${failures.length}): ${failures.join(', ')}\n` : '\nALL CHECKS PASSED\n');
process.exit(failures.length ? 1 : 0);
