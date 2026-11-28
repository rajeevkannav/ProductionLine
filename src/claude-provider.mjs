/**
 * Claude Code provider for the incremental builder.
 *
 * Unlike the Gemini provider (the model returns whole files as JSON and mogra filters them before
 * writing), Claude Code edits the working tree directly and can run the tests itself. mogra keeps
 * its guarantees by checkpointing the tree before every Claude pass and reverting what Claude was
 * not allowed to change afterwards (protected paths, generator-created app code, paths outside the
 * issue's Files list, the Solid migration, .bundle/), and by keeping the Gemfile append-only.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PROTECTED = [/^\.github\//, /^\.mogra\.yaml$/, /^\.git\//, /^\.bundle\//, /^db\/migrate\/\d+_create_solid_tables\.rb$/];
const GEM_LINE = /^[ \t]*gem[ \t]+["']([^"']+)["'].*$/gm;

const ALLOWED_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(bin/rails:*)',
  'Bash(bundle:*)',
  'Bash(yarn:*)',
  'Bash(npm run:*)',
  'Bash(npx @tailwindcss/cli:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(ls:*)',
];
const DISALLOWED_TOOLS = ['Bash(git push:*)', 'Bash(git commit:*)', 'Bash(git reset:*)', 'Bash(git checkout:*)', 'WebFetch', 'WebSearch'];

function git(workdir, args, opts = {}) {
  return execFileSync('git', args, { cwd: workdir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/** Commit the current tree so the next Claude pass can be compared (and partly reverted) against it. */
export function checkpoint(workdir, label) {
  git(workdir, ['add', '-A']);
  try {
    git(workdir, ['-c', 'user.name=mogra', '-c', 'user.email=mogra@localhost', 'commit', '-q', '--no-verify', '--allow-empty', '-m', `mogra checkpoint: ${label}`]);
  } catch {
    /* nothing to commit */
  }
  return git(workdir, ['rev-parse', 'HEAD']).trim();
}

/** Paths changed since `ref` (modified, added, deleted, untracked). */
export function changedSince(workdir, ref) {
  const tracked = git(workdir, ['diff', '--name-only', ref]).split('\n').filter(Boolean);
  const untracked = git(workdir, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  return [...new Set([...tracked, ...untracked])];
}

/** Decide whether Claude may change `path` this run. */
export function isAllowedChange(path, { locked = new Set(), allowedFiles = null, matchesAllowed = () => true } = {}) {
  if (PROTECTED.some((re) => re.test(path))) return false;
  if (locked.has(path)) return false;
  if (allowedFiles && !matchesAllowed(path)) {
    // Files the tools regenerate (lockfiles, schema, build output) follow from allowed edits.
    return /(^|\/)(Gemfile\.lock|yarn\.lock|package-lock\.json)$/.test(path) || path === 'db/schema.rb';
  }
  return true;
}

/** Keep the Gemfile append-only: the previous Gemfile plus any newly declared gems. */
export function appendOnlyGemfile(previous, next) {
  const existing = new Set([...previous.matchAll(GEM_LINE)].map((m) => m[1]));
  const added = [...next.matchAll(GEM_LINE)].filter((m) => !existing.has(m[1])).map((m) => m[0].trim());
  return added.length ? `${previous.replace(/\s*$/, '')}\n\n# Added by mogra\n${[...new Set(added)].join('\n')}\n` : previous;
}

/** Revert every change since `ref` that Claude was not allowed to make; returns the kept paths. */
export function enforceGuards(workdir, ref, rules) {
  const kept = [];
  for (const path of changedSince(workdir, ref)) {
    if (!isAllowedChange(path, rules)) {
      let existed = true;
      try {
        git(workdir, ['cat-file', '-e', `${ref}:${path}`]);
      } catch {
        existed = false;
      }
      if (existed) git(workdir, ['checkout', ref, '--', path]);
      else rmSync(join(workdir, path), { force: true, recursive: true });
      console.log(`[mogra-claude] Reverted ${path} (not allowed in this issue).`);
      continue;
    }
    kept.push(path);
  }
  if (kept.includes('Gemfile') && existsSync(join(workdir, 'Gemfile'))) {
    const previous = git(workdir, ['show', `${ref}:Gemfile`]);
    const merged = appendOnlyGemfile(previous, readFileSync(join(workdir, 'Gemfile'), 'utf8'));
    writeFileSync(join(workdir, 'Gemfile'), merged);
  }
  return kept;
}

function claudeBin() {
  return process.env.MOGRA_CLAUDE_BIN || 'claude';
}

/** Run one headless Claude Code pass in `workdir`; returns { result, costUsd, usage }. */
export function runClaude({ workdir, prompt, model = 'sonnet', phase = 'build', telemetry = [] }) {
  const started = Date.now();
  const raw = execFileSync(
    claudeBin(),
    [
      '-p',
      '--model', model,
      '--output-format', 'json',
      '--permission-mode', 'acceptEdits',
      '--max-turns', String(Number(process.env.MOGRA_CLAUDE_MAX_TURNS) || 80),
      '--allowedTools', ALLOWED_TOOLS.join(','),
      '--disallowedTools', DISALLOWED_TOOLS.join(','),
    ],
    {
      cwd: workdir,
      input: prompt,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
      timeout: Number(process.env.MOGRA_CLAUDE_TIMEOUT_MS) || 45 * 60_000,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, CI: 'true' },
    },
  );
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { result: raw };
  }
  if (parsed.is_error) throw new Error(`Claude Code ${phase} failed: ${String(parsed.result ?? '').slice(0, 500)}`);
  telemetry.push({
    phase,
    timestamp: new Date().toISOString(),
    provider: 'claude-code',
    model,
    costUsd: parsed.total_cost_usd ?? 0,
    turns: parsed.num_turns ?? 0,
    inputTokens: parsed.usage?.input_tokens ?? 0,
    outputTokens: parsed.usage?.output_tokens ?? 0,
    cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
    elapsedMs: Date.now() - started,
  });
  console.log(`[mogra-claude] ${phase}: ${parsed.num_turns ?? '?'} turns.`);
  return parsed;
}

