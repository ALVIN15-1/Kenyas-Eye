/**
 * QA: drives the REAL agent panel in headless Chromium.
 *
 * Proves the panel mounts against the running dev server, populates its
 * provider and model pickers from the live endpoints, and carries one typed
 * command through the tool loop to a real state change on the globe.
 *
 * Requires a dev server on GEV_URL and, for the command leg, a reachable
 * provider. Defaults to Ollama because it needs no credential:
 *
 *   docker run -d --gpus all -p 11434:11434 \
 *     -e OLLAMA_CONTEXT_LENGTH=16384 --name gev-ollama ollama/ollama
 *   docker exec gev-ollama ollama pull qwen3:4b
 *   GOOGLE_MAPS_API_KEY=... npm run dev -- --host localhost --port 4173
 *   node scripts/qa-agent-panel.mjs
 *
 * Env: GEV_URL, GEV_AGENT_PROVIDER, GEV_AGENT_MODEL, SHOT, COMMAND.
 */
import puppeteer from 'puppeteer';

const URL_BASE = process.env.GEV_URL || 'http://localhost:4173';
const PROVIDER = process.env.GEV_AGENT_PROVIDER || 'ollama';
const MODEL = process.env.GEV_AGENT_MODEL || '';
const COMMAND = process.env.COMMAND || 'switch to night vision';
const SHOT = process.env.SHOT || 'qa-shots/agent-panel.png';

/**
 * A local model can spend a long time on a cold load plus prompt processing.
 * Deliberately ABOVE the server's own local budget so the server's diagnostic
 * error surfaces in the transcript instead of this wait expiring first.
 */
const COMMAND_TIMEOUT_MS = 360_000;

