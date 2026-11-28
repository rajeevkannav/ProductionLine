#!/usr/bin/env node
/**
 * Incremental multi-stack feature builder for existing repositories (Rails, Android, iOS, etc.).
 * Reads repo context, requests scoped JSON file patches, enforces protected boundaries,
 * and runs stack-specific local verification + repair loops.
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callGeminiResilient, collectStaticIssues, crossStackUiPromptSection, writeGeneratedFiles, writeRunMetrics } from './free-tier-builder.mjs';
import { checkpoint, changedSince, claudeInstructions, enforceGuards, runClaude, writeClaudeMetrics } from './claude-provider.mjs';
import { SUPPORTED_STACKS } from './conventions.mjs';

/** Folder a stack's code lives in, relative to the repository root ('' for repo-root stacks). */
export function stackScope(stack) {
  return SUPPORTED_STACKS[stack]?.layout === 'stacks-subpath' ? `stacks/${stack}/` : '';
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'tmp', 'log', 'storage', 'vendor', '.gradle', 'build', 'DerivedData', 'dist']);
const CONTEXT_EXTENSIONS = /\.(rb|erb|rake|js|mjs|ts|tsx|css|html|json|yml|yaml|sh|kt|kts|swift|xml|plist|md)$/i;
const PRIORITY_FILES = [
  'Gemfile',
  'package.json',
  'render.yaml',
  'bin/render-build.sh',
  'railway.toml',
  'Dockerfile',
  'config/routes.rb',
  'db/schema.rb',
  'app/models/current.rb',
  'app/models/user.rb',
  'app/models/account.rb',
  'app/controllers/application_controller.rb',
  'playwright.config.ts',
  'build.gradle.kts',
  'app/build.gradle.kts',
  'Package.swift',
];

function listRepoFiles(root, prefix = '') {
  const out = [];
  if (!existsSync(join(root, prefix))) return out;
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listRepoFiles(root, rel));
    else out.push(rel);
  }
  return out;
}

function buildRepoContext(workdir, maxChars = 48_000) {
  const allFiles = listRepoFiles(workdir);
  const prioritized = [
    ...PRIORITY_FILES.filter((f) => allFiles.includes(f)),
    ...allFiles.filter((f) => !PRIORITY_FILES.includes(f) && CONTEXT_EXTENSIONS.test(f)),
  ];

  let used = 0;
  const snippets = [];
  for (const rel of prioritized) {
    if (used >= maxChars) break;
    const abs = join(workdir, rel);
    if (!existsSync(abs)) continue;
    const content = readFileSync(abs, 'utf8');
    const slice = content.slice(0, 4000);
    const block = `### \`${rel}\`\n\`\`\`\n${slice}\n\`\`\``;
    if (used + block.length > maxChars && snippets.length > 0) continue;
    snippets.push(block);
    used += block.length;
  }

  return {
    tree: allFiles.slice(0, 250).join('\n'),
    snippets: snippets.join('\n\n'),
  };
}

function deleteGeneratedFiles(workdir, deletes = []) {
  const root = resolve(workdir);
  for (const relPath of deletes ?? []) {
    if (typeof relPath !== 'string') continue;
    const normalized = relPath.replace(/^\/+/, '');
    if (normalized.startsWith('.github/') || normalized.startsWith('.git/') || normalized === '.mogra.yaml') {
      throw new Error(`Security block: forbidden delete path '${relPath}'`);
    }
    const target = resolve(root, normalized);
    const rel = relative(root, target);
    if (!rel || rel.startsWith('..') || rel.includes('../')) {
      throw new Error(`Security block: path traversal delete '${relPath}'`);
    }
    if (existsSync(target)) rmSync(target, { force: true });
  }
}

export const RAILS_APP_MARKERS = Object.freeze(['Gemfile', 'bin/rails', 'config/application.rb']);
const LOCKFILES = new Set(['Gemfile.lock', 'yarn.lock', 'package-lock.json', 'bun.lockb', 'pnpm-lock.yaml']);

