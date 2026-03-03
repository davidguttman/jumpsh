import { detectDomain, detectDomainFromCerts } from '../domain.js';
import { isDaemonRunning } from '../daemon-status.js';

export default async function status(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: jump.sh status

Show daemon and domain status.
`);
    process.exit(0);
  }

  const running = isDaemonRunning();
  const domain = detectDomain();
  const hasDomain = detectDomainFromCerts() || process.env.JUMPSH_DOMAIN;

  console.log('jump.sh status');
  console.log('─'.repeat(40));

  if (running) {
    console.log('  Daemon:       running');
  } else {
    console.log('  Daemon:       not running');
  }

  if (hasDomain) {
    console.log(`  Domain:       ${domain}`);
    console.log(`  Dashboard:    https://dash.${domain}`);
  } else {
    console.log('  Domain:       not configured');
    console.log('  Run:          jump.sh register');
  }
}