/** Instructions appended to the issue prompt for Claude Code (it edits files instead of returning JSON). */
export function claudeInstructions({ stack, generators = [], locked = new Set(), allowedFiles = null }) {
  return [
    '',
    '## How to work (mogra, Claude Code)',
    `- Stack: ${stack}. This is an existing app: extend it cleanly and keep every existing feature and passing test.`,
    '- Edit files in this directory directly. Run `bin/rails test` yourself and iterate until it passes. Do not commit, push or switch branches; mogra does that.',
    ...(generators.length
      ? [`- mogra already ran: ${generators.map((g) => `bin/rails generate ${g.join(' ')}`).join('; ')}. Generated app files are read-only (changes are reverted): ${[...locked].join(', ') || 'none'}. Build around them; tests must match their behaviour.`]
      : []),
    ...(allowedFiles ? [`- Only change these paths (anything else is reverted): ${allowedFiles.join(', ')}.`] : []),
    '- Never change .github/, .mogra.yaml, .bundle/, db/migrate/*_create_solid_tables.rb, the `gem "rails"` line or config.load_defaults. Add gems by adding lines to the Gemfile (existing gems stay).',
    '- Minitest 6 has no `stub` / `minitest/mock`: use `define_singleton_method` (restored in `ensure`) or dependency injection.',
    '- Test behaviour (responses, redirects, records, emails, visible text), never CSS class names or element counts.',
    '- After you finish, mogra independently runs: a fresh database built from migrations, `bin/rails test`, RuboCop, Brakeman, bundler-audit, a route check (every route has a controller), and a production smoke check (production config boots, CSS/JS served, no 5xx, no SMTP to localhost). Make sure these will pass.',
  ].join('\n');
}

/** Persist Claude telemetry next to the Gemini format so the portal and PR curator can read it. */
export function writeClaudeMetrics(workdir, telemetry) {
  if (!telemetry.length) return null;
  const totals = telemetry.reduce(
    (acc, c) => ({
      calls: acc.calls + 1,
      turns: acc.turns + c.turns,
      inputTokens: acc.inputTokens + c.inputTokens,
      outputTokens: acc.outputTokens + c.outputTokens,
      costUsdEquivalent: acc.costUsdEquivalent + c.costUsd,
      elapsedMs: acc.elapsedMs + c.elapsedMs,
    }),
    { calls: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsdEquivalent: 0, elapsedMs: 0 },
  );
  const metrics = { schemaVersion: 1, provider: 'claude-code-local', generatedAt: new Date().toISOString(), totals, calls: telemetry };
  writeFileSync(join(workdir, '.mogra-metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
  return metrics;
}
