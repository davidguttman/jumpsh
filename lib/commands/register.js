import { createInterface } from 'readline';
import { execSync } from 'child_process';
import {
  detectGitHubUsername,
  requestChallenge,
  signChallenge,
  completeRegistration,
  waitForCert,
  downloadCertsForUser,
} from '../ssh-register.js';

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
async function promptForIP(ips) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('\nSelect IP address for DNS record:\n');
  ips.forEach((entry, i) => {
    const rec = entry.recommended ? ' (recommended)' : '';
    console.log(`  ${i + 1}) ${entry.ip} — ${entry.source}${rec}`);
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
    console.log(`Usage: jumpsh register [options]

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

  // Step 1: Detect username
  let username;
  if (usernameOverride) {
    username = usernameOverride;
    console.log(`Using GitHub username: ${username}`);
  } else {
    console.log('Detecting GitHub identity...');
    username = detectGitHubUsername();
    if (!username) {
      console.error(
        'Could not detect GitHub username.\n' +
        'Make sure you have an SSH key added to your GitHub account.\n' +
        'See: https://docs.github.com/en/authentication/connecting-to-github-with-ssh\n\n' +
        'Or pass --username <github_username> to skip auto-detection.'
      );
      process.exit(1);
    }
    console.log('\u2713 Found: ' + username);
  }

  // Step 2: Select IP address
  let selectedIP;
  if (ipOverride) {
    selectedIP = { ip: ipOverride, source: 'command line' };
    console.log(`\nUsing IP: ${selectedIP.ip} (${selectedIP.source})`);
  } else {
    const availableIPs = detectIPs();
    selectedIP = await promptForIP(availableIPs);
    console.log(`\u2713 Using ${selectedIP.ip} (${selectedIP.source})`);
  }

  // Step 3: Request challenge
  console.log('\nRequesting challenge...');
  let nonce, keys;
  try {
    ({ nonce, keys } = await requestChallenge(username));
  } catch (err) {
    console.error(`Challenge failed: ${err.message}`);
    process.exit(1);
  }
  console.log('\u2713 Got challenge nonce');

  // Step 4: Sign challenge
  console.log('\nSigning with SSH key...');
  let signature;
  try {
    signature = await signChallenge(nonce, keys);
  } catch (err) {
    console.error(`Signing failed: ${err.message}`);
    process.exit(1);
  }
  console.log('\u2713 Signature created');

  // Step 5: Complete registration
  console.log(`\nRegistering ${username}.jump.sh → ${selectedIP.ip}`);
  try {
    await completeRegistration(username, nonce, signature, selectedIP.ip);
  } catch (err) {
    console.error(`Registration failed: ${err.message}`);
    process.exit(1);
  }
  console.log('\u2713 DNS record created');
  console.log('\u2713 Certificate provisioning started');

  // Step 6: Wait for cert
  console.log('\nWaiting for certificate...');
  try {
    await waitForCert(username);
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
  console.log('\n\u2713 Certificate ready');

  // Step 7: Download certs
  console.log(`\nSaving to ~/.jump.sh/certs/${username}/`);
  let certDir;
  try {
    certDir = await downloadCertsForUser(username);
  } catch (err) {
    console.error(`Cert download failed: ${err.message}`);
    process.exit(1);
  }
  console.log('\u2713 fullchain.pem');
  console.log('\u2713 privkey.pem');

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Done! Your projects are now available at:`);
  console.log(`  https://*.${username}.jump.sh`);
  
  if (selectedIP.source === 'Tailscale') {
    console.log(`\nAccessible from any device on your Tailnet.`);
  } else if (selectedIP.ip === '127.0.0.1') {
    console.log(`\nAccessible only from this machine.`);
  }
}
