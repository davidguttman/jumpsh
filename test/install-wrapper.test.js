import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  generateDaemonWrapper,
  isNpxRun,
  resolveDaemonWrapperConfig,
  resolveGlobalBin,
  resolveNpxPath,
  shellQuote,
} from '../lib/commands/install.js';

describe('install daemon wrapper generation', () => {
  it('detects npx cache package roots', () => {
    assert.equal(isNpxRun('/home/david/.npm/_npx/abc/node_modules/jump.sh', {}), true);
    assert.equal(isNpxRun('/opt/jump.sh', { npm_execpath: '/usr/bin/npx' }), true);
    assert.equal(isNpxRun('/opt/jump.sh', { npm_execpath: '/usr/bin/npm' }), false);
  });

  it('uses an npx-safe command and home cwd for npx installs', () => {
    const packageRoot = '/home/david/.npm/_npx/abc/node_modules/jump.sh';
    const config = resolveDaemonWrapperConfig({
      packageRoot,
      homeDir: '/home/david',
      env: {},
      npxPath: '/usr/bin/npx',
    });
    const wrapper = generateDaemonWrapper(config);

    assert.deepEqual(config, {
      cwd: '/home/david',
      execCommand: "'/usr/bin/npx' --yes jump.sh@latest server",
    });
    assert.ok(wrapper.includes("cd '/home/david' 2>/dev/null"));
    assert.ok(wrapper.includes("exec '/usr/bin/npx' --yes jump.sh@latest server"));
    assert.ok(!wrapper.includes(packageRoot));
    assert.ok(!wrapper.includes('exec npx --yes jump.sh server'));
  });

  it('falls back to npx from PATH when no absolute npx can be resolved', () => {
    const config = resolveDaemonWrapperConfig({
      packageRoot: '/tmp/_npx/abc/node_modules/jump.sh',
      homeDir: '/home/david',
      env: {},
      npxPath: null,
    });

    assert.equal(config.execCommand, "'npx' --yes jump.sh@latest server");
  });

  it('keeps stable package-root binary execution for non-npx installs', () => {
    const packageRoot = '/opt/jump.sh';
    const config = resolveDaemonWrapperConfig({
      packageRoot,
      env: {},
      binExists: () => true,
      nodePath: '/opt/node/bin/node',
      nodeExists: () => true,
    });
    const wrapper = generateDaemonWrapper(config);

    assert.deepEqual(config, {
      cwd: packageRoot,
      execCommand: "'/opt/node/bin/node' '/opt/jump.sh/bin/jumpsh.js' server",
    });
    assert.ok(wrapper.includes("cd '/opt/jump.sh' 2>/dev/null"));
    assert.ok(wrapper.includes("exec '/opt/node/bin/node' '/opt/jump.sh/bin/jumpsh.js' server"));
  });

  it('uses the current absolute Node path by default for local and global installs', () => {
    const config = resolveDaemonWrapperConfig({
      packageRoot: '/opt/jump.sh',
      env: {},
      binExists: () => true,
    });

    assert.equal(
      config.execCommand,
      `${shellQuote(process.execPath)} '/opt/jump.sh/bin/jumpsh.js' server`,
    );
  });

  it('runs the wrapper with its exact absolute Node under an empty service-like PATH', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-wrapper-node-'));
    const packageRoot = path.join(tmpDir, 'jump.sh');
    const binPath = path.join(packageRoot, 'bin', 'jumpsh.js');
    const nodePath = path.join(tmpDir, "node runtime's", 'bin', 'node');
    const resultPath = path.join(tmpDir, 'result.json');
    const wrapperPath = path.join(tmpDir, 'jumpsh-daemon.sh');

    try {
      fs.mkdirSync(path.dirname(binPath), { recursive: true });
      fs.mkdirSync(path.dirname(nodePath), { recursive: true });
      fs.writeFileSync(binPath, '');
      fs.writeFileSync(
        nodePath,
        `#!/bin/sh\nprintf '{"cwd":"%s","bin":"%s","arg":"%s"}' "$PWD" "$1" "$2" > ${shellQuote(resultPath)}\n`,
        { mode: 0o755 },
      );

      const config = resolveDaemonWrapperConfig({ packageRoot, env: {}, nodePath });
      fs.writeFileSync(wrapperPath, generateDaemonWrapper(config), { mode: 0o755 });
      execFileSync('/bin/bash', [wrapperPath], {
        env: { HOME: tmpDir, PATH: '' },
      });

      assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, 'utf8')), {
        cwd: packageRoot,
        bin: binPath,
        arg: 'server',
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('guards mise activation by command availability', () => {
    const wrapper = generateDaemonWrapper({ cwd: '/home/david', execCommand: "'npx' --yes jump.sh@latest server" });
    const guardIndex = wrapper.indexOf('if command -v mise >/dev/null 2>&1; then');
    const activateIndex = wrapper.indexOf('mise activate bash');

    assert.ok(guardIndex >= 0);
    assert.ok(activateIndex > guardIndex);
  });

  it('resolves npx path and shell-quotes commands', () => {
    assert.equal(resolveNpxPath(() => '/usr/local/bin/npx\n'), '/usr/local/bin/npx');
    assert.equal(resolveNpxPath(() => ''), null);
    assert.equal(resolveNpxPath(() => { throw new Error('missing'); }), null);
    assert.equal(shellQuote("/tmp/has ' quote"), "'/tmp/has '\"'\"' quote'");
    assert.equal(
      resolveGlobalBin({
        packageRoot: '/opt/jump.sh',
        binExists: () => true,
        nodePath: '/opt/node/bin/node',
        nodeExists: () => true,
      }),
      "'/opt/node/bin/node' '/opt/jump.sh/bin/jumpsh.js'",
    );
    assert.throws(
      () => resolveGlobalBin({ packageRoot: '/opt/jump.sh', binExists: () => true, nodePath: 'node' }),
      /absolute Node executable/i,
    );
  });
});
