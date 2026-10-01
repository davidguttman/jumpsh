import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';

// Some launchers keep running while the browser is open; past this, assume launched.
const LAUNCH_TIMEOUT_MS = 10000;

// Launch the system browser with the URL as a single argv entry (no shell),
// resolving true only when the launcher exits successfully. The child stays
// referenced until then so the CLI cannot exit before reporting a fallback.
export function launchBrowser(url, { platform = os.platform(), spawn = nodeSpawn, timeoutMs = LAUNCH_TIMEOUT_MS } = {}) {
  const command = platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, [url], { stdio: 'ignore', detached: true });
    } catch {
      resolve(false);
      return;
    }
    let timer = null;
    const settle = (ok) => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      child.unref?.();
      resolve(ok);
    };
    timer = setTimeout(() => settle(true), timeoutMs);
    child.once('error', () => settle(false));
    child.once('exit', (code) => settle(code === 0));
  });
}