/** Number of Minitest runs reported by `rails test` output (0 if none or unparseable). */
export function countMinitestRuns(output = '') {
  const matches = [...String(output).matchAll(/(\d+) runs?, \d+ assertions?/g)];
  return matches.length ? Number(matches[matches.length - 1][1]) : 0;
}

/** Drop model writes to files a generator created in this run: they are known to work. */
export function withoutLockedFiles(filesMap = {}, locked = new Set()) {
  return Object.fromEntries(
    Object.entries(filesMap ?? {}).filter(([path]) => {
      const keep = !locked.has(path.replace(/^\/+/, ''));
      if (!keep) console.log(`[mogra-incremental] Kept generated ${path} (model edit ignored).`);
      return keep;
    }),
  );
}

/** Files the model must never write: lockfiles (bundle/yarn), the dumped schema, and the bootstrap's Solid migration. */
export function isGeneratedPath(path = '') {
  const normalized = String(path).replace(/^\/+/, '');
  return (
    LOCKFILES.has(normalized.split('/').pop()) ||
    normalized.startsWith('.bundle/') ||
    normalized === 'db/schema.rb' ||
    /^db\/migrate\/\d+_create_solid_tables\.rb$/.test(normalized)
  );
}

const ROUTE_CHECK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'rails-route-check.rb');
const PRODUCTION_SMOKE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'rails-production-smoke.rb');
const GEM_LINE = /^[ \t]*gem[ \t]+["']([^"']+)["'].*$/gm;

/**
 * The model may only ADD gems: keep the existing Gemfile (and its `gem "rails"` pin) and append
 * gem lines for gems it does not declare yet. Models often return truncated Gemfiles.
 */
export function mergeGemfile(filesMap = {}, workdir = '.') {
  const proposed = filesMap?.Gemfile;
  const gemfilePath = join(workdir, 'Gemfile');
  if (typeof proposed !== 'string' || !existsSync(gemfilePath)) return filesMap;
  const current = readFileSync(gemfilePath, 'utf8');
  const existing = new Set([...current.matchAll(GEM_LINE)].map((m) => m[1]));
  const added = [...proposed.matchAll(GEM_LINE)].filter((m) => !existing.has(m[1])).map((m) => m[0].trim());
  const next = added.length ? `${current.replace(/\s*$/, '')}\n\n# Added by mogra\n${[...new Set(added)].join('\n')}\n` : current;
  const rest = { ...filesMap };
  delete rest.Gemfile;
  return next === current ? rest : { ...rest, Gemfile: next };
}

/** A change to application code or routes must come with test changes. */
export function missingTestChanges(paths = []) {
  const list = [...paths];
  // Behaviour code needs tests; views, styles and helpers are covered by the production smoke
  // check and the UI review, and forcing test edits for them makes models break working tests.
  const BEHAVIOUR = /^app\/(controllers|models|jobs|mailers|channels|services|policies)\//;
  const touchesApp = list.some((p) => BEHAVIOUR.test(p) || p === 'config/routes.rb' || p.startsWith('lib/'));
  const touchesTests = list.some((p) => p.startsWith('test/'));
  return touchesApp && !touchesTests;
}

/** Drop generated files from model output; they are regenerated by tools, never hand-written. */
export function withoutLockfiles(filesMap = {}) {
  return Object.fromEntries(Object.entries(filesMap ?? {}).filter(([path]) => !isGeneratedPath(path)));
}

/**
 * Keep the part of a failure the model needs: the error message usually sits at the top,
 * followed by long gem backtraces. Drop library frames, then keep head and tail.
 */
