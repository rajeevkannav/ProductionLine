#!/usr/bin/env node
/**
 * Generates the TodoMVC+ Showcase Portal (index.html) styled with the QuantumBlack Design System,
 * backed by real on-disk stack artifacts, skill definitions, .mogra-metrics.json telemetry,
 * and live GitHub Issues / Pull Requests / Actions run history.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { SUPPORTED_STACKS } from './conventions.mjs';
import { resolveIssueStack } from './issue-router.mjs';

const DEFAULT_CONTROL_PLANE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const STACK_LABELS = {
  'react19-ts-vite': 'React 19 + TypeScript + Vite',
  'vue3-ts-vite': 'Vue 3 + TypeScript + Vite',
  'svelte5-ts-vite': 'Svelte 5 + TypeScript + Vite',
  'angular-ts': 'Angular + TypeScript',
  'solid-ts-vite': 'SolidJS + TypeScript + Vite',
};

const PIPELINE_STAGES = [
  {
    step: '01',
    name: 'Issue Intake & Routing',
    detail: 'Reads GitHub Issue forms & labels, validates stack conventions in .mogra.yaml, and attaches routing metadata.',
  },
  {
    step: '02',
    name: 'Autonomous AI Build',
    detail: 'Free-tier single-shot + surgical-repair engine calls Gemini models with scoped context and 7 Agent Skills.',
  },
  {
    step: '03',
    name: 'Independent DevSecOps Gate',
    detail: 'Runs Vitest unit tests, Vite/Angular build, Playwright E2E, 320px reflow, axe-core WCAG 2.2 AA, Gitleaks, npm audit, and SBOM.',
  },
  {
    step: '04',
    name: 'Auto-Merge & Pages Deploy',
    detail: 'Squash-merges verified PRs, compiles every stack with sub-path base routing, and publishes this portal.',
  },
];

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  const totalSec = Math.round(n / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

export function formatTokens(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n.toLocaleString('en-US');
}

export function formatUtcTimestamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Parse frontmatter name/description cleanly from skills/asterisks/SKILL.md. */
export function readSkillsCatalog(controlPlaneDir) {
  const skillsRoot = join(controlPlaneDir, 'skills');
  if (!existsSync(skillsRoot)) return [];
  const entries = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  return entries
    .map((dir) => {
      const skillFile = join(skillsRoot, dir.name, 'SKILL.md');
      if (!existsSync(skillFile)) return null;
      const raw = readFileSync(skillFile, 'utf8');
      const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      let name = dir.name;
      let description = '';
      if (fmMatch) {
        const nameLine = fmMatch[1].match(/^name:\s*(.+)$/m);
        const descLine = fmMatch[1].match(/^description:\s*(.+)$/m);
        if (nameLine) name = nameLine[1].trim().replace(/^["']|["']$/g, '');
        if (descLine) description = descLine[1].trim().replace(/^["']|["']$/g, '');
      }
      return { id: dir.name, name, description };
    })
    .filter(Boolean);
}

/** Inspect on-disk stacks/* and optional .mogra-metrics.json files. */
export function readDiskStacks(stacksDir, builtStackNames = null) {
  const result = {};
  if (!stacksDir || !existsSync(stacksDir)) return result;
  for (const entry of readdirSync(stacksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const stackId = entry.name;
    const dir = join(stacksDir, stackId);
    const hasPkg = existsSync(join(dir, 'package.json'));
    const built = Array.isArray(builtStackNames) ? builtStackNames.includes(stackId) : hasPkg;
    let metrics = null;
    const metricsPath = join(dir, '.mogra-metrics.json');
    if (existsSync(metricsPath)) {
      try {
        metrics = JSON.parse(readFileSync(metricsPath, 'utf8'));
      } catch {
        metrics = null;
      }
    }
    result[stackId] = { stackId, hasPkg, built, metrics };
  }
  return result;
}

async function fetchJson(url, token, fetchImpl) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ProductionLine-Mogra-Portal',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
  return res.json();
}

/** Fetch live repository issues, PRs, and SDLC workflow run timelines with graceful fallback. */
export async function fetchGithubTelemetry({ repo, token = '', fetchImpl = globalThis.fetch } = {}) {
  if (!repo || typeof fetchImpl !== 'function') {
    return { apiLive: false, issues: [], pulls: [], runs: [], jobsByRun: {} };
  }
  try {
    const [rawIssues, rawPulls, rawRuns] = await Promise.all([
      fetchJson(`https://api.github.com/repos/${repo}/issues?state=all&per_page=30&sort=created&direction=asc`, token, fetchImpl),
      fetchJson(`https://api.github.com/repos/${repo}/pulls?state=all&per_page=30`, token, fetchImpl),
      fetchJson(`https://api.github.com/repos/${repo}/actions/workflows/mogra-sdlc.yml/runs?per_page=20`, token, fetchImpl),
    ]);

    const issues = Array.isArray(rawIssues)
      ? rawIssues
          .filter((item) => !item.pull_request)
          .map((item) => ({
            number: item.number,
            title: item.title,
            state: item.state,
            createdAt: item.created_at,
            closedAt: item.closed_at,
            htmlUrl: item.html_url,
            labels: (item.labels ?? []).map((l) => l.name),
            stackId: resolveIssueStack({
              labels: (item.labels ?? []).map((l) => l.name),
              body: item.body ?? '',
              defaultStack: '',
            }) || inferStackFromText(`${item.title}\n${item.body ?? ''}`),
          }))
      : [];

    const pulls = Array.isArray(rawPulls)
      ? rawPulls.map((pr) => ({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          mergedAt: pr.merged_at,
          createdAt: pr.created_at,
          htmlUrl: pr.html_url,
          headRef: pr.head?.ref ?? '',
          mergeCommitSha: pr.merge_commit_sha ?? '',
        }))
      : [];

    const runs = Array.isArray(rawRuns?.workflow_runs)
      ? rawRuns.workflow_runs.map((run) => ({
          id: run.id,
          runNumber: run.run_number,
          displayTitle: run.display_title ?? run.name ?? '',
          event: run.event,
          status: run.status,
          conclusion: run.conclusion,
          createdAt: run.created_at,
          startedAt: run.run_started_at ?? run.created_at,
          updatedAt: run.updated_at,
          htmlUrl: run.html_url,
        }))
      : [];

    const candidateRuns = runs.filter((r) => r.conclusion === 'success' && r.event !== 'repository_dispatch').slice(0, 6);
    const jobsEntries = await Promise.all(
      candidateRuns.map(async (run) => {
        try {
          const data = await fetchJson(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs?per_page=20`, token, fetchImpl);
          const jobs = (data.jobs ?? []).map((j) => ({
            name: j.name,
            conclusion: j.conclusion,
            durationMs: j.started_at && j.completed_at ? new Date(j.completed_at) - new Date(j.started_at) : null,
          }));
          return [run.id, jobs];
        } catch {
          return [run.id, []];
        }
      }),
    );

    return {
      apiLive: true,
      issues,
      pulls,
      runs,
      jobsByRun: Object.fromEntries(jobsEntries),
    };
  } catch (err) {
    console.warn(`[pages-portal] GitHub telemetry unavailable (${err.message}); using local repository state.`);
    return { apiLive: false, issues: [], pulls: [], runs: [], jobsByRun: {} };
  }
}

function inferStackFromText(text) {
  for (const stackId of Object.keys(SUPPORTED_STACKS)) {
    if (String(text ?? '').includes(stackId)) return stackId;
  }
  return '';
}

function matchIssueArtifacts(stackId, issue, pulls, runs, jobsByRun) {
  const issueNum = issue?.number;
  const pr = pulls.find((p) => {
    if (issueNum && (p.headRef.includes(`issue-${issueNum}-`) || p.title.includes(`#${issueNum}`))) return true;
    return p.headRef.includes(stackId) || p.title.includes(stackId);
  }) ?? null;

  const run = runs.find((r) => {
    if (issueNum && r.displayTitle.includes(`#${issueNum}`)) return true;
    return r.displayTitle.includes(stackId);
  }) ?? null;

  const jobs = run ? (jobsByRun[run.id] ?? []) : [];
  const totalJobMs = jobs.reduce((sum, j) => sum + (Number(j.durationMs) || 0), 0);
  const wallMs = run?.startedAt && run?.updatedAt ? new Date(run.updatedAt) - new Date(run.startedAt) : null;

  return { pr, run, jobs, durationMs: wallMs ?? (totalJobMs > 0 ? totalJobMs : null) };
}

export function renderShowcaseHtml({
  repo = 'rajeevkannav/TodoMVC-Plus',
  controlPlaneRepo = 'rajeevkannav/ProductionLine',
  rootBase = '/',
  diskStacks = {},
  telemetry = { apiLive: false, issues: [], pulls: [], runs: [], jobsByRun: {} },
  skills = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const normalizedBase = rootBase.endsWith('/') ? rootBase : `${rootBase}/`;
  const stackOrder = Object.keys(SUPPORTED_STACKS);
  const { issues = [], pulls = [], runs = [], jobsByRun = {}, apiLive = false } = telemetry;

  const rows = stackOrder.map((stackId, index) => {
    const issue = issues.find((i) => i.stackId === stackId) ?? null;
    const disk = diskStacks[stackId] ?? { stackId, hasPkg: false, built: false, metrics: null };
    const matched = matchIssueArtifacts(stackId, issue, pulls, runs, jobsByRun);
    const isLive = Boolean(disk.built);
    const href = `${normalizedBase}${stackId}/`;
    return {
      order: index + 1,
      stackId,
      label: STACK_LABELS[stackId] ?? stackId,
      summary: SUPPORTED_STACKS[stackId],
      isLive,
      href,
      issue,
      disk,
      ...matched,
    };
  });

  const liveCount = rows.filter((r) => r.isLive).length;
  const closedIssuesCount = issues.filter((i) => i.state === 'closed').length;
  const openIssuesCount = issues.filter((i) => i.state === 'open').length;

  const measuredMetrics = rows
    .map((r) => r.disk.metrics?.totals)
    .filter((t) => t && Number.isFinite(t.totalTokens) && t.totalTokens > 0);
  const aggregateTokens = measuredMetrics.reduce((acc, t) => acc + t.totalTokens, 0);
  const aggregateCalls = measuredMetrics.reduce((acc, t) => acc + (t.calls ?? 0), 0);

  const pagesDeployRuns = runs.filter((r) => r.conclusion === 'success').length;
  const repoUrl = `https://github.com/${escapeHtml(repo)}`;
  const controlUrl = `https://github.com/${escapeHtml(controlPlaneRepo)}`;

  const stackCardsHtml = rows
    .map((row) => {
      const statusPill = row.isLive
        ? '<span class="pill pill-live"><span class="dot"></span>LIVE ON PAGES</span>'
        : row.issue?.state === 'open'
          ? '<span class="pill pill-queued">QUEUED ISSUE</span>'
          : '<span class="pill pill-idle">PLANNED</span>';

      const issueLink = row.issue
        ? `<a class="meta-link" href="${escapeHtml(row.issue.htmlUrl)}" target="_blank" rel="noopener noreferrer">Issue #${row.issue.number}</a>`
        : `<span class="meta-muted">Issue #${row.order}</span>`;

      const prLink = row.pr
        ? `<a class="meta-link" href="${escapeHtml(row.pr.htmlUrl)}" target="_blank" rel="noopener noreferrer">PR #${row.pr.number}${row.pr.mergedAt ? ' · Merged' : ''}</a>`
        : '<span class="meta-muted">No PR yet</span>';

      const durationText = row.durationMs ? formatDuration(row.durationMs) : 'Awaiting trigger';
      const tokensText = row.disk.metrics?.totals?.totalTokens
        ? `${formatTokens(row.disk.metrics.totals.totalTokens)} tok`
        : row.isLive
          ? 'Pre-telemetry run'
          : '—';

      const actionHtml = row.isLive
        ? `<a class="btn btn-primary" href="${escapeHtml(row.href)}">Launch ${escapeHtml(row.stackId)} <span aria-hidden="true">→</span></a>`
        : row.issue
          ? `<a class="btn btn-ghost" href="${escapeHtml(row.issue.htmlUrl)}" target="_blank" rel="noopener noreferrer">Inspect Queued Issue #${row.issue.number}</a>`
          : '<span class="btn btn-disabled" aria-disabled="true">Awaiting Issue</span>';

      return `
      <article class="card stack-card ${row.isLive ? 'is-live' : 'is-queued'}">
        <div class="stack-card-top">
          <div>
            <p class="eyebrow mono">${escapeHtml(row.stackId)}</p>
            <h3>${escapeHtml(row.label)}</h3>
          </div>
          ${statusPill}
        </div>
        <p class="card-desc">${escapeHtml(row.summary)}</p>
        <dl class="mini-metrics mono">
          <div><dt>Links</dt><dd>${issueLink} · ${prLink}</dd></div>
          <div><dt>CI Time</dt><dd>${escapeHtml(durationText)}</dd></div>
          <div><dt>Tokens</dt><dd>${escapeHtml(tokensText)}</dd></div>
        </dl>
        <div class="card-actions">${actionHtml}</div>
      </article>`;
    })
    .join('\n');

  const timelineRowsHtml = rows
    .map((row) => {
      const stateBadge = row.issue
        ? row.issue.state === 'closed'
          ? '<span class="pill pill-live">CLOSED</span>'
          : '<span class="pill pill-queued">OPEN</span>'
        : '<span class="pill pill-idle">PENDING</span>';

      const issueCell = row.issue
        ? `<a href="${escapeHtml(row.issue.htmlUrl)}" target="_blank" rel="noopener noreferrer">#${row.issue.number}</a> <span class="muted">(${escapeHtml(formatUtcTimestamp(row.issue.createdAt))})</span>`
        : `#${row.order}`;

      const prCell = row.pr
        ? `<a href="${escapeHtml(row.pr.htmlUrl)}" target="_blank" rel="noopener noreferrer">PR #${row.pr.number}</a>`
        : '—';

      const runCell = row.run
        ? `<a href="${escapeHtml(row.run.htmlUrl)}" target="_blank" rel="noopener noreferrer">Run #${row.run.runNumber}</a>`
        : '—';

      const jobBreakdown = row.jobs.length
        ? row.jobs
            .filter((j) => j.durationMs != null)
            .map((j) => `${j.name.replace(' (verify + playwright + axe + sbom)', '')}: ${formatDuration(j.durationMs)}`)
            .join(' · ')
        : row.isLive
          ? 'Build + Verify + Pages'
          : 'Awaiting dispatch';

      return `
      <tr>
        <td class="mono">${issueCell}</td>
        <td><strong>${escapeHtml(row.stackId)}</strong><div class="subcell">${escapeHtml(jobBreakdown)}</div></td>
        <td>${stateBadge}</td>
        <td class="mono">${prCell}</td>
        <td class="mono">${runCell}</td>
        <td class="mono num">${escapeHtml(row.durationMs ? formatDuration(row.durationMs) : '—')}</td>
      </tr>`;
    })
    .join('\n');

  const tokenRowsHtml = rows
    .map((row) => {
      const m = row.disk.metrics;
      const t = m?.totals;
      const models = m?.calls?.length ? [...new Set(m.calls.map((c) => c.model))].join(', ') : '—';
      const note = t
        ? `${t.calls} API call${t.calls === 1 ? '' : 's'} (${formatDuration(t.elapsedMs)})`
        : row.isLive
          ? 'Merged before .mogra-metrics.json capture (Free-Tier 1-shot)'
          : 'Not executed yet';
      return `
      <tr>
        <td class="mono">${row.issue ? `#${row.issue.number}` : `#${row.order}`} · ${escapeHtml(row.stackId)}</td>
        <td class="mono num">${escapeHtml(t ? String(t.calls) : '—')}</td>
        <td class="mono num">${escapeHtml(t ? formatTokens(t.promptTokens) : '—')}</td>
        <td class="mono num">${escapeHtml(t ? formatTokens(t.candidatesTokens) : '—')}</td>
        <td class="mono num strong">${escapeHtml(t ? formatTokens(t.totalTokens) : '—')}</td>
        <td class="mono">${escapeHtml(models)}</td>
        <td class="subcell-td">${escapeHtml(note)}</td>
      </tr>`;
    })
    .join('\n');

  const skillsHtml = skills
    .map(
      (s) => `
      <article class="card skill-card">
        <div class="skill-head">
          <span class="mono skill-id">${escapeHtml(s.id)}</span>
          <span class="pill pill-skill">SKILL.md</span>
        </div>
        <p>${escapeHtml(s.description || s.name)}</p>
      </article>`,
    )
    .join('\n');

  const stagesHtml = PIPELINE_STAGES.map(
    (s) => `
      <article class="card stage-card">
        <span class="stage-step mono">${escapeHtml(s.step)}</span>
        <h3>${escapeHtml(s.name)}</h3>
        <p>${escapeHtml(s.detail)}</p>
      </article>`,
  ).join('\n');

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TodoMVC+ Showcase — Autonomous Code AI Software Factory (ProductionLine / mogra)</title>
  <meta name="description" content="TodoMVC+ benchmark built autonomously by Code AI agents & skills running on GitHub Actions cloud runners, styled with QuantumBlack design tokens." />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <script>
    (function(){try{var t=localStorage.getItem('mogra-portal-theme');document.documentElement.dataset.theme=(t==='light'||t==='dark')?t:'dark';}catch(e){}})();
  </script>
  <style>
    :root {
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 14px;
    }
    html[data-theme="dark"] {
      color-scheme: dark;
      --bg-canvas: oklch(12.9% 0.042 264.695);
      --bg-surface: oklch(18.2% 0.036 265);
      --bg-elevated: oklch(22.2% 0.038 265);
      --border-hairline: oklch(100% 0 0 / 0.11);
      --border-strong: oklch(100% 0 0 / 0.22);
      --text-primary: #f8fafc;
      --text-secondary: #cbd5e1;
      --text-muted: #94a3b8;
      --accent-teal: #2dd4bf;
      --accent-teal-bg: rgba(45, 212, 191, 0.12);
      --accent-sky: #38bdf8;
      --accent-green: #4ade80;
      --accent-green-bg: rgba(74, 222, 128, 0.12);
      --accent-amber: #fbbf24;
      --accent-amber-bg: rgba(251, 191, 36, 0.12);
      --btn-primary-bg: #2dd4bf;
      --btn-primary-fg: #042f2e;
      --btn-primary-hover: #5eead4;
      --grid-glow: radial-gradient(60rem 26rem at 15% -5%, rgba(45, 212, 191, 0.13), transparent 70%),
                   radial-gradient(48rem 24rem at 85% 0%, rgba(56, 189, 248, 0.10), transparent 65%);
    }
    html[data-theme="light"] {
      color-scheme: light;
      --bg-canvas: #f8fafc;
      --bg-surface: #ffffff;
      --bg-elevated: #f1f5f9;
      --border-hairline: rgba(15, 23, 42, 0.12);
      --border-strong: rgba(15, 23, 42, 0.24);
      --text-primary: #0f172a;
      --text-secondary: #334155;
      --text-muted: #475569;
      --accent-teal: #0f766e;
      --accent-teal-bg: rgba(15, 118, 110, 0.10);
      --accent-sky: #0369a1;
      --accent-green: #15803d;
      --accent-green-bg: rgba(21, 128, 61, 0.10);
      --accent-amber: #b45309;
      --accent-amber-bg: rgba(180, 83, 9, 0.10);
      --btn-primary-bg: #0f766e;
      --btn-primary-fg: #ffffff;
      --btn-primary-hover: #115e59;
      --grid-glow: radial-gradient(60rem 26rem at 15% -5%, rgba(15, 118, 110, 0.08), transparent 70%),
                   radial-gradient(48rem 24rem at 85% 0%, rgba(3, 105, 161, 0.06), transparent 65%);
    }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: var(--font-sans);
      background-color: var(--bg-canvas);
      background-image: var(--grid-glow);
      color: var(--text-primary);
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }
    a { color: var(--accent-teal); text-decoration: none; }
    a:hover { text-decoration: underline; }
    a:focus-visible, button:focus-visible {
      outline: 2px solid var(--accent-sky);
      outline-offset: 2px;
    }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .container {
      width: 100%;
      max-width: 1180px;
      margin: 0 auto;
      padding: 0 16px;
    }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 20;
      backdrop-filter: blur(12px);
      background: color-mix(in srgb, var(--bg-canvas) 82%, transparent);
      border-bottom: 1px solid var(--border-hairline);
    }
    .topbar-inner {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 0;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      letter-spacing: -0.02em;
      color: var(--text-primary);
    }
    .brand-mark {
      display: inline-grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-strong);
      background: var(--bg-surface);
      color: var(--accent-teal);
      font-size: 13px;
      font-weight: 700;
    }
    .top-nav {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      font-size: 13px;
    }
    .nav-link {
      color: var(--text-secondary);
      padding: 6px 10px;
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
    }
    .nav-link:hover {
      border-color: var(--border-hairline);
      background: var(--bg-surface);
      text-decoration: none;
    }
    .theme-btn {
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 500;
      padding: 6px 12px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-strong);
      background: var(--bg-surface);
      color: var(--text-primary);
      cursor: pointer;
    }
    .theme-btn:hover { background: var(--bg-elevated); }
    main { padding: 36px 0 64px; }
    .hero {
      padding: 8px 0 28px;
      border-bottom: 1px solid var(--border-hairline);
    }
    .hero-tag {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--accent-teal);
      background: var(--accent-teal-bg);
      border: 1px solid color-mix(in srgb, var(--accent-teal) 35%, transparent);
      padding: 4px 10px;
      border-radius: 999px;
      margin-bottom: 16px;
    }
    h1 {
      margin: 0 0 12px;
      font-size: clamp(1.75rem, 4vw, 2.65rem);
      line-height: 1.12;
      letter-spacing: -0.035em;
      font-weight: 700;
    }
    .hero-sub {
      margin: 0;
      max-width: 72ch;
      color: var(--text-secondary);
      font-size: 1.02rem;
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 12px;
      margin-top: 24px;
    }
    .kpi-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-hairline);
      border-radius: var(--radius-md);
      padding: 16px;
    }
    .kpi-label {
      margin: 0 0 6px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
    }
    .kpi-value {
      margin: 0;
      font-size: 1.45rem;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    .kpi-sub {
      margin: 4px 0 0;
      font-size: 12px;
      color: var(--text-secondary);
    }
    section { margin-top: 40px; }
    .section-head {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 16px;
    }
    h2 {
      margin: 0;
      font-size: 1.3rem;
      letter-spacing: -0.02em;
    }
    .section-note {
      margin: 0;
      font-size: 13px;
      color: var(--text-muted);
    }
    .card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(270px, 1fr));
      gap: 14px;
    }
    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border-hairline);
      border-radius: var(--radius-md);
      padding: 18px;
      min-width: 0;
    }
    .stack-card.is-live { border-color: color-mix(in srgb, var(--accent-teal) 45%, var(--border-hairline)); }
    .stack-card.is-queued { opacity: 0.92; }
    .stack-card-top {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .eyebrow {
      margin: 0 0 2px;
      font-size: 11px;
      color: var(--accent-sky);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    h3 { margin: 0; font-size: 1.05rem; letter-spacing: -0.015em; }
    .card-desc {
      margin: 10px 0 14px;
      font-size: 13.5px;
      color: var(--text-secondary);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 999px;
      white-space: nowrap;
    }
    .pill-live { color: var(--accent-green); background: var(--accent-green-bg); }
    .pill-live .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .pill-queued { color: var(--accent-amber); background: var(--accent-amber-bg); }
    .pill-idle { color: var(--text-muted); background: var(--bg-elevated); }
    .pill-skill { color: var(--accent-teal); background: var(--accent-teal-bg); }
    .mini-metrics {
      display: grid;
      grid-template-columns: 1fr;
      gap: 6px;
      margin: 0 0 16px;
      padding: 10px 12px;
      border-radius: var(--radius-sm);
      background: var(--bg-elevated);
      font-size: 12px;
    }
    .mini-metrics > div {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 8px;
    }
    .mini-metrics dt { color: var(--text-muted); }
    .mini-metrics dd { margin: 0; color: var(--text-primary); }
    .meta-muted, .muted { color: var(--text-muted); }
    .card-actions { display: flex; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      padding: 9px 14px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      border: 1px solid transparent;
    }
    .btn:hover { text-decoration: none; }
    .btn-primary {
      background: var(--btn-primary-bg);
      color: var(--btn-primary-fg);
    }
    .btn-primary:hover { background: var(--btn-primary-hover); }
    .btn-ghost {
      background: transparent;
      border-color: var(--border-strong);
      color: var(--text-primary);
    }
    .btn-ghost:hover { background: var(--bg-elevated); }
    .btn-disabled {
      background: var(--bg-elevated);
      color: var(--text-muted);
      cursor: not-allowed;
    }
    .stage-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
      gap: 12px;
    }
    .stage-step {
      display: inline-block;
      font-size: 12px;
      font-weight: 600;
      color: var(--accent-teal);
      margin-bottom: 6px;
    }
    .stage-card p, .skill-card p {
      margin: 8px 0 0;
      font-size: 13px;
      color: var(--text-secondary);
    }
    .table-wrap {
      width: 100%;
      overflow-x: auto;
      background: var(--bg-surface);
      border: 1px solid var(--border-hairline);
      border-radius: var(--radius-md);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      text-align: left;
    }
    th, td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border-hairline);
      vertical-align: top;
    }
    th {
      font-family: var(--font-mono);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      background: var(--bg-elevated);
      white-space: nowrap;
    }
    tr:last-child td { border-bottom: 0; }
    .num { text-align: right; white-space: nowrap; }
    .strong { font-weight: 600; color: var(--accent-teal); }
    .subcell, .subcell-td { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
    .econ-banner {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 12px;
      margin-bottom: 14px;
    }
    .skill-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .skill-id { font-size: 13px; font-weight: 600; color: var(--text-primary); }
    footer {
      border-top: 1px solid var(--border-hairline);
      padding: 20px 0 36px;
      font-size: 12.5px;
      color: var(--text-muted);
    }
    .footer-inner {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 12px;
    }
    @media (max-width: 520px) {
      .container { padding: 0 12px; }
      .card, .kpi-card { padding: 14px; }
      th, td { padding: 10px; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="container topbar-inner">
      <a class="brand" href="${escapeHtml(normalizedBase)}">
        <span class="brand-mark mono">M</span>
        <span>TodoMVC+ // ProductionLine (mogra)</span>
      </a>
      <nav class="top-nav" aria-label="Portal sections">
        <a class="nav-link" href="#stacks">Stacks</a>
        <a class="nav-link" href="#journey">Cloud SDLC</a>
        <a class="nav-link" href="#timeline">Timeline</a>
        <a class="nav-link" href="#economics">Token Economics</a>
        <a class="nav-link" href="#skills">Agent Skills</a>
        <button type="button" class="theme-btn" id="themeToggle" aria-pressed="true">Theme: Dark</button>
      </nav>
    </div>
  </header>

  <main class="container">
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-tag mono">
        <span>AUTONOMOUS SOFTWARE FACTORY</span>
        <span>·</span>
        <span>GITHUB ACTIONS CLOUD RUNNERS</span>
        <span>·</span>
        <span>${apiLive ? 'LIVE GITHUB TELEMETRY' : 'LOCAL REPOSITORY SNAPSHOT'}</span>
      </div>
      <h1 id="hero-title">TodoMVC+ Showcase built by Code AI &amp; Agent Skills</h1>
      <p class="hero-sub">
        Every stack in <a href="${repoUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(repo)}</a> is designed, implemented,
        accessibility-audited (WCAG 2.2 AA+ &amp; 320px reflow), security-hardened, and deployed exclusively in the cloud by the
        <a href="${controlUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(controlPlaneRepo)}</a> control plane using
        specialized <code>SKILL.md</code> modules — with zero human code edits on the target repository.
      </p>

      <div class="kpi-grid">
        <article class="kpi-card">
          <p class="kpi-label">Built Stacks Live</p>
          <p class="kpi-value mono">${liveCount} / ${stackOrder.length}</p>
          <p class="kpi-sub">Multi-stack GitHub Pages matrix</p>
        </article>
        <article class="kpi-card">
          <p class="kpi-label">GitHub Issues Tracked</p>
          <p class="kpi-value mono">${closedIssuesCount} Closed · ${openIssuesCount} Queued</p>
          <p class="kpi-sub">${pagesDeployRuns} successful SDLC workflow runs</p>
        </article>
        <article class="kpi-card">
          <p class="kpi-label">Measured Token Usage</p>
          <p class="kpi-value mono">${aggregateTokens > 0 ? `${formatTokens(aggregateTokens)} tok` : 'Instrumented'}</p>
          <p class="kpi-sub">${aggregateCalls > 0 ? `${aggregateCalls} instrumented LLM calls` : 'Active from Issue #2 onward'}</p>
        </article>
        <article class="kpi-card">
          <p class="kpi-label">Inference Cost Architecture</p>
          <p class="kpi-value mono">$0.00</p>
          <p class="kpi-sub">Free-Tier Gemini 15 RPM / 250K TPM</p>
        </article>
      </div>
    </section>

    <section id="stacks" aria-labelledby="stacks-heading">
      <div class="section-head">
        <h2 id="stacks-heading">TodoMVC+ Stack Matrix</h2>
        <p class="section-note">One repository, 5 frontend frameworks built autonomously per GitHub Issue</p>
      </div>
      <div class="card-grid">
        ${stackCardsHtml}
      </div>
    </section>

    <section id="journey" aria-labelledby="journey-heading">
      <div class="section-head">
        <h2 id="journey-heading">How It Works: Autonomous Cloud SDLC Journey</h2>
        <p class="section-note">4-job GitHub Actions pipeline orchestration</p>
      </div>
      <div class="stage-grid">
        ${stagesHtml}
      </div>
    </section>

    <section id="timeline" aria-labelledby="timeline-heading">
      <div class="section-head">
        <h2 id="timeline-heading">Per-Issue Delivery Timeline</h2>
        <p class="section-note">Live GitHub Issues, merged PRs, workflow runs &amp; measured CI durations</p>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>Stack &amp; Job Breakdown</th>
              <th>State</th>
              <th>Pull Request</th>
              <th>SDLC Run</th>
              <th class="num">Total CI Duration</th>
            </tr>
          </thead>
          <tbody>
            ${timelineRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section id="economics" aria-labelledby="econ-heading">
      <div class="section-head">
        <h2 id="econ-heading">Token Economics per GitHub Issue</h2>
        <p class="section-note">Lean single-shot build + surgical repair architecture ($0.00 Free Tier)</p>
      </div>
      <div class="econ-banner">
        <article class="kpi-card">
          <p class="kpi-label">Primary Rich Builder</p>
          <p class="kpi-value mono">gemini-3-flash-preview</p>
          <p class="kpi-sub">Single-shot JSON multi-file synthesis (~250K TPM cap)</p>
        </article>
        <article class="kpi-card">
          <p class="kpi-label">Surgical Repair Loop</p>
          <p class="kpi-value mono">gemini-3.1-flash-lite</p>
          <p class="kpi-sub">500 RPD quota · sends failing stderr + targeted config only</p>
        </article>
        <article class="kpi-card">
          <p class="kpi-label">Telemetry Source</p>
          <p class="kpi-value mono">.mogra-metrics.json</p>
          <p class="kpi-sub">Captured directly from Gemini <code>usageMetadata</code></p>
        </article>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Issue / Stack</th>
              <th class="num">Calls</th>
              <th class="num">Prompt Tokens</th>
              <th class="num">Output Tokens</th>
              <th class="num">Total Tokens</th>
              <th>Models</th>
              <th>Telemetry Notes</th>
            </tr>
          </thead>
          <tbody>
            ${tokenRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section id="skills" aria-labelledby="skills-heading">
      <div class="section-head">
        <h2 id="skills-heading">Active Agent Skills (${skills.length})</h2>
        <p class="section-note">Composable domain instructions loaded by mogra agents during build &amp; verification</p>
      </div>
      <div class="card-grid">
        ${skillsHtml}
      </div>
    </section>
  </main>

  <footer>
    <div class="container footer-inner">
      <span>Generated ${escapeHtml(formatUtcTimestamp(generatedAt))} by <a href="${controlUrl}" target="_blank" rel="noopener noreferrer">ProductionLine (mogra)</a></span>
      <span>Design tokens inspired by <a href="https://designsystem.quantumblack.com/" target="_blank" rel="noopener noreferrer">QuantumBlack Design System</a></span>
    </div>
  </footer>

  <script>
    (function () {
      var btn = document.getElementById('themeToggle');
      var root = document.documentElement;
      function sync() {
        var isDark = root.dataset.theme !== 'light';
        btn.setAttribute('aria-pressed', String(isDark));
        btn.textContent = isDark ? 'Theme: Dark' : 'Theme: Light';
      }
      sync();
      btn.addEventListener('click', function () {
        var next = root.dataset.theme === 'light' ? 'dark' : 'light';
        root.dataset.theme = next;
        try { localStorage.setItem('mogra-portal-theme', next); } catch (e) {}
        sync();
      });
    })();
  </script>
</body>
</html>
`;
}

export async function generateShowcasePortal({
  repo = 'rajeevkannav/TodoMVC-Plus',
  controlPlaneRepo = 'rajeevkannav/ProductionLine',
  rootBase = '/',
  stacksDir = 'stacks',
  builtStacks = null,
  controlPlaneDir = DEFAULT_CONTROL_PLANE,
  outFile = 'pages-dist/index.html',
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '',
  fetchImpl = globalThis.fetch,
} = {}) {
  loadConfig({ controlPlaneDir });
  const diskStacks = readDiskStacks(stacksDir, builtStacks);
  const skills = readSkillsCatalog(controlPlaneDir);
  const telemetry = await fetchGithubTelemetry({ repo, token, fetchImpl });
  const html = renderShowcaseHtml({
    repo,
    controlPlaneRepo,
    rootBase,
    diskStacks,
    telemetry,
    skills,
  });
  if (outFile) {
    mkdirSync(dirname(resolve(outFile)), { recursive: true });
    writeFileSync(resolve(outFile), html, 'utf8');
  }
  return { html, telemetry, diskStacks, skills };
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, cur, idx, arr) => {
      if (cur.startsWith('--')) acc.push([cur.slice(2), arr[idx + 1]]);
      return acc;
    }, []),
  );
  const builtStacks = args['built-stacks']
    ? args['built-stacks'].split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const { telemetry } = await generateShowcasePortal({
    repo: args.repo ?? 'rajeevkannav/TodoMVC-Plus',
    controlPlaneRepo: args['control-plane-repo'] ?? 'rajeevkannav/ProductionLine',
    rootBase: args['root-base'] ?? '/',
    stacksDir: resolve(args['stacks-dir'] ?? 'stacks'),
    builtStacks,
    controlPlaneDir: resolve(args['control-plane'] ?? DEFAULT_CONTROL_PLANE),
    outFile: resolve(args.out ?? 'pages-dist/index.html'),
  });
  console.log(`[pages-portal] Generated ${args.out ?? 'pages-dist/index.html'} (apiLive=${telemetry.apiLive}, issues=${telemetry.issues.length}, runs=${telemetry.runs.length}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[pages-portal] ${err.message}`);
    process.exit(1);
  });
}
