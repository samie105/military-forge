/**
 * The Basis transcoder (public/assets/vendor/basis) runs under a Content-Security-Policy without
 * 'unsafe-eval'. QA (23 Oct 2026): on the trial box, three's transcoder threw EvalError in its
 * worker (embind builds its callers with `new Function`), so phones got no KTX2 art. The vendored copy
 * builds them as closures. Node's --disallow-code-generation-from-strings stands in for the CSP: three's
 * original fails under it, ours transcodes every KTX2 file we ship to the same bytes as the original.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '../public');
const vendored = join(publicDir, 'assets/vendor/basis');
const original = join(dirname(createRequire(import.meta.url).resolve('three')), '../examples/jsm/libs/basis');

/** every .ktx2 under public/assets */
function ktx2Files(dir = join(publicDir, 'assets')): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? ktx2Files(p) : name.endsWith('.ktx2') ? [p] : [];
  });
}

/**
 * Loads a transcoder (copied as CommonJS: the web package is ESM) and transcodes each file's first
 * level to RGBA32, ETC1 and BC1; one line per file: "ok w h levels sha256", or "FAIL <error>".
 */
const PROBE = `
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [dir, ...files] = process.argv.slice(2);
require(path.join(dir, 'basis_transcoder.cjs'))({ wasmBinary: fs.readFileSync(path.join(dir, 'basis_transcoder.wasm')) }).then((M) => {
  M.initializeBasis();
  for (const file of files) {
    const k = new M.KTX2File(new Uint8Array(fs.readFileSync(file)));
    if (!k.isValid() || !k.startTranscoding()) { console.log('FAIL invalid ' + file); continue; }
    const h = crypto.createHash('sha256');
    for (const format of [13, 0, 2]) {
      const out = new Uint8Array(k.getImageTranscodedSizeInBytes(0, 0, 0, format));
      if (!k.transcodeImage(out, 0, 0, 0, format, 0, -1, -1)) console.log('FAIL transcode ' + format);
      h.update(out);
    }
    console.log(['ok', k.getWidth(), k.getHeight(), k.getLevels(), h.digest('hex')].join(' '));
    k.close();
    k.delete();
  }
}).catch((e) => console.log('FAIL ' + e.constructor.name + ': ' + e.message));
`;

/** runs PROBE on a transcoder copy, with or without eval allowed */
function transcode(from: string, files: string[], noEval: boolean): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'basis-'));
  copyFileSync(join(from, 'basis_transcoder.js'), join(dir, 'basis_transcoder.cjs'));
  copyFileSync(join(from, 'basis_transcoder.wasm'), join(dir, 'basis_transcoder.wasm'));
  writeFileSync(join(dir, 'probe.cjs'), PROBE);
  const flags = noEval ? ['--disallow-code-generation-from-strings'] : [];
  const run = spawnSync(process.execPath, [...flags, join(dir, 'probe.cjs'), dir, ...files], { encoding: 'utf8', timeout: 60_000 });
  return run.stdout.trim().split('\n');
}

describe('the vendored Basis transcoder', () => {
  it('builds no code from strings, and its .wasm is three\'s', () => {
    const js = readFileSync(join(vendored, 'basis_transcoder.js'), 'utf8');
    expect(js).not.toMatch(/newFunc\(Function/);
    expect(readFileSync(join(vendored, 'basis_transcoder.wasm')).equals(readFileSync(join(original, 'basis_transcoder.wasm')))).toBe(true);
  });

  it("transcodes every KTX2 file we ship with eval disallowed (a CSP without 'unsafe-eval'), to three's original's bytes", () => {
    const files = ktx2Files();
    expect(files.length).toBeGreaterThan(20);
    // three's original: an EvalError, as QA saw in the box's transcoder worker
    expect(transcode(original, files.slice(0, 1), true)[0]).toMatch(/^FAIL EvalError/);
    const expected = transcode(original, files, false);
    expect(expected.every((line) => line.startsWith('ok '))).toBe(true);
    expect(transcode(vendored, files, true)).toEqual(expected);
  }, 120_000);
});
