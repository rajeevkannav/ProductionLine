import { SUPPORTED_STACKS } from './conventions.mjs';

const META_START = '<!-- mogra:meta:start -->';
const META_END = '<!-- mogra:meta:end -->';

/**
 * Resolve stack ID from issue labels (`stack:<id>`), GitHub Issue form markdown (`### Stack`),
 * inline `stack: <id>` directive, or platform hints (`android`/`ios`), falling back to config default.
 */
export function resolveIssueStack({ labels = [], body = '', title = '', defaultStack = 'react19-ts-vite' } = {}) {
  for (const label of labels) {
    const name = typeof label === 'string' ? label : label?.name ?? '';
    if (name.startsWith('stack:')) {
      const candidate = name.slice('stack:'.length).trim();
      if (SUPPORTED_STACKS[candidate]) return candidate;
    }
    if (name === 'android' || name === 'mobile:android') return 'android-hotwire-native';
    if (name === 'ios' || name === 'mobile:ios') return 'ios-hotwire-native';
  }

  const formMatch = body.match(/###\s*(?:TodoMVC\+?\s*|Target\s*)?Stack[^\n]*\n+([^\n#]+)/i);
  const inlineMatch = body.match(/\bstack\s*:\s*([a-z0-9-]+)/i);
  const rawCandidate = (formMatch?.[1] ?? inlineMatch?.[1] ?? '').trim().toLowerCase();

  for (const stackId of Object.keys(SUPPORTED_STACKS)) {
    if (rawCandidate === stackId || rawCandidate.startsWith(stackId)) {
      return stackId;
    }
  }

  if (/^feat\(android\)/i.test(title)) return 'android-hotwire-native';
  if (/^feat\(ios\)/i.test(title)) return 'ios-hotwire-native';

  return SUPPORTED_STACKS[defaultStack] ? defaultStack : 'react19-ts-vite';
}

/** Upsert the mogra metadata table inside the GitHub Issue body with stack & mode details. */
export function upsertIssueMetadata(
  body = '',
  {
    stack,
    blueprint = 'todomvc-plus',
    harness = 'antigravity',
    model = 'gemini-2.5-pro',
    hitlEnabled = false,
    deliveryMode = 'greenfield-stack',
    deployTarget = 'github-pages',
  } = {},
) {
  const stackInfo = SUPPORTED_STACKS[stack];
  const rows = [
    META_START,
    `> **ProductionLine (\`mogra\`) Run Metadata**`,
    `| Field | Value |`,
    `| :--- | :--- |`,
    `| Blueprint | \`${blueprint}\` |`,
    `| Stack | \`${stack}\` (${stackInfo?.label ?? stack}) |`,
    `| Harness / Model | \`${harness}\` / \`${model}\` |`,
    `| Mode | ${hitlEnabled ? 'Human-in-the-Loop Enabled' : 'Autonomous (HITL Off)'} |`,
  ];

  if (deliveryMode !== 'greenfield-stack' || deployTarget !== 'github-pages') {
    rows.push(`| Delivery / Deploy | \`${deliveryMode}\` → \`${deployTarget}\` |`);
  }
  rows.push(META_END);

  const block = rows.join('\n');
  const pattern = new RegExp(`${META_START}[\\s\\S]*?${META_END}`, 'm');
  if (pattern.test(body)) {
    return body.replace(pattern, block);
  }
  return body.trim() ? `${block}\n\n${body.trim()}` : block;
}

/** Compute updated title and labels ensuring the stack metadata is reflected on the issue. */
export function buildIssueUpdate({ title = '', body = '', labels = [], config }) {
  const stack = resolveIssueStack({
    labels,
    body,
    title,
    defaultStack: config.outcome.stack,
  });
  const stackProfile = SUPPORTED_STACKS[stack];
  const deliveryMode = config.outcome?.mode ?? 'greenfield-stack';
  const deployTarget = config.deployment?.target ?? 'github-pages';

  const cleanLabels = labels
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter((name) => name && !name.startsWith('stack:'));

  const updatedLabels = [...new Set([...cleanLabels, `stack:${stack}`, 'mogra:active'])];
  const tag = `[${stack}]`;
  const appendTag = deliveryMode === 'greenfield-stack';
  const updatedTitle = appendTag && !title.includes(tag) ? `${title.trim()} ${tag}`.trim() : title.trim();
  const updatedBody = upsertIssueMetadata(body, {
    stack,
    blueprint: config.outcome.blueprint,
    harness: config.runtime.harness,
    model: config.runtime.model,
    hitlEnabled: Boolean(config.human_in_the_loop?.enabled),
    deliveryMode,
    deployTarget,
  });

  return {
    stack,
    title: updatedTitle,
    labels: updatedLabels,
    body: updatedBody,
    stackProfile,
    deliveryMode,
    deployTarget,
  };
}
