#!/usr/bin/env node
/** Throwaway review capture: full window + left rail, expanded and collapsed. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.SHOT_DIR || path.join(repoRoot, 'qa-shots', 'review');
const appUrl = process.env.QA_BASE_URL || 'http://localhost:4173';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new', executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  args: ['--use-angle=metal', '--enable-gpu', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(appUrl, { waitUntil: 'networkidle2', timeout: 120000 });
await new Promise((r) => setTimeout(r, 12000));
await page.screenshot({ path: path.join(outDir, '01-initial.png') });

// Expand every collapsible panel so the rails are readable in one frame.
await page.evaluate(() => {
  document.querySelectorAll('.panel-collapsible').forEach((p) => p.classList.remove('collapsed'));
});
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: path.join(outDir, '02-panels-expanded.png') });

const report = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#data-toggles .data-toggle-row')].map((r) => ({
    id: r.dataset.layerId,
    name: r.querySelector('.data-name')?.textContent,
    meta: r.querySelector('.data-toggle-meta')?.textContent,
  }));
  const chips = [...document.querySelectorAll('#map-stack-chips .map-stack-chip')].map((c) => ({
    id: c.dataset.stackId,
    label: c.textContent.trim(),
    active: c.classList.contains('active'),
    unavailable: c.classList.contains('unavailable'),
  }));
  const styles = [...document.querySelectorAll('.style-btn')].map((b) => b.dataset.style);
  const panelIds = [...document.querySelectorAll('.panel-collapsible')].map((p) => p.dataset.panelId || p.id);
  return { rows, chips, styles, panelIds, title: document.title };
});
console.log(JSON.stringify({ report, errors: errors.slice(0, 20) }, null, 2));
await browser.close();
