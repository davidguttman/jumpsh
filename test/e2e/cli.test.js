import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', '..', 'bin', 'jumpsh.js');

function runCli(args) {
  try {
    const stdout = execFileSync('node', [BIN, ...args], {
      encoding: 'utf8',
      timeout: 10000,
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
    };
  }
}

describe('E2E CLI verification', () => {
  it('--version outputs a valid semver line', () => {
    const r = runCli(['--version']);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout.trim(), /^jump\.sh \d+\.\d+\.\d+$/);
  });

  it('--help shows all documented commands', () => {
    const r = runCli(['--help']);
    assert.equal(r.exitCode, 0);
    for (const cmd of ['install', 'uninstall', 'register', 'ls', 'logs', 'status', 'open']) {
      assert.ok(r.stdout.includes(cmd), `help should mention "${cmd}"`);
    }
  });

  it('unknown command exits with code 2', () => {
    const r = runCli(['nonexistent-cmd']);
    assert.equal(r.exitCode, 2);
  });
});
