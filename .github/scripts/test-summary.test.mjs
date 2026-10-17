/**
 * Tests for the CI job summary (test-summary.mjs). Run with `node --test ".github/scripts/*.test.mjs"`;
 * CI runs them right after the workspace tests. Each test builds a throwaway workspace with vitest-shaped reports.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { collect, DEFAULT_REPORT, main, MAX_FAILURES, parseArgs, renderMarkdown, workspaceGlobs, workspacePackages } from './test-summary.mjs';

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/**
 * A workspace in a temp dir. `packages` maps dir → { name, test?: false, report? }, where `report`
 * is `(root, dir) => reportObject` (see `report` below) or a raw string written as the report file.
 */
function workspace(packages, yaml = 'packages:\n  - apps/*\n  - packages/*\n') {
  const root = mkdtempSync(join(tmpdir(), 'test-summary-'));
  roots.push(root);
  writeFileSync(join(root, 'pnpm-workspace.yaml'), yaml);
  for (const [dir, pkg] of Object.entries(packages)) {
    mkdirSync(join(root, dir, '.turbo'), { recursive: true });
    const scripts = pkg.test === false ? {} : { test: 'vitest run' };
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name: pkg.name, scripts }));
    if (pkg.report !== undefined) {
      const body = typeof pkg.report === 'string' ? pkg.report : JSON.stringify(pkg.report(root, dir));
      writeFileSync(join(root, dir, DEFAULT_REPORT), body);
    }
  }
  return root;
}

const pass = (title, ancestors = []) => ({ ancestorTitles: ancestors, title, fullName: [...ancestors, title].join(' '), status: 'passed', failureMessages: [] });
const fail = (title, message, ancestors = []) => ({ ...pass(title, ancestors), status: 'failed', failureMessages: [message] });
const skip = (title, status = 'skipped') => ({ ...pass(title), status });

/** A vitest JSON report: `files` maps a package-relative path → assertion results (or `{ message }` for a file that failed to load). */
const report = (files, extra = {}) => (root, dir) => ({
  startTime: 1000,
  success: true,
  ...extra,
  testResults: Object.entries(files).map(([file, tests], i) => {
    const broken = !Array.isArray(tests);
    const results = broken ? [] : tests;
    const failed = broken || results.some((t) => t.status === 'failed');
    return {
      name: join(root, dir, file),
      startTime: 1000 + i * 100,
      endTime: 1500 + i * 100,
      status: failed ? 'failed' : 'passed',
      message: broken ? tests.message : '',
      assertionResults: results,
    };
  }),
});

describe('workspace discovery', () => {
  it('reads the packages globs of pnpm-workspace.yaml, ignoring comments, quotes and other keys', () => {
    const yaml = [
      'packages:',
      "  - 'apps/*'",
      '  - "packages/*"  # libraries',
      '  - tools/one',
      '  - "!packages/legacy"',
      'minimumReleaseAgeExclude:',
      '  - eslint@10.13.0',
    ].join('\n');
    assert.deepEqual(workspaceGlobs(yaml), ['apps/*', 'packages/*', 'tools/one', '!packages/legacy']);
  });

  it('lists packages in directory order, applies negations and notes which have a test script', () => {
    const root = workspace(
      { 'apps/web': { name: 'web', test: false }, 'packages/sim': { name: 'sim' }, 'packages/legacy': { name: 'legacy' }, 'tools/one': { name: 'one' } },
      'packages:\n  - apps/*\n  - packages/*\n  - tools/one\n  - "!packages/legacy"\n',
    );
    mkdirSync(join(root, 'packages', 'not-a-package')); // a folder without package.json is skipped
    assert.deepEqual(workspacePackages(root), [
      { dir: 'apps/web', name: 'web', hasTest: false },
      { dir: 'packages/sim', name: 'sim', hasTest: true },
      { dir: 'tools/one', name: 'one', hasTest: true },
    ]);
  });
});

