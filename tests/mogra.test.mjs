import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { SUPPORTED_STACKS } from '../src/conventions.mjs';
import { formatEvidenceLedger } from '../src/evidence.mjs';
import { collectStaticIssues, CROSS_STACK_UI, writeGeneratedFiles, writeRunMetrics } from '../src/free-tier-builder.mjs';
import { resolveAgentPlan } from '../src/harness-runner.mjs';
import { buildIssueUpdate, resolveIssueStack } from '../src/issue-router.mjs';
import { generateShowcasePortal } from '../src/pages-portal.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('loads convention-first defaults with HITL disabled, security gates on, and 5 stacks', () => {
  const cfg = loadConfig({ controlPlaneDir: ROOT });
  assert.equal(cfg.human_in_the_loop.enabled, false);
  assert.equal(cfg.runtime.harness, 'gemini-cli');
  assert.equal(cfg.outcome.stack, 'react19-ts-vite');
  assert.equal(cfg.gates.protected_paths_enforced, true);
  assert.equal(cfg.gates.secret_scan_required, true);
  assert.deepEqual(
    Object.keys(SUPPORTED_STACKS),
    ['react19-ts-vite', 'vue3-ts-vite', 'svelte5-ts-vite', 'angular-ts', 'solid-ts-vite'],
  );
});

test('spoke repo overrides only requested fields while keeping conventions', () => {
  const spoke = mkdtempSync(join(tmpdir(), 'mogra-spoke-'));
  try {
    writeFileSync(
      join(spoke, '.mogra.yaml'),
      [
        'runtime:',
        '  harness: codex',
        '  model: gpt-5-codex',
        'agents:',
        '  qa-reflow-verifier:',
        '    harness: claude-code',
        '    model: claude-sonnet-4-5',
      ].join('\n'),
    );
    const cfg = loadConfig({ controlPlaneDir: ROOT, spokeDir: spoke });
    assert.equal(cfg.runtime.harness, 'codex');
    assert.equal(cfg.outcome.stack, 'react19-ts-vite');
    const verifier = resolveAgentPlan({ agentName: 'qa-reflow-verifier', config: cfg, controlPlaneDir: ROOT });
    assert.equal(verifier.harness, 'claude-code');
    assert.equal(verifier.model, 'claude-sonnet-4-5');
    assert.ok(verifier.skills.includes('playwright-a11y-reflow-gate'));
  } finally {
    rmSync(spoke, { recursive: true, force: true });
  }
});

test('rejects invalid stack names during config validation', () => {
  const spoke = mkdtempSync(join(tmpdir(), 'mogra-bad-'));
  try {
    writeFileSync(join(spoke, '.mogra.yaml'), 'outcome:\n  stack: unknown-stack\n');
    assert.throws(() => loadConfig({ controlPlaneDir: ROOT, spokeDir: spoke }), /Unsupported outcome\.stack/);
  } finally {
    rmSync(spoke, { recursive: true, force: true });
  }
});

test('issue router resolves all 5 TodoMVC+ stacks and updates issue metadata idempotently', () => {
  const cfg = loadConfig({ controlPlaneDir: ROOT });
  for (const stackId of Object.keys(SUPPORTED_STACKS)) {
    const resolved = resolveIssueStack({
      body: `### TodoMVC+ Stack\n\n${stackId}\n\n### Goal\nBuild TodoMVC+`,
      defaultStack: cfg.outcome.stack,
    });
    assert.equal(resolved, stackId);
  }

  const first = buildIssueUpdate({
    title: 'Build TodoMVC+',
    body: '### TodoMVC+ Stack\n\nangular-ts',
    labels: ['enhancement'],
    config: cfg,
  });
  assert.equal(first.title, 'Build TodoMVC+ [angular-ts]');
  assert.deepEqual(first.labels.sort(), ['enhancement', 'mogra:active', 'stack:angular-ts']);

  const second = buildIssueUpdate({
    title: first.title,
    body: first.body,
    labels: first.labels,
    config: cfg,
  });
  assert.equal(second.title, first.title);
  assert.equal(second.body, first.body);
});

