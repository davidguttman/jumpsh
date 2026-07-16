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
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
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
    assert.ok(r.stdout.includes('before removing the current daemon'));
  });

  it('upgrade --dry-run shows absolute local commands in execution order', () => {
    const r = runCli(['upgrade', '--dry-run']);
    assert.equal(r.exitCode, 0);

    const removeIndex = r.stdout.indexOf('dry-run: would remove daemon service files only');
    const commandIndex = r.stdout.indexOf(`dry-run: would run ${process.execPath} ${BIN} install`);
    assert.ok(removeIndex >= 0);
    assert.ok(commandIndex > removeIndex);
  });
});

describe('upgrade planning and safety', async () => {
  const {
    createUpgradePlan,
    executeUpgradeCommand,
    executeUpgradePlan,
    readInstalledVersion,
    removeDaemonOnly,
    resolveGlobalToolchain,
    resolveLatestVersion,
    resolveSafeUpgradeCwd,
  } = await import('../lib/commands/upgrade.js');

  function writeNodeWrapper(nodePath) {
    fs.mkdirSync(path.dirname(nodePath), { recursive: true });
    fs.writeFileSync(nodePath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    fs.chmodSync(nodePath, 0o755);
  }

  function writeNpmCli(npmCliPath, content = '') {
    fs.mkdirSync(path.dirname(npmCliPath), { recursive: true });
    fs.writeFileSync(npmCliPath, content);
    fs.chmodSync(npmCliPath, 0o755);
  }

  function createGlobalInstallLayout({ withToolchain = true } = {}) {
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-global-prefix-'));
    const packageRoot = path.join(prefix, 'lib', 'node_modules', 'jump.sh');
    const nodePath = path.join(prefix, 'bin', 'node');
    const npmCliPath = path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const jumpBinPath = path.join(packageRoot, 'bin', 'jumpsh.js');

    fs.mkdirSync(path.dirname(jumpBinPath), { recursive: true });
    fs.writeFileSync(jumpBinPath, '');
    if (withToolchain) {
      writeNodeWrapper(nodePath);
      writeNpmCli(npmCliPath);
    }

    return { prefix, packageRoot, nodePath, npmCliPath, jumpBinPath };
  }

  function createRuntimeToolchain({ standardNpmLayout = true, npmTarget } = {}) {
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-runtime-prefix-'));
    const nodePath = path.join(prefix, 'bin', 'node');
    const npmCliPath = standardNpmLayout
      ? path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : path.join(prefix, 'lib', 'custom-npm', 'npm-cli.js');
    const npmPath = path.join(prefix, 'bin', 'npm');

    writeNodeWrapper(nodePath);
    if (npmTarget) {
      fs.mkdirSync(path.dirname(npmPath), { recursive: true });
      fs.symlinkSync(npmTarget, npmPath);
    } else {
      writeNpmCli(npmCliPath);
      fs.symlinkSync(path.relative(path.dirname(npmPath), npmCliPath), npmPath);
    }

    return { prefix, nodePath, npmCliPath, npmPath };
  }

  it('plans npx upgrades through the latest installer trampoline', () => {
    const plan = createUpgradePlan({ installMode: 'npx', binPath: '/tmp/current/bin/jumpsh.js' });
    assert.deepEqual(plan.commands, [
      { command: 'npx', args: ['--yes', 'jump.sh@latest', 'install'] },
    ]);
  });

  it('plans global npm upgrades through the package-owning Node installation', () => {
    const layout = createGlobalInstallLayout();
    try {
      const plan = createUpgradePlan({
        installMode: 'global',
        packageRoot: layout.packageRoot,
      });

      assert.deepEqual(plan.commands, [
        {
          command: layout.nodePath,
          args: [layout.npmCliPath, 'install', '-g', 'jump.sh@latest', '--prefix', layout.prefix],
        },
        {
          command: layout.nodePath,
          args: [layout.jumpBinPath, 'install'],
        },
      ]);
      assert.equal(plan.preserveState, true);
      assert.ok(plan.commands.every(({ command }) => command !== 'npm' && command !== 'jump.sh'));
      assert.ok(plan.commands.every(({ command }) => command !== process.execPath));
    } finally {
      fs.rmSync(layout.prefix, { recursive: true, force: true });
    }
  });

  it('canonicalizes the target prefix derived from the global package root', () => {
    const layout = createGlobalInstallLayout();
    const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-prefix-alias-'));
    const aliasPrefix = path.join(aliasParent, 'prefix');
    fs.symlinkSync(layout.prefix, aliasPrefix);

    try {
      const toolchain = resolveGlobalToolchain({
        packageRoot: path.join(aliasPrefix, 'lib', 'node_modules', 'jump.sh'),
      });

      assert.equal(toolchain.prefix, layout.prefix);
      assert.equal(toolchain.installTarget, path.join(layout.prefix, 'lib', 'node_modules'));
      assert.equal(toolchain.nodePath, layout.nodePath);
    } finally {
      fs.rmSync(aliasParent, { recursive: true, force: true });
      fs.rmSync(layout.prefix, { recursive: true, force: true });
    }
  });

  it('supports a package prefix split from its runtime Node/npm installation', () => {
    const layout = createGlobalInstallLayout({ withToolchain: false });
    const runtime = createRuntimeToolchain();
    let npmExecuted = false;
    try {
      const plan = createUpgradePlan({
        installMode: 'global',
        packageRoot: layout.packageRoot,
        execPath: runtime.nodePath,
        env: {
          PATH: '/untrusted/path',
          npm_execpath: '/untrusted/npm-cli.js',
          npm_config_prefix: '/different/configured/prefix',
        },
        execFileSync: () => {
          npmExecuted = true;
          throw new Error('resolution must not execute npm');
        },
      });

      assert.equal(plan.toolchain.prefix, layout.prefix);
      assert.equal(plan.toolchain.nodePath, runtime.nodePath);
      assert.equal(plan.toolchain.npmCliPath, runtime.npmCliPath);
      assert.equal(npmExecuted, false);
      assert.deepEqual(plan.commands[0], {
        command: runtime.nodePath,
        args: [runtime.npmCliPath, 'install', '-g', 'jump.sh@latest', '--prefix', layout.prefix],
      });
      assert.deepEqual(plan.commands[1], {
        command: runtime.nodePath,
        args: [layout.jumpBinPath, 'install'],
      });
    } finally {
      fs.rmSync(layout.prefix, { recursive: true, force: true });
      fs.rmSync(runtime.prefix, { recursive: true, force: true });
    }
  });

  it('never executes or selects hostile PATH and npm_execpath candidates', () => {
    const layout = createGlobalInstallLayout({ withToolchain: false });
    const runtime = createRuntimeToolchain();
    const hostileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-hostile-path-'));
    const marker = path.join(hostileDir, 'executed');
    const hostileNpm = path.join(hostileDir, 'npm');
    const hostileExecPath = path.join(hostileDir, 'npm-cli.js');
    const hostileScript = `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`;
    fs.writeFileSync(hostileNpm, hostileScript, { mode: 0o755 });
    fs.writeFileSync(hostileExecPath, hostileScript, { mode: 0o755 });
    try {
      const toolchain = resolveGlobalToolchain({
        packageRoot: layout.packageRoot,
        execPath: runtime.nodePath,
        env: { PATH: hostileDir, npm_execpath: hostileExecPath },
      });

      assert.equal(toolchain.npmCliPath, runtime.npmCliPath);
      assert.equal(fs.existsSync(marker), false);
    } finally {
      fs.rmSync(layout.prefix, { recursive: true, force: true });
      fs.rmSync(runtime.prefix, { recursive: true, force: true });
      fs.rmSync(hostileDir, { recursive: true, force: true });
    }
  });

  it('prefers a complete co-located mise-style pair over a different complete current runtime', () => {
    const layout = createGlobalInstallLayout();
    const runtime = createRuntimeToolchain();
    try {
      const toolchain = resolveGlobalToolchain({
        packageRoot: layout.packageRoot,
        execPath: runtime.nodePath,
      });

      assert.equal(toolchain.nodePath, layout.nodePath);
      assert.equal(toolchain.npmCliPath, layout.npmCliPath);
    } finally {
      fs.rmSync(layout.prefix, { recursive: true, force: true });
      fs.rmSync(runtime.prefix, { recursive: true, force: true });
    }
  });

  it('accepts same-bin npm only when its canonical target is within the runtime prefix', () => {
    const layout = createGlobalInstallLayout({ withToolchain: false });
    const runtime = createRuntimeToolchain({ standardNpmLayout: false });
    try {
      const toolchain = resolveGlobalToolchain({
        packageRoot: layout.packageRoot,
        execPath: runtime.nodePath,
      });

      assert.equal(toolchain.nodePath, runtime.nodePath);
      assert.equal(toolchain.npmCliPath, runtime.npmCliPath);
    } finally {
      fs.rmSync(layout.prefix, { recursive: true, force: true });
      fs.rmSync(runtime.prefix, { recursive: true, force: true });
    }
  });

  it('rejects same-bin npm when its canonical target is outside the runtime prefix', () => {
    const layout = createGlobalInstallLayout({ withToolchain: false });
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-outside-npm-'));
    const outsideNpm = path.join(outsideDir, 'npm-cli.js');
    writeNpmCli(outsideNpm);
    const runtime = createRuntimeToolchain({ standardNpmLayout: false, npmTarget: outsideNpm });
    try {
      assert.throws(
        () => resolveGlobalToolchain({
          packageRoot: layout.packageRoot,
          execPath: runtime.nodePath,
        }),
        /no trusted Node\/npm pair/i,
      );
    } finally {
      fs.rmSync(layout.prefix, { recursive: true, force: true });
      fs.rmSync(runtime.prefix, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('fails toolchain preflight before daemon removal when no trusted pair exists', () => {
    const layout = createGlobalInstallLayout({ withToolchain: false });
    const runtime = createRuntimeToolchain({ standardNpmLayout: false });
    fs.rmSync(runtime.npmCliPath);
    fs.rmSync(runtime.npmPath);
    let removed = false;
    try {
      assert.throws(
        () => {
          const plan = createUpgradePlan({
            installMode: 'global',
            packageRoot: layout.packageRoot,
            execPath: runtime.nodePath,
          });
          executeUpgradePlan(plan, { removeDaemon: () => { removed = true; } });
        },
        /no trusted Node\/npm pair/i,
      );
      assert.equal(removed, false);
    } finally {
      fs.rmSync(layout.prefix, { recursive: true, force: true });
      fs.rmSync(runtime.prefix, { recursive: true, force: true });
    }
  });

  it('rejects unsupported layouts or a missing jump.sh bin before daemon removal', () => {
    const layout = createGlobalInstallLayout();
    let removed = false;
    try {
      fs.rmSync(layout.jumpBinPath);
      assert.throws(
        () => {
          const plan = createUpgradePlan({ installMode: 'global', packageRoot: layout.packageRoot });
          executeUpgradePlan(plan, { removeDaemon: () => { removed = true; } });
        },
        /jump\.sh bin.*not found/i,
      );
      assert.equal(removed, false);
    } finally {
      fs.rmSync(layout.prefix, { recursive: true, force: true });
    }

    assert.throws(
      () => resolveGlobalToolchain({ packageRoot: path.join(os.tmpdir(), 'share', 'jump.sh') }),
      /expected.*lib.*node_modules.*jump\.sh/i,
    );
  });

  it('rejects an unwritable global install target before daemon removal', () => {
    const layout = createGlobalInstallLayout();
    let removed = false;
    const fileSystem = {
      ...fs,
      accessSync(target, mode) {
        if (target === path.join(layout.prefix, 'lib', 'node_modules') && mode === fs.constants.W_OK) {
          const err = new Error('permission denied');
          err.code = 'EACCES';
          throw err;
        }
        return fs.accessSync(target, mode);
      },
    };

    try {
      assert.throws(
        () => {
          const plan = createUpgradePlan({
            installMode: 'global',
            packageRoot: layout.packageRoot,
            fileSystem,
          });
          executeUpgradePlan(plan, { removeDaemon: () => { removed = true; } });
        },
        /global install target.*not writable/i,
      );
      assert.equal(removed, false);
    } finally {
      fs.rmSync(layout.prefix, { recursive: true, force: true });
    }
  });

  it('does not remove the daemon when global package installation fails', () => {
    const layout = createGlobalInstallLayout();
    const events = [];
    try {
      const plan = createUpgradePlan({ installMode: 'global', packageRoot: layout.packageRoot });
      assert.throws(
        () => executeUpgradePlan(plan, {
          cwd: layout.prefix,
          executeCommand: (step) => {
            events.push(step);
            throw new Error('registry unavailable');
          },
          removeDaemon: () => events.push('remove'),
        }),
        /registry unavailable/,
      );
      assert.deepEqual(events, [plan.commands[0]]);
    } finally {
      fs.rmSync(layout.prefix, { recursive: true, force: true });
    }
  });

  it('removes the daemon only between global package and service installation', () => {
    const layout = createGlobalInstallLayout();
    const events = [];
    try {
      const plan = createUpgradePlan({ installMode: 'global', packageRoot: layout.packageRoot });
      executeUpgradePlan(plan, {
        cwd: layout.prefix,
        executeCommand: (step) => events.push(step),
        removeDaemon: () => {
          events.push('remove');
          return [];
        },
      });
      assert.deepEqual(events, [plan.commands[0], 'remove', plan.commands[1]]);
    } finally {
      fs.rmSync(layout.prefix, { recursive: true, force: true });
    }
  });

  it('uses the global installation toolchain for registry and installed version lookups', () => {
    const layout = createGlobalInstallLayout();
    const calls = [];
    const commandRunner = (command, args, options) => {
      calls.push({ command, args, options });
      return calls.length === 1 ? '1.2.3\n' : 'jump.sh 1.2.3\n';
    };

    try {
      const toolchain = resolveGlobalToolchain({ packageRoot: layout.packageRoot });
      assert.equal(resolveLatestVersion('global', { toolchain, cwd: layout.prefix, execFileSync: commandRunner }), '1.2.3');
      assert.equal(readInstalledVersion('global', { toolchain, cwd: layout.prefix, execFileSync: commandRunner }), '1.2.3');
      assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
        { command: layout.nodePath, args: [layout.npmCliPath, 'view', 'jump.sh@latest', 'version'] },
        { command: layout.nodePath, args: [layout.jumpBinPath, '--version'] },
      ]);
      assert.ok(calls.every(({ options }) => options.cwd === layout.prefix));
    } finally {
      fs.rmSync(layout.prefix, { recursive: true, force: true });
    }
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
    const globalLayout = createGlobalInstallLayout();
    const deletedCwd = path.join(tmpParent, 'deleted');
    fs.mkdirSync(deletedCwd);

    const calls = [];
    try {
      process.chdir(deletedCwd);
      fs.rmSync(deletedCwd, { recursive: true, force: true });

      const safeCwd = resolveSafeUpgradeCwd({ homeDir: tmpHome, packageRoot: ROOT });
      const plans = [
        createUpgradePlan({ installMode: 'npx' }),
        createUpgradePlan({
          installMode: 'global',
          packageRoot: globalLayout.packageRoot,
        }),
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
      fs.rmSync(globalLayout.prefix, { recursive: true, force: true });
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
