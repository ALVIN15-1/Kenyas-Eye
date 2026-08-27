/**
 * Mobile profile: lighter rendering on phones and small tablets.
 *
 * The desktop defaults are tuned for a laptop GPU: a preserved drawing
 * buffer (needed for recording), an unbounded photoreal tile cache and
 * several full-screen post-process passes, all at the device pixel ratio.
 * A phone pays for every one of them: the post-process passes re-shade the
 * whole frame, the 3x device pixel ratio triples the pixels, and the tile
 * cache grows until iOS WebKit reloads the tab (around 1 to 1.5 GB of WebGL
 * memory).
 *
 * On a handheld this module trades some image quality for a globe that keeps
 * running: CSS-pixel resolution, a bounded tile cache with a coarser level of
 * detail, and no post-process passes. MSAA stays at 4x: at CSS-pixel
 * resolution it is cheap, and edges need it more there. Desktop is untouched.
 *
 * `?gevMobile=1` / `?gevMobile=0` force the profile on or off (a tablet user
 * who wants desktop quality, or a desktop test of the phone path).
 * `?gevFlags=diag` paints a small on-screen readout of the GPU, browser and
 * canvas sizes, so a phone user can report a rendering problem without a
 * console. See docs/KNOWN-ISSUES.md.
 *
 * @module mobileProfile
 */

/**
 * True on touch-first devices whose shorter screen side is under 900 px.
 * @returns {boolean}
 */
