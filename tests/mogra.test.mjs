import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { SUPPORTED_STACKS } from '../src/conventions.mjs';
import { formatEvidenceLedger } from '../src/evidence.mjs';
import { resolveAgentPlan } from '../src/harness-runner.mjs';
import { buildIssueUpdate, resolveIssueStack } from '../src/issue-router.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('loads convention-first defaults with HITL disabled, security gates on, and 5 stacks', () => {
  const cfg = loadConfig({ controlPlaneDir: ROOT });
  assert.equal(cfg.human_in_the_loop.enabled, false);
  assert.equal(cfg.runtime.harness, 'antigravity');
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
