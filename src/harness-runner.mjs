import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESSES } from './conventions.mjs';
import { parseYaml } from './yaml-lite.mjs';

/** Resolve agent specification, effective harness/model, and required skill paths. */
export function resolveAgentPlan({ agentName, config, controlPlaneDir = process.cwd(), prompt = '', promptFile = '.mogra-work/prompt.md' }) {
  const registryPath = join(controlPlaneDir, 'agents', 'registry.yaml');
  const registry = parseYaml(readFileSync(registryPath, 'utf8'));
  const agentDef = registry.agents?.[agentName];

  if (!agentDef) {
    throw new Error(`Unknown agent '${agentName}' in agents/registry.yaml`);
  }

  const override = config.agents?.[agentName] ?? {};
  const harnessName = override.harness ?? config.runtime.harness;
  const harnessSpec = HARNESSES[harnessName];
  if (!harnessSpec) {
    throw new Error(`Unknown harness '${harnessName}' for agent '${agentName}'`);
  }

  const model = override.model ?? (harnessName === config.runtime.harness ? config.runtime.model : harnessSpec.defaultModel);
  const skills = Array.isArray(agentDef.skills) ? agentDef.skills : [];
  const skillPaths = skills.map((s) => join(controlPlaneDir, 'skills', s, 'SKILL.md'));

  return {
    agent: agentName,
    stage: agentDef.stage,
    goal: agentDef.goal,
    harness: harnessName,
    model,
    envKey: harnessSpec.envKey,
    bin: harnessSpec.bin,
    args: harnessSpec.buildArgs({ model, prompt, promptFile }),
    skills,
    skillPaths,
  };
}