export function summarizeFailure(raw = '', max = 5500) {
  const lines = String(raw).split('\n');
  let libFrames = 0;
  const kept = lines.filter((line) => {
    if (/^(yarn (install|run) v|\[\d\/\d\] |success Already up-to-date|Done in |\$ esbuild |  app\/assets\/builds\/)/.test(line)) return false;
    if (/^\s+from \/.*\/(gems|lib\/ruby)\//.test(line) || /^\s*\/.*\/(gems|lib\/ruby)\/.*:\d+:in /.test(line)) {
      libFrames += 1;
      return libFrames <= 3;
    }
    return true;
  });
  const text = kept.join('\n').trim();
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.45);
  return `${text.slice(0, head)}\n[... output truncated ...]\n${text.slice(-(max - head))}`;
}

function runCommand(cmd, cwd, timeout = 180_000) {
  return execSync(cmd, {
    cwd,
    env: { ...process.env, CI: process.env.CI || 'true', RAILS_ENV: process.env.RAILS_ENV || 'test' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
}

// Same secret scan as the verify job, when gitleaks is installed (catches hard-coded test passwords).
// Scan only what would be committed (tracked + untracked, not gitignored: no log/, tmp/,
// node_modules/), verbosely so the model sees file and line of each finding.
const GITLEAKS_SCAN =
  'if command -v gitleaks >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then ' +
  'scan=$(mktemp -d) && git ls-files -co --exclude-standard -z | rsync -a --from0 --files-from=- . "$scan"/ && ' +
  'gitleaks detect --source "$scan" --no-git --redact --no-banner --no-color -v --exit-code 1; status=$?; rm -rf "$scan"; exit $status; fi';

/** The verify-node-spa job's checks, run in the stack folder (set MOGRA_SKIP_E2E=1 to leave Playwright to GitHub). */
export function nodeCheckCommands(pkg = {}, env = process.env) {
  const scripts = pkg.scripts ?? {};
  return [
    'npm install --no-audit --no-fund',
    ...['typecheck', 'lint'].filter((s) => scripts[s]).map((s) => `npm run ${s}`),
    ...(scripts.test ? ['npm test'] : []),
    ...(scripts['test:e2e'] && env.MOGRA_SKIP_E2E !== '1' ? ['npx playwright install chromium', 'npm run test:e2e'] : []),
    'npm run build',
    'npm audit --omit=dev --audit-level=high',
    GITLEAKS_SCAN,
  ];
}

function runStackChecks(workdir, stack) {
  try {
    if (SUPPORTED_STACKS[stack]?.runtime === 'node') {
      const dir = join(workdir, stackScope(stack));
      if (!existsSync(join(dir, 'package.json'))) return { ok: false, output: `Missing ${stackScope(stack)}package.json.` };
      // The TodoMVC+ blueprint gate the cloud builder uses: cross-stack UI contract, no placeholder stubs.
      const staticIssues = collectStaticIssues(dir);
      if (staticIssues.length) return { ok: false, output: staticIssues.map((i) => `- ${i}`).join('\n') };
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      for (const cmd of nodeCheckCommands(pkg)) runCommand(cmd, dir, 300_000);
    } else if (stack === 'rails8-pg-hotwire') {
      const missing = RAILS_APP_MARKERS.filter((f) => !existsSync(join(workdir, f)));
      if (missing.length > 0) {
        return { ok: false, output: `Not a Rails application: missing ${missing.join(', ')}.` };
      }
      // setup-ruby's bundler-cache freezes the bundle (deployment mode); new gems in the Gemfile must update Gemfile.lock.
      runCommand('bundle config set --local deployment false && bundle config set --local frozen false && (bundle check || bundle install --quiet)', workdir, 240_000);
      // Fresh database each round, built from the migrations (not db/schema.rb), so the schema
      // is re-dumped from migrations and can never drift from them (production runs migrations).
      // Rails 8.1 loads db/schema.rb when migrating an empty database, so remove it first.
      runCommand('rm -f db/schema.rb && DISABLE_DATABASE_ENVIRONMENT_CHECK=1 bundle exec rails db:drop db:create db:migrate', workdir, 180_000);
      const testOutput = runCommand('bundle exec rails test', workdir, 180_000);
      if (countMinitestRuns(testOutput) === 0) {
        return { ok: false, output: `Minitest ran 0 tests; add tests covering this issue.\n${testOutput.slice(-1500)}` };
      }
      if (existsSync(join(workdir, '.rubocop.yml')) || existsSync(join(workdir, 'bin/rubocop'))) {
        // Style offenses are fixed deterministically, not by spending a model repair round on them.
        runCommand('bundle exec rubocop -A --format quiet || true', workdir, 180_000);
        runCommand('bundle exec rubocop --format simple', workdir, 120_000);
      }
      runCommand(`bundle exec rails runner ${JSON.stringify(ROUTE_CHECK_SCRIPT)}`, workdir, 120_000);
      // Production configuration is never exercised by tests: boot it and request every GET page.
      runCommand(
        `RAILS_ENV=production SECRET_KEY_BASE_DUMMY=1 bundle exec rails assets:precompile >/dev/null && RAILS_ENV=production SECRET_KEY_BASE_DUMMY=1 RAILS_LOG_LEVEL=fatal bundle exec rails runner ${JSON.stringify(PRODUCTION_SMOKE_SCRIPT)}; status=$?; RAILS_ENV=production SECRET_KEY_BASE_DUMMY=1 bundle exec rails assets:clobber >/dev/null 2>&1; exit $status`,
        workdir,
        240_000,
      );
      runCommand('bundle exec brakeman -q --no-pager', workdir, 120_000);
      // Same secret scan as the verify job, when gitleaks is installed (catches hard-coded test passwords).
      // Scan only what would be committed (tracked + untracked, not gitignored: no log/, tmp/,
      // node_modules/), verbosely so the model sees file and line of each finding.
      runCommand(GITLEAKS_SCAN, workdir, 120_000);
      runCommand('if bundle exec bundle-audit --help >/dev/null 2>&1; then bundle exec bundle-audit check --update; fi', workdir, 120_000);
    } else if (stack === 'android-hotwire-native') {
      if (existsSync(join(workdir, 'gradlew'))) {
        runCommand('chmod +x gradlew && ./gradlew test lint assembleDebug', workdir, 300_000);
      } else if (!existsSync(join(workdir, 'build.gradle.kts')) && !existsSync(join(workdir, 'build.gradle'))) {
        return { ok: false, output: 'Missing Android Gradle build file (build.gradle.kts / gradlew).' };
      }
    } else if (stack === 'ios-hotwire-native') {
      if (process.platform === 'darwin' && existsSync(join(workdir, 'Package.swift'))) {
        runCommand('swift test', workdir, 240_000);
      } else if (!existsSync(join(workdir, 'Package.swift')) && !readdirSync(workdir).some((f) => f.endsWith('.xcodeproj'))) {
        return { ok: false, output: 'Missing Package.swift or .xcodeproj in iOS directory.' };
      }
    }
    return { ok: true, output: '' };
  } catch (err) {
    const raw = `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}`.trim();
    return { ok: false, output: summarizeFailure(raw) };
  }
}

const GENERATORS = new Set(['authentication', 'model', 'migration', 'controller', 'mailer', 'job', 'channel', 'stimulus']);
const GENERATOR_FLAGS = new Set(['--force', '--skip', '--skip-collision-check', '--api', '--no-test-framework']);
const GENERATOR_ARG = /^[A-Za-z0-9_:!.\/=\-]+$/;

/**
 * Parse the issue's `### Generators` section into allowlisted `rails generate` argument lists.
 * Lines look like `bin/rails generate authentication` or `- rails g model Project name:string`.
 */
/** Glob (`*` within a segment, `**` across segments) to RegExp for repository-relative paths. */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${pattern.replace(/\(\?:\.\*\/\)\?$/, '.*')}$`);
}

/**
 * Parse the issue's optional `### Files` section: repository paths or globs the model may change.
 * Returns null when the section is absent (no restriction).
 */
export function parseAllowedFiles(spec = '') {
  const match = String(spec).match(/^###\s*Files\s*\n([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/m);
  if (!match) return null;
  const globs = match[1]
    .split('\n')
    .filter((raw) => !/^\s*(`{3}|~{3})/.test(raw))
    .map((raw) => raw.replace(/`/g, '').replace(/^\s*[-*]\s*/, '').trim())
    .filter((line) => line && !/^_?no response_?$/i.test(line));
  return globs.length ? globs : null;
}

/** Predicate for the issue's allowed files (always true when the issue declares none). */
export function allowedMatcher(globs = null) {
  if (!globs) return () => true;
  const patterns = globs.map(globToRegExp);
  return (path) => patterns.some((re) => re.test(String(path).replace(/^\/+/, '')));
}

/** Keep only model writes inside the issue's allowed files (when the issue declares them). */
export function withinAllowedFiles(filesMap = {}, globs = null) {
  if (!globs) return filesMap;
  const patterns = globs.map(globToRegExp);
  return Object.fromEntries(
    Object.entries(filesMap ?? {}).filter(([path]) => {
      const normalized = path.replace(/^\/+/, '');
      const keep = patterns.some((re) => re.test(normalized));
      if (!keep) console.log(`[mogra-incremental] Ignored ${normalized}: not in the issue's Files list.`);
      return keep;
    }),
  );
}

export function parseGenerators(spec = '') {
  const section = String(spec).match(/^###\s*Generators\s*\n([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/m)?.[1] ?? '';
  const commands = [];
  for (const raw of section.split('\n')) {
    if (/^\s*(`{3}|~{3})/.test(raw)) continue; // issue-form code fences
    const line = raw.replace(/`/g, '').replace(/^\s*[-*]\s*/, '').trim();
    if (!line || /^_?no response_?$/i.test(line)) continue;
    const match = line.match(/^(?:bin\/)?rails\s+(?:generate|g)\s+(.+)$/);
    if (!match) throw new Error(`Generators: unsupported line '${line}' (expected 'bin/rails generate <generator> ...')`);
    const args = match[1].split(/\s+/);
    if (!GENERATORS.has(args[0])) throw new Error(`Generators: '${args[0]}' is not allowed (allowed: ${[...GENERATORS].join(', ')})`);
    for (const arg of args.slice(1)) {
      if (arg.startsWith('--') ? !GENERATOR_FLAGS.has(arg) : !GENERATOR_ARG.test(arg)) {
        throw new Error(`Generators: argument '${arg}' is not allowed`);
      }
    }
    commands.push(args);
  }
  return commands;
}

function createdTables(source) {
  return [...String(source).matchAll(/create_table\s*\(?\s*[:"']([a-z0-9_]+)/g)].map((m) => m[1]);
}

function existingTables(workdir) {
  const tables = new Set();
  const schema = join(workdir, 'db', 'schema.rb');
  if (existsSync(schema)) createdTables(readFileSync(schema, 'utf8')).forEach((t) => tables.add(t));
  const migrate = join(workdir, 'db', 'migrate');
  if (existsSync(migrate)) {
    for (const f of readdirSync(migrate)) createdTables(readFileSync(join(migrate, f), 'utf8')).forEach((t) => tables.add(t));
  }
  return tables;
}

/** Run the issue's allowlisted Rails generators before the model; drop generated migrations for tables that already exist. */
export function runGenerators(workdir, commands) {
  if (commands.length === 0) return { changed: [], created: [] };
  runCommand('bundle config set --local deployment false && bundle config set --local frozen false', workdir);
  const before = new Set(existsSync(join(workdir, 'db/migrate')) ? readdirSync(join(workdir, 'db/migrate')) : []);
  const tables = existingTables(workdir);
  for (const args of commands) {
    console.log(`[mogra-incremental] rails generate ${args.join(' ')}`);
    execFileSync('bundle', ['exec', 'rails', 'generate', ...args], {
      cwd: workdir,
      env: { ...process.env, CI: 'true', RAILS_ENV: 'development' },
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 300_000,
    });
  }
  const migrate = join(workdir, 'db/migrate');
  for (const f of existsSync(migrate) ? readdirSync(migrate) : []) {
    if (before.has(f)) continue;
    const created = createdTables(readFileSync(join(migrate, f), 'utf8'));
    if (created.length > 0 && created.every((t) => tables.has(t))) {
      rmSync(join(migrate, f));
      console.log(`[mogra-incremental] Dropped generated migration ${f}: tables ${created.join(', ')} already exist.`);
    }
  }
  const status = execSync('git status --porcelain --untracked-files=all', { cwd: workdir, encoding: 'utf8' });
  const entries = status.split('\n').filter(Boolean).map((l) => ({ code: l.slice(0, 2), path: l.slice(3).trim() }));
  return {
    changed: entries.map((e) => e.path),
    created: entries.filter((e) => e.code === '??' || e.code.includes('A')).map((e) => e.path),
  };
}

function checkChange(workdir, stack, changed) {
  const result = runStackChecks(workdir, stack);
  if (!result.ok) return result;
  if (stack === 'rails8-pg-hotwire' && missingTestChanges(changed)) {
    return {
      ok: false,
      output: 'This change edits application code or routes but adds or updates no tests under test/. Add Minitest tests that cover every acceptance criterion in the issue.',
    };
  }
  return result;
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, cur, idx, arr) => {
      if (cur.startsWith('--')) acc.push([cur.slice(2), arr[idx + 1]]);
      return acc;
    }, []),
  );
  const workdir = resolve(args.workdir ?? '.');
  const stack = args.stack ?? 'rails8-pg-hotwire';
  if (args.provider === 'claude-code') {
    await mainClaude({ workdir, stack, model: args.model ?? 'sonnet', promptText: readFileSync(args['prompt-file'], 'utf8') });
    return;
  }
  const primaryModel = args.model ?? 'gemini-3.1-flash-lite';
  const envCandidates = (process.env.MOGRA_CANDIDATES ?? '').split(/\s+/).filter(Boolean);
  // Quality first: editing an existing app needs the stronger Flash models. Rotate across them
  // (each has its own free quota) and wait out rate limits instead of falling back to Flash-Lite,
  // which repeatedly broke working code. MOGRA_ALLOW_LITE=1 restores the Lite fallback.
  const strongModels = [...envCandidates.filter((m) => /flash/.test(m) && !/lite/.test(m)), 'gemini-3-flash-preview'];
  const liteModels = [primaryModel, ...envCandidates.filter((m) => /lite/.test(m))];
  const models = [...new Set(process.env.MOGRA_ALLOW_LITE === '1' ? [...strongModels, ...liteModels] : strongModels)];
  const backoffs = [0, 30, 60, 120];
  const promptText = readFileSync(args['prompt-file'], 'utf8');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');

  const telemetry = [];
  const changed = new Set();
  const generators = stack === 'rails8-pg-hotwire' ? parseGenerators(promptText) : [];
  const generated = runGenerators(workdir, generators);
  generated.changed.forEach((p) => changed.add(p));
  // Generated app code is read-only; generated tests stay editable so they can follow the issue's
  // requirements (e.g. a stricter password rule), and they still have to pass against the locked code.
  const locked = new Set(generated.created.filter((p) => !p.startsWith('test/')));
  const allowedFiles = parseAllowedFiles(promptText);
  const prepare = (files) =>
    mergeGemfile(withoutLockedFiles(withinAllowedFiles(withoutLockfiles(files), allowedFiles), locked), workdir);
  const allowedDeletes = (deletes) =>
    allowedFiles ? Object.keys(withinAllowedFiles(Object.fromEntries((deletes ?? []).map((d) => [d, ''])), allowedFiles)) : deletes;
  const ctx = buildRepoContext(workdir);

  const initialPrompt = [
    promptText,
    '',
    `## Target Stack & Delivery Mode`,
    `- Stack: ${stack}`,
    `- Mode: incremental-feature (extend existing repository cleanly; preserve existing features and passing tests)`,
    '',
    ...(generators.length
      ? [
          '## Generators Already Run',
          `mogra already ran: ${generators.map((g) => `bin/rails generate ${g.join(' ')}`).join('; ')}. These generated files are known to work and are READ-ONLY (edits are ignored): ${[...locked].join(', ') || 'none'}. Build on them: add new files, and adjust only files that existed before. Your tests must match the generated behaviour.`,
          '',
        ]
      : []),
    ...(allowedFiles
      ? [
          '## Files You May Change',
          `Only these paths may be created or changed (anything else is ignored): ${allowedFiles.join(', ')}. Everything else already works; do not touch it.`,
          '',
        ]
      : []),
    '## Current Repository Tree',
    '```',
    ctx.tree,
    '```',
    '',
    '## Key Existing Files',
    ctx.snippets,
    '',
    '## Output Format (STRICT JSON)',
    'Return ONLY a JSON object with shape: { "files": { "<relative-path>": "<full-file-content>" }, "deletes": [] }.',
    'Rules:',
    '- Include ONLY new or modified files (with full updated contents), never return unchanged files.',
    '- NEVER modify .github/workflows/, .mogra.yaml, or delete existing passing tests.',
    '- To add a gem, add it to the Gemfile (Gemfile.lock is updated by bundle install). Never change the `gem "rails"` line, .bundle/, or config.load_defaults.',
    '- Never return lockfiles (Gemfile.lock, yarn.lock, package-lock.json), db/schema.rb, or db/migrate/*_create_solid_tables.rb; they are generated. Add new tables with new migrations.',
    '- Minitest 6 has no `stub` and no `minitest/mock`; fake collaborators with `define_singleton_method` (removed in `ensure`) or plain dependency injection.',
    '- Test behaviour (responses, redirects, records, emails, visible text), never markup details such as CSS class names or element counts; layout is checked separately by the UI review.',
    '- Never hard-code password-like strings in tests (Gitleaks flags them as secrets): define one helper such as `def test_password = "x" * 16` or use `SecureRandom.alphanumeric(16)`.',
    '- The framework skeleton (Rails `rails new`, Gradle, Xcode) already exists: extend it, do not re-create or replace it, and never pin dependencies to older versions.',
    '- Implement the WHOLE issue in this response: every route must have its controller, action, and views; return complete files only.',
    '- Include comprehensive Minitest unit/integration tests for Rails features or unit tests for mobile clients.',
  ].join('\n');

  const first = await callGeminiResilient({ apiKey, models, prompt: initialPrompt, phase: 'incremental-build', telemetry, backoffs });
  const written = writeGeneratedFiles(workdir, prepare(first.files));
  written.forEach((p) => changed.add(p));
  deleteGeneratedFiles(workdir, allowedDeletes(first.deletes));
  console.log(`[mogra-incremental] Applied ${written.length} files (${written.join(', ')}).`);

  const rounds = Math.max(1, Number(process.env.MOGRA_REPAIR_ROUNDS) || 6);
  for (let round = 1; round <= rounds; round++) {
    const check = checkChange(workdir, stack, changed);
    if (check.ok) {
      writeRunMetrics(workdir, telemetry);
      console.log(`[mogra-incremental] Verification passed for ${stack}.`);
      return;
    }
    console.error(`[mogra-incremental] Check failed (round ${round}); requesting repair:\n${check.output}`);
    const latestCtx = buildRepoContext(workdir, 36_000);
    const repairPrompt = [
      `Fix the errors below in stack '${stack}' while preserving all existing features:`,
      '```',
      check.output,
      '```',
      '',
      latestCtx.snippets,
      '',
      'Return ONLY JSON: { "files": { "<relative-path>": "<full-file-content>" }, "deletes": [] }.',
      'Implement the WHOLE issue: every route needs its controller action and views, and every acceptance criterion needs a test.',
      ...(allowedFiles ? [`Only these paths may be changed (anything else is ignored): ${allowedFiles.join(', ')}.`] : []),
      ...(locked.size ? [`Generated files are read-only (edits are ignored); fix the code and tests around them instead: ${[...locked].join(', ')}.`] : []),
      'Test behaviour, not CSS classes or element counts. Fix only what the errors above require; keep everything else unchanged.',
      'Do not return lockfiles, db/schema.rb, or db/migrate/*_create_solid_tables.rb (generated). Minitest 6 has no `stub`/`minitest/mock`: use `define_singleton_method` or dependency injection.',
    ].join('\n');
    const patched = await callGeminiResilient({ apiKey, models, prompt: repairPrompt, phase: `repair-${round}`, telemetry, backoffs });
    const updated = writeGeneratedFiles(workdir, prepare(patched.files));
    updated.forEach((p) => changed.add(p));
    deleteGeneratedFiles(workdir, allowedDeletes(patched.deletes));
    console.log(`[mogra-incremental] Repair round ${round} updated: ${updated.join(', ')}`);
  }

  const finalCheck = checkChange(workdir, stack, changed);
  writeRunMetrics(workdir, telemetry);
  if (!finalCheck.ok) {
    throw new Error(`Incremental verification failed after ${rounds} repair rounds:\n${finalCheck.output}`);
  }
}

/** Claude Code flow: Claude edits the tree; mogra checkpoints, reverts disallowed changes, and verifies. */
async function mainClaude({ workdir, stack, model, promptText }) {
  const telemetry = [];
  const base = checkpoint(workdir, 'base');
  const generators = stack === 'rails8-pg-hotwire' ? parseGenerators(promptText) : [];
  const generated = runGenerators(workdir, generators);
  const locked = new Set(generated.created.filter((p) => !p.startsWith('test/')));
  const allowedFiles = parseAllowedFiles(promptText);
  const scope = stackScope(stack) || null;
  const rules = { locked, allowedFiles, matchesAllowed: allowedMatcher(allowedFiles), scope };
  const instructions = `${claudeInstructions({ stack, generators, locked, allowedFiles, scope })}${scope ? `\n\n${crossStackUiPromptSection()}` : ''}`;
  // Claude works inside the stack's folder; mogra's checkpoints and guards cover the whole repo.
  const cwd = scope ? join(workdir, scope) : workdir;
  const metricsDir = cwd;
  // Generator output is part of this change but belongs to mogra, not to the model: checkpoint it.
  let ref = checkpoint(workdir, 'generators');

  runClaude({ workdir, cwd, model, phase: 'incremental-build', telemetry, prompt: `${promptText}\n${instructions}` });
  enforceGuards(workdir, ref, rules);

  const rounds = Math.max(1, Number(process.env.MOGRA_REPAIR_ROUNDS) || 4);
  for (let round = 1; round <= rounds; round++) {
    const changed = new Set(changedSince(workdir, base));
    const check = checkChange(workdir, stack, changed);
    if (check.ok) {
      writeClaudeMetrics(metricsDir, telemetry);
      console.log(`[mogra-claude] Verification passed for ${stack}.`);
      return;
    }
    console.error(`[mogra-claude] Check failed (round ${round}); asking Claude to repair:\n${check.output}`);
    ref = checkpoint(workdir, `repair-${round}`);
    runClaude({
      workdir,
      cwd,
      model,
      phase: `repair-${round}`,
      telemetry,
      prompt: [
        promptText,
        instructions,
        '',
        `## mogra's checks failed (round ${round})`,
        'Fix the cause of the errors below without breaking existing features. Keep the rules above.',
        '```',
        check.output,
        '```',
      ].join('\n'),
    });
    enforceGuards(workdir, ref, rules);
  }

  const finalCheck = checkChange(workdir, stack, new Set(changedSince(workdir, base)));
  writeClaudeMetrics(metricsDir, telemetry);
  if (!finalCheck.ok) throw new Error(`Verification failed after ${rounds} Claude repair rounds:\n${finalCheck.output}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[mogra-incremental] Fatal: ${err.message}`);
    process.exit(1);
  });
}
