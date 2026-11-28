/**
 * Single source of truth for ProductionLine (codename: mogra) conventions.
 * Spoke repositories can omit .mogra.yaml entirely and inherit these defaults.
 */

export const SUPPORTED_STACKS = Object.freeze({
  'react19-ts-vite': {
    label: 'React 19 + TypeScript + Vite + Tailwind CSS v4 + ARIA/Radix',
    packageManager: 'npm',
    runtime: 'node',
    layout: 'stacks-subpath',
    verifyProfile: 'node-spa',
    defaultAgent: 'frontend-builder',
  },
  'vue3-ts-vite': {
    label: 'Vue 3.5 + TypeScript + Vite + Reka UI + Modern CSS',
    packageManager: 'npm',
    runtime: 'node',
    layout: 'stacks-subpath',
    verifyProfile: 'node-spa',
    defaultAgent: 'frontend-builder',
  },
  'svelte5-ts-vite': {
    label: 'Svelte 5 (Runes) + TypeScript + Vite + Melt UI',
    packageManager: 'npm',
    runtime: 'node',
    layout: 'stacks-subpath',
    verifyProfile: 'node-spa',
    defaultAgent: 'frontend-builder',
  },
  'angular-ts': {
    label: 'Angular 19+ Standalone Signals + TypeScript + Angular CDK/ARIA',
    packageManager: 'npm',
    runtime: 'node',
    layout: 'stacks-subpath',
    verifyProfile: 'node-spa',
    defaultAgent: 'frontend-builder',
  },
  'solid-ts-vite': {
    label: 'SolidJS + TypeScript + Vite + Kobalte ARIA',
    packageManager: 'npm',
    runtime: 'node',
    layout: 'stacks-subpath',
    verifyProfile: 'node-spa',
    defaultAgent: 'frontend-builder',
  },
  'rails8-pg-hotwire': {
    label: 'Ruby on Rails 8 + PostgreSQL + Solid Stack + Hotwire + Tailwind CSS v4',
    packageManager: 'bundler',
    runtime: 'ruby',
    layout: 'repo-root',
    verifyProfile: 'rails-pg',
    defaultAgent: 'rails-fullstack-builder',
  },
  'android-hotwire-native': {
    label: 'Android Kotlin + Hotwire Native (.apk / .aab)',
    packageManager: 'gradle',
    runtime: 'java-android',
    layout: 'subpath',
    subpath: 'clients/android',
    verifyProfile: 'android-apk',
    defaultAgent: 'mobile-native-builder',
  },
  'ios-hotwire-native': {
    label: 'iOS Swift + Hotwire Native (Xcode Simulator / .ipa)',
    packageManager: 'swiftpm',
    runtime: 'xcode-ios',
    layout: 'subpath',
    subpath: 'clients/ios',
    verifyProfile: 'ios-xcode',
    defaultAgent: 'mobile-native-builder',
  },
});

export const SUPPORTED_DELIVERY_MODES = Object.freeze(['greenfield-stack', 'incremental-feature']);
export const SUPPORTED_DEPLOY_TARGETS = Object.freeze(['github-pages', 'render', 'railway', 'mobile-release', 'none']);

export const HARNESSES = Object.freeze({
  antigravity: {
    bin: 'python3',
    defaultModel: 'gemini-3.1-flash-lite',
    envKey: 'GEMINI_API_KEY',
    buildArgs: ({ model, promptFile }) => ['-m', 'google.antigravity.cli', '--model', model, '--prompt-file', promptFile],
  },
  'gemini-cli': {
    bin: 'gemini',
    defaultModel: 'gemini-3.1-flash-lite',
    envKey: 'GEMINI_API_KEY',
    buildArgs: ({ model, prompt }) => ['-m', model, '-p', prompt],
  },
  'claude-code': {
    bin: 'claude',
    defaultModel: 'claude-sonnet-4-5',
    envKey: 'ANTHROPIC_API_KEY',
    buildArgs: ({ model, prompt }) => ['--model', model, '-p', prompt],
  },
  codex: {
    bin: 'codex',
    defaultModel: 'gpt-5-codex',
    envKey: 'OPENAI_API_KEY',
    buildArgs: ({ model, prompt }) => ['exec', '--model', model, prompt],
  },
  goose: {
    bin: 'goose',
    defaultModel: 'gemini-2.5-pro',
    envKey: 'GEMINI_API_KEY',
    buildArgs: ({ promptFile }) => ['run', '--instructions', promptFile],
  },
  openhands: {
    bin: 'openhands',
    defaultModel: 'gemini-2.5-pro',
    envKey: 'GEMINI_API_KEY',
    buildArgs: ({ promptFile }) => ['--headless', '--task-file', promptFile],
  },
  aider: {
    bin: 'aider',
    defaultModel: 'gemini/gemini-2.5-pro',
    envKey: 'GEMINI_API_KEY',
    buildArgs: ({ model, prompt }) => ['--model', model, '--yes', '--message', prompt],
  },
  'deterministic-ci': {
    bin: 'npm',
    defaultModel: 'none',
    envKey: null,
    buildArgs: () => ['test'],
  },
});

export const CONVENTIONS = Object.freeze({
  version: 1,
  factory: {
    name: 'ProductionLine',
    codename: 'mogra',
    control_plane_repo: 'rajeevkannav/ProductionLine',
  },
  human_in_the_loop: {
    enabled: false,
    checkpoints: {
      discovery_approval: false,
      spec_approval: false,
      pr_review_required: false,
      release_approval: false,
    },
  },
  runtime: {
    build: 'cloud', // cloud: GitHub Actions builds from the issue; local: `mogra build` on your machine, GitHub verifies
    harness: 'gemini-cli',
    model: 'gemini-3.1-flash-lite',
    sandbox: 'worktree',
  },
  agents: {},
  outcome: {
    blueprint: 'todomvc-plus',
    stack: 'react19-ts-vite',
    mode: 'greenfield-stack',
    capabilities: [],
  },
  deployment: {
    target: 'github-pages',
    custom_domain: '',
    render: {
      region: 'oregon',
      health_path: '/up',
      service_name: '',
    },
    railway: {
      health_path: '/up',
      service_name: '',
    },
  },
  gates: {
    independent_verifier: true,
    evidence_ledger_required: true,
    a11y_zero_violations: true,
    reflow_320px_zero_overflow: true,
    protected_paths_enforced: true,
    secret_scan_required: true,
    sbom_required: true,
    rails_sast_required: true,
    auto_merge_on_all_gates_green: true,
  },
});
