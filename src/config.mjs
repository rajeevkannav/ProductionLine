import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONVENTIONS,
  HARNESSES,
  SUPPORTED_DELIVERY_MODES,
  SUPPORTED_DEPLOY_TARGETS,
  SUPPORTED_STACKS,
} from './conventions.mjs';
import { parseYaml } from './yaml-lite.mjs';

/** Deep-merge plain objects without mutating inputs. */
export function mergeConfig(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = mergeConfig(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function readOptionalYaml(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  return parseYaml(readFileSync(filePath, 'utf8'));
}

/** Validate resolved configuration against factory conventions and constraints. */
export function validateConfig(cfg) {
  const errors = [];
  if (cfg.version !== 1) errors.push(`Unsupported version: ${cfg.version}`);
  if (!HARNESSES[cfg.runtime?.harness]) {
    errors.push(`Unknown runtime.harness: ${cfg.runtime?.harness}`);
  }
  if (!SUPPORTED_STACKS[cfg.outcome?.stack]) {
    errors.push(`Unsupported outcome.stack: ${cfg.outcome?.stack}`);
  }
  if (cfg.outcome?.mode && !SUPPORTED_DELIVERY_MODES.includes(cfg.outcome.mode)) {
    errors.push(`Unsupported outcome.mode: ${cfg.outcome.mode}`);
  }
  if (cfg.deployment?.target && !SUPPORTED_DEPLOY_TARGETS.includes(cfg.deployment.target)) {
    errors.push(`Unsupported deployment.target: ${cfg.deployment.target}`);
  }
  for (const [agentName, agentCfg] of Object.entries(cfg.agents ?? {})) {
    if (agentCfg?.harness && !HARNESSES[agentCfg.harness]) {
      errors.push(`Unknown harness for agent '${agentName}': ${agentCfg.harness}`);
    }
  }
  if (errors.length) {
    throw new Error(`Invalid mogra configuration:\n- ${errors.join('\n- ')}`);
  }
  return cfg;
}

/**
 * Load effective factory config by layering:
 * conventions -> control-plane mogra.yaml -> spoke .mogra.yaml -> runtime overrides.
 */
export function loadConfig({ controlPlaneDir = process.cwd(), spokeDir = null, override = {} } = {}) {
  const controlCfg = readOptionalYaml(join(controlPlaneDir, 'mogra.yaml'));
  const spokeCfg = spokeDir ? readOptionalYaml(join(spokeDir, '.mogra.yaml')) : {};

  let resolved = mergeConfig(CONVENTIONS, controlCfg);
  resolved = mergeConfig(resolved, spokeCfg);
  resolved = mergeConfig(resolved, override);

  // If HITL is disabled globally, keep individual checkpoints off unless explicitly enabled
  if (resolved.human_in_the_loop?.enabled) {
    resolved.human_in_the_loop.checkpoints = {
      ...resolved.human_in_the_loop.checkpoints,
      spec_approval: spokeCfg.human_in_the_loop?.checkpoints?.spec_approval ?? true,
      pr_review_required: spokeCfg.human_in_the_loop?.checkpoints?.pr_review_required ?? true,
    };
  }

  return validateConfig(resolved);
}
