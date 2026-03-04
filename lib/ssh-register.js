import { execSync, execFile, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const JUMPSH_DIR = path.join(os.homedir(), '.jump.sh');

export function getRegisterApiOrigin() {
  return process.env.JUMPSH_API || process.env.JUMPSH_API_ORIGIN || 'https://jump.sh';
}

// Step 1: Detect GitHub username via SSH
export function detectGitHubUsername() {
  try {
    const output = execSync('ssh -T git@github.com 2>&1', {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const match = output.match(/Hi ([^!]+)!/);
    if (match) return match[1];
  } catch (err) {
    const out = (err.stderr || '') + (err.stdout || '');
    const match = out.match(/Hi ([^!]+)!/);
    if (match) return match[1];
  }
  return null;
}

// Step 2: Request challenge nonce from API
export async function requestChallenge(username) {
  const origin = getRegisterApiOrigin();
  const res = await fetch(`${origin}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Challenge request failed (HTTP ${res.status})`);
  }

  const { challenge_nonce: nonce, keys } = await res.json();

  if (!keys || keys.length === 0) {
    throw new Error(
      'GitHub has no SSH keys for this account.\n' +
      'Add one at https://github.com/settings/keys'
    );
  }

  return { nonce, keys };
}

// Find local private keys that match GitHub's public keys
function findMatchingKeys(githubKeys) {
  function keyBody(line) {
    const parts = line.trim().split(/\s+/);
    return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : line.trim();
  }

  const githubBodies = new Set(githubKeys.map(keyBody));
  const sshDir = path.join(os.homedir(), '.ssh');
  const keyNames = ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa'];
  const matches = [];

  for (const name of keyNames) {
    const privPath = path.join(sshDir, name);
    const pubPath = privPath + '.pub';

    if (!fs.existsSync(privPath) || !fs.existsSync(pubPath)) continue;

    const pubContent = fs.readFileSync(pubPath, 'utf8').trim();
    if (githubBodies.has(keyBody(pubContent))) {
      matches.push({ privPath, pubPath, pubContent });
    }
  }

  return matches;
}

// Ensure agent is running with a matching key loaded
function ensureAgent(matchingKeys) {
  // Check if agent is already working
  try {
    const loaded = execSync('ssh-add -L', { encoding: 'utf8', timeout: 5000 });
    // Check if any loaded key matches
    for (const { pubContent } of matchingKeys) {
      if (loaded.includes(pubContent.split(/\s+/)[1])) {
        return null; // Agent ready, no cleanup needed
      }
    }
  } catch {
    // Agent not running or no keys
  }

  // Start a temporary agent
  console.log('No SSH agent detected. Starting temporary agent for signing...');
  console.log('(Agent will be cleaned up automatically)');
  const agentOut = execSync('ssh-agent -s', { encoding: 'utf8' });
  
  // Parse SSH_AUTH_SOCK and SSH_AGENT_PID
  const sockMatch = agentOut.match(/SSH_AUTH_SOCK=([^;]+)/);
  const pidMatch = agentOut.match(/SSH_AGENT_PID=(\d+)/);
  
  if (!sockMatch || !pidMatch) {
    throw new Error('Failed to start SSH agent');
  }

  process.env.SSH_AUTH_SOCK = sockMatch[1];
  process.env.SSH_AGENT_PID = pidMatch[1];

  // Add the first matching key (will prompt for passphrase if needed)
  const keyPath = matchingKeys[0].privPath;
  console.log(`Adding key to agent: ${keyPath}`);
  console.log('(You may be prompted for your passphrase)');
  
  try {
    execSync(`ssh-add "${keyPath}"`, { 
      stdio: 'inherit',
      timeout: 60_000 
    });
  } catch (err) {
    // Clean up agent on failure
    try { process.kill(parseInt(pidMatch[1])); } catch {}
    throw new Error('Failed to add SSH key to agent');
  }

  // Return cleanup function
  return () => {
    try { process.kill(parseInt(pidMatch[1])); } catch {}
  };
}

// Step 3: Sign challenge via agent
export async function signChallenge(nonce, keys) {
  const matchingKeys = findMatchingKeys(keys);

  if (matchingKeys.length === 0) {
    throw new Error(
      'No local SSH keys match your GitHub account.\n' +
      '  Check ~/.ssh/ for your keys\n' +
      '  Check https://github.com/settings/keys'
    );
  }

  const cleanup = ensureAgent(matchingKeys);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-'));

  try {
    // Write public key to temp file for signing
    const pubKeyFile = path.join(tmpDir, 'key.pub');
    fs.writeFileSync(pubKeyFile, matchingKeys[0].pubContent + '\n');

    const signature = await new Promise((resolve, reject) => {
      const proc = execFile('ssh-keygen', [
        '-Y', 'sign',
        '-f', pubKeyFile,
        '-n', 'jump.sh',
      ], (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      });
      proc.stdin.write(nonce);
      proc.stdin.end();
    });

    return signature;
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        'ssh-keygen not found. Install OpenSSH or ensure ssh-keygen is on your PATH.'
      );
    }
    throw new Error('Failed to sign challenge: ' + err.message);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (cleanup) cleanup();
  }
}