test('evidence ledger preserves factual pass/fail/not-run states', () => {
  const md = formatEvidenceLedger({
    stack: 'react19-ts-vite',
    harness: 'antigravity',
    model: 'gemini-3.1-flash-lite',
    checks: [
      { name: '320px Reflow', passed: true, command: 'npx playwright test', detail: 'scrollWidth 320 <= 320' },
      { name: 'SBOM', passed: null, command: '', detail: 'Pending' },
    ],
  });
  assert.match(md, /\| 320px Reflow \| PASS \|/);
  assert.match(md, /\| SBOM \| NOT RUN \|/);
});

test('free-tier builder blocks path traversal and protected workflow paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mogra-gen-'));
  try {
    const written = writeGeneratedFiles(dir, { 'src/App.tsx': 'export default function App() {}' });
    assert.deepEqual(written, ['src/App.tsx']);
    assert.throws(() => writeGeneratedFiles(dir, { '../evil.js': 'bad' }), /path traversal/);
    assert.throws(() => writeGeneratedFiles(dir, { '.github/workflows/ci.yml': 'bad' }), /forbidden generated path/);

    const metrics = writeRunMetrics(dir, [
      { phase: 'initial-build', model: 'gemini-3-flash-preview', promptTokenCount: 4000, candidatesTokenCount: 6500, thoughtsTokenCount: 200, totalTokenCount: 10700, elapsedMs: 12000 },
      { phase: 'repair-1', model: 'gemini-3.1-flash-lite', promptTokenCount: 1500, candidatesTokenCount: 800, thoughtsTokenCount: 0, totalTokenCount: 2300, elapsedMs: 3200 },
    ]);
    assert.equal(metrics.totals.calls, 2);
    assert.equal(metrics.totals.totalTokens, 13000);
    assert.ok(existsSync(join(dir, '.mogra-metrics.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('showcase portal renders QuantumBlack UI, GitHub timeline, measured & pre-telemetry token economics, and degrades offline', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mogra-portal-'));
  try {
    const stacksDir = join(tmp, 'stacks');
    mkdirSync(join(stacksDir, 'react19-ts-vite'), { recursive: true });
    writeFileSync(join(stacksDir, 'react19-ts-vite', 'package.json'), '{"name":"react"}');
    mkdirSync(join(stacksDir, 'vue3-ts-vite'), { recursive: true });
    writeFileSync(join(stacksDir, 'vue3-ts-vite', 'package.json'), '{"name":"vue"}');
    writeFileSync(
      join(stacksDir, 'vue3-ts-vite', '.mogra-metrics.json'),
      JSON.stringify({
        schemaVersion: 1,
        provider: 'google-ai-studio-free-tier',
        costUsd: 0,
        totals: { calls: 1, promptTokens: 5120, candidatesTokens: 7400, thoughtsTokens: 100, totalTokens: 12620, elapsedMs: 14500 },
        calls: [{ phase: 'initial-build', model: 'gemini-3-flash-preview' }],
      }),
    );

    const mockFetch = async (url) => {
      if (url.includes('/issues?')) {
        return {
          ok: true,
          json: async () => [
            { number: 1, title: 'Build <script>alert(1)</script> [react19-ts-vite]', state: 'closed', created_at: '2026-11-26T00:00:00Z', closed_at: '2026-11-26T00:04:00Z', html_url: 'https://github.com/o/r/issues/1', labels: [{ name: 'stack:react19-ts-vite' }], body: '' },
            { number: 2, title: 'Build Vue [vue3-ts-vite]', state: 'closed', created_at: '2026-11-27T01:00:00Z', closed_at: '2026-11-27T01:03:00Z', html_url: 'https://github.com/o/r/issues/2', labels: [{ name: 'stack:vue3-ts-vite' }], body: '' },
          ],
        };
      }
      if (url.includes('/pulls?')) {
        return { ok: true, json: async () => [{ number: 19, title: 'feat: #1', state: 'closed', merged_at: '2026-11-26T00:04:00Z', html_url: 'https://github.com/o/r/pull/19', head: { ref: 'mogra/issue-1-react19-ts-vite' } }] };
      }
      if (url.includes('/runs?')) {
        return { ok: true, json: async () => ({ workflow_runs: [{ id: 100, run_number: 18, display_title: 'Issue #1', event: 'issues', status: 'completed', conclusion: 'success', run_started_at: '2026-11-26T00:00:00Z', updated_at: '2026-11-26T00:03:45Z', html_url: 'https://github.com/o/r/actions/runs/100' }] }) };
      }
      return { ok: true, json: async () => ({ jobs: [{ name: 'intake', conclusion: 'success', started_at: '2026-11-26T00:00:00Z', completed_at: '2026-11-26T00:00:09Z' }] }) };
    };

    const outFile = join(tmp, 'pages-dist', 'index.html');
    const result = await generateShowcasePortal({
      repo: 'rajeevkannav/TodoMVC-Plus',
      rootBase: '/TodoMVC-Plus/',
      stacksDir,
      builtStacks: ['react19-ts-vite', 'vue3-ts-vite'],
      controlPlaneDir: ROOT,
      outFile,
      fetchImpl: mockFetch,
    });

    const html = readFileSync(outFile, 'utf8');
    assert.equal(result.telemetry.apiLive, true);
    assert.match(html, /href="\/TodoMVC-Plus\/react19-ts-vite\/"/);
    assert.match(html, /12,620/);
    assert.match(html, /Pre-telemetry run/);
    assert.match(html, /QuantumBlack Design System/);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.ok(result.skills.length >= 7);

    const offline = await generateShowcasePortal({
      repo: 'rajeevkannav/TodoMVC-Plus',
      rootBase: '/TodoMVC-Plus/',
      stacksDir,
      builtStacks: ['react19-ts-vite'],
      controlPlaneDir: ROOT,
      outFile: join(tmp, 'offline.html'),
      fetchImpl: async () => { throw new Error('network disabled'); },
    });
    assert.equal(offline.telemetry.apiLive, false);
    assert.match(offline.html, /LOCAL REPOSITORY SNAPSHOT/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('react19-ts-vite CSS-only QuantumBlack light theme keeps Tailwind v4 and safe light tokens', () => {
  const css = readFileSync(join(ROOT, 'src', 'themes', 'react19-qb-light.css'), 'utf8');
  assert.match(css, /@import "tailwindcss";/);
  assert.match(css, /color-scheme:\s*light;/);
  assert.doesNotMatch(css, /prefers-color-scheme:\s*dark/);
  assert.match(css, /overflow-wrap:\s*anywhere;/);
});

function writeCompliantStack(dir) {
  const files = {
    'package.json': JSON.stringify({ name: 'stack', devDependencies: { vite: '^7.0.0', vitest: '^3.0.0' } }),
    'vitest.config.ts': 'export default { test: { environment: "jsdom", exclude: ["e2e/**"] } };',
    'vite.config.ts': 'export default { base: process.env.VITE_BASE_PATH || "/" };',
    'playwright.config.ts': 'export default { webServer: { command: "npm run dev -- --host 127.0.0.1 --port 4173", url: "http://127.0.0.1:4173" } };',
    'e2e/todomvc.spec.ts': 'import AxeBuilder from "@axe-core/playwright";\ntest("a11y", async ({ page }) => { await page.setViewportSize({ width: 320, height: 640 }); await new AxeBuilder({ page }).analyze(); });',
    'src/main.ts': "import './styles.css';\nimport { mount } from './app';",
    'src/app.ts': [
      'const store = { undo() {}, filter: "active" as "all" | "active" | "completed" }; localStorage.getItem("todos");',
      `export const markup = \`<main class="todoapp">${CROSS_STACK_UI.requiredClasses.map((c) => `<div class="${c}"></div>`).join('')}</main>\`;`,
    ].join('\n'),
    'src/styles.css': [
      `:root {\n  color-scheme: light;\n${Object.entries(CROSS_STACK_UI.lightTokens).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`,
      `:root[data-theme="dark"] {\n  color-scheme: dark;\n${Object.entries(CROSS_STACK_UI.darkTokens).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`,
      '.todoapp { max-width: var(--qb-content-width); }',
    ].join('\n'),
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

test('cross-stack UI contract: compliant stack passes static checks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mogra-ui-'));
  try {
    writeCompliantStack(dir);
    assert.deepEqual(collectStaticIssues(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cross-stack UI contract: flags skeleton, token, theme, Tailwind, and scoped-style drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mogra-ui-'));
  const issuesAfter = (mutate) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeCompliantStack(dir);
    mutate();
    return collectStaticIssues(dir).join('\n');
  };
  try {
    const appPath = join(dir, 'src/app.ts');
    assert.match(
      issuesAfter(() => writeFileSync(appPath, readFileSync(appPath, 'utf8').replace(/todo-filters/g, 'filters').replace(/"todo-list"/, '"todos"'))),
      /missing class name\(s\) `todo-list`, `todo-filters`/,
    );

    const cssPath = join(dir, 'src/styles.css');
    assert.match(
      issuesAfter(() => writeFileSync(cssPath, readFileSync(cssPath, 'utf8').replace(/--qb-accent:/g, '--brand:'))),
      /missing shared design token\(s\) --qb-accent\b/,
    );
    assert.match(
      issuesAfter(() => writeFileSync(cssPath, `${readFileSync(cssPath, 'utf8')}\n@media (prefers-color-scheme: dark) { :root { --qb-canvas: #000; } }`)),
      /MUST NOT auto-switch themes/,
    );
    assert.match(issuesAfter(() => rmSync(cssPath)), /Missing required global stylesheet `src\/styles\.css`/);
    assert.match(issuesAfter(() => writeFileSync(join(dir, 'src/main.ts'), "import { mount } from './app';")), /is never loaded/);
    assert.match(
      issuesAfter(() => writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { tailwindcss: '^4.0.0', '@tailwindcss/vite': '^4.0.0' } }))),
      /remove tailwindcss, @tailwindcss\/vite/,
    );
    assert.match(
      issuesAfter(() => writeFileSync(join(dir, 'src/Item.svelte'), '<li class="todo-item"></li>\n<style>li { color: red; }</style>')),
      /Component-scoped <style> block in src\/Item\.svelte/,
    );
    assert.match(
      issuesAfter(() => writeFileSync(join(dir, 'src/app.component.ts'), "@Component({ selector: 'app-root', styleUrl: './app.component.css' }) export class AppComponent {}")),
      /Angular component styles in src\/app\.component\.ts/,
    );
    // Angular may load the stylesheet through angular.json instead of an entry import.
    assert.doesNotMatch(
      issuesAfter(() => {
        writeFileSync(join(dir, 'src/main.ts'), "import { mount } from './app';");
        writeFileSync(join(dir, 'angular.json'), JSON.stringify({ projects: { app: { architect: { build: { options: { styles: ['src/styles.css'] } } } } } }));
      }),
      /is never loaded/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cross-stack UI light tokens match the react19-ts-vite QuantumBlack light theme', () => {
  const css = readFileSync(join(ROOT, 'src', 'themes', 'react19-qb-light.css'), 'utf8');
  const pairs = {
    '--qb-canvas': '--qb-canvas',
    '--qb-surface': '--qb-surface',
    '--qb-elevated': '--qb-elevated',
    '--qb-text': '--qb-text',
    '--qb-text-secondary': '--qb-text-secondary',
    '--qb-text-muted': '--qb-text-muted',
    '--qb-teal': '--qb-accent',
    '--qb-teal-hover': '--qb-accent-hover',
    '--qb-sky': '--qb-focus',
  };
  for (const [react19Token, sharedToken] of Object.entries(pairs)) {
    const value = css.match(new RegExp(`${react19Token}:\\s*([^;]+);`))?.[1];
    assert.equal(CROSS_STACK_UI.lightTokens[sharedToken], value, `${sharedToken} should equal react19 ${react19Token}`);
  }
});
