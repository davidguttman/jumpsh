import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'jumpsh.js');

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [BIN, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, ...opts.env },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
    };
  }
}

describe('CLI upgrade registration/help', () => {
  it('top-level help lists upgrade', () => {
    const r = runCli(['--help']);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /upgrade\s+Upgrade jump\.sh itself/);
  });

  it('upgrade --help explains state preservation', () => {
    const r = runCli(['upgrade', '--help']);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('Usage: jump.sh upgrade'));
    assert.ok(r.stdout.includes('preserves ~/.jump.sh'));
    assert.ok(r.stdout.includes('daemon service'));
  });
});

describe('upgrade planning and safety', async () => {
  const {
    createUpgradePlan,
    executeUpgradeCommand,
    removeDaemonOnly,
    resolveSafeUpgradeCwd,
  } = await import('../lib/commands/upgrade.js');

  it('plans npx upgrades through the latest installer trampoline', () => {
    const plan = createUpgradePlan({ installMode: 'npx', binPath: '/tmp/current/bin/jumpsh.js' });
    assert.deepEqual(plan.commands, [
      { command: 'npx', args: ['--yes', 'jump.sh@latest', 'install'] },
    ]);
  });

  it('plans global npm upgrades without deleting state', () => {
    const plan = createUpgradePlan({ installMode: 'global', binPath: '/usr/local/bin/jump.sh' });
    assert.deepEqual(plan.commands, [
      { command: 'npm', args: ['install', '-g', 'jump.sh@latest'] },
      { command: 'jump.sh', args: ['install'] },
    ]);
    assert.equal(plan.preserveState, true);
  });

  it('plans local checkout upgrades without global npm mutation', () => {
    const binPath = path.join(ROOT, 'bin', 'jumpsh.js');
    const plan = createUpgradePlan({ installMode: 'local', binPath });
    assert.deepEqual(plan.commands, [
      { command: process.execPath, args: [binPath, 'install'] },
    ]);
  });

  it('executes all upgrade reinstall modes from a safe cwd when the caller cwd was deleted', () => {
    const originalCwd = process.cwd();
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-upgrade-safe-home-'));
    const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-upgrade-deleted-cwd-'));
    const deletedCwd = path.join(tmpParent, 'deleted');
    fs.mkdirSync(deletedCwd);

    const calls = [];
    try {
      process.chdir(deletedCwd);
      fs.rmSync(deletedCwd, { recursive: true, force: true });

      const safeCwd = resolveSafeUpgradeCwd({ homeDir: tmpHome, packageRoot: ROOT });
      const plans = [
        createUpgradePlan({ installMode: 'npx' }),
        createUpgradePlan({ installMode: 'global' }),
        createUpgradePlan({ installMode: 'local', binPath: path.join(ROOT, 'bin', 'jumpsh.js') }),
      ];

      for (const plan of plans) {
        for (const step of plan.commands) {
          executeUpgradeCommand(step, {
            cwd: safeCwd,
            execFileSync: (command, args, options) => calls.push({ command, args, options }),
          });
        }
      }

      assert.equal(safeCwd, tmpHome);
      assert.equal(fs.existsSync(safeCwd), true);
      assert.deepEqual(
        calls.map(({ command, args }) => ({ command, args })),
        plans.flatMap((plan) => plan.commands),
      );
      for (const call of calls) {
        assert.equal(call.options.cwd, tmpHome);
        assert.equal(call.options.stdio, 'inherit');
      }
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpParent, { recursive: true, force: true });
    }
  });

  it('removes daemon files but preserves ~/.jump.sh state files', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-upgrade-home-'));
    try {
      const stateDir = path.join(tmpHome, '.jump.sh');
      fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'projects.json'), '{"projects":[]}');
      fs.writeFileSync(path.join(stateDir, 'cert.pem'), 'cert');
      fs.writeFileSync(path.join(stateDir, 'jumpsh-daemon.sh'), '#!/bin/sh\n');

      const systemdDir = path.join(tmpHome, '.config', 'systemd', 'user');
      fs.mkdirSync(systemdDir, { recursive: true });
      fs.writeFileSync(path.join(systemdDir, 'jumpsh.service'), '[Service]\n');

      const commands = [];
      const removed = removeDaemonOnly({
        platform: 'linux',
        homeDir: tmpHome,
        execSync: (cmd, options) => commands.push({ cmd, options }),
      });

      assert.ok(removed.some((entry) => entry.includes('jumpsh.service')));
      assert.ok(removed.some((entry) => entry.includes('jumpsh-daemon.sh')));
      assert.ok(commands.some(({ cmd }) => cmd.includes('systemctl --user stop jumpsh')));
      assert.ok(commands.every(({ options }) => options.cwd === tmpHome));
      assert.equal(fs.existsSync(path.join(stateDir, 'jumpsh-daemon.sh')), false);
      assert.equal(fs.existsSync(path.join(systemdDir, 'jumpsh.service')), false);
      assert.equal(fs.existsSync(stateDir), true);
      assert.equal(fs.readFileSync(path.join(stateDir, 'projects.json'), 'utf8'), '{"projects":[]}');
      assert.equal(fs.readFileSync(path.join(stateDir, 'cert.pem'), 'utf8'), 'cert');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
