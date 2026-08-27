/**
 * Boot diagnostics for the loading screen.
 *
 * main.js replaces the loader status on its first line, so when the module
 * graph fails to load or throws while evaluating, the screen stays on
 * "Initializing photorealistic world…" forever and nothing explains why.
 * Phones have no console to look at. This module reports those failures on
 * the loading screen itself, and past a threshold says that the boot is slow
 * rather than dead.
 *
 * It is loaded from index.html before main.js on purpose: module scripts run
 * in document order, and the listeners below have to exist before main.js
 * and its imports start evaluating. It has no imports of its own so that it
 * cannot fail for the same reason it is watching for.
 *
 * @module bootDiagnostics
 */

// Past this, a boot that has not handed over to main.js is reported as slow.
const BOOT_SLOW_AFTER_MS = 20000;

// How often the slow-boot check runs. Coarse on purpose: it only updates a
// label, and the label already has a seconds counter.
const BOOT_POLL_MS = 5000;

// Enough of a message or stack to be useful in a screenshot. The loader is a
// status line, not a console.
const BOOT_ERROR_MAX_CHARS = 400;

// Reference point for the seconds counter shown on a slow boot.
const bootStartedAt = Date.now();

/**
 * The status line inside the loading screen, or null once the screen is gone.
 * Queried on every use because main.js owns that element from its first line.
 * @returns {HTMLElement|null}
 */
function loaderStatusElement() {
  return document.querySelector('#loading-screen .loader-status');
}

/**
 * Whether the loading screen is still what the user sees. Both properties are
 * checked because the dismiss animation fades opacity to 0 before the screen
 * is finally set to display: none.
 * @returns {boolean}
 */
function loadingScreenVisible() {
  const loadingScreen = document.getElementById('loading-screen');
  if (!loadingScreen) return false;

  const style = getComputedStyle(loadingScreen);
  return style.display !== 'none' && style.opacity !== '0';
}

/**
 * Replace the loading status with a red boot error. Does nothing once the
 * loading screen is gone: after a successful boot, errors belong to the app's
 * own handling, not to this module.
 * @param {string} message - Error text; truncated to BOOT_ERROR_MAX_CHARS.
 */
function showBootError(message) {
  const loaderStatus = loaderStatusElement();
  if (!loaderStatus || !loadingScreenVisible()) return;

  loaderStatus.textContent = `Boot error: ${String(message).slice(0, BOOT_ERROR_MAX_CHARS)}`;
  loaderStatus.style.color = '#ff4444';
  loaderStatus.style.whiteSpace = 'pre-wrap';
}

/**
 * Turn an error event into one line for the loader. A resource that failed to
 * load (a module script, a stylesheet) carries no message, only the element
 * whose src or href failed; a thrown error carries message, file and line.
 * @param {ErrorEvent|Event} event - From the window 'error' listener.
 * @returns {string}
 */
function describeErrorEvent(event) {
  const failedUrl = event.target?.src || event.target?.href;
  if (failedUrl && !(event instanceof ErrorEvent)) {
    return `failed to load ${String(failedUrl).replace(window.location.origin, '')}`;
  }

  const sourceLocation = event.filename
    ? ` @ ${event.filename.replace(window.location.origin, '')}:${event.lineno}`
    : '';
  return (event.message || event.error?.message || 'script error') + sourceLocation;
}

// Capture phase, because a failed script or module fetch fires 'error' on the
// element itself and never bubbles up to the window. Thrown errors, including
// one inside main.js or any of its imports, arrive here as well.
window.addEventListener('error', (event) => {
  showBootError(describeErrorEvent(event));
}, true);

// A rejected promise nobody caught (a failed dynamic import, a fetch inside
// init()) is the other way a boot dies without a word.
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  showBootError(reason?.message || reason?.stack || String(reason));
});

// What index.html shipped in the status line. main.js overwrites it on its
// first line, which is how "main.js has taken over" is detected below.
const initialStatusText = loaderStatusElement()?.textContent;

// While the status text is still the initial one, main.js has not run. Past
// the threshold, say so with a counter instead of looking hung; stop as soon
// as main.js takes over or the loading screen goes away.
const slowBootTimer = setInterval(() => {
  const loaderStatus = loaderStatusElement();
  if (!loaderStatus || !loadingScreenVisible() || loaderStatus.textContent !== initialStatusText) {
    clearInterval(slowBootTimer);
    return;
  }

  const elapsedSeconds = Math.round((Date.now() - bootStartedAt) / 1000);
  if (elapsedSeconds >= BOOT_SLOW_AFTER_MS / 1000) {
    loaderStatus.textContent = `${initialStatusText} (${elapsedSeconds}s — still downloading modules; slow network?)`;
  }
}, BOOT_POLL_MS);