describe('collect', () => {
  it('counts files and tests per package and in total, and skips packages without a test script', () => {
    const root = workspace({
      'apps/web': { name: '@mm/web', test: false },
      'packages/shared': { name: '@mm/shared', report: report({ 'test/a.test.ts': [pass('a'), pass('b')] }) },
      'packages/sim': {
        name: '@mm/sim',
        report: report({ 'test/golden.test.ts': [pass('g1'), pass('g2')], 'test/movement.test.ts': [pass('m'), skip('s'), skip('t', 'todo')] }),
      },
    });
    const summary = collect(root, { highlights: [] });
    assert.deepEqual(
      summary.packages.map((p) => [p.name, p.state, p.files, p.passed, p.failed, p.skipped]),
      [
        ['@mm/shared', 'ok', 1, 2, 0, 0],
        ['@mm/sim', 'ok', 2, 3, 0, 2],
      ],
    );
    assert.deepEqual(summary.total, { files: 3, passed: 5, failed: 0, skipped: 2 });
    assert.equal(summary.packages[1].durationMs, 600); // report start 1000 → last file end 1600
    assert.deepEqual(summary.failures, []);
    assert.deepEqual(summary.warnings, []);
  });

  it('lists failing tests with their suite path, repo-relative file and a trimmed, colour-free message', () => {
    const failing = (root, dir) => {
      const frames = [`    at ${join(root, dir, 'test/combat.test.ts')}:4:31`, `    at file://${root}/node_modules/vitest/run.js:9:1`];
      const long = ['AssertionError: \u001b[31mexpected 1 to be 2\u001b[39m', ...frames, ...Array.from({ length: 30 }, (_, i) => `    at frame ${i}`)];
      return report({ 'test/combat.test.ts': [pass('ok'), fail('hits', long.join('\n'), ['weapons', 'hammer'])] })(root, dir);
    };
    const root = workspace({ 'packages/sim': { name: '@mm/sim', report: failing } });
    const summary = collect(root, { highlights: [] });
    assert.equal(summary.packages[0].state, 'failed');
    assert.equal(summary.failures.length, 1);
    const [f] = summary.failures;
    assert.equal(f.file, 'packages/sim/test/combat.test.ts');
    assert.equal(f.title, 'weapons › hammer › hits');
    const lines = f.message.split('\n');
    assert.deepEqual(lines.slice(0, 3), ['AssertionError: expected 1 to be 2', '    at packages/sim/test/combat.test.ts:4:31', '    at node_modules/vitest/run.js:9:1']);
    assert.equal(lines.length, 13); // 12 lines kept + the ellipsis line
    assert.equal(lines[12], '…');
  });

  it('reports a file that failed to load, even though it has no tests', () => {
    const root = workspace({
      'apps/game-server': { name: '@mm/server', report: report({ 'test/room.test.ts': [pass('r')], 'test/server.test.ts': { message: "Cannot find module './gone'" } }) },
    });
    const [p] = collect(root, { highlights: [] }).packages;
    assert.equal(p.state, 'failed');
    assert.equal(p.files, 2);
    assert.equal(p.failedFiles, 1);
    assert.deepEqual(p.failures, [{ file: 'apps/game-server/test/server.test.ts', title: 'file failed to run', message: "Cannot find module './gone'" }]);
  });

  it('flags a run that vitest marked failed with every test passing (an unhandled error)', () => {
    const root = workspace({ 'packages/net': { name: '@mm/net', report: report({ 'test/a.test.ts': [pass('a')] }, { success: false }) } });
    const [p] = collect(root, { highlights: [] }).packages;
    assert.equal(p.state, 'failed');
    assert.equal(p.failures[0].title, 'run failed');
  });

  it('warns about packages whose report is missing or is not JSON', () => {
    const root = workspace({
      'packages/a': { name: '@mm/a' },
      'packages/b': { name: '@mm/b', report: '{ not json' },
    });
    const summary = collect(root, { highlights: [] });
    assert.deepEqual(
      summary.packages.map((p) => p.state),
      ['missing', 'invalid'],
    );
    assert.deepEqual(summary.warnings, ['@mm/a: no test report', '@mm/b: unreadable test report']);
    assert.match(summary.failures[1].message, /^unreadable report packages\/b\/\.turbo\/vitest-report\.json: /);
  });

  it('counts highlights by file and test name, and warns when one did not run', () => {
    const root = workspace({
      'apps/game-server': {
        name: '@mm/server',
        report: report({ 'test/server.test.ts': [pass('joins', ['pipe (uws)']), fail('kicks', 'x', ['pipe (uws)']), pass('joins', ['pipe (ws)'])] }),
      },
    });
    const highlights = [
      { label: 'uws', file: 'apps/game-server/test/server.test.ts', name: '(uws)' },
      { label: 'ws', file: 'apps/game-server/test/server.test.ts', name: '(ws)' },
      { label: 'golden', file: 'packages/sim/test/golden.test.ts' },
    ];
    const summary = collect(root, { highlights });
    assert.deepEqual(summary.highlights, [
      { label: 'uws', passed: 1, total: 2 },
      { label: 'ws', passed: 1, total: 1 },
      { label: 'golden', passed: 0, total: 0 },
    ]);
    assert.deepEqual(summary.warnings, ['golden: no tests ran']);
  });
});

