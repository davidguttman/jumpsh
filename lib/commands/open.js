import { execSync } from 'child_process';
import os from 'os';
import { detectDomain, detectPort, formatDashUrl } from '../domain.js';

export default async function open(argv) {
  const domain = detectDomain();
  const port = detectPort();
  const url = formatDashUrl(domain, port);

  console.log(url);

  const cmd = os.platform() === 'darwin' ? 'open' : 'xdg-open';
  try {
    execSync(`${cmd} "${url}"`, { stdio: 'ignore' });
  } catch {
    console.error(`Could not open browser. Visit: ${url}`);
  }
}
