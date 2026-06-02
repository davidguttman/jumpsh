import { execSync as defaultExecSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export function daemonPaths({ homeDir = os.homedir(), platform = os.platform() } = {}) {
  const stateDir = path.join(homeDir, '.jump.sh');
  const wrapperPath = path.join(stateDir, 'jumpsh-daemon.sh');

  if (platform === 'darwin') {
    return {
      stateDir,
      wrapperPath,
      servicePath: path.join(homeDir, 'Library', 'LaunchAgents', 'sh.jump.daemon.plist'),
    };
  }

  if (platform === 'linux') {
    return {
      stateDir,
      wrapperPath,
      servicePath: path.join(homeDir, '.config', 'systemd', 'user', 'jumpsh.service'),
    };
  }

  return { stateDir, wrapperPath, servicePath: null };
}

export function removeDaemonOnly({
  platform = os.platform(),
  homeDir = os.homedir(),
  execSync = defaultExecSync,
  fileSystem = fs,
} = {}) {
  const removed = [];
  const { wrapperPath, servicePath } = daemonPaths({ homeDir, platform });

  if (platform === 'darwin') {
    try {
      execSync('launchctl bootout gui/$(id -u)/sh.jump.daemon 2>/dev/null', { stdio: 'ignore' });
      removed.push('Stopped daemon');
    } catch { /* may not be running */ }

    if (servicePath && fileSystem.existsSync(servicePath)) {
      fileSystem.unlinkSync(servicePath);
      removed.push(`Removed ${servicePath}`);
    }
  } else if (platform === 'linux') {
    try {
      execSync('systemctl --user stop jumpsh 2>/dev/null', { stdio: 'ignore' });
      execSync('systemctl --user disable jumpsh 2>/dev/null', { stdio: 'ignore' });
      removed.push('Stopped and disabled daemon');
    } catch { /* may not be running */ }

    if (servicePath && fileSystem.existsSync(servicePath)) {
      fileSystem.unlinkSync(servicePath);
      try { execSync('systemctl --user daemon-reload', { stdio: 'ignore' }); } catch { /* best effort */ }
      removed.push(`Removed ${servicePath}`);
    }
  }

  if (fileSystem.existsSync(wrapperPath)) {
    fileSystem.unlinkSync(wrapperPath);
    removed.push(`Removed ${wrapperPath}`);
  }

  return removed;
}
