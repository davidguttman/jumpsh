import {
  detectGitHubUsername,
  requestChallenge,
  signChallenge,
  completeRegistration,
  waitForCert,
  downloadCertsForUser,
} from '../ssh-register.js';

export default async function register(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: jumpsh register [options]

Register via GitHub SSH key. Provisions *.username.jump.sh with
automatic DNS and TLS certificate.

Options:
  --ip <address>        IP address for A record (default: 127.0.0.1)
  --username <name>     GitHub username (skip auto-detection)
  --help, -h            Show this help

Environment:
  JUMPSH_API            API server (default: https://api.jump.sh)
`);
    process.exit(0);
  }

  const ip = argv.includes('--ip')
    ? argv[argv.indexOf('--ip') + 1]
    : '127.0.0.1';

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

  // Step 2: Request challenge
  console.log('\nRequesting challenge...');
  let nonce, keys;
  try {
    ({ nonce, keys } = await requestChallenge(username));
  } catch (err) {
    console.error(`Challenge failed: ${err.message}`);
    process.exit(1);
  }
  console.log('\u2713 Got challenge nonce');

  // Step 3: Sign challenge
  console.log('\nSigning with SSH key...');
  let signature;
  try {
    signature = await signChallenge(nonce, keys);
  } catch (err) {
    console.error(`Signing failed: ${err.message}`);
    process.exit(1);
  }
  console.log('\u2713 Signature created');

  // Step 4: Complete registration
  console.log(`\nRegistering ${username}.jump.sh...`);
  try {
    await completeRegistration(username, nonce, signature, ip);
  } catch (err) {
    console.error(`Registration failed: ${err.message}`);
    process.exit(1);
  }
  console.log('\u2713 DNS record created');
  console.log('\u2713 Certificate provisioning started');

  // Step 5: Wait for cert
  console.log('\nWaiting for certificate...');
  try {
    await waitForCert(username);
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
  console.log('\n\u2713 Certificate ready');

  // Step 6: Download certs
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

  console.log(`\nDone! Your projects are now available at:`);
  console.log(`  https://*.${username}.jump.sh`);
}
