#!/usr/bin/env node
/**
 * mogra local runner: build one GitHub issue on this machine with Claude Code, then hand the PR to
 * GitHub, where the independent verify job, auto-merge, deploy and sub-issue chain run as usual.
 *
 *   node src/local-runner.mjs build --repo owner/name --issue 17 [--model sonnet] [--keep]
 *   node src/local-runner.mjs next  --repo owner/name            # build the issue marked mogra:next
 *
 * Supports rails8-pg-hotwire incremental features and the TodoMVC+ Node stacks (stacks/<stack>/).
 *
 * Needs: `gh` (signed in), the `claude` CLI signed in to your subscription (or MOGRA_CLAUDE_BIN),
 * and Node; Rails builds also need Ruby + Bundler and PostgreSQL binaries (initdb/pg_ctl). Nothing on this machine listens
 * to GitHub: you start each build, and only issues opened by the repository owner are built.
 */
import { execFileSync, execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { SUPPORTED_STACKS } from './conventions.mjs';
import { resolveAgentPlan } from './harness-runner.mjs';
import { buildIssueUpdate } from './issue-router.mjs';

const CONTROL_PLANE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BUILT_LABEL = 'mogra:built';
export const NEXT_LABEL = 'mogra:next';

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const log = (msg) => console.log(`[mogra-local] ${msg}`);

/** Conventional-commit title used by the cloud build too. */
export function changeTitle(issueTitle, issueNumber, stack) {
  return /^[a-z]+(\([^)]+\))?!?: /.test(issueTitle) ? `${issueTitle} (#${issueNumber})` : `feat(${stack}): ${issueTitle} (#${issueNumber})`;
}

/** Which stacks a local build can take: Rails incremental features, or any Node stack. */
export function localBuildKind(stack, deliveryMode) {
  if (stack === 'rails8-pg-hotwire' && deliveryMode === 'incremental-feature') return 'rails';
  if (SUPPORTED_STACKS[stack]?.runtime === 'node') return 'node';
  return null;
}

/** Same composition as scripts/run-agent.sh: task header, issue, skills, rules. */
export function composePrompt({ issueNumber, stack, plan, issueTitle, issueBody }) {
  const skills = plan.skillPaths
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p, 'utf8').replace(/^---[\s\S]*?---\s*/, ''))
    .join('\n');
  return [
    `# ProductionLine (mogra) Task — Issue #${issueNumber} (${stack})`,
    `Goal: ${plan.goal}`,
    `Delivery Mode: ${plan.deliveryMode}`,
    '',
    `Title: ${issueTitle}`,
    '',
    issueBody,
    '',
    '## Skills',
    skills,
    '## Rules',
    '- Implement the requested GitHub Issue incrementally without breaking existing features.',
    '- Include complete tests (Minitest for Rails).',
    '- Never edit .github/workflows/ or .mogra.yaml.',
  ].join('\n');
}

function ensureClone(repo) {
  const dir = join(homedir(), '.mogra', 'spokes', repo.replace('/', '__'));
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dirname(dir), { recursive: true });
    log(`Cloning ${repo} into ${dir}`);
    sh('gh', ['repo', 'clone', repo, dir]);
  }
  sh('git', ['-C', dir, 'fetch', '--prune', 'origin']);
  return dir;
}

