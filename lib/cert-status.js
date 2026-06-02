import { createPrivateKey, createPublicKey, X509Certificate } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const CERT_EXPIRING_SOON_MS = 30 * 24 * 60 * 60 * 1000;

const CERT_BLOCK_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;
const DEFAULT_CERTS_DIR = path.join(os.homedir(), '.jump.sh', 'certs');

function result(status, ready = false, expires_at = null) {
  return { status, ready, expires_at };
}

function firstCertificatePem(pem) {
  if (typeof pem !== 'string') return null;
  const match = pem.match(CERT_BLOCK_RE);
  return match ? match[0] : null;
}

export function certificateStatusFromPem(pem, options = {}) {
  if (!pem) return result('missing');

  const now = options.now ? new Date(options.now) : new Date();
  const expiringSoonMs = options.expiringSoonMs ?? CERT_EXPIRING_SOON_MS;
  const certPem = firstCertificatePem(pem);

  if (!certPem) return result('malformed');

  try {
    const cert = new X509Certificate(certPem);
    const expiresAt = new Date(cert.validTo);
    if (Number.isNaN(expiresAt.getTime())) return result('malformed');

    const expires_at = expiresAt.toISOString();
    const remainingMs = expiresAt.getTime() - now.getTime();

    if (remainingMs <= 0) return result('expired', false, expires_at);
    if (remainingMs <= expiringSoonMs) return result('expiring', false, expires_at);
    return result('valid', true, expires_at);
  } catch {
    return result('malformed');
  }
}

export function validatePrivateKeyPem(keyPem) {
  if (typeof keyPem !== 'string' || !keyPem.trim()) return false;
  try {
    createPrivateKey(keyPem);
    return true;
  } catch {
    return false;
  }
}

export function validateCertificateKeyPairPem(certPem, keyPem) {
  const certBlock = firstCertificatePem(certPem);
  if (!certBlock || typeof keyPem !== 'string' || !keyPem.trim()) return false;

  try {
    const cert = new X509Certificate(certBlock);
    const privateKey = createPrivateKey(keyPem);
    const keyPublic = createPublicKey(privateKey);
    const certPublicDer = cert.publicKey.export({ type: 'spki', format: 'der' });
    const keyPublicDer = keyPublic.export({ type: 'spki', format: 'der' });
    return certPublicDer.equals(keyPublicDer);
  } catch {
    return false;
  }
}

export function isCertStatusHealthy(certStatus) {
  return certStatus?.status === 'valid' && certStatus.ready === true;
}

export function localCertStatus({ certPath, keyPath, now, expiringSoonMs } = {}) {
  if (!certPath || !fs.existsSync(certPath)) return result('missing');
  if (keyPath && !fs.existsSync(keyPath)) return result('missing');

  let certPem;
  try {
    certPem = fs.readFileSync(certPath, 'utf8');
  } catch {
    return result('missing');
  }

  const certStatus = certificateStatusFromPem(certPem, { now, expiringSoonMs });
  if (certStatus.status !== 'valid' && certStatus.status !== 'expiring' && certStatus.status !== 'expired') {
    return certStatus;
  }

  if (keyPath) {
    try {
      const keyPem = fs.readFileSync(keyPath, 'utf8');
      if (!validatePrivateKeyPem(keyPem)) return result('malformed');
      if (!validateCertificateKeyPairPem(certPem, keyPem)) return result('mismatched');
    } catch {
      return result('missing');
    }
  }

  return certStatus;
}

export function certPairPathsForDir(dir) {
  const pairs = [
    { certName: 'server.pem', keyName: 'server-key.pem' },
    { certName: 'fullchain.pem', keyName: 'privkey.pem' },
  ];

  for (const pair of pairs) {
    const certPath = path.join(dir, pair.certName);
    const keyPath = path.join(dir, pair.keyName);
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      return { certPath, keyPath, certName: pair.certName, keyName: pair.keyName };
    }
  }

  for (const pair of pairs) {
    const certPath = path.join(dir, pair.certName);
    const keyPath = path.join(dir, pair.keyName);
    if (fs.existsSync(certPath) || fs.existsSync(keyPath)) {
      return { certPath, keyPath, certName: pair.certName, keyName: pair.keyName };
    }
  }

  return {
    certPath: path.join(dir, 'fullchain.pem'),
    keyPath: path.join(dir, 'privkey.pem'),
    certName: 'fullchain.pem',
    keyName: 'privkey.pem',
  };
}

function usernameFromDomain(domain) {
  if (!domain || domain === 'jump.sh') return null;
  if (!domain.endsWith('.jump.sh')) return null;
  const username = domain.slice(0, -'.jump.sh'.length);
  return username && !username.includes('.') ? username : null;
}

function candidateForDir(dir, meta = {}) {
  const paths = certPairPathsForDir(dir);
  const status = localCertStatus(paths);
  return { ...status, ...meta, ...paths, cert_dir: dir, configured: true };
}

export function getBestLocalCertStatus({ certsDir = DEFAULT_CERTS_DIR, domain = null } = {}) {
  const candidates = [];

  if (fs.existsSync(certsDir)) {
    const defaultPaths = certPairPathsForDir(certsDir);
    if (fs.existsSync(defaultPaths.certPath) || fs.existsSync(defaultPaths.keyPath)) {
      candidates.push(candidateForDir(certsDir, { kind: 'default', domain: 'jump.sh' }));
    }

    try {
      const entries = fs.readdirSync(certsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(certsDir, entry.name);
        const paths = certPairPathsForDir(dir);
        if (fs.existsSync(paths.certPath) || fs.existsSync(paths.keyPath)) {
          candidates.push(candidateForDir(dir, {
            kind: 'remote',
            username: entry.name,
            domain: `${entry.name}.jump.sh`,
          }));
        }
      }
    } catch {
      // Ignore unreadable cert directories; fall through to missing if no candidates.
    }
  }

  if (candidates.length === 0) {
    return { ...result('missing'), configured: false };
  }

  const username = usernameFromDomain(domain);
  if (username) {
    const domainMatch = candidates.find((candidate) => candidate.username === username);
    if (domainMatch) return domainMatch;
  }

  const firstRemote = candidates.find((candidate) => candidate.kind === 'remote');
  return firstRemote || candidates[0];
}
