#!/usr/bin/env node
/**
 * Links the shared TodoMVC+ theme into every built stack so all showcase stacks look the same.
 *
 *   node src/pages-theme.mjs --pages-dir pages-dist --root-base /TodoMVC-Plus/ --stacks react19-ts-vite,vue3-ts-vite
 *
 * Copies src/themes/todomvc-qb-light.css to <pages-dir>/_mogra/todomvc-theme.css and adds a
 * <link> to it at the end of each <pages-dir>/<stack>/index.html <head>. Stack source is never
 * modified, so a rebuilt stack picks the theme up again on the next deploy.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const THEME_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), 'themes', 'todomvc-qb-light.css');
export const THEME_PATH = '_mogra/todomvc-theme.css';
const MARKER = 'data-mogra-theme';

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
  for (const stack of stacks) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(stack)) throw new Error(`Invalid stack name: ${stack}`);
    const index = join(pagesDir, stack, 'index.html');
    if (!existsSync(index)) continue;
    writeFileSync(index, injectThemeLink(readFileSync(index, 'utf8'), href));
    themed.push(stack);
  }
  return { href, themed };
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
  const { href, themed } = applyTheme({ pagesDir: args['pages-dir'] || 'pages-dist', rootBase: args['root-base'] || '/', stacks });
  console.log(`Linked ${href} into ${themed.length ? themed.join(', ') : 'no stacks'}`);
}
