import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { SUPPORTED_STACKS } from '../src/conventions.mjs';
import { formatEvidenceLedger } from '../src/evidence.mjs';
import { writeGeneratedFiles, writeRunMetrics } from '../src/free-tier-builder.mjs';
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
