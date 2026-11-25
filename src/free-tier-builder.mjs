#!/usr/bin/env node
/**
 * Lean single-shot + surgical-repair builder for Free-Tier API limits (15 RPM / 250K TPM).
 * Generates structured JSON { "files": { "<path>": "<content>" } } in 1 request (~15K tokens)
 * instead of 20+ multi-turn CLI loops that exceed 250K TPM.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const FORBIDDEN_PREFIXES = ['.github/', '.git/', 'node_modules/', 'dist/'];

/** Safely write generated files inside workdir, blocking path traversal and protected paths. */
export function writeGeneratedFiles(workdir, filesMap) {
  const root = resolve(workdir);
  const written = [];
  for (const [relPath, content] of Object.entries(filesMap ?? {})) {
    if (typeof content !== 'string') continue;
    const normalized = relPath.replace(/^\/+/, '');
    if (FORBIDDEN_PREFIXES.some((p) => normalized.startsWith(p)) || normalized === '.mogra.yaml') {
      throw new Error(`Security block: forbidden generated path '${relPath}'`);
    }
    const target = resolve(root, normalized);
    const rel = relative(root, target);
    if (!rel || rel.startsWith('..') || rel.includes('../')) {
      throw new Error(`Security block: path traversal '${relPath}'`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    written.push(normalized);
  }
  return written;
}

async function callGeminiJson({ apiKey, model, prompt }) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
        maxOutputTokens: 32768,
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  const payload = JSON.parse(text);
  const raw = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Gemini returned empty candidate content');
  return JSON.parse(raw);
}

function runLocalChecks(workdir) {
  try {
    execSync(
      'npm install --no-audit --no-fund && npm run typecheck --if-present && npm test --if-present && npm run build',
      { cwd: workdir, encoding: 'utf8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 },
    );
    return { ok: true, output: '' };
  } catch (err) {
    const combined = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim();
    return { ok: false, output: combined.slice(-3500) };
  }
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, cur, idx, arr) => {
      if (cur.startsWith('--')) acc.push([cur.slice(2), arr[idx + 1]]);
      return acc;
    }, []),
  );
  const workdir = resolve(args.workdir ?? '.');
  const model = args.model ?? 'gemini-3.1-flash-lite';
  const promptText = readFileSync(args['prompt-file'], 'utf8');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');

  const initialPrompt = [
    promptText,
    '',
    '## Output Format (STRICT JSON)',
    'Return ONLY a JSON object with shape: { "files": { "<relative-path>": "<full-file-content>" } }.',
    'Generate all files needed in the working directory: package.json, package-lock.json is optional, tsconfig.json, vite.config.ts, vitest.config.ts (excluding e2e/**), playwright.config.ts, index.html, src/*, and e2e/todomvc.spec.ts.',
    'Keep code clean, accessible (WCAG 2.2 AA+, 320px zero-overflow reflow), and complete.',
  ].join('\n');

  console.log(`[mogra-oneshot] Generating files via model='${model}'...`);
  const first = await callGeminiJson({ apiKey, model, prompt: initialPrompt });
  const files = writeGeneratedFiles(workdir, first.files);
  console.log(`[mogra-oneshot] Wrote ${files.length} files.`);

  for (let round = 1; round <= 2; round++) {
    const check = runLocalChecks(workdir);
    if (check.ok) {
      console.log(`[mogra-oneshot] Local typecheck, unit tests, and build passed.`);
      return;
    }
    console.error(`[mogra-oneshot] Check failed (round ${round}); requesting surgical repair:\n${check.output}`);
    const repairPrompt = [
      `Fix ONLY the failing files in ${files.join(', ')} based on this build/test error:`,
      '```',
      check.output,
      '```',
      'Return ONLY JSON: { "files": { "<relative-path>": "<updated-full-content>" } }.',
    ].join('\n');
    const patched = await callGeminiJson({ apiKey, model, prompt: repairPrompt });
    const updated = writeGeneratedFiles(workdir, patched.files);
    console.log(`[mogra-oneshot] Patched ${updated.length} files.`);
  }

  const finalCheck = runLocalChecks(workdir);
  if (!finalCheck.ok) {
    throw new Error(`Build/tests still failing after surgical repair:\n${finalCheck.output}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(err.status === 429 || err.status === 503 ? 75 : 1);
  });
}
