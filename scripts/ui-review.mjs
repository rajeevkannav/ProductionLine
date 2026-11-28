#!/usr/bin/env node
/**
 * UI review for a running Rails app: screenshots every page at desktop and 320px widths,
 * signed out and (when a review account is given) signed in, and fails on horizontal
 * overflow at 320px (WCAG 2.2 reflow).
 *
 * Usage: node ui-review.mjs --upstream http://127.0.0.1:3999 --tls-cert cert.pem --tls-key key.pem \
 *          --paths paths.txt --out ui-review [--email review@example.com --password ...]
 * Production Rails apps assume TLS (assume_ssl/force_ssl), so the review browses through a local
 * HTTPS proxy (https://localhost:3443 -> upstream) that sets X-Forwarded-Proto like Railway's edge.
 * Requires the `playwright` package and a Chromium install.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:https';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => (cur.startsWith('--') ? [...acc, [cur.slice(2), arr[i + 1]]] : acc), []),
);
const upstream = new URL(args.upstream ?? 'http://127.0.0.1:3999');
const PROXY_PORT = Number(args['proxy-port'] ?? 3443);
const base = `https://localhost:${PROXY_PORT}`;

function startTlsProxy() {
  const server = createServer({ cert: readFileSync(args['tls-cert']), key: readFileSync(args['tls-key']) }, (req, res) => {
    const forward = httpRequest(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    forward.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(forward);
  });
  return new Promise((resolve) => server.listen(PROXY_PORT, '127.0.0.1', () => resolve(server)));
}
const out = args.out ?? 'ui-review';
const paths = readFileSync(args.paths, 'utf8').split('\n').map((p) => p.trim()).filter(Boolean);
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile-320', width: 320, height: 640 },
];

const slug = (path) => (path === '/' ? 'home' : path.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-'));

async function review(browser, label, signIn) {
  const results = [];
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      ignoreHTTPSErrors: true, // self-signed certificate of the local review proxy
    });
    const page = await context.newPage();
    if (signIn) {
      const ok = await signIn(page);
      if (!ok) {
        await context.close();
        return { results, signedIn: false };
      }
    }
    for (const path of paths) {
      const response = await page.goto(`${base}${path}`, { waitUntil: 'networkidle' }).catch(() => null);
      const status = response?.status() ?? 0;
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth).catch(() => 0);
      const file = join(out, `${label}--${slug(path)}--${viewport.name}.png`);
      await page.screenshot({ path: file, fullPage: true }).catch(() => {});
      results.push({ label, path, viewport: viewport.name, status, overflow, url: page.url(), file });
    }
    await context.close();
  }
  return { results, signedIn: Boolean(signIn) };
}

async function main() {
  const { chromium } = await import('playwright');
  mkdirSync(out, { recursive: true });
  const proxy = await startTlsProxy();
  const browser = await chromium.launch();

  const signedOut = await review(browser, 'signed-out', null);
  let signedIn = { results: [], signedIn: false };
  if (args.email && args.password) {
    signedIn = await review(browser, 'signed-in', async (page) => {
      await page.goto(`${base}/session/new`, { waitUntil: 'networkidle' }).catch(() => null);
      const email = page.locator('input[name="email_address"], input[type="email"]').first();
      const password = page.locator('input[name="password"], input[type="password"]').first();
      if (!(await email.count()) || !(await password.count())) return false;
      await email.fill(args.email);
      await password.fill(args.password);
      await Promise.all([
        page.waitForURL((url) => !url.pathname.startsWith('/session'), { timeout: 15000 }).catch(() => {}),
        password.press('Enter'),
      ]);
      await page.waitForLoadState('networkidle').catch(() => {});
      return !new URL(page.url()).pathname.startsWith('/session');
    });
  }
  await browser.close();
  proxy.close();

  const all = [...signedOut.results, ...signedIn.results];
  const problems = all
    .filter((r) => r.viewport === 'mobile-320' && r.overflow > 1)
    .map((r) => `${r.label} ${r.path}: ${r.overflow}px horizontal overflow at 320px`);
  problems.push(...all.filter((r) => r.status >= 500).map((r) => `${r.label} ${r.path}: HTTP ${r.status}`));

  const lines = [
    '### UI review (mogra)',
    '',
    `Screenshots of ${paths.length} pages at 1280px and 320px, signed out${signedIn.signedIn ? ' and signed in' : ''}, are in the run's **ui-review** artifact.`,
    '',
    '| Page | Signed in | 1280px | 320px overflow |',
    '| :--- | :--- | :--- | :--- |',
    ...paths.flatMap((path) =>
      ['signed-out', 'signed-in']
        .filter((label) => label === 'signed-out' || signedIn.signedIn)
        .map((label) => {
          const desk = all.find((r) => r.label === label && r.path === path && r.viewport === 'desktop');
          const mob = all.find((r) => r.label === label && r.path === path && r.viewport === 'mobile-320');
          return `| \`${path}\` | ${label === 'signed-in' ? 'yes' : 'no'} | ${desk?.status ?? '-'} | ${mob ? (mob.overflow > 1 ? `**${mob.overflow}px**` : 'none') : '-'} |`;
        }),
    ),
    '',
    problems.length ? `**Problems:**\n${problems.map((p) => `- ${p}`).join('\n')}` : 'No reflow problems at 320px.',
  ];
  writeFileSync(join(out, 'summary.md'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  if (problems.length) process.exit(1);
}

main().catch((err) => {
  console.error(`[mogra] UI review failed: ${err.message}`);
  process.exit(1);
});
