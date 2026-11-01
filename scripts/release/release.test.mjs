/**
 * The release commands (docs/release.md) against throwaway repos: a dev repo ("origin"), a public
 * repo ("public") and a checkout with both as remotes. deploy.sh runs with stand-ins for ssh and
 * curl, so nothing here reaches the box or GitHub.
 *   node --test "scripts/release/*.test.mjs"
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = ['lib.sh', 'publish.sh', 'promote.sh', 'deploy.sh'];
const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;

let root, work, gitEnv;
const git = (...args) => execFileSync('git', args, { cwd: work, env: gitEnv, encoding: 'utf8' }).trim();
const gitIn = (dir, ...args) => execFileSync('git', args, { cwd: dir, env: gitEnv, encoding: 'utf8' }).trim();
/** runs scripts/release/<name> on the throwaway checkout: { status, out } (stdout and stderr together) */
function run(name, args = [], env = {}) {
  const r = spawnSync('bash', [join(here, name), ...args], { env: { ...gitEnv, MF_REPO_DIR: work, ...env }, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
function commit(file, body, msg) {
  writeFileSync(join(work, file), body);
  git('add', '-A');
  git('commit', '-qm', msg);
  return git('rev-parse', 'HEAD');
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'mf-release-'));
  writeFileSync(join(root, 'gitconfig'), '[init]\n\tdefaultBranch = main\n');
  gitEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
  for (const r of ['origin.git', 'public.git']) execFileSync('git', ['init', '-q', '--bare', join(root, r)], { env: gitEnv });
  work = join(root, 'work');
  execFileSync('git', ['init', '-q', work], { env: gitEnv });
  git('remote', 'add', 'origin', join(root, 'origin.git'));
  git('remote', 'add', 'public', join(root, 'public.git'));
  // the public repo starts from a parentless snapshot, as the real one did
  commit('README', 'v0\n', 'first');
  const owner = { ...gitEnv, GIT_AUTHOR_NAME: 'samie105', GIT_AUTHOR_EMAIL: '42389790+samie105@users.noreply.github.com', GIT_COMMITTER_NAME: 'samie105', GIT_COMMITTER_EMAIL: '42389790+samie105@users.noreply.github.com' };
  const first = execFileSync('git', ['commit-tree', 'HEAD^{tree}', '-m', 'Forged Force'], { cwd: work, env: owner, encoding: 'utf8' }).trim();
  git('push', '-q', 'public', `${first}:refs/heads/main`);
  git('push', '-q', 'origin', 'main');
});
after(() => rmSync(root, { recursive: true, force: true }));

describe('the release scripts', () => {
  for (const name of scripts) {
    it(`${name} parses${has('shellcheck') ? ' and passes shellcheck' : ''}`, () => {
      execFileSync('bash', ['-n', join(here, name)]);
      if (has('shellcheck')) execFileSync('shellcheck', ['-s', 'bash', join(here, name)]);
    });
  }
  it('all stop at the first error (set -euo pipefail, through lib.sh)', () => {
    assert.match(readFileSync(join(here, 'lib.sh'), 'utf8'), /^set -euo pipefail$/m);
    for (const name of ['publish.sh', 'promote.sh', 'deploy.sh']) assert.match(readFileSync(join(here, name), 'utf8'), /^\. "\$\(dirname "\$0"\)\/lib\.sh"$/m, name);
  });
});

describe('publish.sh', () => {
  it('needs a message', () => {
    assert.notEqual(run('publish.sh').status, 0);
  });
  it('puts dev main\'s tree on public main as one commit by the noreply address, with no dev history', () => {
    commit('game.txt', 'v1\n', 'feat: one');
    commit('game.txt', 'v2\n', 'feat: two');
    git('push', '-q', 'origin', 'main');
    const r = run('publish.sh', ['Two features']);
    assert.equal(r.status, 0, r.out);
    git('fetch', '-q', 'public');
    assert.equal(git('rev-parse', 'public/main^{tree}'), git('rev-parse', 'origin/main^{tree}'));
    assert.equal(git('log', '-1', '--format=%an <%ae>|%cn <%ce>|%s', 'public/main'), 'samie105 <42389790+samie105@users.noreply.github.com>|samie105 <42389790+samie105@users.noreply.github.com>|Two features');
    assert.equal(git('rev-list', '--count', 'public/main'), '2', 'the snapshot sits on the last one: no dev commits');
    assert.equal(gitIn(join(root, 'public.git'), 'log', '--format=%ae', 'main').split('\n').filter((e) => e === 'dev@example.com').length, 0);
  });
  it('refuses when there is nothing new', () => {
    const r = run('publish.sh', ['Again']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /nothing to publish/);
  });
  it('refuses while local main has commits origin doesn\'t', () => {
    commit('game.txt', 'v3\n', 'feat: unpushed');
    const r = run('publish.sh', ['Unpushed']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /push them first/);
    git('push', '-q', 'origin', 'main');
    assert.equal(run('publish.sh', ['Three']).status, 0);
  });
});

