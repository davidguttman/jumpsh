import { createInterface } from 'readline';
import { execSync } from 'child_process';
import {
  detectGitHubUsername,
  requestChallenge,
  signChallenge,
  completeRegistration,
  waitForCert,
  downloadCertsForUser,
  getStatus,
  startDeviceFlow,
  pollDeviceFlow,
  completeOAuthRegistration,
} from '../ssh-register.js';
import { isDaemonRunning, restartDaemon } from '../daemon-status.js';
import { detectPort, detectProtocol, formatDashUrl } from '../domain.js';

// Prompt yes/no
function promptYesNo(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === '' || a === 'y' || a === 'yes');
    });
  });
}

// Run the GitHub Device Flow, returns { username }
async function runOAuthFlow(ip) {
  const device = await startDeviceFlow();

  console.log(`\n  First, copy your one-time code: ${device.user_code}\n`);
  console.log(`  Then authorize at: ${device.verification_uri}`);

  // Try to open browser
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    execSync(`${cmd} "${device.verification_uri}"`, { stdio: 'ignore' });
    console.log('  (browser opened)');
  } catch {
    // User will navigate manually
  }

  console.log('\nWaiting for GitHub authorization...');
  const { username, accessToken } = await pollDeviceFlow(device.device_code, {
    interval: device.interval || 5,
    expiresIn: device.expires_in || 900
  });

  // Tell the API server to create DNS + cert
  await completeOAuthRegistration(accessToken, ip);

  console.log(`\n✓ Authenticated as ${username}`);
  console.log('✓ DNS record created');
  console.log('✓ Certificate provisioning started');
  return { username };
}

// Detect available IP addresses
function detectIPs() {
  const ips = [];

  // Tailscale IP
  try {
    const tsIP = execSync('tailscale ip -4 2>/dev/null', { encoding: 'utf8' }).trim();
    if (tsIP && /^\d+\.\d+\.\d+\.\d+$/.test(tsIP)) {
      ips.push({ ip: tsIP, source: 'Tailscale', recommended: true });
    }
  } catch {}

  // Always offer localhost
  ips.push({ ip: '127.0.0.1', source: 'localhost (this machine only)' });

  return ips;
}

// Prompt user for IP selection
async function promptForIP(ips, currentIP) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('\nSelect IP address for DNS record:\n');
  ips.forEach((entry, i) => {
    const rec = entry.recommended ? ' (recommended)' : '';
    const current = entry.ip === currentIP ? ' ← current' : '';
    console.log(`  ${i + 1}) ${entry.ip} — ${entry.source}${rec}${current}`);
  });
  console.log(`  c) Custom IP address`);
  console.log();

  const defaultChoice = ips.findIndex(e => e.recommended) + 1 || 1;

  return new Promise((resolve) => {
    rl.question(`Choice [${defaultChoice}]: `, (answer) => {
      rl.close();
      
      const trimmed = answer.trim();
      
      // Custom IP
      if (trimmed.toLowerCase() === 'c') {
        const rl2 = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl2.question('Enter IP address: ', (customIP) => {
          rl2.close();
          resolve({ ip: customIP.trim(), source: 'custom' });
        });
        return;
      }
      
      // Numbered choice or default
      const choice = trimmed === '' ? defaultChoice : parseInt(trimmed, 10);
      if (choice >= 1 && choice <= ips.length) {
        resolve(ips[choice - 1]);
      } else {
        // Invalid, use default
        resolve(ips[defaultChoice - 1]);
      }
    });
  });
}

