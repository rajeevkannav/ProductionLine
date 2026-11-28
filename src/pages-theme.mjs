#!/usr/bin/env node
/**
 * Links the shared TodoMVC+ theme into every built stack so all showcase stacks look the same.
 *
 *   node src/pages-theme.mjs --pages-dir pages-dist --root-base /TodoMVC-Plus/ --stacks react19-ts-vite,vue3-ts-vite
 *
 * Copies src/themes/todomvc-qb-light.css to <pages-dir>/_mogra/todomvc-theme.css and adds a
 * <link> to it at the end of each <pages-dir>/<stack>/index.html <head>. Stack source is never
 * modified, so a rebuilt stack picks the theme up again on the next deploy.
 *
 * Stacks that already follow the cross-stack UI contract (`main.todoapp`, own src/styles.css with
 * light/dark tokens) are left alone: the shared theme is a fallback for stacks not yet on it.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const THEME_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), 'themes', 'todomvc-qb-light.css');
export const THEME_PATH = '_mogra/todomvc-theme.css';
const MARKER = 'data-mogra-theme';

// The contract's root class as a whole word, quoted or not: React/Vue emit "todoapp", Svelte
// class="todoapp", Solid's compiled templates class=todoapp. Not todoapp-* or *-todoapp.
const CONTRACT_CLASS = /(^|[^\w-])todoapp(?![\w-])/;

/** True when a built stack renders the cross-stack UI contract (its markup carries the `todoapp` class). */
export function followsUiContract(distDir) {
  const stack = [distDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (/\.(m?js|html)$/.test(entry.name) && CONTRACT_CLASS.test(readFileSync(path, 'utf8'))) return true;
    }
  }
  return false;
}

/** Returns html with the theme <link> placed just before </head> (once). */
export function injectThemeLink(html, href) {
  if (html.includes(MARKER)) return html;
  const tag = `<link rel="stylesheet" href="${href}" ${MARKER}>`;
  const at = html.search(/<\/head>/i);
  if (at === -1) throw new Error('index.html has no </head>');
  return `${html.slice(0, at)}  ${tag}\n${html.slice(at)}`;
}

export function applyTheme({ pagesDir, rootBase = '/', stacks, themeSource = THEME_SOURCE }) {
  const css = readFileSync(themeSource);
  const version = createHash('sha256').update(css).digest('hex').slice(0, 10);
  const target = join(pagesDir, THEME_PATH);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, css);

  const base = rootBase.endsWith('/') ? rootBase : `${rootBase}/`;
  const href = `${base}${THEME_PATH}?v=${version}`;
  const themed = [];
  const skipped = [];
  for (const stack of stacks) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(stack)) throw new Error(`Invalid stack name: ${stack}`);
    const index = join(pagesDir, stack, 'index.html');
    if (!existsSync(index)) continue;
    if (followsUiContract(join(pagesDir, stack))) {
      skipped.push(stack);
      continue;
    }
    writeFileSync(index, injectThemeLink(readFileSync(index, 'utf8'), href));
    themed.push(stack);
  }
  return { href, themed, skipped };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    args[key.slice(2)] = argv[i + 1] ?? '';
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const stacks = (args.stacks || '').split(',').map((s) => s.trim()).filter(Boolean);
  const { href, themed, skipped } = applyTheme({ pagesDir: args['pages-dir'] || 'pages-dist', rootBase: args['root-base'] || '/', stacks });
  console.log(`Linked ${href} into ${themed.length ? themed.join(', ') : 'no stacks'}`);
  if (skipped.length) console.log(`Left ${skipped.join(', ')} on their own src/styles.css (cross-stack UI contract).`);
}
