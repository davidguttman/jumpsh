import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
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

describe('CLI add', () => {
  it('add --help prints help and exits 0', () => {
    const r = runCli(['add', '--help']);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('jump.sh add'));
    assert.ok(r.stdout.includes('--name'));
    assert.ok(r.stdout.includes('--json'));
    assert.ok(r.stdout.includes('--yes'));
  });

  it('add -h also prints help', () => {
    const r = runCli(['add', '-h']);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('jump.sh add'));
  });

  it('add --json outputs valid JSON with detection for a node project', () => {
    // Use the jumpsh project itself (has package.json)
    const projectDir = path.join(__dirname, '..');
    const r = runCli(['add', projectDir, '--json']);
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.path);
    assert.ok(parsed.detected);
    assert.ok(parsed.detected.type);
    assert.ok(parsed.suggested);
    assert.ok(parsed.suggested.name);
    assert.ok(parsed.suggested.subdomain);
  });

  it('add --json with --name uses provided name', () => {
    const projectDir = path.join(__dirname, '..');
    const r = runCli(['add', projectDir, '--json', '--name', 'custom-name']);
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.suggested.name, 'custom-name');
    assert.equal(parsed.suggested.subdomain, 'custom-name');
  });

  it('add --json sanitizes subdomain (no trailing/leading dashes, no repeated dashes)', () => {
    const projectDir = path.join(__dirname, '..');
    const r = runCli(['add', projectDir, '--json', '--name', 'My App!']);
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.suggested.subdomain, 'my-app', 'trailing dash should be stripped');
  });

  it('add with invalid path shows error', () => {
    const r = runCli(['add', '/nonexistent/path/that/does/not/exist', '--json']);
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.includes('Error'));
  });

  it('add --json for empty dir shows error', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-test-'));
    try {
      const r = runCli(['add', tmpDir, '--json']);
      assert.notEqual(r.exitCode, 0);
      assert.ok(r.stderr.includes('Error'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('add without daemon shows daemon-not-running error', () => {
    // Use --yes to skip confirmation, daemon won't be running in test
    const projectDir = path.join(__dirname, '..');
    const r = runCli(['add', projectDir, '--name', 'test-proj', '--yes']);
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.includes('daemon') || r.stderr.includes('not running') || r.stderr.includes('Error'));
  });
});
