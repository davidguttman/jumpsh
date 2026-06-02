import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

export function restartDaemon() {
  const cwd = resolveSafeCommandCwd();
  if (os.platform() === 'darwin') {
    execSync('launchctl kickstart -k gui/$(id -u)/sh.jump.daemon', { stdio: 'ignore', cwd });
  } else {
    execSync('systemctl --user restart jumpsh', { stdio: 'ignore', cwd });
  }
}

export function isDaemonRunning() {
  const cwd = resolveSafeCommandCwd();
  try {
    if (os.platform() === 'darwin') {
      const out = execSync('launchctl list sh.jump.daemon 2>/dev/null', { encoding: 'utf8', cwd });
      const pidMatch = out.match(/"PID"\s*=\s*(\d+)/);
      return pidMatch != null;
    } else {
      const out = execSync('systemctl --user is-active jumpsh 2>/dev/null', { encoding: 'utf8', cwd });
      return out.trim() === 'active';
    }
  } catch {
    return false;
  }
}


function resolveSafeCommandCwd() {
  const homeDir = os.homedir();
  for (const candidate of [homeDir, '/']) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Try the next fallback.
    }
  }

  return '/';
}