export function isMobileDevice() {
  // Tests import this module under Node, where there is no window.
  if (typeof window === 'undefined') return false;

  // A manual override in the URL wins over detection.
  const forced = /[?&#]gevMobile=(1|0)/.exec(window.location.href);
  if (forced) return forced[1] === '1';

  // Finger rather than mouse: the primary pointer is imprecise. maxTouchPoints
  // is the fallback for browsers without the media query.
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches === true;
  const touch = (navigator.maxTouchPoints || 0) > 0;

  // The shorter side, so orientation does not matter. 900 px keeps phones and
  // regular iPads in; a 12.9 inch iPad Pro (1024 px) stays on desktop.
  const small = Math.min(window.screen?.width || 9999, window.screen?.height || 9999) < 900;

  // A touch laptop is not a phone; a small touch screen is.
  return (coarse || touch) && small;
}

/** Settings applied on handhelds. Each one is a fill-rate or memory saving. */
export const MOBILE_PROFILE = Object.freeze({
  // Kept at the desktop value: at CSS-pixel resolution 4x MSAA is cheap, and
  // edges need it more there.
  msaaSamples: 4,
  // Only recording needs the buffer preserved, and it blocks the fast swap.
  preserveDrawingBuffer: false,
  // Photoreal tiles kept in memory. Unbounded upstream, which is what makes
  // iOS reload the tab; 256 MB plus 64 MB of overflow before Cesium refuses
  // new tiles keeps a phone well under its WebGL ceiling.
  tilesetCacheBytes: 256 * 1024 * 1024,
  tilesetMaximumCacheOverflowBytes: 64 * 1024 * 1024,
  // Coarser level of detail than Cesium's default of 16: fewer, larger tiles
  // per view.
  tilesetMaximumScreenSpaceError: 24,
  // Scope mask, sharpen, bloom and the style shaders each re-shade the whole
  // frame.
  disablePostProcess: true,
});

/** The upstream desktop defaults, spelled out so the two can be compared. */
export const DESKTOP_PROFILE = Object.freeze({
  // The upstream viewer options, unchanged.
  msaaSamples: 4,
  preserveDrawingBuffer: true,
  // null means "leave Cesium's default alone".
  tilesetCacheBytes: null,
  tilesetMaximumCacheOverflowBytes: null,
  tilesetMaximumScreenSpaceError: null,
  // Every visual style and full-screen pass stays available.
  disablePostProcess: false,
});

/**
 * The profile for this device, decided once per page load.
 * @returns {typeof MOBILE_PROFILE | typeof DESKTOP_PROFILE}
 */
export function activeProfile() {
  return isMobileDevice() ? MOBILE_PROFILE : DESKTOP_PROFILE;
}

/**
 * Apply the profile's tile limits to a Cesium3DTileset. Each limit is written
 * only when the profile sets it, so the desktop profile (all null) leaves
 * Cesium's own defaults exactly as they were.
 * @param {import('cesium').Cesium3DTileset} tileset - The photoreal tileset.
 * @param {object} [profile] - MOBILE_PROFILE or DESKTOP_PROFILE (active one).
 */
export function applyTilesetProfile(tileset, profile = activeProfile()) {
  // The tileset is null when Google 3D Tiles failed to load and the app fell
  // back to the plain globe.
  if (!tileset) return;

  // `!= null` on purpose: 0 would be a legal value, only null means "not set".
  // cacheBytes is the memory Cesium keeps loaded tiles in before it starts
  // unloading the ones outside the view.
  if (profile.tilesetCacheBytes != null) tileset.cacheBytes = profile.tilesetCacheBytes;

  // How far over cacheBytes the cache may grow while tiles needed for the
  // current view are still arriving, before Cesium refuses new ones.
  if (profile.tilesetMaximumCacheOverflowBytes != null) {
    tileset.maximumCacheOverflowBytes = profile.tilesetMaximumCacheOverflowBytes;
  }

  // Screen-space error in pixels that a tile may show before Cesium refines
  // it into its children. Higher means coarser tiles and fewer requests.
  if (profile.tilesetMaximumScreenSpaceError != null) {
    tileset.maximumScreenSpaceError = profile.tilesetMaximumScreenSpaceError;
  }
}

/**
 * Disable every post-process stage (style shaders, sharpen, bloom, FXAA).
 * @param {import('cesium').Viewer} viewer
 * @returns {number} stages that were enabled and got switched off
 */
export function disableAllPostProcess(viewer) {
  // Cesium's PostProcessStageCollection; absent on the bare viewers used in
  // tests.
  const stages = viewer?.scene?.postProcessStages;
  if (!stages) return 0;

  // Counts only stages that were actually on, so the console line is honest.
  let disabledCount = 0;

  // The collection is not iterable; it exposes length and get(index).
  for (let i = 0; i < stages.length; i += 1) {
    const stage = stages.get(i);
    if (!stage?.enabled) continue;
    stage.enabled = false;
    disabledCount += 1;
  }

  // The built-in stages live outside the indexed list.
  if (stages.fxaa) stages.fxaa.enabled = false;
  if (stages.bloom) stages.bloom.enabled = false;

  return disabledCount;
}

/**
 * True when `?gevFlags=diag` is in the URL (query or hash).
 * @param {string} [href]
 * @returns {boolean}
 */
export function wantsDiagOverlay(href = (typeof window !== 'undefined' ? window.location.href : '')) {
  // Query or hash: share links keep their state in the hash.
  const match = /[?&#]gevFlags=([a-z0-9,_-]+)/i.exec(href || '');
  if (!match) return false;

  return match[1].toLowerCase().split(',').includes('diag');
}

/**
 * On-screen readout for reporting rendering problems from a phone: browser,
 * GPU, device pixel ratio, canvas vs. drawing-buffer size, GL limits and
 * which profile is active. Refreshes every 2 s. Only installed with
 * `?gevFlags=diag`.
 * @param {import('cesium').Viewer} viewer
 * @returns {HTMLElement|null}
 */
export function installDiagOverlay(viewer) {
  if (!wantsDiagOverlay() || typeof document === 'undefined') return null;

  // A <pre> keeps the line breaks without any CSS of its own.
  const readout = document.createElement('pre');
  readout.id = 'gev-diag';
  readout.style.cssText = 'position:fixed;left:6px;top:6px;z-index:99999;margin:0;padding:6px 8px;background:rgba(0,0,0,.8);color:#7CFC00;font:11px/1.35 monospace;white-space:pre-wrap;max-width:92vw;pointer-events:none';
  document.body.appendChild(readout);

  // Cesium's own context first: asking the canvas would create a second one.
  const gl = viewer?.scene?.context?._gl || viewer?.canvas?.getContext('webgl2');
  // The unmasked GPU name; null where the browser hides it.
  const rendererInfo = gl?.getExtension('WEBGL_debug_renderer_info');

  /**
   * Read one GL limit by name, or '?' when the context or the constant is
   * missing, so one unsupported query never blanks the whole readout.
   * @param {string} name - A WebGL constant name such as 'MAX_TEXTURE_SIZE'.
   * @returns {number|number[]|string}
   */
  function glParameter(name) {
    try {
      return gl.getParameter(gl[name]);
    } catch {
      return '?';
    }
  }

  /**
   * Rewrite the readout from live values. Cheap enough to run on a timer:
   * eight template strings and one textContent assignment.
   */
  function repaint() {
    // CSS size against attribute size on the canvas shows any DPR mismatch.
    const canvas = viewer?.canvas;
    const scene = viewer?.scene;

    readout.textContent = [
      `UA ${navigator.userAgent.slice(0, 90)}`,
      `renderer ${rendererInfo ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) : '?'}`,
      `dpr ${window.devicePixelRatio} inner ${window.innerWidth}x${window.innerHeight} screen ${screen.width}x${screen.height}`,
      `canvas css ${canvas?.clientWidth}x${canvas?.clientHeight} attr ${canvas?.width}x${canvas?.height} buffer ${gl?.drawingBufferWidth}x${gl?.drawingBufferHeight}`,
      `resolutionScale ${viewer?.resolutionScale} recommended ${viewer?.useBrowserRecommendedResolution} msaa ${scene?.msaaSamples}`,
      `MAX_TEXTURE ${glParameter('MAX_TEXTURE_SIZE')} MAX_RENDERBUFFER ${glParameter('MAX_RENDERBUFFER_SIZE')} MAX_VIEWPORT ${glParameter('MAX_VIEWPORT_DIMS')}`,
      `mobileProfile ${Boolean(window.__gevMobile)} stages ${scene?.postProcessStages?.length}`,
      `webgl2 ${typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext}`,
    ].join('\n');
  }

  // Sizes change on rotate and on the first resize; 2 s is plenty for a
  // screenshot.
  repaint();
  setInterval(repaint, 2000);
  return readout;
}
