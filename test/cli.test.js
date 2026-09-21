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
    // --json (dry-run) routes errors to stdout as JSON
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.action, 'add');
    assert.ok(parsed.error);
  });

  it('add --json for empty dir shows error', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-test-'));
    try {
      const r = runCli(['add', tmpDir, '--json']);
      assert.notEqual(r.exitCode, 0);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.code, 'DETECT_FAILED');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  // NOTE: any add test that uses --yes must point at a path that fails
  // detection BEFORE the daemon call, otherwise it will create a real
  // project on a host where the daemon is running.

  it('add --yes against unfit path errors out before touching daemon', () => {
    // Nonexistent path → detect fails → no daemon call, no creation.
    const r = runCli(['add', '/nonexistent/path/that/does/not/exist', '--yes']);
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.includes('Error'));
  });

  it('add --json --yes against unfit path emits JSON failure (no daemon call)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-test-'));
    try {
      const r = runCli(['add', tmpDir, '--yes', '--json']);
      assert.notEqual(r.exitCode, 0);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.action, 'add');
      assert.equal(parsed.code, 'DETECT_FAILED');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('CLI start/stop/restart', () => {
  for (const cmd of ['start', 'stop', 'restart']) {
    it(`${cmd} --help prints help and exits 0`, () => {
      const r = runCli([cmd, '--help']);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes(`jump.sh ${cmd}`));
      assert.ok(r.stdout.includes('--json'));
    });

    it(`${cmd} -h also prints help`, () => {
      const r = runCli([cmd, '-h']);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes(`jump.sh ${cmd}`));
    });

    it(`${cmd} --json for unknown project emits JSON error`, () => {
      // Project name guaranteed not to exist; works whether or not the
      // daemon is running (NOT_FOUND vs DAEMON_NOT_RUNNING).
      const r = runCli([cmd, '__definitely_not_a_real_project__', '--json']);
      assert.notEqual(r.exitCode, 0);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.action, cmd);
      assert.ok(['DAEMON_NOT_RUNNING', 'NOT_FOUND'].includes(parsed.code), `unexpected code ${parsed.code}`);
    });

    it(`${cmd} for unknown project prints text error`, () => {
      const r = runCli([cmd, '__definitely_not_a_real_project__']);
      assert.notEqual(r.exitCode, 0);
      assert.ok(r.stderr.includes('Error') || r.stderr.includes('daemon') || r.stderr.includes('not'));
    });
  }
});

describe('CLI ls --json', () => {
  it('ls --help mentions --json', () => {
    const r = runCli(['ls', '--help']);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('--json'));
  });

  it('ls --json emits JSON object with projects array', () => {
    const r = runCli(['ls', '--json']);
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed.projects));
    assert.equal(typeof parsed.dockerAvailable, 'boolean');
  });
});

describe('CLI status --json', () => {
  it('status --help mentions --json', () => {
    const r = runCli(['status', '--help']);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('--json'));
  });

  it('status --json emits valid JSON with daemon field', () => {
    const r = runCli(['status', '--json']);
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok('installed' in parsed);
    assert.ok('daemon' in parsed);
    assert.ok('domain' in parsed);
    assert.ok('dashboard' in parsed);
    assert.equal(typeof parsed.running, 'boolean');
  });

  it('status --json honors JUMPSH_DASHBOARD_HOST', () => {
    const r = runCli(['status', '--json'], {
      env: {
        JUMPSH_DASHBOARD_HOST: 'control.example.test',
        JUMPSH_DOMAIN: 'alice.jump.sh',
      },
    });
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.dashboard, 'https://control.example.test');
  });
});
