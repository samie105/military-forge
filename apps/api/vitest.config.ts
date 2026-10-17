import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each route-test file boots its own PGlite (Postgres in WASM, ~1 s on an idle machine).
    // Under heavy load that can take far longer, so give set-up hooks room.
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
