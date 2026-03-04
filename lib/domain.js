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
 * Detect the configured server port from systemd/launchd config.
 * macOS: always 443 (plist sets JUMPSH_PORT=443)
 * Linux: reads systemd unit, defaults to 4443
 */
export function detectPort() {
  if (os.platform() === 'darwin') return 443;
  const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'jumpsh.service');
  try {
    const unit = fs.readFileSync(unitPath, 'utf8');
    const match = unit.match(/Environment=JUMPSH_PORT=(\d+)/);
    if (match) return parseInt(match[1], 10);
  } catch {}
  return 4443;
}

/**
 * Format a dashboard URL with port suffix (omit port for 443).
 */
export function formatDashUrl(domain, port) {
  const portSuffix = port === 443 ? '' : `:${port}`;
  return `https://dash.${domain}${portSuffix}`;
}
