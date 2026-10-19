/**
 * cloud-init.sh stays pasteable: under EC2's 16 KB user-data limit, valid bash, shellcheck-clean
 * (when shellcheck is installed), and with the settings the docs tell the owner to look at.
 *   node --test scripts/net-trial/
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'cloud-init.sh');
const text = readFileSync(script, 'utf8');
const has = (bin) => {
  try {
    execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('cloud-init.sh', () => {
  it('fits in EC2 user data (16 KB, before base64)', () => {
    assert.ok(statSync(script).size < 16 * 1024, `${statSync(script).size} bytes`);
  });
  it('is a bash script that parses', () => {
    assert.ok(text.startsWith('#!/bin/bash\n'));
    execFileSync('bash', ['-n', script]);
  });
  it('ends with exit 0, so cloud-init records a success', () => {
    assert.match(text, /\nexit 0\n$/);
  });
  it('passes shellcheck', { skip: !has('shellcheck') && 'shellcheck not installed' }, () => {
    execFileSync('shellcheck', ['-s', 'bash', script]);
  });
  it('clones the public repo and plays Street Market with bots by default', () => {
    assert.match(text, /^REPO="\$\{MF_REPO:-https:\/\/github\.com\/samie105\/military-forge\}"$/m);
    assert.match(text, /^REF="\$\{MF_REF:-main\}"$/m);
    assert.match(text, /^MAP="street-market"$/m);
    assert.match(text, /^BOTS="4"$/m);
  });
  it('never prints the owner secrets to the public status page', () => {
    const status = text.slice(text.indexOf('status() {'), text.indexOf('[ -n "${OWNER:-}" ] || return 0'));
    assert.ok(!/ADMIN_TOKEN|EXPORT_TOKEN|\$OWNER/.test(status.replace('| redact', '')), 'the public part of status() must not use the secrets');
  });
});
