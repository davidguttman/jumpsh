import https from 'https';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { certPairPathsForDir, isCertStatusHealthy, localCertStatus, usernameFromDomain } from '../cert-status.js';
import { downloadCertsForUser } from '../ssh-register.js';

const JUMPSH_DIR = path.join(os.homedir(), '.jump.sh');
const CERTS_DIR = path.join(JUMPSH_DIR, 'certs');
const CERT_FILE = path.join(CERTS_DIR, 'server.pem');
const KEY_FILE = path.join(CERTS_DIR, 'server-key.pem');

export async function downloadCerts() {
  const origin = process.env.JUMPSH_ORIGIN || 'https://jump.sh';
  const certUrl = `${origin}/certs/server.pem`;
  const keyUrl = `${origin}/certs/server-key.pem`;

  fs.mkdirSync(CERTS_DIR, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(CERTS_DIR, '.tmp-download-'));
  const tmpCertFile = path.join(tmpDir, 'server.pem');
  const tmpKeyFile = path.join(tmpDir, 'server-key.pem');

  console.log(`Downloading certs from ${origin}...`);

  try {
    try {
      await downloadFile(certUrl, tmpCertFile);
    } catch (err) {
      const msg = `Failed to download certificate: ${err.message}\n` +
        `  URL: ${certUrl}\n\nTo fix:\n` +
        `  1. Check that ${origin} is reachable\n` +
        `  2. Or set JUMPSH_ORIGIN to the correct server URL\n` +
        `  3. Or manually place server.pem and server-key.pem in ${CERTS_DIR}`;
      throw new Error(msg, { cause: err });
    }

    try {
      await downloadFile(keyUrl, tmpKeyFile);
    } catch (err) {
      const msg = `Failed to download key: ${err.message}\n` +
        `  URL: ${keyUrl}\n\nTo fix:\n` +
        `  1. Check that ${origin} is reachable\n` +
        `  2. Or set JUMPSH_ORIGIN to the correct server URL\n` +
        `  3. Or manually place server.pem and server-key.pem in ${CERTS_DIR}`;
      throw new Error(msg, { cause: err });
    }

    const status = localCertStatus({ certPath: tmpCertFile, keyPath: tmpKeyFile });
    if (status.status !== 'valid') {
      const expires = status.expires_at ? `, expires ${status.expires_at}` : '';
      throw new Error(`Downloaded certificates failed validation: ${status.status}${expires}`);
    }

    fs.renameSync(tmpCertFile, CERT_FILE);
    fs.renameSync(tmpKeyFile, KEY_FILE);

    console.log(`  Downloaded: ${CERT_FILE}`);
    console.log(`  Downloaded: ${KEY_FILE}`);
    console.log('Certificates installed successfully.');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function userCertStatus(username, certsDir = CERTS_DIR) {
  const certDir = path.join(certsDir, username);
  const paths = certPairPathsForDir(certDir);
  return {
    ...localCertStatus(paths),
    certDir,
    username,
    kind: 'remote',
  };
}

export function detectRegisteredCertUsernames({ certsDir = CERTS_DIR, domain = null } = {}) {
  const usernames = new Set();
  const fromDomain = usernameFromDomain(domain);
  if (fromDomain) usernames.add(fromDomain);

  try {
    const entries = fs.readdirSync(certsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const paths = certPairPathsForDir(path.join(certsDir, entry.name));
      if (fs.existsSync(paths.certPath) || fs.existsSync(paths.keyPath)) {
        usernames.add(entry.name);
      }
    }
  } catch {
    // No certs directory yet; the domain-derived username (if any) still applies.
  }

  return [...usernames];
}

export function getDefaultCertStatus({ certsDir = CERTS_DIR } = {}) {
  return localCertStatus({
    certPath: path.join(certsDir, 'server.pem'),
    keyPath: path.join(certsDir, 'server-key.pem'),
  });
}

function describeCertStatus(status) {
  return status.expires_at ? `${status.status}, expires ${status.expires_at}` : status.status;
}

// Refresh every cert pair the HTTPS server serves: each registered user dir
// (certs/<username>/) plus the legacy default pair (certs/server.pem). The
// default pair is only bootstrapped from scratch when no user is registered.
// Never throws; per-target failures are logged and reported via `error`.
export async function ensureHttpsCerts({
  certsDir = CERTS_DIR,
  domain = null,
  downloadDefault = downloadCerts,
  downloadUser = downloadCertsForUser,
  log = console.log,
} = {}) {
  const usernames = detectRegisteredCertUsernames({ certsDir, domain });
  const results = [];

  for (const username of usernames) {
    const before = userCertStatus(username, certsDir);
    const entry = { kind: 'remote', username, before, after: before };
    if (!isCertStatusHealthy(before)) {
      log(`Registered TLS certificates for ${username}.jump.sh are ${describeCertStatus(before)}. Attempting user cert refresh...`);
      try {
        await downloadUser(username);
        entry.after = userCertStatus(username, certsDir);
      } catch (err) {
        entry.error = err.message;
        log(`User cert refresh for ${username}.jump.sh failed: ${err.message}`);
      }
    }
    results.push(entry);
  }

  const defaultBefore = getDefaultCertStatus({ certsDir });
  if (usernames.length === 0 || defaultBefore.status !== 'missing') {
    const entry = { kind: 'default', before: defaultBefore, after: defaultBefore };
    if (!isCertStatusHealthy(defaultBefore)) {
      log(`Default TLS certificates are ${describeCertStatus(defaultBefore)}. Attempting legacy cert download...`);
      try {
        await downloadDefault();
        entry.after = getDefaultCertStatus({ certsDir });
      } catch (err) {
        entry.error = err.message;
        log(`Default cert download failed: ${err.message}`);
      }
    }
    results.push(entry);
  }

  return { results };
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Drain response body before following redirect
        res.resume();
        downloadFile(res.headers.location, destPath).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      const out = fs.createWriteStream(destPath, { mode: 0o600 });
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout downloading ${url}`));
    });
  });
}