export default async function register(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: jump.sh register [options]

Register via GitHub SSH key. Provisions *.username.jump.sh with
automatic DNS and TLS certificate.

Options:
  --ip <address>        IP address for A record (skip prompt)
  --username <name>     GitHub username (skip auto-detection)
  --help, -h            Show this help

Environment:
  JUMPSH_API            API server (default: https://jump.sh)
`);
    process.exit(0);
  }

  const ipOverride = argv.includes('--ip')
    ? argv[argv.indexOf('--ip') + 1]
    : null;

  const usernameOverride = argv.includes('--username')
    ? argv[argv.indexOf('--username') + 1]
    : null;

  // Intro
  const W = 61;
  const pad = (s) => s.padEnd(W);
  console.log(`
┌${'─'.repeat(W)}┐
│${pad('  jump.sh registration')}│
├${'─'.repeat(W)}┤
│${pad('  This gives you a wildcard subdomain: *.username.jump.sh')}│
│${pad('')}│
│${pad('  1. You choose an IP address')}│
│${pad('  2. We use ssh-agent to prove you control your GitHub')}│
│${pad('  3. We set up DNS and give you HTTPS certs')}│
└${'─'.repeat(W)}┘
`);

  // Step 1: Select IP address (collected early so OAuth flow can use it)
  let selectedIP;
  if (ipOverride) {
    selectedIP = { ip: ipOverride, source: 'command line' };
    console.log(`\nUsing IP: ${selectedIP.ip} (${selectedIP.source})`);
  } else {
    const availableIPs = detectIPs();
    selectedIP = await promptForIP(availableIPs);
    console.log(`✓ Using ${selectedIP.ip} (${selectedIP.source})`);
  }

  // Step 2: Detect username
  let username;
  let usedOAuth = false;

  if (usernameOverride) {
    username = usernameOverride;
    console.log(`Using GitHub username: ${username}`);
  } else {
    console.log('\nDetecting GitHub identity...');
    username = detectGitHubUsername();
    if (!username) {
      console.log(
        'Could not detect GitHub username via SSH.'
      );
      const useOAuth = await promptYesNo('Authenticate with GitHub instead? (Y/n) ');
      if (!useOAuth) {
        console.error(
          '\nMake sure you have an SSH key added to your GitHub account.\n' +
          'See: https://docs.github.com/en/authentication/connecting-to-github-with-ssh\n\n' +
          'Or pass --username <github_username> to skip auto-detection.'
        );
        process.exit(1);
      }
      const result = await runOAuthFlow(selectedIP.ip);
      username = result.username;
      usedOAuth = true;
    } else {
      console.log(`✓ Found: ${username}`);
      console.log(`  Your subdomain will be: *.${username}.jump.sh`);
    }
  }

  // Check current status
  if (!usedOAuth) {
    const status = await getStatus(username);
    if (status && status.ready) {
      console.log(`\nAlready registered:`);
      console.log(`   IP: ${status.ip}`);
      console.log(`   Subdomain: *.${username}.jump.sh`);
      console.log(`\n   Re-running will update IP and/or renew cert if needed.`);
    }
  }

  // Step 3: SSH challenge/sign flow (skip if OAuth already completed registration)
  if (!usedOAuth) {
    // Request challenge
    console.log('\nRequesting challenge from jump.sh...');
    let nonce, keys;
    try {
      ({ nonce, keys } = await requestChallenge(username));
    } catch (err) {
      console.error(`Challenge failed: ${err.message}`);
      process.exit(1);
    }
    console.log('✓ Got challenge nonce');

    // Sign challenge
    console.log('\nProving GitHub identity via SSH signature...');
    let signature;
    try {
      signature = await signChallenge(nonce, keys);
    } catch (err) {
      console.log(`SSH signing failed: ${err.message}`);
      const useOAuth = await promptYesNo('Authenticate with GitHub instead? (Y/n) ');
      if (!useOAuth) {
        process.exit(1);
      }
      const result = await runOAuthFlow(selectedIP.ip);
      username = result.username;
      usedOAuth = true;
    }

    if (!usedOAuth) {
      console.log('✓ Signature created');

      // Complete registration
      console.log(`\nRegistering ${username}.jump.sh → ${selectedIP.ip}`);
      try {
        await completeRegistration(username, nonce, signature, selectedIP.ip);
      } catch (err) {
        console.error(`Registration failed: ${err.message}`);
        process.exit(1);
      }
      console.log('✓ DNS record created');
      console.log('✓ Certificate provisioning started');
    }
  }

  // Step 6: Wait for cert
  console.log('\nWaiting for certificate (this may take a moment)...');
  try {
    await waitForCert(username);
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
  console.log('\n✓ Certificate ready');

  // Step 7: Download certs
  console.log(`\nSaving certificates to ~/.jump.sh/certs/${username}/`);
  let certDir;
  try {
    certDir = await downloadCertsForUser(username);
  } catch (err) {
    console.error(`Cert download failed: ${err.message}`);
    process.exit(1);
  }
  console.log('✓ fullchain.pem');
  console.log('✓ privkey.pem');

  // Restart daemon to pick up new certs
  if (isDaemonRunning()) {
    try {
      restartDaemon();
      console.log('✓ Daemon restarted with new certs');
    } catch (err) {
      console.warn(`⚠ Could not restart daemon: ${err.message}`);
    }
  }

  const port = detectPort();
  const protocol = detectProtocol();
  const dashUrl = formatDashUrl(`${username}.jump.sh`, port, protocol);

  console.log(`
╔${'═'.repeat(W)}╗
║${pad('  Done! Your projects are now available at:')}║
║${pad('')}║
║${pad(`    https://*.${username}.jump.sh`)}║
║${pad('')}║
║${pad(`  Dashboard: ${dashUrl}`)}║
║${pad('')}║`);
  if (selectedIP.source === 'Tailscale') {
    console.log(`║${pad('  Accessible from any device on your Tailnet.')}║`);
  } else if (selectedIP.ip === '127.0.0.1') {
    console.log(`║${pad('  Accessible only from this machine.')}║`);
  }
  console.log(`╚${'═'.repeat(W)}╝`);

  // Open dashboard in browser
  const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    execSync(`${openCmd} "${dashUrl}"`, { stdio: 'ignore' });
  } catch {}
}
