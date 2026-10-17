import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Runtime-agnostic packages: these run identically in the browser, on the server and in tests.
// The sim must never touch the DOM, Node APIs, rendering code, wall-clock time or non-deterministic maths.
const PURE_PACKAGES = [
  'packages/shared/src/**',
  'packages/sim/src/**',
  'packages/content/src/**',
  'packages/protocol/src/**',
  'packages/netcode/src/**',
];

const nonDeterministicMath = ['random', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'exp', 'expm1', 'pow', 'log', 'log2', 'log10', 'cbrt', 'hypot'];

export default defineConfig(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/vendor/**', 'docs/**', '.worktrees/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/web/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['apps/game-server/**', '**/test/**', 'scripts/**', '**/*.config.*', '.github/**'],
    languageOptions: { globals: globals.node },
  },
  {
    files: PURE_PACKAGES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'dgram', 'worker_threads', 'child_process'],
              message: 'Pure packages must stay runtime-agnostic: no Node APIs.',
            },
            {
              group: ['three', 'three/*', 'tweakpane', 'uWebSockets.js', '@military-forge/web', '@military-forge/game-server'],
              message: 'Pure packages may not import rendering, DOM or server code.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        'window', 'document', 'navigator', 'location', 'localStorage', 'performance',
        'requestAnimationFrame', 'setTimeout', 'setInterval', 'process', 'Buffer',
      ],
      'no-restricted-properties': [
        'error',
        ...nonDeterministicMath.map((property) => ({
          object: 'Math',
          property,
          message: 'Non-deterministic across JS engines. Use the seeded PRNG / sim maths in @military-forge/shared.',
        })),
        { object: 'Date', property: 'now', message: 'No wall-clock time in pure packages.' },
      ],
    },
  },
);
