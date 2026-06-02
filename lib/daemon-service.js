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
  cwd = resolveSafeDaemonCommandCwd({ homeDir, fileSystem }),
} = {}) {
  const removed = [];
  const runCommand = (cmd, opts) => execSync(cmd, { ...opts, cwd });
  const { wrapperPath, servicePath } = daemonPaths({ homeDir, platform });

  if (platform === 'darwin') {
    try {
      runCommand('launchctl bootout gui/$(id -u)/sh.jump.daemon 2>/dev/null', { stdio: 'ignore' });
      removed.push('Stopped daemon');
    } catch { /* may not be running */ }

    if (servicePath && fileSystem.existsSync(servicePath)) {
      fileSystem.unlinkSync(servicePath);
      removed.push(`Removed ${servicePath}`);
    }
  } else if (platform === 'linux') {
    try {
      runCommand('systemctl --user stop jumpsh 2>/dev/null', { stdio: 'ignore' });
      runCommand('systemctl --user disable jumpsh 2>/dev/null', { stdio: 'ignore' });
      removed.push('Stopped and disabled daemon');
    } catch { /* may not be running */ }

    if (servicePath && fileSystem.existsSync(servicePath)) {
      fileSystem.unlinkSync(servicePath);
      try { runCommand('systemctl --user daemon-reload', { stdio: 'ignore' }); } catch { /* best effort */ }
      removed.push(`Removed ${servicePath}`);
    }
  }

  if (fileSystem.existsSync(wrapperPath)) {
    fileSystem.unlinkSync(wrapperPath);
    removed.push(`Removed ${wrapperPath}`);
  }

  return removed;
}


function resolveSafeDaemonCommandCwd({ homeDir, fileSystem }) {
  for (const candidate of [homeDir, path.parse(homeDir || path.sep).root]) {
    if (!candidate) continue;
    try {
      if (fileSystem.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Try the next fallback.
    }
  }

  return path.sep;
}
