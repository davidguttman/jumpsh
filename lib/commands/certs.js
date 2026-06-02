import https from 'https';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isCertStatusHealthy, localCertStatus } from '../cert-status.js';

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

export function getDefaultCertStatus() {
  return localCertStatus({ certPath: CERT_FILE, keyPath: KEY_FILE });
}

export function certsExist() {
  return isCertStatusHealthy(getDefaultCertStatus());
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
