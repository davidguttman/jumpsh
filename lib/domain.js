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

/**
 * Detect the running server port from server.json (written by server.js on startup).
 * Falls back to 4443 if server.json doesn't exist (server not running).
 */
export function detectPort() {
  const serverJsonPath = path.join(os.homedir(), '.jump.sh', 'server.json');
  try {
    const data = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));
    if (data.port) return data.port;
  } catch {}
  return 4443;
}

/**
 * Detect the running server protocol from server.json.
 * Falls back to 'https' if server.json doesn't exist.
 */
export function detectProtocol() {
  const serverJsonPath = path.join(os.homedir(), '.jump.sh', 'server.json');
  try {
    const data = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));
    if (data.protocol) return data.protocol;
  } catch {}
  return 'https';
}

/**
 * Format a dashboard URL with port suffix (omit port for 443/80).
 */
export function formatDashUrl(domain, port, protocol = 'https') {
  const defaultPort = protocol === 'https' ? 443 : 80;
  const portSuffix = port === defaultPort ? '' : `:${port}`;
  return `${protocol}://dash.${domain}${portSuffix}`;
}
