import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectDomain, detectDomainFromCerts, detectPort } from '../domain.js';
import { isDaemonRunning } from '../daemon-status.js';
import { getBestLocalCertStatus } from '../cert-status.js';

export default async function status(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: jump.sh status [--json]

Show daemon and domain status.

Options:
  --json        Emit machine-readable JSON output
  --help, -h    Show this help
`);
    process.exit(0);
  }

  const json = argv.includes('--json');

  const installed = isInstalled();
  const running = isDaemonRunning();
  const domain = detectDomain();
  const hasDomain = !!(detectDomainFromCerts() || process.env.JUMPSH_DOMAIN);
  const port = detectPort();
  const certStatus = getBestLocalCertStatus({ domain });
  const showCertStatus = hasDomain || certStatus.configured;

  const portSuffix = port === 443 ? '' : `:${port}`;
  const dashUrl = hasDomain
    ? `https://dash.${domain}${portSuffix}`
    : `https://dash.jump.sh${portSuffix}`;

  if (json) {
    const payload = {
      installed,
      daemon: running ? 'running' : 'stopped',
      running,
      domain,
      remote: hasDomain,
      port,
      dashboard: dashUrl,
    };
    if (showCertStatus) {
      payload.cert_status = certStatus.status;
      payload.expires_at = certStatus.expires_at;
    }
    console.log(JSON.stringify(payload));
    return;
  }

  console.log('jump.sh status');
  console.log('─'.repeat(40));

  console.log(`  Installed:    ${installed ? 'yes' : 'no'}`);
  if (running) {
    console.log('  Daemon:       running');
  } else {
    console.log('  Daemon:       not running');
  }

  if (hasDomain) {
    console.log(`  Domain:       ${domain}`);
  } else {
    console.log('  Remote access: not configured');
    console.log('  Run:           jump.sh register');
  }
  if (showCertStatus) {
    const expires = certStatus.expires_at ? ` (expires ${certStatus.expires_at})` : '';
    console.log(`  TLS cert:     ${certStatus.status}${expires}`);
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

