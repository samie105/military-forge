#!/usr/bin/env node
/**
 * Fetches uWebSockets.js for THIS machine only: the JS glue + the one native binary matching
 * the current platform, CPU and Node ABI (~5 MB), instead of the full ~95 MB GitHub tarball
 * that contains every platform. Installs into apps/game-server/vendor/uWebSockets.js (gitignored).
 *
 * The game server uses it automatically when present and falls back to `ws` otherwise.
 *   pnpm uws:fetch            # fetch if missing
 *   pnpm uws:fetch --force    # re-download
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = 'v20.71.0';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'apps', 'game-server', 'vendor', 'uWebSockets.js');
const binary = `uws_${process.platform}_${process.arch}_${process.versions.modules}.node`;
const files = ['package.json', 'index.d.ts', 'uws.js', 'ESM_wrapper.mjs', binary];
const force = process.argv.includes('--force');
const quiet = process.argv.includes('--quiet');
const log = (msg) => !quiet && console.log(msg);

async function download(file) {
  const url = `https://raw.githubusercontent.com/uNetworking/uWebSockets.js/${TAG}/${file}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
      if (res.status === 404) throw Object.assign(new Error(`${file} not found for ${TAG}`), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const tmp = join(dest, `${file}.part`);
      writeFileSync(tmp, bytes);
      renameSync(tmp, join(dest, file));
      log(`  ✓ ${file} (${(bytes.length / 1024).toFixed(0)} KB)`);
      return;
    } catch (err) {
      if (err.fatal || attempt === 4) throw err;
      log(`  … ${file}: ${err.message}, retrying (${attempt}/3)`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

if (!force && existsSync(join(dest, binary)) && existsSync(join(dest, 'uws.js'))) {
  log(`uWebSockets.js ${TAG} already present (${binary}).`);
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
log(`Fetching uWebSockets.js ${TAG} for ${process.platform}/${process.arch}, Node ABI ${process.versions.modules} → ${dest}`);
try {
  for (const f of files) await download(f);
  log('Done. Restart the game server to use uWebSockets.js.');
} catch (err) {
  console.error(`uWebSockets.js fetch failed: ${err.message}\nThe game server will keep using the 'ws' fallback.`);
  process.exit(1);
}
