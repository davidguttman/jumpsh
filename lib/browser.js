import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';

// Launch the system browser with the URL as a single argv entry (no shell),
// resolving true only when the launcher exits successfully.
export function launchBrowser(url, { platform = os.platform(), spawn = nodeSpawn } = {}) {
  const command = platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, [url], { stdio: 'ignore', detached: true });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
    child.unref?.();
  });
}
