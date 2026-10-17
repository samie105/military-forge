// Guards turbo's cache keys. Turbo hashes only the files inside a package (plus its workspace
// dependencies, via the `transit` task). A tsconfig that extends a file outside its package, such
// as the root tsconfig.base.json, is invisible to turbo unless turbo.json lists it in
// `globalDependencies`. Without that, a cached `pnpm typecheck` replays a pass after a
// compiler-option change. Run with: node --test ".github/scripts/*.test.mjs"
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** JSON with // and /* comments and trailing commas (turbo.json, tsconfig). Strings are kept intact. */
export function parseJsonc(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2);
      if (i < 0) throw new Error('unterminated block comment');
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Directories of the workspace packages (pnpm-workspace.yaml globs of the form `dir/*`). */
function workspacePackages(root) {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [...yaml.matchAll(/^\s*-\s*['"]?([^'"\s]+)\/\*['"]?\s*$/gm)].map((m) => m[1]);
  return globs.flatMap((g) =>
    readdirSync(join(root, g), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, g, d.name, 'package.json')))
      .map((d) => join(root, g, d.name)),
  );
}

function tsconfigs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.name === 'node_modules' || d.name === 'dist' || d.name.startsWith('.')) return [];
    const p = join(dir, d.name);
    if (d.isDirectory()) return tsconfigs(p);
    return /^tsconfig.*\.json$/.test(d.name) ? [p] : [];
  });
}

/** Every relative `extends` target, followed transitively. Package names (no ./ or ../) are skipped. */
function extendsChain(file, seen = new Set()) {
  const ext = parseJsonc(readFileSync(file, 'utf8')).extends;
  for (const e of [ext ?? []].flat()) {
    if (!e.startsWith('.')) continue;
    const target = resolve(dirname(file), e.endsWith('.json') ? e : `${e}.json`);
    if (seen.has(target)) continue;
    seen.add(target);
    extendsChain(target, seen);
  }
  return seen;
}

/** Files that some package's tsconfig extends but that lie outside that package. */
export function externalTsconfigInputs(root) {
  const found = new Map(); // repo-relative path → first tsconfig that pulls it in
  for (const pkg of workspacePackages(root)) {
    for (const cfg of tsconfigs(pkg)) {
      for (const target of extendsChain(cfg)) {
        if (target === pkg || target.startsWith(pkg + sep)) continue;
        const rel = relative(root, target).split(sep).join('/');
        if (!found.has(rel)) found.set(rel, relative(root, cfg).split(sep).join('/'));
      }
    }
  }
  return found;
}

test('parseJsonc keeps // inside strings and drops comments', () => {
  const v = parseJsonc('{\n  "$schema": "https://x.dev/a.json", // c\n  /* b */ "a": [1, 2,],\n}');
  assert.deepEqual(v, { $schema: 'https://x.dev/a.json', a: [1, 2] });
});

test('the root tsconfig.base.json is extended by the packages (sanity check of the scan)', () => {
  assert.ok(externalTsconfigInputs(ROOT).has('tsconfig.base.json'));
});

test('turbo.json globalDependencies covers every tsconfig a package extends from outside itself', () => {
  const turbo = parseJsonc(readFileSync(join(ROOT, 'turbo.json'), 'utf8'));
  const globals = new Set(turbo.globalDependencies ?? []);
  const missing = [...externalTsconfigInputs(ROOT)]
    .filter(([file]) => !globals.has(file))
    .map(([file, by]) => `${file} (extended by ${by})`);
  assert.deepEqual(missing, [], 'add these to "globalDependencies" in turbo.json');
});
