import { execSync, execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const JUMPSH_DIR = path.join(os.homedir(), '.jump.sh');

export function getRegisterApiOrigin() {
  return process.env.JUMPSH_API || process.env.JUMPSH_API_ORIGIN || 'https://api.jump.sh';
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
    // ssh -T exits non-zero even on success
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
    body: JSON.stringify({ github_username: username }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Challenge request failed (HTTP ${res.status})`);
  }

  const { challenge_nonce, keys } = await res.json();

  if (!keys || keys.length === 0) {
    throw new Error(
      'GitHub has no SSH keys for this account.\n' +
      'Add one at https://github.com/settings/keys'
    );
  }

  return { nonce: challenge_nonce, keys };
}

// Step 3: Sign challenge using ssh-agent
export async function signChallenge(nonce, keys) {
  // List keys loaded in ssh-agent
  let agentKeys;
  try {
    const output = execSync('ssh-add -L', { encoding: 'utf8', timeout: 5000 });
    agentKeys = output.trim().split('\n').filter(Boolean);
  } catch {
    throw new Error(
      'No SSH keys loaded in your agent.\n' +
      '  ssh-add -l                   # List loaded keys\n' +
      '  ssh-add ~/.ssh/id_ed25519    # Add a key'
    );
  }

  if (!agentKeys.length || agentKeys[0].includes('no identities')) {
    throw new Error(
      'No SSH keys loaded in your agent.\n' +
      '  ssh-add -l                   # List loaded keys\n' +
      '  ssh-add ~/.ssh/id_ed25519    # Add a key'
    );
  }

  // Parse key body (type + base64) for comparison
  function keyBody(line) {
    const parts = line.trim().split(/\s+/);
    return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : line.trim();
  }

  const agentBodies = new Set(agentKeys.map(keyBody));
  const matchingKeys = keys.filter(k => agentBodies.has(keyBody(k)));

  if (matchingKeys.length === 0) {
    throw new Error(
      'None of your loaded SSH keys match your GitHub account.\n' +
      '  ssh-add -l                          # Loaded keys\n' +
      '  Check https://github.com/settings/keys'
    );
  }

  // Try signing with each matching key via agent
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-'));

  try {
    for (const pubkey of matchingKeys) {
      const keyFile = path.join(tmpDir, 'key.pub');
      fs.writeFileSync(keyFile, pubkey + '\n');

      try {
        const signature = await new Promise((resolve, reject) => {
          const proc = execFile('ssh-keygen', [
            '-Y', 'sign',
            '-f', keyFile,
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
            'ssh-keygen not found. Install OpenSSH or ensure ssh-keygen is on your PATH.\n' +
            '  macOS:  brew install openssh\n' +
            '  Linux:  sudo apt install openssh-client'
          );
        }
        continue;
      }
    }

    throw new Error(
      'SSH agent refused to sign with any matching key.\n' +
      '  ssh-add -l    # Verify keys are loaded'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Step 4: Complete registration
export async function completeRegistration(username, nonce, signature, ip = '127.0.0.1') {
  const origin = getRegisterApiOrigin();
  const res = await fetch(`${origin}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ github_username: username, nonce, signature, ip }),
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
