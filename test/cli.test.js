import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'jumpsh.js');

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [BIN, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, ...opts.env },
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

describe('CLI --help', () => {
  it('prints help and exits 0', () => {
    const r = runCli(['--help']);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('jump.sh'));
    assert.ok(r.stdout.includes('Usage'));
  });

  it('-h also prints help', () => {
    const r = runCli(['-h']);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('Usage'));
  });
});

describe('CLI --version', () => {
  it('prints version and exits 0', () => {
    const r = runCli(['--version']);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout.trim(), /^jump\.sh \d+\.\d+\.\d+/);
  });

  it('-v also prints version', () => {
    const r = runCli(['-v']);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout.trim(), /^jump\.sh \d+\.\d+\.\d+/);
  });
});

describe('CLI unknown command', () => {
  it('exits 2 for unknown command', () => {
    const r = runCli(['foobar']);
    assert.equal(r.exitCode, 2);
  });
});
