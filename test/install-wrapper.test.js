import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
    });
    const wrapper = generateDaemonWrapper(config);

    assert.deepEqual(config, {
      cwd: packageRoot,
      execCommand: "node '/opt/jump.sh/bin/jumpsh.js' server",
    });
    assert.ok(wrapper.includes("cd '/opt/jump.sh' 2>/dev/null"));
    assert.ok(wrapper.includes("exec node '/opt/jump.sh/bin/jumpsh.js' server"));
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
    assert.equal(resolveGlobalBin({ packageRoot: '/opt/jump.sh', binExists: () => true }), "node '/opt/jump.sh/bin/jumpsh.js'");
  });
});