// Step 4: Complete registration
export async function completeRegistration(username, nonce, signature, ip = '127.0.0.1') {
  const origin = getRegisterApiOrigin();
  const res = await fetch(`${origin}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, nonce, signature, ip }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Registration failed (HTTP ${res.status})`);
  }

  return res.json();
}

// Step 5: Poll for certificate readiness
export async function waitForCert(username, { maxWaitMs = 120_000, intervalMs = 3_000 } = {}) {
  const origin = getRegisterApiOrigin();
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${origin}/api/status?username=${username}`);
      if (res.ok) {
        const { ready } = await res.json();
        if (ready) return true;
      }
    } catch {
      // Transient network error — keep polling
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, intervalMs));
  }

  throw new Error('Timed out waiting for certificate (120s). Try again later.');
}

// Step 6: Download and save certificates
export async function downloadCertsForUser(username) {
  const origin = getRegisterApiOrigin();
  const res = await fetch(`${origin}/api/certs?username=${username}`);

  if (!res.ok) {
    throw new Error('Failed to download certificates');
  }

  const { cert_pem, key_pem } = await res.json();

  const certDir = path.join(JUMPSH_DIR, 'certs', username);
  fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });

  fs.writeFileSync(path.join(certDir, 'fullchain.pem'), cert_pem, { mode: 0o644 });
  fs.writeFileSync(path.join(certDir, 'privkey.pem'), key_pem, { mode: 0o600 });

  return certDir;
}

// OAuth fallback: open browser to start GitHub OAuth flow
export function registerViaOAuth(ip) {
  const state = randomBytes(16).toString('hex');
  const origin = getRegisterApiOrigin();
  const url = `${origin}/api/oauth/github?state=${encodeURIComponent(state)}&ip=${encodeURIComponent(ip)}`;

  const cmd = os.platform() === 'darwin' ? 'open' : 'xdg-open';
  try {
    execSync(`${cmd} "${url}"`, { stdio: 'ignore' });
  } catch {
    console.error(`Could not open browser. Visit:\n  ${url}`);
  }

  return { state };
}

// OAuth fallback: poll for completion
export async function pollOAuthResult(state, { maxWaitMs = 120_000, intervalMs = 2_000 } = {}) {
  const origin = getRegisterApiOrigin();
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${origin}/api/oauth/status?state=${encodeURIComponent(state)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.complete) return { username: data.username, subdomain: data.subdomain };
      }
    } catch {
      // Transient network error — keep polling
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, intervalMs));
  }

  throw new Error('Timed out waiting for GitHub authorization (120s). Try again.');
}

// Check current registration status
export async function getStatus(username) {
  const origin = getRegisterApiOrigin();
  const res = await fetch(`${origin}/api/status?username=${username}`);
  
  if (!res.ok) return null;
  
  return res.json(); // { ready: bool, ip: string }
}
