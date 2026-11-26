#!/usr/bin/env node
/**
 * Lean single-shot + surgical-repair builder for Free-Tier API limits (15 RPM / 250K TPM).
 * Preserves on-disk progress across retries and rotates through healthy models on transient 503s.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const FORBIDDEN_PREFIXES = ['.github/', '.git/', 'node_modules/', 'dist/'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Safely write generated files inside workdir, blocking path traversal and protected paths. */
export function writeGeneratedFiles(workdir, filesMap) {
  const root = resolve(workdir);
  const written = [];
  for (const [relPath, content] of Object.entries(filesMap ?? {})) {
    if (typeof content !== 'string') continue;
    const normalized = relPath.replace(/^\/+/, '');
    if (FORBIDDEN_PREFIXES.some((p) => normalized.startsWith(p)) || normalized === '.mogra.yaml') {
      throw new Error(`Security block: forbidden generated path '${relPath}'`);
    }
    const target = resolve(root, normalized);
    const rel = relative(root, target);
    if (!rel || rel.startsWith('..') || rel.includes('../')) {
      throw new Error(`Security block: path traversal '${relPath}'`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    written.push(normalized);
  }
  return written;
}

function listProjectFiles(root, prefix = '') {
  const out = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listProjectFiles(root, rel));
    else out.push(rel);
  }
  return out;
}

async function callGeminiOnce({ apiKey, model, prompt }) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
        maxOutputTokens: 32768,
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Gemini HTTP ${res.status} (${model}): ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const payload = JSON.parse(text);
  const raw = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error(`Gemini (${model}) returned empty candidate content`);
  return JSON.parse(raw);
}

/** Call Gemini rotating across candidate models and backing off cleanly on 429/503. */
async function callGeminiResilient({ apiKey, models, prompt }) {
  let lastErr;
  for (const backoffSec of [0, 15, 35]) {
    if (backoffSec > 0) {
      console.error(`[mogra-oneshot] cooling down ${backoffSec}s before next model pass...`);
      await sleep(backoffSec * 1000);
    }
    for (const model of models) {
      try {
        console.log(`[mogra-oneshot] calling model='${model}'...`);
        return await callGeminiOnce({ apiKey, model, prompt });
      } catch (err) {
        lastErr = err;
        console.error(`[mogra-oneshot] ${err.message}`);
        if (err.status !== 429 && err.status !== 503 && err.status !== 404) throw err;
      }
    }
  }
  throw lastErr;
}

function runLocalChecks(workdir) {
  try {
    execSync(
      'npm install --no-audit --no-fund && npm run typecheck --if-present && npm run lint --if-present && npm test --if-present && npm run build',
      { cwd: workdir, encoding: 'utf8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 },
    );
    return { ok: true, output: '' };
  } catch (err) {
    const combined = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim();
    return { ok: false, output: combined.slice(-3500) };
  }
}

function readConfigContext(workdir) {
  const candidates = ['package.json', 'vitest.config.ts', 'vitest.config.mts', 'vite.config.ts', 'playwright.config.ts', 'tsconfig.json'];
  return candidates
    .filter((file) => existsSync(join(workdir, file)))
    .map((file) => `File \`${file}\`:\n\`\`\`\n${readFileSync(join(workdir, file), 'utf8').slice(0, 2500)}\n\`\`\``)
    .join('\n');
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, cur, idx, arr) => {
      if (cur.startsWith('--')) acc.push([cur.slice(2), arr[idx + 1]]);
      return acc;
    }, []),
  );
  const workdir = resolve(args.workdir ?? '.');
  const primaryModel = args.model ?? 'gemini-3.1-flash-lite';
  const envCandidates = (process.env.MOGRA_CANDIDATES ?? '').split(/\s+/).filter(Boolean);
  const models = [...new Set([primaryModel, ...envCandidates])];
  const promptText = readFileSync(args['prompt-file'], 'utf8');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');

  if (!existsSync(join(workdir, 'package.json'))) {
    const initialPrompt = [
      promptText,
      '',
      '## Output Format (STRICT JSON)',
      'Return ONLY a JSON object with shape: { "files": { "<relative-path>": "<full-file-content>" } }.',
      'Generate all files needed in the working directory: package.json (scripts: typecheck, lint, test, build, test:e2e), tsconfig.json, vite.config.ts (with base: process.env.VITE_BASE_PATH || "/"), vitest.config.ts (using vitest/config with test.environment="jsdom", include:["src/**/*.{test,spec}.{ts,tsx}"], exclude:["e2e/**","node_modules/**","dist/**"]), playwright.config.ts (testDir:"./e2e", webServer command:"npm run dev -- --port 4173 --strictPort", url:"http://127.0.0.1:4173", use.baseURL:"http://127.0.0.1:4173"), index.html, src/*, at least one unit test file under src/*.test.ts(x), and e2e/todomvc.spec.ts.',
      'Ensure EVERY package imported in vite.config.ts, vitest.config.ts, playwright.config.ts, src/*, or e2e/* (e.g. vitest, jsdom, @testing-library/react, @playwright/test, @axe-core/playwright) is declared in package.json dependencies or devDependencies.',
      'Keep code clean, accessible (WCAG 2.2 AA+, 320px zero-overflow reflow), and complete.',
    ].join('\n');

    const first = await callGeminiResilient({ apiKey, models, prompt: initialPrompt });
    const files = writeGeneratedFiles(workdir, first.files);
    console.log(`[mogra-oneshot] Wrote ${files.length} files.`);
  }

  for (let round = 1; round <= 3; round++) {
    const check = runLocalChecks(workdir);
    if (check.ok) {
      console.log(`[mogra-oneshot] Local typecheck, lint, unit tests, and build passed.`);
      return;
    }
    const existingFiles = listProjectFiles(workdir);
    console.error(`[mogra-oneshot] Check failed (round ${round}); requesting surgical repair:\n${check.output}`);
    const configContext = readConfigContext(workdir);
    const repairPrompt = [
      `Fix or create any needed files (current files: [${existingFiles.join(', ')}]) to resolve this error:`,
      '```',
      check.output,
      '```',
      configContext,
      'Rules: Keep vitest unit tests isolated to src/**/*.{test,spec}.{ts,tsx} and exclude e2e/** in vitest.config.ts. Declare any missing packages in package.json.',
      'Return ONLY JSON: { "files": { "<relative-path>": "<updated-full-content>" } }.',
    ].join('\n');
    const patched = await callGeminiResilient({ apiKey, models, prompt: repairPrompt });
    const updated = writeGeneratedFiles(workdir, patched.files);
    console.log(`[mogra-oneshot] Patched ${updated.length} files.`);
  }

  const finalCheck = runLocalChecks(workdir);
  if (!finalCheck.ok) {
    throw new Error(`Build/tests still failing after surgical repair:\n${finalCheck.output}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(err.status === 429 || err.status === 503 ? 75 : 1);
  });
}