function startPostgres() {
  const root = mkdtempSync(join(tmpdir(), 'mogra-pg-'));
  const data = join(root, 'data');
  const port = 56000 + Math.floor(Math.random() * 1000);
  sh('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
  sh('pg_ctl', ['-D', data, '-o', `-p ${port} -k '' -c listen_addresses=127.0.0.1`, '-l', join(root, 'pg.log'), '-w', 'start']);
  return {
    url: `postgres://postgres@127.0.0.1:${port}/mogra_test`,
    stop: () => {
      try {
        sh('pg_ctl', ['-D', data, '-m', 'fast', 'stop']);
      } catch {
        /* already stopped */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Rails' JS/CSS build calls `yarn`; provide a shim when Yarn 1 isn't installed. */
function yarnShimDir() {
  try {
    sh('yarn', ['--version']);
    return null;
  } catch {
    const dir = mkdtempSync(join(tmpdir(), 'mogra-bin-'));
    const shim = join(dir, 'yarn');
    writeFileSync(shim, '#!/bin/sh\nexec npx --yes yarn@1.22.22 "$@"\n');
    chmodSync(shim, 0o755);
    return dir;
  }
}

export async function build({ repo, issue, model, keep = false }) {
  const owner = repo.split('/')[0];
  const data = JSON.parse(sh('gh', ['issue', 'view', String(issue), '-R', repo, '--json', 'title,body,labels,author,state']));
  if (data.state !== 'OPEN') throw new Error(`#${issue} is ${data.state.toLowerCase()}`);
  if (data.author?.login !== owner) {
    throw new Error(`#${issue} was opened by ${data.author?.login}, not ${owner}; local builds only run issues the repository owner opened.`);
  }
  const labels = (data.labels ?? []).map((l) => l.name);
  if (labels.includes('mogra:epic')) throw new Error(`#${issue} is a milestone epic; build its sub-issues instead.`);

  const clone = ensureClone(repo);
  const config = loadConfig({ controlPlaneDir: CONTROL_PLANE, spokeDir: clone });
  const routed = buildIssueUpdate({ title: data.title, body: data.body ?? '', labels, config });
  const stack = routed.stack;
  const kind = localBuildKind(stack, routed.deliveryMode);
  if (!kind) {
    throw new Error(`Local builds support rails8-pg-hotwire incremental features and Node stacks (got ${stack} / ${routed.deliveryMode}).`);
  }
  const plan = resolveAgentPlan({ config, controlPlaneDir: CONTROL_PLANE, stackOverride: stack });
  const effectiveModel = model ?? (plan.harness === 'claude-code' ? plan.model : 'sonnet');

  const branch = `mogra/issue-${issue}-${stack}`;
  const worktree = join(homedir(), '.mogra', 'worktrees', `${repo.replace('/', '__')}-${issue}`);
  if (existsSync(worktree)) {
    try {
      sh('git', ['-C', clone, 'worktree', 'remove', '--force', worktree]);
    } catch {
      rmSync(worktree, { recursive: true, force: true });
    }
  }
  sh('git', ['-C', clone, 'worktree', 'prune']);
  const remoteBranch = sh('git', ['-C', clone, 'ls-remote', '--heads', 'origin', branch]);
  const startPoint = remoteBranch ? `origin/${branch}` : 'origin/main';
  sh('git', ['-C', clone, 'worktree', 'add', '-B', branch, worktree, startPoint]);
  const startCommit = sh('git', ['-C', worktree, 'rev-parse', 'HEAD']);
  log(`Building #${issue} "${data.title}" in ${worktree} (${startPoint}, Claude model ${effectiveModel})`);

  for (const [name, color, description] of [
    [NEXT_LABEL, 'fbca04', 'Next issue for a local mogra build (node src/local-runner.mjs next)'],
    [BUILT_LABEL, '0e8a16', 'Built locally by mogra; GitHub verifies, merges and deploys'],
    [`stack:${stack}`, '5319e7', ''],
    ['mogra:active', '0075ca', ''],
  ]) {
    sh('gh', ['label', 'create', name, '-R', repo, '--color', color, ...(description ? ['--description', description] : []), '--force']);
  }
  sh('gh', ['issue', 'edit', String(issue), '-R', repo, '--add-label', `stack:${stack},mogra:active`]);
  if (labels.includes(NEXT_LABEL)) sh('gh', ['issue', 'edit', String(issue), '-R', repo, '--remove-label', NEXT_LABEL]);

  const promptFile = join(worktree, '..', `mogra-prompt-${issue}.md`);
  writeFileSync(promptFile, composePrompt({ issueNumber: issue, stack, plan, issueTitle: data.title, issueBody: data.body ?? '' }));

  const pg = kind === 'rails' ? startPostgres() : null;
  const shim = kind === 'rails' ? yarnShimDir() : null;
  const env = {
    ...process.env,
    ...(pg ? { DATABASE_URL: pg.url } : {}),
    PATH: shim ? `${shim}:${process.env.PATH}` : process.env.PATH,
  };
  let ok = false;
  try {
    if (kind === 'node') {
      // The builder installs, tests and builds inside stacks/<stack>/; Claude may only change that folder.
      mkdirSync(join(worktree, 'stacks', stack), { recursive: true });
    } else if (!existsSync(join(worktree, 'config', 'application.rb'))) {
      execSync(`bash ${JSON.stringify(join(CONTROL_PLANE, 'scripts', 'bootstrap-rails.sh'))} . ${JSON.stringify(repo.split('/')[1])} ${JSON.stringify(routed.deployTarget)}`, {
        cwd: worktree,
        env,
        stdio: 'inherit',
      });
    }
    if (kind === 'rails') {
      execSync('bundle config set --local deployment false && bundle install --quiet', { cwd: worktree, env, stdio: 'inherit' });
      if (existsSync(join(worktree, 'package.json'))) execSync('yarn install --silent', { cwd: worktree, env, stdio: 'inherit' });
    }

    execFileSync(
      process.execPath,
      [join(CONTROL_PLANE, 'src', 'incremental-builder.mjs'), '--workdir', worktree, '--stack', stack, '--provider', 'claude-code', '--model', effectiveModel, '--prompt-file', promptFile],
      { cwd: worktree, env, stdio: 'inherit' },
    );
    ok = true;

    // Squash mogra's checkpoints into one commit, like the cloud build.
    sh('git', ['-C', worktree, 'reset', '--soft', startCommit]);
    const buildOutput = kind === 'node'
      ? ['node_modules', 'dist', 'playwright-report', 'test-results', 'sbom.cdx.json'].map((p) => join('stacks', stack, p))
      : ['vendor/bundle', '.bundle', 'node_modules', 'public/assets', 'config/master.key'];
    for (const p of buildOutput) rmSync(join(worktree, p), { recursive: true, force: true });
    sh('git', ['-C', worktree, 'add', '-A']);
    const title = changeTitle(data.title, issue, stack);
    sh('git', ['-C', worktree, 'commit', '-q', '-m', `${title}\n\nBuilt locally by ProductionLine (mogra) with Claude Code (${effectiveModel}).`]);
    sh('git', ['-C', worktree, 'push', '-q', '--force-with-lease', '-u', 'origin', branch]);

    let pr = sh('gh', ['pr', 'list', '-R', repo, '--head', branch, '--json', 'number', '--jq', '.[0].number // empty']);
    if (!pr) {
      const url = sh('gh', ['pr', 'create', '-R', repo, '--base', 'main', '--head', branch, '--title', title, '--body', `Closes #${issue}\n\nBuilt locally by ProductionLine (\`mogra\`) with Claude Code (\`${effectiveModel}\`); GitHub runs the independent verification, merge and deploy.`]);
      pr = url.split('/').pop();
    }
    // (Re)apply the label so the verify workflow runs for this push.
    try {
      sh('gh', ['pr', 'edit', pr, '-R', repo, '--remove-label', BUILT_LABEL]);
    } catch {
      /* not labelled yet */
    }
    sh('gh', ['pr', 'edit', pr, '-R', repo, '--add-label', BUILT_LABEL]);
    log(`PR #${pr} pushed and labelled ${BUILT_LABEL}: GitHub now verifies, merges, deploys and marks the next issue.`);
    return { pr: Number(pr), branch };
  } finally {
    pg?.stop();
    if (shim) rmSync(shim, { recursive: true, force: true });
    if (ok && !keep) {
      try {
        sh('git', ['-C', clone, 'worktree', 'remove', '--force', worktree]);
      } catch {
        /* leave it */
      }
    } else if (!ok) {
      log(`Build failed; the worktree is kept for inspection: ${worktree}`);
    }
  }
}

/** The open issue labelled mogra:next (set by the chain after a verified deploy), if any. */
export function nextIssue(repo) {
  const n = sh('gh', ['issue', 'list', '-R', repo, '--label', NEXT_LABEL, '--state', 'open', '--json', 'number', '--jq', '.[0].number // empty']);
  return n ? Number(n) : null;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = Object.fromEntries(
    rest.reduce((acc, cur, i, arr) => (cur.startsWith('--') ? [...acc, [cur.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']] : acc), []),
  );
  if (!flags.repo) throw new Error('--repo owner/name is required');
  if (command === 'build') {
    if (!flags.issue) throw new Error('--issue <number> is required');
    await build({ repo: flags.repo, issue: Number(flags.issue), model: flags.model, keep: flags.keep === 'true' });
  } else if (command === 'next') {
    const issue = nextIssue(flags.repo);
    if (!issue) return log(`No open issue labelled ${NEXT_LABEL} in ${flags.repo}.`);
    await build({ repo: flags.repo, issue, model: flags.model, keep: flags.keep === 'true' });
  } else {
    throw new Error('Usage: node src/local-runner.mjs <build --issue N | next> --repo owner/name [--model sonnet] [--keep]');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[mogra-local] ${err.message}`);
    process.exit(1);
  });
}
