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
  const startedAt = Date.now();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    signal: AbortSignal.timeout(95_000),
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
  const meta = payload.usageMetadata ?? {};
  return {
    data: JSON.parse(raw),
    usage: {
      model,
      elapsedMs: Date.now() - startedAt,
      promptTokenCount: Number(meta.promptTokenCount ?? 0),
      candidatesTokenCount: Number(meta.candidatesTokenCount ?? 0),
      thoughtsTokenCount: Number(meta.thoughtsTokenCount ?? 0),
      totalTokenCount: Number(meta.totalTokenCount ?? 0),
    },
  };
}

/** Call Gemini rotating across candidate models and backing off cleanly on 429/503/network timeouts. */
async function callGeminiResilient({ apiKey, models, prompt, phase = 'build', telemetry = [] }) {
  let lastErr;
  for (const backoffSec of [0, 15, 35]) {
    if (backoffSec > 0) {
      console.error(`[mogra-oneshot] cooling down ${backoffSec}s before next model pass...`);
      await sleep(backoffSec * 1000);
    }
    for (const model of models) {
      try {
        console.log(`[mogra-oneshot] calling model='${model}'...`);
        const result = await callGeminiOnce({ apiKey, model, prompt });
        telemetry.push({ phase, timestamp: new Date().toISOString(), ...result.usage });
        return result.data;
      } catch (err) {
        lastErr = err;
        console.error(`[mogra-oneshot] ${err.message}`);
        if (err.status && err.status !== 429 && err.status !== 503 && err.status !== 404) throw err;
      }
    }
  }
  throw lastErr;
}

