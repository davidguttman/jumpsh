import fs from 'fs';
import os from 'os';
import path from 'path';

const JUMPSH_DIR = path.join(os.homedir(), '.jump.sh');
const AUTH_PATH = path.join(JUMPSH_DIR, 'auth.json');

/**
 * Read stored auth credentials.
 * @returns {{ token: string, machine_id?: string, machine_name?: string } | null}
 */
export function readAuth() {
  try {
    const data = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
    if (!data.token) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Write auth credentials to disk (0600 perms).
 */
export function writeAuth(data) {
  fs.mkdirSync(JUMPSH_DIR, { recursive: true });
  fs.writeFileSync(AUTH_PATH, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Clear stored auth.
 */
export function clearAuth() {
  try { fs.unlinkSync(AUTH_PATH); } catch { /* ok */ }
}

/**
 * Check if we have a valid auth token.
 */
export function isLoggedIn() {
  const auth = readAuth();
  return auth !== null && typeof auth.token === 'string' && auth.token.length > 0;
}

/**
 * Get the API origin URL.
 * Priority: JUMPSH_API_ORIGIN env > persisted config > default.
 */
export function getApiOrigin() {
  return process.env.JUMPSH_API_ORIGIN || 'https://jump.sh';
}

/**
 * Get the remote domain for this machine.
 */
export function getRemoteDomain() {
  return process.env.JUMPSH_REMOTE_DOMAIN || 'dmg.jump.sh';
}
