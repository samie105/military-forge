#!/usr/bin/env node
/**
 * Writes the CI job summary for the test step. It shows one row of counts per workspace package
 * and the counts this project cares most about: golden replays, and the game-server pipe over
 * each transport. It then lists the failures. The data comes from the vitest JSON report that CI
 * asks every package's `vitest run` to write (see .github/workflows/ci.yml).
 *
 *   node .github/scripts/test-summary.mjs [--report .turbo/vitest-report.json] [--check lint=success …]
 *
 * --report is the report path relative to each package (default below). Each --check name=outcome
 * adds a step outcome (success / failure / skipped / cancelled) to the header line.
 * The summary is appended to $GITHUB_STEP_SUMMARY when that is set, and printed to stdout
 * otherwise. Missing reports and highlights that did not run become ::warning annotations.
 * The script exits 0 when tests failed, because the test step has already failed the job.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_REPORT = '.turbo/vitest-report.json';

/** Tests worth a line of their own: `file` is repo-relative; `name` filters by full test name. */
export const HIGHLIGHTS = [
  { label: 'Golden replays', file: 'packages/sim/test/golden.test.ts' },
  { label: 'Bot golden matches', file: 'packages/bots/test/golden.test.ts' },
  { label: 'Bot no-stuck soak', file: 'packages/bots/test/soak.test.ts' },
  { label: 'Server pipe over uWebSockets.js', file: 'apps/game-server/test/server.test.ts', name: '(uws)' },
  { label: 'Server pipe over ws', file: 'apps/game-server/test/server.test.ts', name: '(ws)' },
];

/** Failures listed in full; the rest are only counted, so a refactor that breaks everything stays readable. */
export const MAX_FAILURES = 20;
const MAX_MESSAGE_LINES = 12;
const MAX_MESSAGE_CHARS = 1500;

// ---------- workspace ----------

/** The `packages:` globs of pnpm-workspace.yaml, in the two forms this repo uses: `dir/*` and `dir`. */
export function workspaceGlobs(yaml) {
  const globs = [];
  let inPackages = false;
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^\S/.test(line)) inPackages = /^packages:\s*$/.test(line);
    else if (inPackages) {
      const item = /^\s+-\s+(['"]?)(.+?)\1\s*$/.exec(line);
      if (item) globs.push(item[2]);
    }
  }
  return globs;
}

/** Workspace packages sorted by directory: `{ dir, name, hasTest }`, dir relative to the root with `/` separators. */
export function workspacePackages(root) {
  const dirs = new Set();
  const excluded = new Set();
  for (const glob of workspaceGlobs(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))) {
    const negated = glob.startsWith('!');
    const pattern = (negated ? glob.slice(1) : glob).replace(/\/+$/, '');
    const matches = pattern.endsWith('/*') ? childDirs(root, pattern.slice(0, -2)) : [pattern];
    for (const dir of matches) (negated ? excluded : dirs).add(dir);
  }
  return [...dirs]
    .filter((dir) => !excluded.has(dir) && existsSync(join(root, dir, 'package.json')))
    .sort()
    .map((dir) => {
      const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
      return { dir, name: pkg.name ?? dir, hasTest: typeof pkg.scripts?.test === 'string' };
    });
}

function childDirs(root, parent) {
  const full = join(root, parent);
  if (!existsSync(full)) return [];
  return readdirSync(full, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => `${parent}/${d.name}`);
}

// ---------- reports ----------

