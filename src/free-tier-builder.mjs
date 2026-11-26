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
    signal: AbortSignal.timeout(90_000),
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

/** Call Gemini rotating across candidate models and backing off cleanly on 429/503/network timeouts. */
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
        if (err.status && err.status !== 429 && err.status !== 503 && err.status !== 404) throw err;
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
    const pwCfgPath = join(workdir, 'playwright.config.ts');
    if (!existsSync(pwCfgPath) || !existsSync(join(workdir, 'e2e/todomvc.spec.ts'))) {
      return {
        ok: false,
        output: 'Missing required Playwright files: create both playwright.config.ts and e2e/todomvc.spec.ts.',
      };
    }
    const pwCfg = readFileSync(pwCfgPath, 'utf8');
    if (pwCfg.includes('127.0.0.1') && !pwCfg.includes('--host 127.0.0.1') && !pwCfg.includes('--host=127.0.0.1')) {
      return {
        ok: false,
        output: 'playwright.config.ts webServer.url uses 127.0.0.1, so webServer.command MUST pass `--host 127.0.0.1` (otherwise Vite binds IPv6 ::1 on Linux CI and Playwright times out).',
      };
    }
    execSync('npx playwright test --list', { cwd: workdir, encoding: 'utf8', stdio: 'pipe', maxBuffer: 5 * 1024 * 1024 });
    execSync('npx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler --skipLibCheck e2e/*.ts', {
      cwd: workdir,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 5 * 1024 * 1024,
    });
    const srcFiles = listProjectFiles(workdir).filter((f) => f.startsWith('src/') && /\.(tsx?|jsx?|vue|svelte|html)$/.test(f));
    for (const file of srcFiles) {
      const content = readFileSync(join(workdir, file), 'utf8');
      if (/<label\b[^>]*\baria-label\s*=/.test(content)) {
        return {
          ok: false,
          output: `Accessibility error (axe aria-prohibited-attr) in ${file}: never put aria-label on <label>. Use a <button type="button" aria-label="..."> triggering a hidden <input type="file">, or put <span class="sr-only">...</span> inside <label>.`,
        };
      }
    }
    return { ok: true, output: '' };
  } catch (err) {
    const combined = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim();
    return { ok: false, output: combined.slice(-3500) };
  }
}

