import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import { countMinitestRuns, mergeGemfile, missingTestChanges, parseGenerators, summarizeFailure, withoutLockfiles } from '../src/incremental-builder.mjs';
import { generateShowcasePortal } from '../src/pages-portal.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('loads convention-first defaults with HITL disabled, security gates on, and 8 supported stacks', () => {
  const cfg = loadConfig({ controlPlaneDir: ROOT });
  assert.equal(cfg.human_in_the_loop.enabled, false);
  assert.equal(cfg.runtime.harness, 'gemini-cli');
  assert.equal(cfg.outcome.stack, 'react19-ts-vite');
  assert.equal(cfg.outcome.mode, 'greenfield-stack');
  assert.equal(cfg.deployment.target, 'github-pages');
  assert.equal(cfg.gates.protected_paths_enforced, true);
  assert.equal(cfg.gates.secret_scan_required, true);
  assert.deepEqual(
    Object.keys(SUPPORTED_STACKS),
    [
      'react19-ts-vite',
      'vue3-ts-vite',
      'svelte5-ts-vite',
      'angular-ts',
      'solid-ts-vite',
      'rails8-pg-hotwire',
      'android-hotwire-native',
      'ios-hotwire-native',
    ],
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

test('issue router resolves all TodoMVC+ stacks and updates issue metadata idempotently', () => {
  const cfg = loadConfig({ controlPlaneDir: ROOT });
  const frontendStacks = ['react19-ts-vite', 'vue3-ts-vite', 'svelte5-ts-vite', 'angular-ts', 'solid-ts-vite'];
  for (const stackId of frontendStacks) {
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

test('supports Rails 8 + Render + Hotwire Native mobile incremental-feature spoke configuration', () => {
  const spoke = mkdtempSync(join(tmpdir(), 'mogra-jumpstart-'));
  try {
    writeFileSync(
      join(spoke, '.mogra.yaml'),
      [
        'version: 1',
        'outcome:',
        '  blueprint: jumpstart-pro-plus',
        '  mode: incremental-feature',
        '  stack: rails8-pg-hotwire',
        '  capabilities:',
        '    - rails-multi-tenant-security',
        '    - quantumblack-rails-ui',
        '    - render-free-tier-ops',
        'deployment:',
        '  target: render',
        '  render:',
        '    region: oregon',
        '    health_path: /up',
      ].join('\n'),
    );
    const cfg = loadConfig({ controlPlaneDir: ROOT, spokeDir: spoke });
    assert.equal(cfg.outcome.blueprint, 'jumpstart-pro-plus');
    assert.equal(cfg.outcome.mode, 'incremental-feature');
    assert.equal(cfg.outcome.stack, 'rails8-pg-hotwire');
    assert.equal(cfg.deployment.target, 'render');
    assert.equal(cfg.deployment.render.region, 'oregon');
    assert.deepEqual(cfg.outcome.capabilities, [
      'rails-multi-tenant-security',
      'quantumblack-rails-ui',
      'render-free-tier-ops',
    ]);

    const railsPlan = resolveAgentPlan({ config: cfg, controlPlaneDir: ROOT });
    assert.equal(railsPlan.agent, 'rails-fullstack-builder');
    assert.equal(railsPlan.stackProfile.layout, 'repo-root');
    assert.equal(railsPlan.stackProfile.verifyProfile, 'rails-pg');
    assert.ok(railsPlan.skills.includes('rails-multi-tenant-security'));
    assert.ok(railsPlan.skillPaths.some((p) => p.endsWith('render-free-tier-ops/SKILL.md')));

    const androidIssue = buildIssueUpdate({
      title: 'feat(android): scaffold Hotwire Native app',
      body: 'Build Android client',
      labels: ['enhancement'],
      config: cfg,
    });
    assert.equal(androidIssue.stack, 'android-hotwire-native');
    assert.equal(androidIssue.title, 'feat(android): scaffold Hotwire Native app');
    assert.equal(androidIssue.stackProfile.subpath, 'clients/android');
    assert.equal(androidIssue.deliveryMode, 'incremental-feature');
    assert.equal(androidIssue.deployTarget, 'render');
  } finally {
    rmSync(spoke, { recursive: true, force: true });
  }
});

test('incremental builder rejects empty test runs and model-written lockfiles', () => {
  assert.equal(countMinitestRuns('Finished in 0.1s.\n3 runs, 7 assertions, 0 failures, 0 errors, 0 skips'), 3);
  assert.equal(countMinitestRuns('1 run, 1 assertion, 0 failures'), 1);
  assert.equal(countMinitestRuns('0 runs, 0 assertions, 0 failures'), 0);
  assert.equal(countMinitestRuns('Usage:\n  rails new APP_PATH [options]'), 0);

  const kept = withoutLockfiles({
    Gemfile: 'source "https://rubygems.org"',
    'Gemfile.lock': 'GEM',
    'yarn.lock': '#',
    'clients/android/package-lock.json': '{}',
    'app/models/user.rb': 'class User; end',
    'db/schema.rb': 'ActiveRecord::Schema',
    '.bundle/config': 'BUNDLE_FROZEN: "false"',
    'db/migrate/20250101000000_create_solid_tables.rb': 'class CreateSolidTables',
    'db/migrate/20260101000000_create_accounts.rb': 'class CreateAccounts',
  });
  assert.deepEqual(Object.keys(kept).sort(), [
    'Gemfile',
    'app/models/user.rb',
    'db/migrate/20260101000000_create_accounts.rb',
  ]);
});

test('failure summaries keep the error message and drop gem backtraces', () => {
  const frames = Array.from({ length: 400 }, (_, i) => `\tfrom /opt/ruby/lib/ruby/gems/3.4.0/gems/minitest-6.1.0/lib/minitest.rb:${i}:in 'x'`);
  const raw = ["test/foo_test.rb:2:in 'require': cannot load such file -- minitest/mock (LoadError)", ...frames, 'Command failed: bundle exec rails test'].join('\n');
  const out = summarizeFailure(raw);
  assert.match(out, /cannot load such file -- minitest\/mock/);
  assert.match(out, /Command failed: bundle exec rails test/);
  assert.ok(out.split('\n').filter((l) => l.includes('/gems/')).length <= 3);
  const long = summarizeFailure(`HEAD-ERROR\n${'x'.repeat(20000)}\nTAIL`, 1000);
  assert.ok(long.length < 1100);
  assert.match(long, /^HEAD-ERROR/);
  assert.match(long, /TAIL$/);
});

test('generated scripts are written executable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mogra-exec-'));
  try {
    writeGeneratedFiles(dir, {
      'bin/render-build.sh': '#!/usr/bin/env bash\nset -o errexit\n',
      'app/models/user.rb': 'class User; end\n',
    });
    assert.equal(statSync(join(dir, 'bin/render-build.sh')).mode & 0o111, 0o111);
    assert.equal(statSync(join(dir, 'app/models/user.rb')).mode & 0o111, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supports the Railway + Neon deploy target with its host skill and no Render skill', () => {
  const spoke = mkdtempSync(join(tmpdir(), 'mogra-railway-'));
  try {
    writeFileSync(
      join(spoke, '.mogra.yaml'),
      [
        'version: 1',
        'outcome:',
        '  mode: incremental-feature',
        '  stack: rails8-pg-hotwire',
        '  capabilities:',
        '    - railway-neon-free-tier-ops',
        'deployment:',
        '  target: railway',
        '  railway:',
        '    service_name: jumpstart-pro-plus',
      ].join('\n'),
    );
    const cfg = loadConfig({ controlPlaneDir: ROOT, spokeDir: spoke });
    assert.equal(cfg.deployment.target, 'railway');
    assert.equal(cfg.deployment.railway.health_path, '/up');
    assert.equal(cfg.deployment.railway.service_name, 'jumpstart-pro-plus');

    const plan = resolveAgentPlan({ config: cfg, controlPlaneDir: ROOT });
    assert.ok(plan.skillPaths.some((p) => p.endsWith('railway-neon-free-tier-ops/SKILL.md')));
    assert.ok(!plan.skills.includes('render-free-tier-ops'));

    const issue = buildIssueUpdate({ title: 'feat: add accounts', body: '', labels: [], config: cfg });
    assert.equal(issue.deployTarget, 'railway');

    const bootstrap = readFileSync(join(ROOT, 'scripts/bootstrap-rails.sh'), 'utf8');
    assert.match(bootstrap, /DEPLOY_TARGET" = "railway"/);
    assert.match(bootstrap, /sleepApplication = true/);
  } finally {
    rmSync(spoke, { recursive: true, force: true });
  }
});

test('Rails bootstrap encrypts credentials with the spoke RAILS_MASTER_KEY and never keeps it', () => {
  const bootstrap = readFileSync(join(ROOT, 'scripts/bootstrap-rails.sh'), 'utf8');
  assert.match(bootstrap, /RAILS_MASTER_KEY secret is required/);
  assert.match(bootstrap, /\^\[0-9a-f\]\{32\}\$/);
  assert.ok(bootstrap.indexOf('> config/master.key') < bootstrap.indexOf('rails new .'));
  assert.match(bootstrap, /rm -f config\/master\.key/);

  const workflow = readFileSync(join(ROOT, '.github/workflows/mogra-sdlc.yml'), 'utf8');
  assert.match(workflow, /RAILS_MASTER_KEY:\n\s+required: false/);
  assert.match(workflow, /unset MOGRA_RAILS_MASTER_KEY/);
  assert.ok(workflow.indexOf('unset MOGRA_RAILS_MASTER_KEY') < workflow.indexOf('run-agent.sh spoke'));
  assert.match(workflow, /rm -f config\/master\.key config\/credentials\/\*\.key/);
});

test('model Gemfile edits can only add gems, never drop gems or re-pin Rails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mogra-gemfile-'));
  try {
    writeFileSync(join(dir, 'Gemfile'), 'source "https://rubygems.org"\ngem "rails", "~> 8.1.4"\ngem "pg"\ngem "puma"\n');
    const out = mergeGemfile({ Gemfile: 'gem "rails", "~> 8.0.0"\ngem "bcrypt", "~> 3.1.7"\n', 'app/a.rb': 'x' }, dir);
    assert.match(out.Gemfile, /gem "rails", "~> 8\.1\.4"/);
    assert.doesNotMatch(out.Gemfile, /8\.0\.0/);
    assert.match(out.Gemfile, /gem "puma"/);
    assert.match(out.Gemfile, /gem "bcrypt", "~> 3\.1\.7"/);
    assert.equal(out['app/a.rb'], 'x');
    const unchanged = mergeGemfile({ Gemfile: 'gem "pg"\n' }, dir);
    assert.equal(unchanged.Gemfile, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('application changes without test changes are rejected', () => {
  assert.equal(missingTestChanges(['app/models/user.rb', 'config/routes.rb']), true);
  assert.equal(missingTestChanges(['app/models/user.rb', 'test/models/user_test.rb']), false);
  assert.equal(missingTestChanges(['Gemfile', 'README.md']), false);
});

test('Rails route check script ships with the control plane', () => {
  const script = readFileSync(join(ROOT, 'scripts/rails-route-check.rb'), 'utf8');
  assert.match(script, /constantize/);
  assert.match(script, /template_exists\?/);
  assert.match(readFileSync(join(ROOT, 'src/incremental-builder.mjs'), 'utf8'), /rails runner/);
});

test('issue Generators section is parsed against an allowlist', () => {
  const spec = '### Outcome\nx\n\n### Generators\n\n```text\nbin/rails generate authentication --force\n- `rails g model Project name:string! account:references`\n```\n\n## Skills\nignored';
  assert.deepEqual(parseGenerators(spec), [
    ['authentication', '--force'],
    ['model', 'Project', 'name:string!', 'account:references'],
  ]);
  assert.deepEqual(parseGenerators('### Generators\n\n_No response_\n\n### Notes'), []);
  assert.deepEqual(parseGenerators('### Outcome\nno generators'), []);
  assert.throws(() => parseGenerators('### Generators\nbin/rails generate scaffold Post'), /not allowed/);
  assert.throws(() => parseGenerators('### Generators\nbin/rails generate model Post; rm -rf /'), /not allowed/);
  assert.throws(() => parseGenerators('### Generators\nbin/rails db:drop'), /unsupported line/);
});

test('model edits to generator-created files are ignored', async () => {
  const { withoutLockedFiles } = await import('../src/incremental-builder.mjs');
  const out = withoutLockedFiles(
    { 'app/controllers/sessions_controller.rb': 'x', 'app/controllers/registrations_controller.rb': 'y' },
    new Set(['app/controllers/sessions_controller.rb']),
  );
  assert.deepEqual(Object.keys(out), ['app/controllers/registrations_controller.rb']);
});