/** Persist measured Gemini API token telemetry for the TodoMVC+ showcase portal. */
export function writeRunMetrics(workdir, telemetry) {
  if (!Array.isArray(telemetry) || telemetry.length === 0) return null;
  const totals = telemetry.reduce(
    (acc, call) => ({
      calls: acc.calls + 1,
      promptTokens: acc.promptTokens + Number(call.promptTokenCount ?? 0),
      candidatesTokens: acc.candidatesTokens + Number(call.candidatesTokenCount ?? 0),
      thoughtsTokens: acc.thoughtsTokens + Number(call.thoughtsTokenCount ?? 0),
      totalTokens: acc.totalTokens + Number(call.totalTokenCount ?? 0),
      elapsedMs: acc.elapsedMs + Number(call.elapsedMs ?? 0),
    }),
    { calls: 0, promptTokens: 0, candidatesTokens: 0, thoughtsTokens: 0, totalTokens: 0, elapsedMs: 0 },
  );
  const metrics = {
    schemaVersion: 1,
    provider: 'google-ai-studio-free-tier',
    costUsd: 0,
    generatedAt: new Date().toISOString(),
    totals,
    calls: telemetry,
  };
  writeFileSync(join(workdir, '.mogra-metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
  return metrics;
}

function collectStaticIssues(workdir) {
  const issues = [];
  const vitestCfgPath = existsSync(join(workdir, 'vitest.config.ts'))
    ? join(workdir, 'vitest.config.ts')
    : join(workdir, 'vitest.config.mts');
  if (!existsSync(vitestCfgPath)) {
    issues.push('Missing required file: vitest.config.ts (must configure jsdom and exclude e2e/**).');
  } else if (!readFileSync(vitestCfgPath, 'utf8').includes('e2e')) {
    issues.push('vitest.config.ts MUST exclude `e2e/**` so `vitest run` never executes Playwright specs.');
  }
  const viteCfgPath = existsSync(join(workdir, 'vite.config.ts'))
    ? join(workdir, 'vite.config.ts')
    : join(workdir, 'vite.config.mts');
  if (existsSync(viteCfgPath) && !readFileSync(viteCfgPath, 'utf8').includes('VITE_BASE_PATH')) {
    issues.push('vite.config.ts MUST set `base: process.env.VITE_BASE_PATH || "/"` for GitHub Pages subpath deployment.');
  }
  const pwCfgPath = join(workdir, 'playwright.config.ts');
  const e2ePath = join(workdir, 'e2e/todomvc.spec.ts');
  if (!existsSync(pwCfgPath)) {
    issues.push('Missing required file: playwright.config.ts.');
  } else {
    const pwCfg = readFileSync(pwCfgPath, 'utf8');
    if (!pwCfg.includes('127.0.0.1') || (!pwCfg.includes('--host 127.0.0.1') && !pwCfg.includes('--host=127.0.0.1'))) {
      issues.push('playwright.config.ts MUST bind IPv4 explicitly: set webServer.command with `--host 127.0.0.1 --port 4173 --strictPort` (or `--host 127.0.0.1 --port 4173`) and webServer.url + use.baseURL to `http://127.0.0.1:4173` (never localhost).');
    }
  }
  if (!existsSync(e2ePath)) {
    issues.push('Missing required file: e2e/todomvc.spec.ts.');
  } else {
    const e2eSrc = readFileSync(e2ePath, 'utf8');
    if (!e2eSrc.includes('@axe-core/playwright') || !e2eSrc.includes('AxeBuilder') || !e2eSrc.includes('320')) {
      issues.push('e2e/todomvc.spec.ts MUST include @axe-core/playwright (`import AxeBuilder from "@axe-core/playwright"; const res = await new AxeBuilder({ page }).analyze(); expect(res.violations).toEqual([]);` — NEVER checkA11y) AND a 320px viewport zero-horizontal-overflow reflow check.');
    }
    if (e2eSrc.split('\n').some((line) => (line.includes('.getByText(') || (line.includes('.getByRole(') && line.includes('name:'))) && !line.includes('exact:'))) {
      issues.push('e2e/todomvc.spec.ts MUST pass `{ exact: true }` to every `.getByText(..., { exact: true })` AND `.getByRole(..., { name: ..., exact: true })` call so strict-mode locators never collide with longer aria-labels or aria-live announcements.');
    }
    if (/press\(['"]Enter['"]\)\s*;\s*(?:\/\/[^\n]*\n)?\s*await\s+page\.reload\s*\(/.test(e2eSrc)) {
      issues.push('e2e/todomvc.spec.ts calls `page.reload()` immediately after `press("Enter")` without waiting for the item to render or IndexedDB to commit. Assert `.toBeVisible()` and `await page.waitForTimeout(150)` BEFORE `await page.reload()`.');
    }
  }

  const srcFiles = listProjectFiles(workdir).filter((f) => f.startsWith('src/') && /\.(tsx?|jsx?|vue|svelte|html)$/.test(f));
  let combinedSrc = '';
  for (const file of srcFiles) {
    const content = readFileSync(join(workdir, file), 'utf8');
    combinedSrc += '\n' + content;
    if (/<label\b[^>]*\baria-label\s*=/.test(content)) {
      issues.push(`Accessibility error (axe aria-prohibited-attr) in ${file}: never put aria-label on <label>. Use a <button type="button" aria-label="..."> triggering a hidden <input type="file">, or put <span class="sr-only">...</span> inside <label>.`);
    }
    if (/(?:^|[\s"'`])text-(?:slate|gray|zinc|neutral|stone)-(?:300|400)\b/.test(content)) {
      issues.push(`WCAG color-contrast violation in ${file}: light-mode \`text-slate-400\`/\`text-gray-400\` fails 4.5:1 contrast on light backgrounds (ratio ~2.5:1). Use \`text-slate-600\`/\`text-slate-700\` (and \`dark:text-slate-300\`) instead.`);
    }
    if (!/\.(test|spec)\./.test(file) && /\bload\w*\([^)]*\)\.then\(/.test(content) && !/(cancelled|canceled|isMounted|mounted|active|AbortController)/.test(content)) {
      issues.push(`Vitest teardown race in ${file}: async storage hydration (\`.then(...)\`) MUST check a cleanup flag (\`let active = true; ... if (active) setTodos(...); return () => { active = false; }\`) so state setters never run after jsdom unmount.`);
    }
  }
  if (!/active/i.test(combinedSrc) || !/completed/i.test(combinedSrc) || !/(indexedDB|localStorage)/.test(combinedSrc) || !/undo/i.test(combinedSrc)) {
    issues.push('Incomplete TodoMVC+ app in src/: must include filters (All/Active/Completed), persistent IndexedDB/localStorage storage, and Undo/Redo support (not a bare add-only toy).');
  }
  return issues;
}

function compactErrorOutput(raw) {
  const clean = raw
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/<svg[\s\S]*?<\/svg>/g, '<svg />')
    .trim();
  if (clean.length <= 5000) return clean;
  return `${clean.slice(0, 2500)}\n...\n${clean.slice(-2500)}`;
}

let pwInstalled = false;

function runLocalChecks(workdir) {
  const issues = collectStaticIssues(workdir);
  const checkEnv = { ...process.env, DEBUG_PRINT_LIMIT: '800', CI: process.env.CI || 'true' };
  try {
    execSync(
      'npm install --no-audit --no-fund --loglevel=error && npm run typecheck --if-present && npm run lint --if-present && npm test --if-present && npm run build && npm audit --omit=dev --audit-level=high',
      { cwd: workdir, env: checkEnv, encoding: 'utf8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 },
    );
    if (existsSync(join(workdir, 'playwright.config.ts')) && existsSync(join(workdir, 'e2e/todomvc.spec.ts'))) {
      execSync('npx playwright test --list && npx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler --skipLibCheck e2e/*.ts', {
        cwd: workdir,
        env: checkEnv,
        encoding: 'utf8',
        stdio: 'pipe',
        maxBuffer: 5 * 1024 * 1024,
      });
      if (issues.length === 0) {
        if (!pwInstalled) {
          console.log('[mogra-oneshot] Installing Playwright Chromium for pre-PR E2E/a11y verification...');
          execSync('npx playwright install --with-deps chromium', {
            cwd: workdir,
            env: checkEnv,
            encoding: 'utf8',
            stdio: 'pipe',
            maxBuffer: 10 * 1024 * 1024,
          });
          pwInstalled = true;
        }
        const pwOutFile = `/tmp/mogra-e2e-${process.pid}.log`;
        try {
          execSync(`npx playwright test --reporter=list --retries=0 --timeout=20000 > "${pwOutFile}" 2>&1`, {
            cwd: workdir,
            env: checkEnv,
            timeout: 90_000,
            stdio: 'ignore',
          });
        } catch (pwErr) {
          const pwLog = existsSync(pwOutFile) ? readFileSync(pwOutFile, 'utf8') : pwErr.message;
          throw new Error(`Playwright E2E failed:\n${pwLog}`);
        }
      }
    }
  } catch (err) {
    issues.push(compactErrorOutput(`${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}`));
  }
  return issues.length === 0 ? { ok: true, output: '' } : { ok: false, output: issues.join('\n\n').slice(-5500) };
}

function readConfigContext(workdir) {
  const priority = ['package.json', 'vitest.config.ts', 'vitest.config.mts', 'vite.config.ts', 'playwright.config.ts', 'tsconfig.json'];
  const all = listProjectFiles(workdir).filter((f) => /\.(json|ts|tsx|js|jsx|mjs|cjs|vue|svelte|css|html)$/.test(f));
  const selected = [...new Set([...priority, ...all])].filter((f) => existsSync(join(workdir, f)));
  return selected
    .map((file) => {
      const cap = file.endsWith('.css') ? 1200 : 8000;
      return `File \`${file}\`:\n\`\`\`\n${readFileSync(join(workdir, file), 'utf8').slice(0, cap)}\n\`\`\``;
    })
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
  const models = [...new Set([primaryModel, 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest', ...envCandidates.filter((m) => /flash-lite/.test(m))])];
  const richModels = [...new Set([
    'gemini-3-flash-preview',
    ...models,
  ])];
  const promptText = readFileSync(args['prompt-file'], 'utf8');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');
  const telemetry = [];

  if (!existsSync(join(workdir, 'package.json'))) {
    const initialPrompt = [
      promptText,
      '',
      '## Output Format (STRICT JSON)',
      'Return ONLY a JSON object with shape: { "files": { "<relative-path>": "<full-file-content>" } }.',
      'Build a COMPLETE, polished, production-quality application — NO minimal toy stubs. Include ALL requested features:',
      '1. Full TodoMVC CRUD: add todo (trimmed non-empty), toggle single & toggle-all, inline edit (Enter/Blur saves, Escape cancels, empty deletes), delete todo, Clear Completed, live remaining count, All/Active/Completed filters.',
      '2. TodoMVC+ Power Features: versioned IndexedDB persistence WITH synchronous localStorage write-through mirror on every save (and fast localStorage read fallback so immediate reloads never lose in-flight IndexedDB writes, and initial mount never overwrites persisted items with []; ALWAYS guard async `.then(...)` hydration with an unmount cleanup flag `let active = true; ... return () => { active = false; }` so state setters never run after jsdom teardown), BroadcastChannel multi-tab sync (feature-detected), Undo/Redo history (buttons + Ctrl+Z / Ctrl+Shift+Z), prototype-pollution-safe validated JSON Export/Import, and accessible Light/Dark theme toggle.',
      '3. Accessibility, QuantumBlack Design System Aesthetic & Ultra-Modern CSS: OKLCH + light-dark() design tokens inspired by QuantumBlack (Inter + JetBrains Mono typography, dark obsidian slate-950/slate-900 default & high-contrast light Mist surface, 1px hairline borders, teal-400/sky-500 semantic accents, tabular-nums counters), @layer, @container responsive layout with ZERO horizontal overflow at 320px width, >=4.5:1 contrast (NEVER use text-slate-400 or text-gray-400 on light surfaces — use slate-600/700 for >=4.5:1 ratio and dark:text-slate-300 in dark mode), visible :focus-visible rings, aria-live polite announcements, logical focus restoration, prefers-reduced-motion, and forced-colors support. NEVER put aria-label on <label>, <div>, or <span> without an ARIA role (use <button aria-label="..."> or <span class="sr-only"> inside <label>).',
      '',
      'REQUIRED files checklist:',
      '- package.json (scripts: dev, typecheck: "tsc --noEmit", lint: "tsc --noEmit", test: "vitest run", build: "tsc --noEmit && vite build", test:e2e: "playwright test")',
      '- tsconfig.json (MUST have "noEmit": true so tsc never emits .js files into src/ or e2e/)',
      '- vite.config.ts (with base: process.env.VITE_BASE_PATH || "/")',
      '- vitest.config.ts (using vitest/config with test.environment="jsdom", include:["src/**/*.{test,spec}.{ts,tsx}"], exclude:["e2e/**","node_modules/**","dist/**"])',
      '- playwright.config.ts (testDir:"./e2e", timeout: 30000, webServer: { command: "npm run dev -- --host 127.0.0.1 --port 4173 --strictPort" (or "--host 127.0.0.1 --port 4173" for Angular), url: "http://127.0.0.1:4173", reuseExistingServer: !process.env.CI, timeout: 60000 }, use: { baseURL: "http://127.0.0.1:4173" })',
      '- index.html',
      '- Modular src/* source files & clean modern CSS (prefer native CSS without postcss.config.js unless all plugins are in devDependencies; feature-detect `window.matchMedia?.(...)` and `typeof BroadcastChannel !== "undefined"` so Vitest jsdom never throws)',
      '- Real unit tests under src/ (e.g. src/test/setup.ts with `afterEach(cleanup)` + `window.matchMedia` mock, and src/App.test.tsx testing CRUD, filters, undo/redo, and safe JSON import; ALWAYS scope item presence/removal checks inside the list via `within(screen.getByRole(\'list\'))` and NEVER assert on or `waitForElementToBeRemoved` the `role="status"` live announcer)',
      '- Comprehensive e2e/todomvc.spec.ts (CRUD, reload persistence — ALWAYS assert `toBeVisible()` and `await page.waitForTimeout(150)` BEFORE calling `await page.reload()`, zero horizontal overflow at 320px/768px/1280px, and @axe-core/playwright zero violations; use Playwright `page.getByLabel(...)` — NEVER `getByLabelText` — pass `{ exact: true }` to EVERY `getByText(..., { exact: true })` AND `getByRole(..., { name: ..., exact: true })`, and scope checkbox assertions by row/listitem when toggling changes its aria-label)',
      'Ensure EVERY package imported in any file (vitest, jsdom, @testing-library/react, @playwright/test, @axe-core/playwright, etc.) is declared in package.json with compatible peer versions (for Angular 19: NEVER install @testing-library/angular@18+ because it requires @angular 20+ — test Angular stores/signals directly with Vitest or pin compatible versions), and `npm audit --omit=dev --audit-level=high` passes cleanly (use zero-dependency runtime TypeScript validation instead of vulnerable `zod <4.6.7`).',
    ].join('\n');

    const first = await callGeminiResilient({ apiKey, models: richModels, prompt: initialPrompt, phase: 'initial-build', telemetry });
    const files = writeGeneratedFiles(workdir, first.files);
    console.log(`[mogra-oneshot] Wrote ${files.length} files (${files.join(', ')}).`);
  }

  for (let round = 1; round <= 7; round++) {
    const check = runLocalChecks(workdir);
    if (check.ok) {
      writeRunMetrics(workdir, telemetry);
      console.log(`[mogra-oneshot] Local typecheck, lint, unit tests, and build passed.`);
      return;
    }
    const existingFiles = listProjectFiles(workdir);
    console.error(`[mogra-oneshot] Check failed (round ${round}); requesting surgical repair:\n${check.output}`);
    const configContext = readConfigContext(workdir);
    const hints = [
      'Keep vitest unit tests isolated to src/**/*.{test,spec}.{ts,tsx} and exclude e2e/** in vitest.config.ts.',
      'Declare any missing packages in package.json.',
    ];
    if (check.output.includes('No test files found')) {
      hints.push('CRITICAL: No unit test file matched Vitest include! Create a passing unit test file under src/ (e.g. src/App.test.tsx or src/store.test.ts) right now.');
    }
    if (check.output.includes('Found multiple elements') || check.output.includes('getMultipleElementsFoundError')) {
      hints.push('CRITICAL: Testing Library leaked DOM between tests! Import `cleanup` from `@testing-library/react` and `afterEach` from `vitest` directly in `src/App.test.tsx` and call `afterEach(() => cleanup())`.');
    }
    if (check.output.includes('waitForElementToBeRemoved') || (check.output.includes('role="status"') && !check.output.includes('within('))) {
      hints.push('CRITICAL: Do NOT assert on or waitForElementToBeRemoved on `role="status"` (the live announcer element stays mounted!). Scope todo item checks inside the list using `within(screen.getByRole(\'list\')).queryByText(...)` instead of `screen.queryByText(...)`.');
    }
    if (check.output.includes('eslint')) {
      hints.push('If using ESLint v9+, use eslint.config.mjs (remove .eslintrc*), or simplify lint script cleanly.');
    }
    if (check.output.includes('ERESOLVE')) {
      hints.push('CRITICAL npm ERESOLVE peer conflict: Align package major versions or remove incompatible test helper packages (e.g., for @angular 19 remove @testing-library/angular@18+ or test store/signals purely with Vitest; do NOT just bump @testing-library/angular to 18/19 without matching @angular/core).');
    }
    if (check.output.includes('NG0203')) {
      hints.push('CRITICAL Angular NG0203: Do NOT call `new AppComponent()` directly in Vitest when the constructor uses `effect()`! Either test via `TestBed.runInInjectionContext(() => new AppComponent())` / pure store class without DI, or persist changes explicitly inside store methods (add/toggle/delete/undo) instead of `effect()` in the constructor.');
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
    const patched = await callGeminiResilient({ apiKey, models, prompt: repairPrompt, phase: `repair-${round}`, telemetry });
    const updated = writeGeneratedFiles(workdir, patched.files);
    console.log(`[mogra-oneshot] Patched ${updated.length} files (${updated.join(', ')}).`);
  }

  const finalCheck = runLocalChecks(workdir);
  if (!finalCheck.ok) {
    throw new Error(`Build/tests still failing after surgical repair:\n${finalCheck.output}`);
  }
  writeRunMetrics(workdir, telemetry);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(err.status === 429 || err.status === 503 ? 75 : 1);
  });
}