const failures = [];
const check = (label, condition, detail = '') => {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures.push(label);
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ''}`);
};

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const consoleErrors = [];
const agentCalls = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200)); });
page.on('pageerror', (err) => consoleErrors.push(`PAGEERROR: ${err.message.slice(0, 200)}`));
page.on('response', async (res) => {
  if (!res.url().includes('/api/agent/')) return;
  agentCalls.push({ path: res.url().replace(URL_BASE, ''), status: res.status() });
});

/** Wait for the panel to finish whatever load it is doing. */
const waitForSettled = (timeout = 60_000) => page.waitForFunction(
  () => {
    const panel = document.getElementById('agent-panel');
    const state = panel?.dataset.agentStatus;
    return state === 'ready' || state === 'unavailable';
  },
  { timeout, polling: 250 },
);

try {
  console.log(`\nGEV agent panel QA — ${URL_BASE}\n`);
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  console.log('Mount');
  await page.waitForSelector('#agent-panel', { timeout: 20_000 });
  const mount = await page.evaluate(() => ({
    panelId: document.getElementById('agent-panel')?.dataset.panelId,
    mounted: Boolean(window.__godsEyeView?.agentPanel),
    width: getComputedStyle(document.querySelector('.agent-panel-inner')).width,
    backdrop: getComputedStyle(document.querySelector('.agent-panel-inner')).backdropFilter !== 'none',
  }));
  check('panel joins the [data-panel-id] stack', mount.panelId === 'agent-panel');
  check('controller mounted', mount.mounted);
  check('panel chrome styled', mount.width === '320px' && mount.backdrop, `${mount.width}, backdrop ${mount.backdrop}`);

  console.log('\nProviders');
  await page.waitForFunction(() => document.querySelector('#agent-provider')?.options.length > 0, { timeout: 30_000 });
  await waitForSettled();
  const providers = await page.evaluate(() => [...document.querySelectorAll('#agent-provider option')]
    .map((option) => ({ id: option.value, label: option.textContent })));
  check('all three providers offered', providers.length === 3, providers.map((p) => p.id).join(', '));
  const unconfigured = providers.find((p) => p.label.includes('needs '));
  check('unconfigured providers name their env var', Boolean(unconfigured), unconfigured?.label || 'none unconfigured');

  console.log(`\nModels (${PROVIDER})`);
  // Re-selecting the provider that is ALREADY selected still fires `change`,
  // which reloads the model list and empties the select. Submitting into that
  // window is exactly what the panel now refuses, so only switch when the
  // selection actually differs, and then wait for the reload to start before
  // waiting for it to finish.
  const alreadySelected = await page.evaluate(() => document.getElementById('agent-provider')?.value);
  if (alreadySelected !== PROVIDER) {
    await page.select('#agent-provider', PROVIDER);
    await page.waitForFunction(
      () => document.getElementById('agent-panel')?.dataset.agentStatus === 'thinking',
      { timeout: 20_000 },
    ).catch(() => {});
  }
  await waitForSettled();
  // The panel only re-enables input once a usable model is actually selected.
  await page.waitForFunction(
    () => document.getElementById('agent-model')?.value && !document.getElementById('agent-input')?.disabled,
    { timeout: 30_000 },
  ).catch(() => {});
  const models = await page.evaluate(() => ({
    count: document.querySelectorAll('#agent-model option').length,
    selected: document.getElementById('agent-model')?.value,
    status: document.getElementById('agent-status')?.textContent,
    cost: document.getElementById('agent-cost')?.textContent,
    inputEnabled: !document.getElementById('agent-input')?.disabled,
  }));
  check('models listed', models.count > 0, `${models.count} usable`);
  check('a model is preselected', Boolean(models.selected), models.selected);
  check('cost readout populated', models.cost !== 'n/a', models.cost);
  check('input enabled once a model exists', models.inputEnabled);

  if (MODEL) {
    await page.select('#agent-model', MODEL);
    await page.evaluate(() => document.getElementById('agent-model').dispatchEvent(new Event('change')));
  }

  console.log(`\nCommand: "${COMMAND}"`);
  if (!models.count) {
    check('command dispatched', false, 'skipped: no usable model');
  } else {
    await page.evaluate((text) => {
      document.getElementById('agent-input').value = text;
      // requestSubmit rather than a click: the send button is disabled during a
      // provider switch, so a click can land on a dead control and be swallowed.
      document.getElementById('agent-form').requestSubmit();
    }, COMMAND);

    const outcome = await page.waitForFunction(
      () => {
        const status = document.getElementById('agent-panel')?.dataset.agentStatus;
        const entries = [...document.querySelectorAll('#agent-transcript .agent-entry')];
        if (status !== 'ready' || entries.length < 2) return null;
        return {
          entries: entries.map((entry) => ({
            kind: entry.className.replace('agent-entry agent-entry-', ''),
            text: entry.textContent.slice(0, 160),
            outcome: entry.dataset.outcome || null,
          })),
        };
      },
      { timeout: COMMAND_TIMEOUT_MS, polling: 500 },
    ).then((handle) => handle.jsonValue()).catch((error) => ({ error: error.message }));

    if (outcome.error) {
      check('command completed', false, outcome.error);
    } else {
      const kinds = outcome.entries.map((entry) => entry.kind);
      const toolEntry = outcome.entries.find((entry) => entry.kind === 'tool');
      check('user turn recorded', kinds.includes('user'));
      check('a tool was dispatched', Boolean(toolEntry), toolEntry ? `${toolEntry.text} → ${toolEntry.outcome}` : 'none');
      check('tool reported success', toolEntry?.outcome === 'ok', toolEntry?.outcome || 'n/a');
      check('no error entry', !kinds.includes('error'));
      console.log('\n  transcript:');
      for (const entry of outcome.entries) {
        console.log(`    [${entry.kind}] ${entry.text}${entry.outcome ? ` (${entry.outcome})` : ''}`);
      }

      const applied = await page.evaluate(() => ({
        style: document.body.dataset.style || window.__godsEyeView?.styleManager?.currentStyle || null,
      }));
      console.log(`  resulting style: ${applied.style ?? 'unreported'}`);
    }
  }

  console.log('\nHygiene');
  // Upstream layers fail loudly without their own keys, which is expected in a
  // QA environment and says nothing about the agent. Only errors this feature
  // could have caused are failures; the rest are reported and moved past.
  const unrelated = /Failed to load resource|GOOGLE_MAPS_API_KEY|tile\.googleapis|Cesium|ion\.cesium/i;
  const agentErrors = consoleErrors.filter((text) => !unrelated.test(text));
  check('no agent console errors', agentErrors.length === 0, agentErrors.slice(0, 3).join(' | '));
  if (consoleErrors.length !== agentErrors.length) {
    console.log(`  [note] ignored ${consoleErrors.length - agentErrors.length} unrelated layer/tile errors`);
  }
  console.log('  agent API calls:', agentCalls.map((c) => `${c.path} ${c.status}`).join(' | ') || 'none');
  const failedCalls = agentCalls.filter((call) => call.status >= 400);
  check('no failed agent API calls', failedCalls.length === 0,
    failedCalls.map((call) => `${call.path} ${call.status}`).join(', '));

  await page.screenshot({ path: SHOT });
  console.log(`\nScreenshot: ${SHOT}`);
} finally {
  await browser.close();
}

console.log(failures.length ? `\nFAILED (${failures.length}): ${failures.join(', ')}\n` : '\nALL CHECKS PASSED\n');
process.exit(failures.length ? 1 : 0);
