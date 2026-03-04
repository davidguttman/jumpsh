import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectDomain, detectDomainFromCerts } from '../domain.js';
import { isDaemonRunning } from '../daemon-status.js';

export default async function status(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: jump.sh status

Show daemon and domain status.
`);
    process.exit(0);
  }

  const installed = isInstalled();
  const running = isDaemonRunning();
  const domain = detectDomain();
  const hasDomain = detectDomainFromCerts() || process.env.JUMPSH_DOMAIN;
  const port = detectPort();

  console.log('jump.sh status');
  console.log('─'.repeat(40));

  console.log(`  Installed:    ${installed ? 'yes' : 'no'}`);
  if (running) {
    console.log('  Daemon:       running');
  } else {
    console.log('  Daemon:       not running');
  }

  const portSuffix = port === 443 ? '' : `:${port}`;
  const dashUrl = hasDomain
    ? `https://dash.${domain}${portSuffix}`
    : `https://dash.jump.sh${portSuffix}`;

  if (hasDomain) {
    console.log(`  Domain:       ${domain}`);
  } else {
    console.log('  Remote access: not configured');
    console.log('  Run:           jump.sh register');
  }
  console.log(`  Dashboard:    ${dashUrl}`);
}

function isInstalled() {
  const platform = os.platform();
  if (platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'sh.jump.daemon.plist');
    return fs.existsSync(plistPath);
  } else {
    const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'jumpsh.service');
    return fs.existsSync(unitPath);
  }
}

function detectPort() {
  const platform = os.platform();
  if (platform === 'darwin') {
    // macOS plist always sets JUMPSH_PORT=443
    return 443;
  }
  // Linux: read systemd unit file for JUMPSH_PORT
  const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'jumpsh.service');
  try {
    const unit = fs.readFileSync(unitPath, 'utf8');
    const match = unit.match(/Environment=JUMPSH_PORT=(\d+)/);
    if (match) return parseInt(match[1], 10);
  } catch { /* unit file may not exist */ }
  return 4443;
}
