import fs from 'fs';
import os from 'os';
import path from 'path';

const certPath = path.join(os.homedir(), '.jump.sh', 'certs');

/**
 * Auto-detect domain from cert subdirectories
 * e.g. certs/username/ → username.jump.sh
 */
export function detectDomainFromCerts() {
  try {
    const entries = fs.readdirSync(certPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subdir = path.join(certPath, entry.name);
      const hasLegacy = fs.existsSync(path.join(subdir, 'server-key.pem')) &&
                        fs.existsSync(path.join(subdir, 'server.pem'));
      const hasNew = fs.existsSync(path.join(subdir, 'privkey.pem')) &&
                     fs.existsSync(path.join(subdir, 'fullchain.pem'));
      if (hasLegacy || hasNew) {
        return `${entry.name}.jump.sh`;
      }
    }
  } catch {}
  return null;
}

/**
 * Detect domain: env var > cert detection > fallback
 */
export function detectDomain() {
  return process.env.JUMPSH_DOMAIN || detectDomainFromCerts() || 'jump.sh';
}
