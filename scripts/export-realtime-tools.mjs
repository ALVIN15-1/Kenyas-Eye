#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'const GEV_REALTIME_TOOLS = [';

export function extractRealtimeTools(source) {
  const markerStart = source.indexOf(MARKER);
  if (markerStart < 0) {
    throw new Error('GEV_REALTIME_TOOLS literal not found in vite.config.js');
  }
  const arrayStart = source.indexOf('[', markerStart);
  if (arrayStart < 0) {
    throw new Error('GEV_REALTIME_TOOLS array start not found');
  }

  let depth = 0;
  let inString = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = arrayStart; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      inString = char;
      continue;
    }
    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        const literal = source.slice(arrayStart, i + 1);
        // The literal is trusted local source from this repository. Evaluating only
        // the bracketed array keeps imports and server code out of the export path.
        const tools = Function(`"use strict"; return (${literal});`)();
        if (!Array.isArray(tools)) throw new Error('GEV_REALTIME_TOOLS did not evaluate to an array');
        return tools;
      }
    }
  }
  throw new Error('GEV_REALTIME_TOOLS array end not found');
}

export function writeRealtimeTools({ rootDir = process.cwd() } = {}) {
  const viteConfigPath = join(rootDir, 'vite.config.js');
  const outputPath = join(rootDir, 'livekit-voice', 'tools.json');
  const tools = extractRealtimeTools(readFileSync(viteConfigPath, 'utf8'));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(tools, null, 2)}\n`);
  return { outputPath, count: tools.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootDir = process.argv[2] || process.cwd();
  const result = writeRealtimeTools({ rootDir });
  console.log(`Wrote ${result.count} tools to ${result.outputPath}`);
}
