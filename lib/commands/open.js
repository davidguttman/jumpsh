import { execSync } from 'child_process';
import os from 'os';
import { detectDomain, detectDomainFromCerts } from '../domain.js';

export default async function open(argv) {
  const hasDomain = detectDomainFromCerts() || process.env.JUMPSH_DOMAIN;
  
  if (!hasDomain) {
    console.error('No domain configured yet.');
    console.error('');
    console.error('Register to get your *.username.jump.sh subdomain:');
    console.error('  jump.sh register');
    process.exit(1);
  }

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
