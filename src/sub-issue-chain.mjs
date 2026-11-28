#!/usr/bin/env node
/**
 * Sub-issue chaining across milestones.
 *
 * Issues form a tree with GitHub sub-issues: a roadmap epic -> milestone epics -> buildable leaf issues.
 * Epics carry the `mogra:epic` label and are never built. When a leaf issue is merged and deployed,
 * mogra walks the tree to find the next open leaf, closing epics whose sub-issues are all done:
 *
 *   next open sibling in the same parent        -> start it (or its first open leaf, if it is an epic)
 *   no open sibling                             -> close the parent, move up and repeat
 *   next sibling is an epic without sub-issues  -> pause the chain on that epic
 *
 * Usage (deploy job): GH_TOKEN=... node sub-issue-chain.mjs --repo owner/name --issue 13 [--mode cloud|local]
 * In local build mode the next issue is labelled mogra:next (built by `mogra build`/`next` on your
 * machine) instead of mogra:run (built by GitHub Actions).
 */

export const EPIC_LABEL = 'mogra:epic';
export const QUEUED_LABEL = 'mogra:queued';
export const RUN_LABEL = 'mogra:run';
export const NEXT_LABEL = 'mogra:next';

const isEpic = (issue) => (issue.labels ?? []).some((l) => (typeof l === 'string' ? l : l?.name) === EPIC_LABEL);

/** First open leaf at or below `issue`, or a pause when an epic has no open sub-issues yet. */
async function descend(issue, api) {
  if (!isEpic(issue)) return { next: issue };
  const open = (await api.subIssues(issue.number)).filter((s) => s.state === 'open');
  if (open.length === 0) return { paused: issue };
  return descend(open[0], api);
}

/**
 * Plan the chain step after `issueNumber` finished. Pure apart from the read-only `api`
 * ({ parent(n) -> issue|null, subIssues(n) -> issue[] }), so it can be tested without GitHub.
 * Returns { close: [{ number, after }], next: issue|null, paused: issue|null }.
 */
export async function planNext(issueNumber, api) {
  const close = [];
  let child = issueNumber;
  for (let depth = 0; depth < 10; depth++) {
    const parent = await api.parent(child);
    if (!parent) return { close, next: null, paused: null };
    const sibling = (await api.subIssues(parent.number)).find((s) => s.state === 'open' && s.number !== child);
    if (sibling) {
      const { next = null, paused = null } = await descend(sibling, api);
      return { close, next, paused };
    }
    close.push({ number: parent.number, after: child });
    child = parent.number;
  }
  return { close, next: null, paused: null };
}

function githubApi(repo, token) {
  const base = `https://api.github.com/repos/${repo}`;
  const request = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'mogra-sub-issue-chain',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
    return res.status === 204 ? {} : res.json();
  };
  return {
    parent: (n) => request('GET', `/issues/${n}/parent`),
    subIssues: async (n) => (await request('GET', `/issues/${n}/sub_issues?per_page=100`)) ?? [],
    comment: (n, body) => request('POST', `/issues/${n}/comments`, { body }),
    close: (n) => request('PATCH', `/issues/${n}`, { state: 'closed', state_reason: 'completed' }),
    removeLabel: (n, label) => request('DELETE', `/issues/${n}/labels/${encodeURIComponent(label)}`),
    addLabel: (n, label) => request('POST', `/issues/${n}/labels`, { labels: [label] }),
  };
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, cur, i, arr) => (cur.startsWith('--') ? [...acc, [cur.slice(2), arr[i + 1]]] : acc), []),
  );
  const token = process.env.GH_TOKEN;
  if (!token) {
    console.log('::warning::MOGRA_BOT_TOKEN not set; sub-issue chaining skipped.');
    return;
  }
  const issue = Number(args.issue);
  const api = githubApi(args.repo, token);
  const plan = await planNext(issue, api);

  for (const { number, after } of plan.close) {
    await api.comment(number, `ProductionLine (\`mogra\`): #${after} is done, and so are all other sub-issues. Closing.`);
    await api.close(number);
    console.log(`[mogra] Closed #${number}: all sub-issues done.`);
  }
  const local = args.mode === 'local';
  if (plan.next) {
    await api.removeLabel(plan.next.number, QUEUED_LABEL);
    await api.removeLabel(plan.next.number, local ? NEXT_LABEL : RUN_LABEL);
    await api.addLabel(plan.next.number, local ? NEXT_LABEL : RUN_LABEL);
    const parent = await api.parent(plan.next.number);
    const action = local
      ? `#${plan.next.number} is next: build it locally with \`node src/local-runner.mjs next --repo ${args.repo}\``
      : `starting #${plan.next.number}`;
    if (parent) await api.comment(parent.number, `ProductionLine (\`mogra\`): #${issue} merged and deployed; ${action}.`);
    console.log(`[mogra] ${local ? 'Marked' : 'Started'} #${plan.next.number}${local ? ` (${NEXT_LABEL})` : ''}.`);
  } else if (plan.paused) {
    await api.comment(
      plan.paused.number,
      `ProductionLine (\`mogra\`): the chain reached this milestone after #${issue}, but it has no open sub-issues yet. Add sub-issues (labelled \`${QUEUED_LABEL}\`) and label the first one \`${RUN_LABEL}\` to continue.`,
    );
    console.log(`[mogra] Chain paused at #${plan.paused.number}: no sub-issues yet.`);
  } else {
    console.log(`[mogra] #${issue}: nothing to chain.`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[mogra] Sub-issue chaining failed: ${err.message}`);
    process.exit(1);
  });
}
