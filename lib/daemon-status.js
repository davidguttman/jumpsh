import { execSync } from 'child_process';
import os from 'os';

export function isDaemonRunning() {
  try {
    if (os.platform() === 'darwin') {
      const out = execSync('launchctl list sh.jump.daemon 2>/dev/null', { encoding: 'utf8' });
      const pidMatch = out.match(/"PID"\s*=\s*(\d+)/);
      return pidMatch != null;
    } else {
      const out = execSync('systemctl --user is-active jumpsh 2>/dev/null', { encoding: 'utf8' });
      return out.trim() === 'active';
    }
  } catch {
    return false;
  }
}
