import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESSES, SUPPORTED_STACKS } from './conventions.mjs';
import { parseYaml } from './yaml-lite.mjs';

/** Resolve agent specification, effective harness/model, and required skill paths. */
export function resolveAgentPlan({
  agentName,
  config,
  controlPlaneDir = process.cwd(),
  prompt = '',
  promptFile = '.mogra-work/prompt.md',
  stackOverride = null,
} = {}) {
  const registryPath = join(controlPlaneDir, 'agents', 'registry.yaml');
  const registry = parseYaml(readFileSync(registryPath, 'utf8'));
  const stackId = stackOverride && SUPPORTED_STACKS[stackOverride] ? stackOverride : config.outcome?.stack;
  const stackProfile = SUPPORTED_STACKS[stackId] ?? SUPPORTED_STACKS['react19-ts-vite'];

  const effectiveAgent = agentName || stackProfile.defaultAgent || 'frontend-builder';
  const agentDef = registry.agents?.[effectiveAgent];

  if (!agentDef) {
    throw new Error(`Unknown agent '${effectiveAgent}' in agents/registry.yaml`);
  }

  const override = config.agents?.[effectiveAgent] ?? {};
  const harnessName = override.harness ?? config.runtime.harness;
  const harnessSpec = HARNESSES[harnessName];
  if (!harnessSpec) {
    throw new Error(`Unknown harness '${harnessName}' for agent '${effectiveAgent}'`);
  }

  const model = override.model ?? (harnessName === config.runtime.harness ? config.runtime.model : harnessSpec.defaultModel);
  const baseSkills = Array.isArray(agentDef.skills) ? agentDef.skills : [];
  const capabilitySkills = Array.isArray(config.outcome?.capabilities) ? config.outcome.capabilities : [];
  const skills = [...new Set([...baseSkills, ...capabilitySkills])];
  const skillPaths = skills
    .map((s) => join(controlPlaneDir, 'skills', s, 'SKILL.md'))
    .filter((p) => existsSync(p));

  return {
    agent: effectiveAgent,
    stage: agentDef.stage,
    goal: agentDef.goal,
    harness: harnessName,
    model,
    envKey: harnessSpec.envKey,
    bin: harnessSpec.bin,
    args: harnessSpec.buildArgs({ model, prompt, promptFile }),
    stack: stackId,
    stackProfile,
    deliveryMode: config.outcome?.mode ?? 'greenfield-stack',
    skills,
    skillPaths,
  };
}
