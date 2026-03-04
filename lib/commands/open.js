import { execSync } from 'child_process';
import os from 'os';
import { detectDomain } from '../domain.js';

export default async function open(argv) {
  const domain = detectDomain();
  const url = `https://dash.${domain}`;

  console.log(url);

  const cmd = os.platform() === 'darwin' ? 'open' : 'xdg-open';
  try {
    execSync(`${cmd} "${url}"`, { stdio: 'ignore' });
  } catch {
    console.error(`Could not open browser. Visit: ${url}`);
  }
}
