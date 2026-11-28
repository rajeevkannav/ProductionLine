#!/usr/bin/env node
/**
 * Lean single-shot + surgical-repair builder for Free-Tier API limits (15 RPM / 250K TPM).
 * Preserves on-disk progress across retries and rotates through healthy models on transient 503s.
 */

import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const FORBIDDEN_PREFIXES = ['.github/', '.git/', 'node_modules/', 'dist/'];

/**
 * Cross-stack UI contract: every TodoMVC+ stack renders the same DOM skeleton (class names)
 * and styles it from one global `src/styles.css` built on the same QuantumBlack light tokens,
 * so all five deployed apps look and behave alike regardless of framework.
 */
export const CROSS_STACK_UI = Object.freeze({
  stylesheet: 'src/styles.css',
  requiredClasses: Object.freeze([
    'todoapp', 'app-header', 'app-title', 'app-stack', 'app-toolbar',
    'new-todo-form', 'new-todo', 'todo-main', 'toggle-all', 'todo-list', 'todo-item',
    'todo-toggle', 'todo-title', 'todo-edit', 'todo-destroy',
    'app-footer', 'todo-count', 'todo-filters', 'clear-completed',
  ]),
  lightTokens: Object.freeze({
    '--qb-canvas': '#f8fafc',
    '--qb-surface': '#ffffff',
    '--qb-elevated': '#f1f5f9',
    '--qb-border': 'rgba(15, 23, 42, 0.12)',
    '--qb-border-strong': 'rgba(15, 23, 42, 0.22)',
    '--qb-text': '#0f172a',
    '--qb-text-secondary': '#334155',
    '--qb-text-muted': '#475569',
    '--qb-accent': '#0f766e',
    '--qb-accent-hover': '#115e59',
    '--qb-on-accent': '#ffffff',
    '--qb-focus': '#0369a1',
    '--qb-danger': '#be123c',
    '--qb-danger-bg': '#ffe4e6',
    '--qb-radius': '14px',
    '--qb-radius-sm': '8px',
    '--qb-content-width': '40rem',
    '--qb-font-sans': "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    '--qb-font-mono': "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  }),
  darkTokens: Object.freeze({
    '--qb-canvas': '#020617',
    '--qb-surface': '#0f172a',
    '--qb-elevated': '#1e293b',
    '--qb-border': 'rgba(148, 163, 184, 0.18)',
    '--qb-border-strong': 'rgba(148, 163, 184, 0.32)',
    '--qb-text': '#f1f5f9',
    '--qb-text-secondary': '#cbd5e1',
    '--qb-text-muted': '#94a3b8',
    '--qb-accent': '#2dd4bf',
    '--qb-accent-hover': '#5eead4',
    '--qb-on-accent': '#042f2e',
    '--qb-focus': '#38bdf8',
    '--qb-danger': '#fb7185',
    '--qb-danger-bg': 'rgba(244, 63, 94, 0.15)',
  }),
});

const CROSS_STACK_SKELETON = `<main class="todoapp" aria-labelledby="app-title">
  <header class="app-header">
    <h1 id="app-title" class="app-title">TodoMVC+</h1>
    <p class="app-stack">{stack id from the issue, e.g. vue3-ts-vite}</p>
    <div class="app-toolbar" role="toolbar" aria-label="App actions">
      <button type="button" class="btn">Undo</button> <button type="button" class="btn">Redo</button>
      <button type="button" class="btn">Export</button>
      <button type="button" class="btn">Import</button> <input type="file" accept="application/json" hidden>
      <button type="button" class="btn" aria-pressed="false">Dark theme</button>
    </div>
  </header>
  <form class="new-todo-form">
    <label for="new-todo" class="sr-only">New todo</label>
    <input id="new-todo" class="new-todo" placeholder="What needs to be done?" autocomplete="off">
    <button type="submit" class="btn btn-primary">Add</button>
  </form>
  <section class="todo-main" aria-label="Todos">  <!-- render only when there is at least one todo -->
    <input id="toggle-all" class="toggle-all" type="checkbox"> <label for="toggle-all">Mark all as complete</label>
    <ul class="todo-list">
      <li class="todo-item">  <!-- add "completed" / "editing" modifier classes on the li -->
        <input type="checkbox" class="todo-toggle" aria-label="Toggle {title}">
        <span class="todo-title">{title}</span>  <!-- double-click (and Enter on the focused title) starts editing -->
        <input class="todo-edit" aria-label="Edit {title}">  <!-- rendered only while editing -->
        <button type="button" class="todo-destroy" aria-label="Delete {title}">×</button>
      </li>
    </ul>
  </section>
  <footer class="app-footer">  <!-- render only when there is at least one todo -->
    <span class="todo-count"><strong>{n}</strong> {item|items} left</span>
    <nav class="todo-filters" aria-label="Filter todos">
      <button type="button" class="filter" aria-pressed="true">All</button>
      <button type="button" class="filter" aria-pressed="false">Active</button>
      <button type="button" class="filter" aria-pressed="false">Completed</button>
    </nav>
    <button type="button" class="btn clear-completed">Clear completed</button>
  </footer>
  <div class="sr-only" role="status" aria-live="polite"></div>
</main>`;

