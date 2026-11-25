#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { buildIssueUpdate } from './issue-router.mjs';
import { resolveAgentPlan } from './harness-runner.mjs';
import { formatEvidenceLedger } from './evidence.mjs';

const DEFAULT_CONTROL_PLANE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      flags[key] = next && !next.startsWith('--') ? (i++, next) : 'true';
    }
  }
  return flags;
}

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const controlPlaneDir = flags['control-plane'] ? resolve(flags['control-plane']) : DEFAULT_CONTROL_PLANE;
const spokeDir = flags.spoke ? resolve(flags.spoke) : null;

try {
  const config = loadConfig({ controlPlaneDir, spokeDir });

  if (command === 'validate' || command === 'resolve-config') {
    console.log(JSON.stringify(config, null, 2));
  } else if (command === 'route-issue') {
    const title = flags.title ?? '';
    const body = flags['body-file'] ? readFileSync(flags['body-file'], 'utf8') : (flags.body ?? '');
    const labels = flags.labels ? flags.labels.split(',').map((s) => s.trim()).filter(Boolean) : [];
    console.log(JSON.stringify(buildIssueUpdate({ title, body, labels, config }), null, 2));
  } else if (command === 'plan-agent') {
    const agentName = flags.agent ?? 'frontend-builder';
    const prompt = flags.prompt ?? '';
    console.log(JSON.stringify(resolveAgentPlan({ agentName, config, controlPlaneDir, prompt }), null, 2));
  } else if (command === 'evidence') {
    const checks = flags['checks-file'] ? JSON.parse(readFileSync(flags['checks-file'], 'utf8')) : [];
    console.log(formatEvidenceLedger({
      stack: config.outcome.stack,
      harness: config.runtime.harness,
      model: config.runtime.model,
      checks,
    }));
  } else {
    console.error('Usage: node src/cli.mjs <validate|resolve-config|route-issue|plan-agent|evidence> [--flags]');
    process.exit(1);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