/** Reads one package's report: `{ report }`, `{ missing: true }` or `{ error }`. */
export function readReport(root, dir, reportPath) {
  const file = join(root, dir, reportPath);
  if (!existsSync(file)) return { missing: true };
  try {
    return { report: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    return { error: `unreadable report ${dir}/${reportPath}: ${err.message}` };
  }
}

/**
 * A report's absolute file path, relative to the repo. Vitest reports real paths, and the root
 * may be reached through a symlink (macOS: /tmp is /private/tmp), so both spellings are tried.
 */
function repoPath(file, roots) {
  for (const root of roots) {
    const rel = relative(root, file);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  }
  return file.split(sep).join('/');
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

/** First lines of an error, without colour codes, and with paths made repo-relative so stack frames stay short. */
function trimMessage(message, roots) {
  let clean = stripAnsi(message);
  for (const root of roots) clean = clean.replaceAll(`file://${root}/`, '').replaceAll(`${root}/`, '');
  const lines = clean.trimEnd().split('\n');
  let kept = lines.slice(0, MAX_MESSAGE_LINES).join('\n');
  if (kept.length > MAX_MESSAGE_CHARS) kept = `${kept.slice(0, MAX_MESSAGE_CHARS)}…`;
  else if (lines.length > MAX_MESSAGE_LINES) kept += '\n…';
  return kept;
}

/**
 * Counts for one package from its vitest JSON report (the Jest-compatible shape vitest writes).
 * `state` is ok | failed | missing (no report) | invalid (report not JSON). `roots` are the repo
 * root's spellings that file paths are made relative to.
 */
export function summarisePackage(pkg, read, roots) {
  const out = {
    name: pkg.name,
    dir: pkg.dir,
    state: 'ok',
    files: 0,
    failedFiles: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    fileRows: [],
    tests: [],
    failures: [],
  };
  if (!read.report) {
    out.state = read.missing ? 'missing' : 'invalid';
    out.failures.push(
      read.missing
        ? { file: pkg.dir, title: 'no test report', message: 'The test task crashed before vitest wrote its report, or its test script is not `vitest run`.' }
        : { file: pkg.dir, title: 'unreadable test report', message: read.error },
    );
    return out;
  }
  const report = read.report;
  let start = Number.isFinite(report.startTime) ? report.startTime : Infinity;
  let end = -Infinity;
  for (const result of report.testResults ?? []) {
    const file = repoPath(result.name, roots);
    const row = { file, passed: 0, failed: 0, skipped: 0, durationMs: Math.max(0, (result.endTime ?? 0) - (result.startTime ?? 0)) };
    if (Number.isFinite(result.startTime)) start = Math.min(start, result.startTime);
    if (Number.isFinite(result.endTime)) end = Math.max(end, result.endTime);
    for (const a of result.assertionResults ?? []) {
      // vitest statuses: passed, failed, skipped, pending, todo. The last three all count as skipped.
      const status = a.status === 'passed' || a.status === 'failed' ? a.status : 'skipped';
      row[status]++;
      out.tests.push({ file, name: a.fullName ?? a.title, status });
      if (status === 'failed') {
        const title = [...(a.ancestorTitles ?? []), a.title].join(' › ');
        out.failures.push({ file, title, message: trimMessage((a.failureMessages ?? []).join('\n'), roots) });
      }
    }
    // A file can fail outside any test (import error, failing hook): it then has a message and maybe no tests.
    if (result.status === 'failed') {
      out.failedFiles++;
      if (result.message) out.failures.push({ file, title: 'file failed to run', message: trimMessage(result.message, roots) });
    }
    out.files++;
    out.passed += row.passed;
    out.failed += row.failed;
    out.skipped += row.skipped;
    out.fileRows.push(row);
  }
  out.fileRows.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  out.durationMs = end > start ? end - start : 0;
  if (out.failed > 0 || out.failedFiles > 0) out.state = 'failed';
  else if (report.success === false) {
    out.state = 'failed';
    out.failures.push({ file: pkg.dir, title: 'run failed', message: 'vitest reported a failure outside any test (an unhandled error). See the test step log.' });
  }
  return out;
}

/** Passed/total for each highlight across every package's tests. */
export function highlightCounts(packages, highlights = HIGHLIGHTS) {
  return highlights.map((h) => {
    const tests = packages.flatMap((p) => p.tests).filter((t) => t.file === h.file && (!h.name || t.name.includes(h.name)));
    return { label: h.label, passed: tests.filter((t) => t.status === 'passed').length, total: tests.length };
  });
}

/** Everything the summary shows. `checks` is `[[name, outcome], …]` from --check. */
export function collect(root, { reportPath = DEFAULT_REPORT, checks = [], highlights = HIGHLIGHTS } = {}) {
  const roots = [realpathSync(root), root];
  const packages = workspacePackages(root)
    .filter((p) => p.hasTest)
    .map((p) => summarisePackage(p, readReport(root, p.dir, reportPath), roots));
  const total = { files: 0, passed: 0, failed: 0, skipped: 0 };
  for (const p of packages) for (const k of Object.keys(total)) total[k] += p[k];
  const counted = highlightCounts(packages, highlights);
  const warnings = [
    ...packages.filter((p) => p.state === 'missing' || p.state === 'invalid').map((p) => `${p.name}: ${p.failures[0].title}`),
    ...counted.filter((h) => h.total === 0).map((h) => `${h.label}: no tests ran`),
  ];
  return { packages, total, highlights: counted, checks, warnings, failures: packages.flatMap((p) => p.failures) };
}

// ---------- Markdown ----------

const OUTCOME = { success: 'passed', failure: 'FAILED', cancelled: 'cancelled', skipped: 'skipped', '': 'not run' };
/** Literal text on one line: Markdown that changes meaning (emphasis, links, HTML, table pipes) is escaped. */
const text = (s) => String(s).replace(/[\\`*_[\]<>|~]/g, '\\$&').replace(/\r?\n/g, ' ');
/** A code span that survives backticks in the content. */
function code(s) {
  const t = String(s).replace(/\r?\n/g, ' ');
  const ticks = '`'.repeat(Math.max(0, ...(t.match(/`+/g) ?? []).map((m) => m.length)) + 1);
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${t}${pad}${ticks}`;
}
/** A code span in a table cell: GFM splits cells on `|` even inside code, unless it is escaped. */
const cellCode = (s) => code(s).replace(/\|/g, '\\|');
/** A fenced block longer than any backtick run in the content. */
function fence(s) {
  const f = '`'.repeat(Math.max(2, ...(s.match(/`{3,}/g) ?? []).map((m) => m.length)) + 1);
  return `${f}text\n${s}\n${f}`;
}
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const bold = (n) => (n > 0 ? `**${n}**` : '0');

/** The job summary as GitHub-flavoured Markdown. */
export function renderMarkdown(summary) {
  const { packages, total, highlights, checks, failures } = summary;
  const noReport = packages.filter((p) => p.state === 'missing' || p.state === 'invalid').length;
  const headline = [
    total.failed > 0 && `${total.failed} failed`,
    `${total.passed} passed`,
    total.skipped > 0 && `${total.skipped} skipped`,
    noReport > 0 && `${noReport} package${noReport === 1 ? '' : 's'} without a report`,
  ].filter(Boolean);
  const lines = [`## Tests: ${headline.join(', ')}`, ''];
  if (checks.length > 0) lines.push(checks.map(([name, outcome]) => `${text(name)} **${OUTCOME[outcome] ?? text(outcome)}**`).join(' · '), '');

  lines.push('| Package | Files | Passed | Failed | Skipped | Time |', '| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const p of packages) {
    if (p.state === 'missing' || p.state === 'invalid') {
      lines.push(`| ${cellCode(p.name)} | – | – | – | – | ${p.state === 'missing' ? 'no report' : 'bad report'} |`);
    } else {
      const files = p.failedFiles > 0 ? `${p.files} (**${p.failedFiles} failed**)` : `${p.files}`;
      lines.push(`| ${cellCode(p.name)} | ${files} | ${p.passed} | ${bold(p.failed)} | ${p.skipped} | ${seconds(p.durationMs)} |`);
    }
  }
  lines.push(`| **Total** | **${total.files}** | **${total.passed}** | **${total.failed}** | **${total.skipped}** | |`, '');

  if (highlights.length > 0) {
    lines.push(highlights.map((h) => `${text(h.label)}: **${h.total === 0 ? 'not run' : `${h.passed} / ${h.total}`}**`).join(' · '), '');
  }

  if (failures.length > 0) {
    lines.push('### Failures', '');
    for (const f of failures.slice(0, MAX_FAILURES)) {
      lines.push(`- ${code(f.file)} › ${text(f.title)}`);
      if (f.message) lines.push('', fence(f.message).replace(/^/gm, '  '), '');
    }
    if (failures.length > MAX_FAILURES) lines.push(`- …and ${failures.length - MAX_FAILURES} more (see the test step log)`, '');
  }

  const rows = packages.flatMap((p) => p.fileRows);
  if (rows.length > 0) {
    lines.push('<details><summary>Per file</summary>', '', '| File | Passed | Failed | Skipped | Time |', '| --- | ---: | ---: | ---: | ---: |');
    for (const r of rows) lines.push(`| ${cellCode(r.file)} | ${r.passed} | ${bold(r.failed)} | ${r.skipped} | ${seconds(r.durationMs)} |`);
    lines.push('', '</details>', '');
  }
  return lines.join('\n');
}

// ---------- CLI ----------

/** Parses argv into `{ reportPath, checks }`. Throws on anything it does not understand. */
export function parseArgs(argv) {
  const opts = { reportPath: DEFAULT_REPORT, checks: [] };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--report') opts.reportPath = value();
    else if (flag === '--check') {
      // A step that never ran has an empty outcome in the workflow expression: `lint=` is valid.
      const v = value();
      const eq = v.indexOf('=');
      if (eq <= 0) throw new Error(`--check expects name=outcome, got "${v}"`);
      opts.checks.push([v.slice(0, eq), v.slice(eq + 1)]);
    } else throw new Error(`unknown argument "${argv[i]}"`);
  }
  return opts;
}

/** Runs the CLI and returns its exit code. Everything it touches is injectable for tests. */
export function main(
  argv,
  { root = process.cwd(), env = process.env, stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s) } = {},
) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    stderr(`test-summary: ${err.message}\n`);
    return 2;
  }
  const summary = collect(root, opts);
  const markdown = renderMarkdown(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  else stdout(`${markdown}\n`);
  for (const w of summary.warnings) stdout(env.GITHUB_ACTIONS === 'true' ? `::warning title=Test summary::${w}\n` : `warning: ${w}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