function formatTokenBlock(selector, tokens) {
  const lines = Object.entries(tokens).map(([name, value]) => `  ${name}: ${value};`);
  return `${selector} {\n${lines.join('\n')}\n}`;
}

export function crossStackUiPromptSection() {
  return [
    '## Cross-stack UI Consistency (MANDATORY — identical look across react19, vue3, svelte5, angular and solid)',
    'Every TodoMVC+ stack MUST render the SAME DOM skeleton with the SAME class names and the SAME visual design. Translate the markup below into this framework\'s template syntax (className / class / :class / class: / [class.x] / classList are all fine) without renaming, dropping, or wrapping-and-restyling any class:',
    '```html',
    CROSS_STACK_SKELETON,
    '```',
    `Styling rules: put ALL app styling in ONE global plain-CSS file \`${CROSS_STACK_UI.stylesheet}\` (import it from the entry file, e.g. \`import './styles.css'\` in src/main.ts(x); for angular-ts list it in angular.json \`styles\`). NO Tailwind (never add tailwindcss / @tailwindcss/* / postcss.config.*), NO CSS-in-JS, NO inline style attributes, and NO component-scoped styles (no <style> blocks in .vue/.svelte files, no \`styles\`/\`styleUrl(s)\` in Angular components).`,
    `\`${CROSS_STACK_UI.stylesheet}\` MUST start with this exact QuantumBlack light token block (light Mist is the default first paint, \`color-scheme: light\`) and the dark override, and MUST style every element ONLY through these var(--qb-*) tokens:`,
    '```css',
    formatTokenBlock(':root', { 'color-scheme': 'light', ...CROSS_STACK_UI.lightTokens }),
    formatTokenBlock(':root[data-theme="dark"]', { 'color-scheme': 'dark', ...CROSS_STACK_UI.darkTokens }),
    '```',
    'The theme toggle sets/removes `data-theme="dark"` on `document.documentElement` and persists the choice in localStorage; default is light. NEVER auto-switch with `@media (prefers-color-scheme: dark)`.',
    'Shared visual spec: body uses var(--qb-canvas) with var(--qb-font-sans); `.todoapp` is a centered card (max-width: var(--qb-content-width); margin-inline: auto; background var(--qb-surface); 1px solid var(--qb-border); border-radius var(--qb-radius); padding 1.5rem, 1rem at <=480px); `.app-title` has a 0.375rem-wide var(--qb-accent) bar via ::before; `.app-stack` is a small var(--qb-font-mono) pill in var(--qb-text-secondary) on var(--qb-elevated); `.btn-primary` and active filters (`[aria-pressed="true"]`) are var(--qb-accent) with var(--qb-on-accent) text; other buttons and `.filter` are var(--qb-elevated) pills in var(--qb-text-secondary) with var(--qb-font-mono) 0.75rem text; `.todo-item` rows are var(--qb-canvas) with 1px var(--qb-border) and var(--qb-radius-sm); `.todo-item.completed .todo-title` is line-through in var(--qb-text-muted); `.todo-destroy:hover` uses var(--qb-danger) on var(--qb-danger-bg); `.todo-count` uses tabular-nums; all :focus-visible outlines are 2px solid var(--qb-focus) with 2px offset; `.app-toolbar`, `.new-todo-form`, `.app-footer` and `.todo-filters` use flex-wrap and `.todo-title` uses overflow-wrap: anywhere so nothing overflows at 320px; include a `.sr-only` utility.',
  ].join('\n');
}
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
    // Scripts must stay executable (e.g. Render's buildCommand ./bin/render-build.sh).
    if (normalized.startsWith('bin/') || normalized.endsWith('.sh') || content.startsWith('#!')) chmodSync(target, 0o755);
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
export async function callGeminiResilient({ apiKey, models, prompt, phase = 'build', telemetry = [], backoffs = [0, 15, 35] }) {
  let lastErr;
  let rateLimited = null;
  const unavailable = new Set(); // models this key cannot use (404): skip them on later passes
  for (const backoffSec of backoffs) {
    if (backoffSec > 0) {
      console.error(`[mogra-oneshot] cooling down ${backoffSec}s before next model pass...`);
      await sleep(backoffSec * 1000);
    }
    for (const model of models) {
      if (unavailable.has(model)) continue;
      try {
        console.log(`[mogra-oneshot] calling model='${model}'...`);
        const result = await callGeminiOnce({ apiKey, model, prompt });
        telemetry.push({ phase, timestamp: new Date().toISOString(), ...result.usage });
        return result.data;
      } catch (err) {
        lastErr = err;
        if (err.status === 429) rateLimited = err;
        if (err.status === 404) unavailable.add(model);
        console.error(`[mogra-oneshot] ${err.message}`);
        if (err.status && err.status !== 429 && err.status !== 503 && err.status !== 404) throw err;
      }
    }
  }
  if (rateLimited) lastErr = rateLimited; // report the quota, not a model that doesn't exist
  if (lastErr?.status === 429) {
    lastErr.message = `Gemini free-tier quota exhausted for ${models.join(', ')} (HTTP 429 after ${backoffs.length} passes). Re-run after the quota resets (daily reset at midnight Pacific). ${lastErr.message}`;
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

export function collectStaticIssues(workdir) {
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
    if (/\.(test|spec)\.ts$/.test(file) && content.includes('TestBed') && !content.includes('initTestEnvironment')) {
      issues.push(`Angular Vitest TestBed error in ${file}: NEVER use TestBed in Vitest without initTestEnvironment. Put state/CRUD/Undo logic in a pure TypeScript store (e.g. src/app/todo.store.ts) without effect()/inject() and test the store directly in ${file} without TestBed.`);
    }
  }
  if (!/active/i.test(combinedSrc) || !/completed/i.test(combinedSrc) || !/(indexedDB|localStorage)/.test(combinedSrc) || !/undo/i.test(combinedSrc)) {
    issues.push('Incomplete TodoMVC+ app in src/: must include filters (All/Active/Completed), persistent IndexedDB/localStorage storage, and Undo/Redo support (not a bare add-only toy).');
  }
  const indexHtml = existsSync(join(workdir, 'src/index.html'))
    ? readFileSync(join(workdir, 'src/index.html'), 'utf8')
    : existsSync(join(workdir, 'index.html'))
      ? readFileSync(join(workdir, 'index.html'), 'utf8')
      : '';
  if (!/<main\b/i.test(combinedSrc) && !/<main\b/i.test(indexHtml)) {
    issues.push('Accessibility error (axe landmark-one-main): wrap the main app content in a semantic `<main>` landmark element.');
  }
  issues.push(...collectCrossStackUiIssues(workdir, srcFiles, combinedSrc));
  issues.push(...collectCompletenessIssues(workdir, srcFiles));
  return issues;
}

/**
 * Anti-stub gate: keyword presence alone let placeholder apps through (Undo wired to alert(),
 * no-op Export/Import, single smoke tests). Require evidence that each power feature is implemented
 * and that unit/E2E suites exercise more than a render smoke test.
 */
function collectCompletenessIssues(workdir, srcFiles) {
  const issues = [];
  const read = (f) => readFileSync(join(workdir, f), 'utf8');
  const appSrc = srcFiles.filter((f) => !/\.(test|spec)\./.test(f)).map(read).join('\n');
  const unitSrc = srcFiles.filter((f) => /\.(test|spec)\./.test(f)).map(read).join('\n');
  const e2eSrc = listProjectFiles(workdir).filter((f) => f.startsWith('e2e/') && /\.ts$/.test(f)).map(read).join('\n');

  const features = [
    [/\bindexedDB\b/, 'versioned IndexedDB persistence (`indexedDB.open(...)` with an `onupgradeneeded` object store) plus the localStorage mirror'],
    [/\bBroadcastChannel\b/, 'feature-detected BroadcastChannel multi-tab sync'],
    [/\b(?:ctrlKey|metaKey)\b/, 'keyboard Undo/Redo shortcuts (Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z via `event.ctrlKey || event.metaKey`)'],
    [/['"`]z['"`]/i, 'keyboard Undo/Redo shortcuts matching the `z` key'],
    [/['"`]Escape['"`]/, 'Escape cancels inline edit'],
    [/\bnew Blob\b|\bcreateObjectURL\b/, 'JSON Export that downloads a file (`new Blob([...], { type: "application/json" })` + `URL.createObjectURL`)'],
    [/\bFileReader\b|\.text\(\)/, 'JSON Import that reads the chosen file (`await file.text()` or FileReader) and validates it before replacing todos'],
    [/data-theme/, 'theme toggle that sets/removes `data-theme="dark"` on `document.documentElement`'],
  ];
  const missing = features.filter(([re]) => !re.test(appSrc)).map(([, label]) => label);
  if (missing.length > 0) {
    issues.push(`Incomplete TodoMVC+ app (stub detected): implement these required power features in src/ (non-test code): ${[...new Set(missing)].map((m) => `\n  - ${m}`).join('')}`);
  }
  if (/\b(?:alert|confirm|prompt)\s*\(/.test(appSrc)) {
    issues.push('Placeholder UI detected: remove `alert()`/`confirm()`/`prompt()` calls from src/ and implement the real behaviour (Undo/Redo history, Export/Import, theme toggle).');
  }
  if (/(?:onClick|onclick|on:click|@click|\(click\))\s*=\s*[{"']\s*\(\)\s*=>\s*\{\s*\}/.test(appSrc)) {
    issues.push('Placeholder UI detected: a button has an empty `() => {}` click handler. Wire every toolbar button (Undo, Redo, Export, Import, theme toggle) to real behaviour.');
  }

  const unitCases = (unitSrc.match(/\b(?:it|test)\s*\(\s*['"`]/g) ?? []).length;
  if (unitCases < 5) {
    issues.push(`Unit tests too shallow (${unitCases} test case(s)): add at least 5 Vitest cases under src/ covering add/trim, toggle & toggle-all, inline edit/delete, filters + Clear Completed, Undo/Redo, and rejection of malformed / prototype-polluting JSON import.`);
  }
  const e2eCases = (e2eSrc.match(/\btest\s*\(\s*['"`]/g) ?? []).length;
  if (e2eCases < 4 || !/page\.reload\s*\(/.test(e2eSrc)) {
    issues.push(`E2E suite too shallow (${e2eCases} test(s)): e2e/todomvc.spec.ts needs at least 4 Playwright tests including CRUD (add, toggle, edit, delete), filters, reload persistence (\`await page.reload()\` after waiting for the item), Undo/Redo, axe zero violations, and the 320px reflow check.`);
  }
  return issues;
}

/** Structural checks for the Cross-stack UI Consistency contract (shared skeleton + shared QuantumBlack light tokens). */
function collectCrossStackUiIssues(workdir, srcFiles, combinedSrc) {
  const issues = [];
  const ref = 'Follow the Cross-stack UI Consistency rules.';

  const missingClasses = CROSS_STACK_UI.requiredClasses.filter(
    (cls) => !new RegExp(`(?<![\\w-])${cls}(?![\\w-])`).test(combinedSrc),
  );
  if (missingClasses.length > 0) {
    issues.push(`Cross-stack UI skeleton mismatch: the shared TodoMVC+ markup is missing class name(s) ${missingClasses.map((c) => `\`${c}\``).join(', ')}. Use the exact shared skeleton class names in src/. ${ref}`);
  }

  const cssPath = join(workdir, CROSS_STACK_UI.stylesheet);
  if (!existsSync(cssPath)) {
    issues.push(`Missing required global stylesheet \`${CROSS_STACK_UI.stylesheet}\` holding the shared QuantumBlack light tokens and all app styles. ${ref}`);
  } else {
    const css = readFileSync(cssPath, 'utf8');
    const missingTokens = Object.keys(CROSS_STACK_UI.lightTokens).filter(
      (token) => !new RegExp(`${token}\\s*:`).test(css),
    );
    if (missingTokens.length > 0) {
      issues.push(`\`${CROSS_STACK_UI.stylesheet}\` is missing shared design token(s) ${missingTokens.join(', ')} in its :root block. Copy the exact token block. ${ref}`);
    }
    if (!/color-scheme\s*:\s*light/.test(css) || !/\[data-theme=["']?dark["']?\]/.test(css)) {
      issues.push(`\`${CROSS_STACK_UI.stylesheet}\` MUST default to \`color-scheme: light\` in :root and define the dark theme only under \`:root[data-theme="dark"]\`. ${ref}`);
    }
    if (/prefers-color-scheme\s*:\s*dark/.test(css)) {
      issues.push(`\`${CROSS_STACK_UI.stylesheet}\` MUST NOT auto-switch themes with \`@media (prefers-color-scheme: dark)\`; light is the shared default and dark is opt-in via \`data-theme="dark"\`. ${ref}`);
    }
    const angularJsonPath = join(workdir, 'angular.json');
    const importedFromAngular = existsSync(angularJsonPath) && readFileSync(angularJsonPath, 'utf8').includes(CROSS_STACK_UI.stylesheet);
    if (!importedFromAngular && !/['"]\.{1,2}\/(?:[\w-]+\/)*styles\.css['"]/.test(combinedSrc)) {
      issues.push(`\`${CROSS_STACK_UI.stylesheet}\` is never loaded: import it from the entry file (e.g. \`import './styles.css';\` in src/main.ts) or list it in angular.json \`styles\`. ${ref}`);
    }
  }

  const pkgPath = join(workdir, 'package.json');
  if (existsSync(pkgPath)) {
    let pkg = {};
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
      // Malformed package.json is reported by the npm install step.
    }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const tailwind = Object.keys(deps).filter((name) => name === 'tailwindcss' || name.startsWith('@tailwindcss/'));
    if (tailwind.length > 0) {
      issues.push(`Cross-stack UI uses plain CSS only: remove ${tailwind.join(', ')} from package.json and style through \`${CROSS_STACK_UI.stylesheet}\`. ${ref}`);
    }
  }

  for (const file of srcFiles) {
    const content = readFileSync(join(workdir, file), 'utf8');
    if (/\.(vue|svelte)$/.test(file) && /<style\b/i.test(content)) {
      issues.push(`Component-scoped <style> block in ${file}: move these rules into \`${CROSS_STACK_UI.stylesheet}\` so every stack shares one stylesheet. ${ref}`);
    }
    if (/\.ts$/.test(file) && content.includes('@Component') && /\b(?:styles|styleUrls?)\s*:/.test(content)) {
      issues.push(`Angular component styles in ${file}: remove \`styles\`/\`styleUrl(s)\` and put the rules in \`${CROSS_STACK_UI.stylesheet}\` so every stack shares one stylesheet. ${ref}`);
    }
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
  const checkEnv = { ...process.env, DEBUG_PRINT_LIMIT: '800', CI: process.env.CI || 'true', NG_CLI_ANALYTICS: 'false' };
  try {
    execSync(
      'npm install --no-audit --no-fund --loglevel=error && npm run typecheck --if-present && npm run lint --if-present && npm test --if-present && npm run build && npm audit --omit=dev --audit-level=high',
      { cwd: workdir, env: checkEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000, maxBuffer: 10 * 1024 * 1024 },
    );
    if (existsSync(join(workdir, 'playwright.config.ts')) && existsSync(join(workdir, 'e2e/todomvc.spec.ts'))) {
      execSync('npx playwright test --list && npx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler --skipLibCheck $(npx tsc -v | grep -qE "Version [6-9]" && echo "--ignoreConfig" || true) e2e/*.ts', {
        cwd: workdir,
        env: checkEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        maxBuffer: 5 * 1024 * 1024,
      });
      if (issues.length === 0) {
        if (!pwInstalled) {
          console.log('[mogra-oneshot] Installing Playwright Chromium for pre-PR E2E/a11y verification...');
          execSync('npx playwright install --with-deps chromium', {
            cwd: workdir,
            env: checkEnv,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 180_000,
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
  const priority = ['package.json', 'angular.json', 'vitest.config.ts', 'vitest.config.mts', 'vite.config.ts', 'playwright.config.ts', 'tsconfig.json'];
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
      '3. Accessibility, QuantumBlack Design System Aesthetic & Ultra-Modern CSS: the shared QuantumBlack light-theme tokens defined in the Cross-stack UI Consistency section below (Inter + JetBrains Mono typography, light Mist default surface with an opt-in dark obsidian theme, 1px hairline borders, teal/sky semantic accents, tabular-nums counters), responsive layout with ZERO horizontal overflow at 320px width, >=4.5:1 contrast (secondary text uses var(--qb-text-secondary)/var(--qb-text-muted), NEVER slate-400/gray-400 equivalents on light surfaces), visible :focus-visible rings, aria-live polite announcements, logical focus restoration, prefers-reduced-motion, and forced-colors support. NEVER put aria-label on <label>, <div>, or <span> without an ARIA role (use <button aria-label="..."> or <span class="sr-only"> inside <label>).',
      '',
      crossStackUiPromptSection(),
      '',
      'REQUIRED files checklist:',
      '- package.json (scripts: dev, typecheck: "tsc --noEmit", lint: "tsc --noEmit", test: "vitest run", build: "tsc --noEmit && vite build", test:e2e: "playwright test")',
      '- tsconfig.json (MUST have "noEmit": true, "module": "ES2022", "moduleResolution": "bundler", "skipLibCheck": true, and NEVER set "allowImportingTsExtensions", "downlevelIteration", or "baseUrl")',
      '- vite.config.ts (with base: process.env.VITE_BASE_PATH || "/")',
      '- vitest.config.ts (using vitest/config with test.environment="jsdom", include:["src/**/*.{test,spec}.{ts,tsx}"], exclude:["e2e/**","node_modules/**","dist/**"]; for solid-ts-vite MUST include `plugins: [solid()]`, `resolve: { conditions: ["development", "browser"] }`, and `test.deps`/`server.deps.inline: [/solid-js/]` so SolidJS runs in client mode!)',
      '- playwright.config.ts (testDir:"./e2e", timeout: 30000, webServer: { command: "npm run dev -- --host 127.0.0.1 --port 4173 --strictPort" for Vite OR "npx ng serve --host 127.0.0.1 --port 4173" for Angular (NEVER pass --strictPort to ng serve!), url: "http://127.0.0.1:4173", reuseExistingServer: !process.env["CI"], timeout: 60000 }, use: { baseURL: "http://127.0.0.1:4173" })',
      '- index.html',
      '- Modular src/* source files & clean modern CSS (prefer native CSS without postcss.config.js unless all plugins are in devDependencies; feature-detect `window.matchMedia?.(...)` and `typeof BroadcastChannel !== "undefined"` so Vitest jsdom never throws)',
      '- Real unit tests under src/ (e.g. src/test/setup.ts with `afterEach(cleanup)` + `window.matchMedia` mock, and src/App.test.tsx testing CRUD, filters, undo/redo, and safe JSON import; ALWAYS scope item presence/removal checks inside the list via `within(screen.getByRole(\'list\'))` and NEVER assert on or `waitForElementToBeRemoved` the `role="status"` live announcer)',
      '- Comprehensive e2e/todomvc.spec.ts (CRUD, reload persistence — ALWAYS assert `toBeVisible()` and `await page.waitForTimeout(150)` BEFORE calling `await page.reload()`, zero horizontal overflow at 320px/768px/1280px, and @axe-core/playwright zero violations; use Playwright `page.getByLabel(...)` — NEVER `getByLabelText` — pass `{ exact: true }` to EVERY `getByText(..., { exact: true })` AND `getByRole(..., { name: ..., exact: true })`, and scope checkbox assertions by row/listitem when toggling changes its aria-label)',
      'Ensure EVERY package imported in any file (vitest, jsdom, @testing-library/react, @playwright/test, @axe-core/playwright, etc.) is declared in package.json with compatible peer versions (for angular-ts: NEVER use `@angular/*` 19.x and NEVER add `@angular-eslint/*` or `@testing-library/angular` — use ONLY dependencies `"@angular/animations": "^22.0.0"`, `"@angular/core": "^22.0.0"`, `"@angular/common": "^22.0.0"`, `"@angular/forms": "^22.0.0"`, `"@angular/platform-browser": "^22.0.0"`, `"@angular/compiler": "^22.0.0"`, `"@angular/cdk": "^22.0.0"`, `"rxjs": "^7.8.0"`, `"tslib": "^2.6.0"`, `"zone.js": "~0.16.0"` and devDependencies `"@angular-devkit/build-angular": "^22.0.0"`, `"@angular/cli": "^22.0.0"`, `"@angular/compiler-cli": "^22.0.0"`, `"typescript": "~6.0.0"`, `"vitest": "^2.1.0"`, `"jsdom": "^26.0.0"`, `"@playwright/test": "^1.50.0"`, `"@axe-core/playwright": "^4.10.0"`; ALWAYS include `tsconfig.app.json` (`{ "extends": "./tsconfig.json", "compilerOptions": { "noEmit": false, "types": [] }, "files": ["src/main.ts"] }`) + valid root `angular.json` with `"version": 1` and `"projects": { "app": { "projectType": "application", "root": "", "sourceRoot": "src", "architect": { "build": { "builder": "@angular-devkit/build-angular:application", "options": { "outputPath": "dist", "index": "src/index.html", "browser": "src/main.ts", "tsConfig": "tsconfig.app.json", "styles": ["src/styles.css"] } }, "serve": { "builder": "@angular-devkit/build-angular:dev-server", "options": { "buildTarget": "app:build" } } } } }` — NEVER switch builders to `@angular/build:*`; bootstrap strictly via standalone `bootstrapApplication(AppComponent)` from `@angular/platform-browser` in `src/main.ts` importing `zone.js` cleanly (NEVER use `AppModule`/`NgModule`/`@angular/platform-browser-dynamic`); put all TodoMVC+ CRUD/filter/undo/persistence logic in a pure TypeScript class `src/app/todo.store.ts` with ZERO `effect()` calls in constructors, NEVER import `TestBed` or `@testing-library/angular` in Vitest `*.spec.ts` — unit test `src/app/todo.store.ts` directly and test rendered UI in `e2e/todomvc.spec.ts` — wrap the app UI inside `<main>` landmark, and import `CommonModule` strictly from `@angular/common`), and `npm audit --omit=dev --audit-level=high` passes cleanly (use zero-dependency runtime TypeScript validation instead of vulnerable `zod <4.6.7`).',
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
      hints.push('CRITICAL npm ERESOLVE peer conflict: If this is Angular, REPLACE `dependencies` and `devDependencies` completely with ONLY: dependencies={"@angular/animations":"^22.0.0","@angular/cdk":"^22.0.0","@angular/common":"^22.0.0","@angular/compiler":"^22.0.0","@angular/core":"^22.0.0","@angular/forms":"^22.0.0","@angular/platform-browser":"^22.0.0","rxjs":"^7.8.0","tslib":"^2.6.0","zone.js":"~0.16.0"}, devDependencies={"@angular-devkit/build-angular":"^22.0.0","@angular/cli":"^22.0.0","@angular/compiler-cli":"^22.0.0","@axe-core/playwright":"^4.10.0","@playwright/test":"^1.50.0","jsdom":"^26.0.0","typescript":"~6.0.0","vitest":"^2.1.0"}. Remove ALL 19.x packages and remove `@angular-eslint/*` / `@testing-library/angular`.');
    }
    if (check.output.includes('NG0203')) {
      hints.push('CRITICAL Angular NG0203: Do NOT call `new AppComponent()` directly in Vitest when the constructor uses `effect()`! Either test via `TestBed.runInInjectionContext(() => new AppComponent())` / pure store class without DI, or persist changes explicitly inside store methods (add/toggle/delete/undo) instead of `effect()` in the constructor.');
    }
    if (check.output.includes('initTestEnvironment')) {
      hints.push('CRITICAL Angular TestBed error: In Vitest, either initialize `getTestBed().initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting())` (with `"zone.js"`, `"zone.js/testing"`, and `"@angular/compiler"` imported) OR remove `TestBed` completely and instantiate the store/service directly (`new TodoService()`, without `effect()`/`inject()`).');
    }
    if (check.output.includes('npm audit')) {
      hints.push('CRITICAL npm audit high vulnerability: Upgrade ALL `@angular/*` packages (`@angular/core`, `@angular/common`, `@angular/forms`, `@angular/platform-browser`, `@angular/compiler`, `@angular/cli`, `@angular/build`, `@angular/cdk`) to `^22.0.0`, and remove vulnerable runtime deps so `npm audit --omit=dev --audit-level=high` passes.');
    }
    if (check.output.includes('outside a workspace')) {
      hints.push('CRITICAL Angular workspace error: Create valid `angular.json` at project root with `"version": 1, "projects": { "app": { "projectType": "application", "root": "", "sourceRoot": "src", "architect": { "build": { "builder": "@angular-devkit/build-angular:application", "options": { "outputPath": "dist", "index": "src/index.html", "browser": "src/main.ts", "tsConfig": "tsconfig.app.json", "styles": ["src/styles.css"] } }, "serve": { "builder": "@angular-devkit/build-angular:dev-server", "options": { "buildTarget": "app:build" } } } } }` and ensure `src/index.html`, `src/main.ts`, and `tsconfig.app.json` exist.');
    }
    if (check.output.includes('TS5096')) {
      hints.push('CRITICAL TS5096: Remove `"allowImportingTsExtensions"` from `tsconfig.json` and `tsconfig.app.json`!');
    }
    if (check.output.includes('TS5101') || check.output.includes('TS5090')) {
      hints.push('CRITICAL TS5101/TS5090 (TypeScript 6): Remove `"baseUrl"` and `"paths"` from `tsconfig.json` and `tsconfig.app.json` completely; use relative imports `./...`.');
    }
    if (check.output.includes('@angular/animations')) {
      hints.push('CRITICAL missing package: Add `"@angular/animations": "^22.0.0"` to `dependencies` in `package.json`.');
    }
    if (check.output.includes('strictPort')) {
      hints.push('CRITICAL Playwright WebServer error: Angular `ng serve` does NOT accept `--strictPort`. Remove `--strictPort` from `playwright.config.ts` (`webServer.command: "npx ng serve --host 127.0.0.1 --port 4173"`).');
    }
    if (check.output.includes('@angular/build:')) {
      hints.push('CRITICAL Angular builder error: Keep `"@angular-devkit/build-angular:application"` and `"@angular-devkit/build-angular:dev-server"` in `angular.json` (do NOT use `@angular/build:*`).');
    }
    if (check.output.includes('NG6008') || check.output.includes('platform-browser-dynamic')) {
      hints.push('CRITICAL Angular bootstrap error: Delete `AppModule` / `app.module.ts` and bootstrap standalone `AppComponent` directly in `src/main.ts` using `bootstrapApplication(AppComponent)` from `@angular/platform-browser` (with `import "zone.js";`).');
    }
    if (check.output.includes('downlevelIteration') || check.output.includes('moduleResolution=node10')) {
      hints.push('CRITICAL TS6 tsconfig error: Remove `"downlevelIteration"` and set `"module": "ES2022", "moduleResolution": "bundler", "skipLibCheck": true` in `tsconfig.json`.');
    }
    if (check.output.includes('Client-only API called on the server side')) {
      hints.push('CRITICAL SolidJS Vitest SSR error: SolidJS is resolving server bundle inside Vitest! In `vitest.config.ts`, MUST include `plugins: [solid()]` (from `vite-plugin-solid`), `resolve: { conditions: ["development", "browser"] }`, and `test: { environment: "jsdom", server: { deps: { inline: [/solid-js/] } }, exclude: ["e2e/**"] }`, or test a pure signal store in `src/store.test.ts` without DOM `render()`.');
    }
    if (check.output.includes('Cross-stack UI') || check.output.includes(CROSS_STACK_UI.stylesheet)) {
      hints.push(`CRITICAL Cross-stack UI contract violation. Follow these rules exactly:\n${crossStackUiPromptSection()}`);
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
    if (updated.includes('package.json')) {
      rmSync(join(workdir, 'package-lock.json'), { force: true });
      rmSync(join(workdir, 'node_modules'), { recursive: true, force: true });
    }
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
