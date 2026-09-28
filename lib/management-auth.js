import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';

export const MANAGEMENT_USER = 'jump';
export const MANAGEMENT_TOKEN_FILE = 'management-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function managementTokenPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.jump.sh', MANAGEMENT_TOKEN_FILE);
}

export function managementAccessLines(homeDir = os.homedir()) {
  return [
    `Dashboard username: ${MANAGEMENT_USER}`,
    `Dashboard password: read ${managementTokenPath(homeDir)}`,
  ];
}

function chmodIfSupported(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch (err) {
    if (!['ENOSYS', 'ENOTSUP'].includes(err.code)) throw err;
  }
}

function constantTimeEqual(actual, expected) {
  const actualHash = crypto.createHash('sha256').update(String(actual)).digest();
  const expectedHash = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function validateToken(token, tokenPath) {
  if (!token || token.length < 32) {
    throw new Error(`Invalid management token in ${tokenPath}`);
  }
  return token;
}

export function ensureManagementToken({ homeDir = os.homedir() } = {}) {
  const stateDir = path.join(homeDir, '.jump.sh');
  const tokenPath = managementTokenPath(homeDir);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodIfSupported(stateDir, 0o700);

  if (fs.existsSync(tokenPath)) {
    chmodIfSupported(tokenPath, 0o600);
    return validateToken(fs.readFileSync(tokenPath, 'utf8').trim(), tokenPath);
  }

  const token = crypto.randomBytes(32).toString('base64url');
  try {
    const fd = fs.openSync(tokenPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${token}\n`, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    chmodIfSupported(tokenPath, 0o600);
    return validateToken(fs.readFileSync(tokenPath, 'utf8').trim(), tokenPath);
  }
  return token;
}

export function readManagementToken({ homeDir = os.homedir() } = {}) {
  const tokenPath = managementTokenPath(homeDir);
  return validateToken(fs.readFileSync(tokenPath, 'utf8').trim(), tokenPath);
}

function verifyAuthorization(header, token) {
  if (typeof header !== 'string') return null;
  const bearer = header.match(/^Bearer ([A-Za-z0-9_-]+)$/u);
  if (bearer) return constantTimeEqual(bearer[1], token) ? 'bearer' : null;

  const basic = header.match(/^Basic ([A-Za-z0-9+/=]+)$/u);
  if (!basic) return null;
  let decoded;
  try {
    decoded = Buffer.from(basic[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return constantTimeEqual(username, MANAGEMENT_USER) && constantTimeEqual(password, token)
    ? 'basic'
    : null;
}

function refererOrigin(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isLoopback(address) {
  if (typeof address !== 'string') return false;
  if (address === '::1') return true;
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return isIP(ipv4) === 4 && ipv4.startsWith('127.');
}

export function managementAuth({ token, dashboardOrigin }) {
  if (!token || !dashboardOrigin) throw new Error('managementAuth requires token and dashboardOrigin');

  return function requireManagementAuth(req, res, next) {
    // Use the actual socket, never Host or forwarded headers. Do not challenge
    // remote HTTP clients to send reusable credentials after TLS fallback.
    if (!req.socket?.encrypted && !isLoopback(req.socket?.remoteAddress)) {
      return res.status(403).send('Remote management requires HTTPS');
    }

    const authType = verifyAuthorization(req.get?.('authorization') || req.headers?.authorization, token);
    if (!authType) {
      res.setHeader('WWW-Authenticate', 'Basic realm="jump.sh management", charset="UTF-8"');
      return res.status(401).send('Management authentication required');
    }

    if (authType === 'basic' && !SAFE_METHODS.has(req.method)) {
      const origin = req.get?.('origin') || req.headers?.origin;
      const referer = req.get?.('referer') || req.headers?.referer;
      const trustedOrigin = origin || refererOrigin(referer);
      // Startup may have selected a different port/protocol after registration.
      const configuredOrigin = typeof dashboardOrigin === 'function' ? dashboardOrigin() : dashboardOrigin;
      if (!configuredOrigin || trustedOrigin !== configuredOrigin) {
        return res.status(403).send('Cross-origin management mutation denied');
      }
    }

    req.managementAuth = authType;
    next();
  };
}