describe('promote.sh', () => {
  it('creates production at a commit of public main, moves it forward, and rolls it back', () => {
    git('fetch', '-q', 'public');
    const [three, two] = git('rev-list', '-2', 'public/main').split('\n');
    let r = run('promote.sh', [two]);
    assert.equal(r.status, 0, r.out);
    assert.equal(gitIn(join(root, 'public.git'), 'rev-parse', 'production'), two);
    r = run('promote.sh', [three.slice(0, 9)]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /^release: /m);
    assert.equal(gitIn(join(root, 'public.git'), 'rev-parse', 'production'), three);
    r = run('promote.sh', [two]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /^rollback: /m);
    assert.equal(gitIn(join(root, 'public.git'), 'rev-parse', 'production'), two);
    assert.match(run('promote.sh', [two]).out, /already at/);
  });
  it('refuses a commit that isn\'t on public main (a dev commit, or nonsense)', () => {
    const dev = git('rev-parse', 'origin/main');
    let r = run('promote.sh', [dev]);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /not on public main/);
    r = run('promote.sh', ['nope']);
    assert.notEqual(r.status, 0);
    assert.notEqual(run('promote.sh').status, 0, 'no argument');
  });
});

describe('deploy.sh', () => {
  /** ssh and curl stand-ins: ssh keeps what it was asked and given, and answers as a box would */
  function stubs(rc = 0) {
    const bin = mkdtempSync(join(root, 'bin-'));
    writeFileSync(join(bin, 'ssh'), `#!/bin/bash\nprintf '%s\\n' "$*" >>"${bin}/ssh.log"\ncase "$*" in\n*'cat >/root/'*) cat >"${bin}/setup.sh" ;;\n*'bash /root/mf-setup-'*) echo rc=${rc}; echo '[mf-trial 10:00:00] commit abc1234 2026-10-31'; echo '[mf-trial 10:00:01] == ready' ;;\nesac\n`);
    writeFileSync(join(bin, 'curl'), '#!/bin/bash\nprintf 200\n');
    for (const f of ['ssh', 'curl']) chmodSync(join(bin, f), 0o755);
    return bin;
  }
  function setupScript(withEnv) {
    execFileSync('mkdir', ['-p', join(work, 'scripts/net-trial')]);
    writeFileSync(join(work, 'scripts/net-trial/cloud-init.sh'), `#!/bin/bash\n${withEnv ? 'MF_ENV="${MF_ENV:-production}"\n' : ''}exit 0\n`);
    git('add', '-A');
    git('commit', '-qm', 'setup');
    git('push', '-q', 'origin', 'main');
    assert.equal(run('publish.sh', [`setup ${withEnv}`]).status, 0);
  }
  it('refuses an unknown environment', () => {
    const r = run('deploy.sh', ['prod']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /usage: deploy\.sh staging\|production/);
  });
  it('refuses staging while public main\'s setup predates staging (it would deploy main over production)', () => {
    setupScript(false);
    const bin = stubs();
    const r = run('deploy.sh', ['staging'], { PATH: `${bin}:${process.env.PATH}` });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /predates staging/);
  });
  it('ships that branch\'s own setup and runs it as the environment, printing the exit code and the ready line', () => {
    setupScript(true);
    const bin = stubs();
    const r = run('deploy.sh', ['staging'], { PATH: `${bin}:${process.env.PATH}`, MF_BOX: 'mf@10.0.0.1' });
    assert.equal(r.status, 0, r.out);
    assert.equal(readFileSync(join(bin, 'setup.sh'), 'utf8'), git('show', 'public/main:scripts/net-trial/cloud-init.sh') + '\n');
    const log = readFileSync(join(bin, 'ssh.log'), 'utf8');
    assert.match(log, /flock -w 1800 \/run\/mf-deploy\.lock env MF_ENV=staging MF_REF=main bash \/root\/mf-setup-staging\.sh >\/tmp\/mf-deploy-staging\.log 2>&1/);
    assert.match(log, /umask 077/);
    assert.match(r.out, /^rc=0$/m);
    assert.match(r.out, /== ready/);
    assert.match(r.out, /https:\/\/staging\.10-0-0-1\.sslip\.io\/api\/health 200/);
  });
  it('production runs public production with MF_REF=production, and a failed setup fails the command', () => {
    git('fetch', '-q', 'public');
    assert.equal(run('promote.sh', [git('rev-parse', 'public/main')]).status, 0);
    let bin = stubs();
    let r = run('deploy.sh', ['production'], { PATH: `${bin}:${process.env.PATH}`, MF_BOX: 'mf@10.0.0.1' });
    assert.equal(r.status, 0, r.out);
    assert.match(readFileSync(join(bin, 'ssh.log'), 'utf8'), /env MF_ENV=production MF_REF=production bash \/root\/mf-setup-production\.sh/);
    assert.match(r.out, /https:\/\/10-0-0-1\.sslip\.io\/ 200/);
    bin = stubs(1);
    r = run('deploy.sh', ['production'], { PATH: `${bin}:${process.env.PATH}`, MF_BOX: 'mf@10.0.0.1' });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /setup failed \(rc=1\)/);
  });
});