describe('renderMarkdown', () => {
  const sample = () =>
    workspace({
      'packages/sim': { name: '@mm/sim', report: report({ 'test/golden.test.ts': [pass('g'), fail('range | combat', 'boom ``` fence')] }) },
      'packages/zed': { name: '@mm/zed' },
    });

  it('renders the headline, step outcomes, the package table, highlights, failures and the per-file table', () => {
    const md = renderMarkdown(
      collect(sample(), {
        checks: [
          ['lint', 'success'],
          ['typecheck', 'failure'],
          ['test', ''],
        ],
        highlights: [{ label: 'Golden replays', file: 'packages/sim/test/golden.test.ts' }],
      }),
    );
    const lines = md.split('\n');
    assert.equal(lines[0], '## Tests: 1 failed, 1 passed, 1 package without a report');
    assert.ok(lines.includes('lint **passed** · typecheck **FAILED** · test **not run**'));
    assert.ok(lines.includes('| `@mm/sim` | 1 (**1 failed**) | 1 | **1** | 0 | 0.5 s |'));
    assert.ok(lines.includes('| `@mm/zed` | – | – | – | – | no report |'));
    assert.ok(lines.includes('| **Total** | **1** | **1** | **1** | **0** | |'));
    assert.ok(lines.includes('Golden replays: **1 / 2**'));
    // pipes in titles are escaped, and a fence longer than any backtick run in the message keeps it intact
    assert.ok(lines.includes('- `packages/sim/test/golden.test.ts` › range \\| combat'));
    assert.match(md, /\n {2}````text\n {2}boom ``` fence\n {2}````\n/);
    assert.ok(lines.includes('| `packages/sim/test/golden.test.ts` | 1 | **1** | 0 | 0.5 s |'));
  });

  it('caps the failure list and says how many more there are', () => {
    const tests = Array.from({ length: MAX_FAILURES + 3 }, (_, i) => fail(`t${i}`, 'nope'));
    const root = workspace({ 'packages/sim': { name: '@mm/sim', report: report({ 'test/a.test.ts': tests }) } });
    const md = renderMarkdown(collect(root, { highlights: [] }));
    assert.equal((md.match(/^- `packages\/sim\/test\/a\.test\.ts` › t\d+$/gm) ?? []).length, MAX_FAILURES);
    assert.match(md, /^- …and 3 more \(see the test step log\)$/m);
  });

  it('escapes Markdown in test names and keeps code spans intact around backticks and pipes', () => {
    const root = workspace({ 'packages/a|b': { name: 'we`ird|pkg', report: report({ 'test/x.test.ts': [fail('<b>*x*</b>', 'm')] }) } });
    const md = renderMarkdown(collect(root, { highlights: [] }));
    assert.match(md, /^\| ``we`ird\\\|pkg`` \| 1 \(\*\*1 failed\*\*\) \|/m);
    assert.match(md, /› \\<b\\>\\\*x\\\*\\<\/b\\>$/m);
  });
});

describe('CLI', () => {
  it('parses --report and --check in both spellings, and rejects anything else', () => {
    assert.deepEqual(parseArgs([]), { reportPath: DEFAULT_REPORT, checks: [] });
    assert.deepEqual(parseArgs(['--report', 'r.json', '--check=lint=success', '--check', 'test=']), {
      reportPath: 'r.json',
      checks: [
        ['lint', 'success'],
        ['test', ''],
      ],
    });
    assert.throws(() => parseArgs(['--report']), /--report needs a value/);
    assert.throws(() => parseArgs(['--check', 'lint']), /name=outcome/);
    assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  });

  it('appends to $GITHUB_STEP_SUMMARY and emits warnings as workflow annotations on GitHub Actions', () => {
    const root = workspace({ 'packages/a': { name: '@mm/a' } });
    const file = join(root, 'summary.md');
    writeFileSync(file, '## earlier step\n');
    const out = [];
    const code = main([], { root, env: { GITHUB_STEP_SUMMARY: file, GITHUB_ACTIONS: 'true' }, stdout: (s) => out.push(s) });
    assert.equal(code, 0);
    const written = readFileSync(file, 'utf8');
    assert.ok(written.startsWith('## earlier step\n## Tests: 0 passed, 1 package without a report\n'));
    assert.ok(out.includes('::warning title=Test summary::@mm/a: no test report\n'));
    assert.ok(out.includes('::warning title=Test summary::Golden replays: no tests ran\n'));
    assert.ok(!out.some((s) => s.startsWith('## Tests')));
  });

  it('prints to stdout without $GITHUB_STEP_SUMMARY, and exits 2 on bad arguments', () => {
    const root = workspace({ 'packages/a': { name: '@mm/a', report: report({ 'test/a.test.ts': [pass('a')] }) } });
    const out = [];
    assert.equal(main(['--check', 'lint=success'], { root, env: {}, stdout: (s) => out.push(s) }), 0);
    assert.match(out[0], /^## Tests: 1 passed\n\nlint \*\*passed\*\*\n/);
    assert.ok(out.includes('warning: Server pipe over ws: no tests ran\n'));
    const err = [];
    assert.equal(main(['--bogus'], { root, env: {}, stdout: (s) => out.push(s), stderr: (s) => err.push(s) }), 2);
    assert.deepEqual(err, ['test-summary: unknown argument "--bogus"\n']);
  });
});