function readConfigContext(workdir, errorOutput = '') {
  const base = ['package.json', 'vitest.config.ts', 'vitest.config.mts', 'vite.config.ts', 'playwright.config.ts', 'tsconfig.json'];
  const all = listProjectFiles(workdir);
  const referenced = all.filter((f) => errorOutput.includes(f));
  const shared = all.filter((f) => /^src\/(types|hooks|lib|utils)\//.test(f) || /^src\/types\.[cm]?ts$/.test(f));
  const selected = [...new Set([...base, ...referenced, ...shared])].filter((f) => existsSync(join(workdir, f)));
  return selected
    .map((file) => `File \`${file}\`:\n\`\`\`\n${readFileSync(join(workdir, file), 'utf8').slice(0, 12000)}\n\`\`\``)
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
  const richModels = [...new Set([
    'gemini-3-flash-preview',
    'gemini-flash-latest',
    'gemini-2.5-flash',
    ...models.filter((m) => !m.includes('flash-lite')),
    ...models,
  ])];
  const promptText = readFileSync(args['prompt-file'], 'utf8');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');

  if (!existsSync(join(workdir, 'package.json'))) {
    const initialPrompt = [
      promptText,
      '',
      '## Output Format (STRICT JSON)',
      'Return ONLY a JSON object with shape: { "files": { "<relative-path>": "<full-file-content>" } }.',
      'Build a COMPLETE, polished, production-quality application — NO minimal toy stubs. Include ALL requested features:',
      '1. Full TodoMVC CRUD: add todo (trimmed non-empty), toggle single & toggle-all, inline edit (Enter/Blur saves, Escape cancels, empty deletes), delete todo, Clear Completed, live remaining count, All/Active/Completed filters.',
      '2. TodoMVC+ Power Features: versioned IndexedDB persistence with localStorage fallback (for jsdom), BroadcastChannel multi-tab sync (feature-detected), Undo/Redo history (buttons + Ctrl+Z / Ctrl+Shift+Z), prototype-pollution-safe validated JSON Export/Import, and accessible Light/Dark theme toggle.',
      '3. Accessibility & Ultra-Modern CSS: OKLCH + light-dark() design tokens, @layer, @container responsive layout with ZERO horizontal overflow at 320px width, >=4.5:1 contrast, visible :focus-visible rings, aria-live polite announcements, logical focus restoration, prefers-reduced-motion, and forced-colors support. NEVER put aria-label on <label>, <div>, or <span> without an ARIA role (use <button aria-label="..."> or <span class="sr-only"> inside <label>).',
      '',
      'REQUIRED files checklist:',
      '- package.json (scripts: dev, typecheck: "tsc --noEmit", lint: "tsc --noEmit" or eslint v9 flat config, test: "vitest run", build: "tsc --noEmit && vite build", test:e2e: "playwright test")',
      '- tsconfig.json (MUST have "noEmit": true so tsc never emits .js files into src/ or e2e/)',
      '- vite.config.ts (with base: process.env.VITE_BASE_PATH || "/")',
      '- vitest.config.ts (using vitest/config with test.environment="jsdom", include:["src/**/*.{test,spec}.{ts,tsx}"], exclude:["e2e/**","node_modules/**","dist/**"])',
      '- playwright.config.ts (testDir:"./e2e", timeout: 120000, webServer: { command: "npm run dev -- --host 127.0.0.1 --port 4173 --strictPort" (or "--host 127.0.0.1 --port 4173" for Angular), url: "http://127.0.0.1:4173", reuseExistingServer: !process.env.CI, timeout: 120000 }, use: { baseURL: "http://127.0.0.1:4173" })',
      '- index.html',
      '- Modular src/* source files & clean modern CSS (prefer native CSS without postcss.config.js unless all plugins are in devDependencies; feature-detect `window.matchMedia?.(...)` and `typeof BroadcastChannel !== "undefined"` so Vitest jsdom never throws)',
      '- Real unit tests under src/ (e.g. src/App.test.tsx) testing CRUD, filters, undo/redo, and safe JSON import',
      '- Comprehensive e2e/todomvc.spec.ts (CRUD, reload persistence, zero horizontal overflow at 320px/768px/1280px, and @axe-core/playwright zero violations; use Playwright `page.getByLabel(...)` — NEVER `getByLabelText` — and pass `{ exact: true }` to `page.getByText(..., { exact: true })` or scope inside `page.getByRole(\'list\')`)',
      'Ensure EVERY package imported in any file (vitest, jsdom, @testing-library/react, @playwright/test, @axe-core/playwright, etc.) is declared in package.json.',
    ].join('\n');

    const first = await callGeminiResilient({ apiKey, models: richModels, prompt: initialPrompt });
    const files = writeGeneratedFiles(workdir, first.files);
    console.log(`[mogra-oneshot] Wrote ${files.length} files (${files.join(', ')}).`);
  }

  for (let round = 1; round <= 5; round++) {
    const check = runLocalChecks(workdir);
    if (check.ok) {
      console.log(`[mogra-oneshot] Local typecheck, lint, unit tests, and build passed.`);
      return;
    }
    const existingFiles = listProjectFiles(workdir);
    console.error(`[mogra-oneshot] Check failed (round ${round}); requesting surgical repair:\n${check.output}`);
    const configContext = readConfigContext(workdir, check.output);
    const hints = [
      'Keep vitest unit tests isolated to src/**/*.{test,spec}.{ts,tsx} and exclude e2e/** in vitest.config.ts.',
      'Declare any missing packages in package.json.',
    ];
    if (check.output.includes('No test files found')) {
      hints.push('CRITICAL: No unit test file matched Vitest include! Create a passing unit test file under src/ (e.g. src/App.test.tsx or src/store.test.ts) right now.');
    }
    if (check.output.includes('eslint')) {
      hints.push('If using ESLint v9+, use eslint.config.mjs (remove .eslintrc*), or simplify lint script cleanly.');
    }
    const repairPrompt = [
      `Fix or create any needed files (current files: [${existingFiles.join(', ')}]) to resolve ALL errors shown below:`,
      '```',
      check.output,
      '```',
      configContext,
      `Rules:\n- ${hints.join('\n- ')}`,
      'Return ONLY JSON: { "files": { "<relative-path>": "<updated-full-content>" } }.',
    ].join('\n');
    const patched = await callGeminiResilient({ apiKey, models, prompt: repairPrompt });
    const updated = writeGeneratedFiles(workdir, patched.files);
    console.log(`[mogra-oneshot] Patched ${updated.length} files (${updated.join(', ')}).`);
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
