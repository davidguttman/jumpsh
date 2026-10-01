import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import { renderLoginPage } from './login-page.js';

export const MANAGEMENT_TOKEN_FILE = 'management-token';
export const MANAGEMENT_REVOCATIONS_DIR = 'revoked-sessions';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Browser sessions are stateless signed cookies keyed by the management token,
// so replacing the token (and restarting the daemon) invalidates every session.
const TLS_SESSION_COOKIE = '__Host-jumpsh_session';
const LOOPBACK_SESSION_COOKIE = 'jumpsh_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LOGIN_BODY = 4096;
const MAX_REVOKED_SESSIONS = 10000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const MARKER_CONTENT_PATTERN = /^(\d{1,15})\n$/u;
const STALE_TEMP_MS = 60 * 60 * 1000;
// `jump.sh open` login codes: disposable, single use, and short lived.
const LOGIN_CODE_TTL_MS = 60 * 1000;
const MAX_LOGIN_CODES = 16;

export function managementTokenPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.jump.sh', MANAGEMENT_TOKEN_FILE);
}

export function managementRevocationsPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.jump.sh', MANAGEMENT_REVOCATIONS_DIR);
}

export function managementAccessLines(homeDir = os.homedir()) {
  return [
    `Dashboard login: paste the token from ${managementTokenPath(homeDir)}`,
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

function verifyBearer(header, token) {
  if (typeof header !== 'string') return false;
  const bearer = header.match(/^Bearer ([A-Za-z0-9_-]+)$/u);
  return Boolean(bearer) && constantTimeEqual(bearer[1], token);
}

function headerValue(req, name) {
  return req.get?.(name) || req.headers?.[name];
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

function requestUrl(req) {
  try {
    return new URL(req.originalUrl || req.url || '/', 'http://management.invalid');
  } catch {
    return new URL('http://management.invalid/');
  }
}

// Only same-origin absolute paths; never protocol-relative or back to /login.
function safeNext(value) {
  if (typeof value !== 'string' || value.length > 2048) return '/';
  if (!/^\/(?![/\\])/u.test(value) || value.includes('\\')) return '/';
  if ([...value].some(char => char.charCodeAt(0) < 0x20 || char === '\u007f')) return '/';
  const { pathname } = new URL(value, 'http://management.invalid');
  return pathname === '/login' || pathname === '/logout' ? '/' : value;
}

function parseCookies(header) {
  const cookies = new Map();
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!cookies.has(name)) cookies.set(name, part.slice(separator + 1).trim());
  }
  return cookies;
}

const STORE_UNAVAILABLE = 'Browser sign-in is unavailable because the session revocation directory could not be read or saved. Fix or remove it, then restart the daemon. The CLI still works.';

function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_LOGIN_BODY) {
        req.removeAllListeners('data');
        req.resume?.();
        const err = new Error('Login request too large');
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

// Logout revocations are one marker file per session id, holding only its
// expiry, so daemons sharing a home never overwrite each other's revocations
// and every request sees revocations made by any instance.

// True if a marker exists (whatever its content). Errors other than a
// missing marker throw so callers fail closed.
function markerExists(dir, id) {
  try {
    fs.statSync(path.join(dir, id));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

function revocationDirUsable(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (err) {
    return err.code === 'ENOENT';
  }
}

// Atomic private write: 0700 directory, 0600 temp file renamed into place.
function writeMarker(dir, id, expires) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Tighten (drop group/other access) but never grant the owner new access.
  const mode = fs.statSync(dir).mode & 0o777;
  if (mode & 0o077) chmodIfSupported(dir, mode & 0o700);
  const temp = path.join(dir, `.${id}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${expires}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, path.join(dir, id));
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

// Remove markers whose session has expired anyway, and abandoned temp files.
// Malformed markers are kept (they fail closed) and still count.
// Returns the number of live markers.
function pruneMarkers(dir, current) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  let live = 0;
  for (const name of entries) {
    const file = path.join(dir, name);
    if (name.startsWith('.') && name.endsWith('.tmp')) {
      try {
        if (fs.statSync(file).mtimeMs <= Date.now() - STALE_TEMP_MS) fs.rmSync(file, { force: true });
      } catch { /* concurrently removed */ }
      continue;
    }
    if (!SESSION_ID_PATTERN.test(name)) continue;
    let content = null;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
    }
    const match = content?.match(MARKER_CONTENT_PATTERN);
    if (match && Number(match[1]) <= current) {
      fs.rmSync(file, { force: true });
      continue;
    }
    live++;
  }
  return live;
}

export function managementAuth({
  token,
  dashboardOrigin,
  revocationDir: revocationPath,
  now = Date.now,
  tokenPath = managementTokenPath(),
  maxRevocations = MAX_REVOKED_SESSIONS,
}) {
  if (!token || !dashboardOrigin) throw new Error('managementAuth requires token and dashboardOrigin');
  if (!revocationPath) throw new Error('managementAuth requires revocationDir');

  const sessionKey = crypto.createHmac('sha256', token).update('jump.sh browser session v1').digest();
  // Set when a revocation could not be persisted: browser sessions then fail
  // closed in this daemon until restart. `unsaved` keeps that revocation.
  let revocationStoreError = null;
  const unsaved = new Set();
  // Outstanding login codes by SHA-256 digest -> expiry.
  const loginCodes = new Map();

  function digest(value) {
    return crypto.createHash('sha256').update(value).digest('base64url');
  }

  function pruneLoginCodes() {
    const current = now();
    for (const [key, expires] of loginCodes) if (expires <= current) loginCodes.delete(key);
  }

  function issueLoginCode() {
    pruneLoginCodes();
    if (loginCodes.size >= MAX_LOGIN_CODES) return null;
    const code = crypto.randomBytes(32).toString('base64url');
    loginCodes.set(digest(code), now() + LOGIN_CODE_TTL_MS);
    return code;
  }

  // Synchronous lookup-and-delete, so concurrent exchanges cannot both succeed.
  function consumeLoginCode(code) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(code)) return false;
    const key = digest(code);
    const expires = loginCodes.get(key);
    if (expires === undefined) return false;
    loginCodes.delete(key);
    return expires > now();
  }

  function sign(payload) {
    return crypto.createHmac('sha256', sessionKey).update(payload).digest('base64url');
  }

  function issueSession(remember) {
    const expires = now() + (remember ? REMEMBER_TTL_MS : SESSION_TTL_MS);
    const payload = `v1.${expires}.${crypto.randomBytes(16).toString('base64url')}`;
    return `${payload}.${sign(payload)}`;
  }

  function verifySession(value) {
    const match = typeof value === 'string' && value.match(/^(v1\.(\d{1,15})\.([A-Za-z0-9_-]{22}))\.([A-Za-z0-9_-]{43})$/u);
    if (!match) return null;
    const [, payload, expires, id, signature] = match;
    if (!constantTimeEqual(signature, sign(payload))) return null;
    if (revocationStoreError || Number(expires) <= now() || unsaved.has(id)) return null;
    try {
      if (markerExists(revocationPath, id)) return null;
    } catch {
      return null;
    }
    return { id, expires: Number(expires) };
  }

  // Returns 'ok', 'full' (never evict live revocations), or 'unsaved'.
  function revoke(session) {
    try {
      const live = pruneMarkers(revocationPath, now());
      if (live >= maxRevocations && !markerExists(revocationPath, session.id)) return 'full';
      writeMarker(revocationPath, session.id, session.expires);
      return 'ok';
    } catch (err) {
      unsaved.add(session.id);
      revocationStoreError = err;
      console.error(`Browser sign-in disabled: cannot save revocation in ${revocationPath}: ${err.message}`);
      return 'unsaved';
    }
  }

  function cookieAttributes(secure) {
    return `Path=/;${secure ? ' Secure;' : ''} HttpOnly; SameSite=Lax`;
  }

  function sessionCookie(cookieName, secure, remember) {
    const maxAge = remember ? `; Max-Age=${REMEMBER_TTL_MS / 1000}` : '';
    return `${cookieName}=${issueSession(remember)}${maxAge}; ${cookieAttributes(secure)}`;
  }

  function trustedRequestOrigin(req) {
    const origin = headerValue(req, 'origin');
    const trusted = origin || refererOrigin(headerValue(req, 'referer'));
    // Startup may have selected a different port/protocol after registration.
    const configured = typeof dashboardOrigin === 'function' ? dashboardOrigin() : dashboardOrigin;
    return Boolean(configured) && trusted === configured;
  }

  function sendPage(res, status, { next, error }) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).send(renderLoginPage({ next, error, tokenPath }));
  }

  async function handleLogin(req, res, cookieName, secure) {
    if (!trustedRequestOrigin(req)) return res.status(403).send('Cross-origin login denied');
    if (revocationStoreError || !revocationDirUsable(revocationPath)) {
      return sendPage(res, 503, { next: '/', error: STORE_UNAVAILABLE });
    }
    let form;
    try {
      form = await readForm(req);
    } catch (err) {
      return res.status(err.status || 400).send(err.status ? err.message : 'Invalid login request');
    }
    const next = safeNext(form.get('next') || '/');
    if (form.has('code')) {
      res.setHeader('Cache-Control', 'no-store');
      if (!consumeLoginCode(form.get('code'))) {
        return res.status(401).json({ ok: false, error: 'This login link has expired or was already used.' });
      }
      res.setHeader('Set-Cookie', sessionCookie(cookieName, secure, false));
      return res.status(200).json({ ok: true, next });
    }
    const submitted = form.get('token') || '';
    if (!constantTimeEqual(submitted.trim(), token)) {
      return sendPage(res, 401, { next, error: 'That token is not valid. Check the token file and try again.' });
    }
    res.setHeader('Set-Cookie', sessionCookie(cookieName, secure, form.get('remember') === 'on'));
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(303, next);
  }

  return function requireManagementAuth(req, res, next) {
    // Use the actual socket, never Host or forwarded headers. Never accept or
    // solicit reusable credentials from remote plaintext clients.
    const secure = Boolean(req.socket?.encrypted);
    if (!secure && !isLoopback(req.socket?.remoteAddress)) {
      return res.status(403).send('Remote management requires HTTPS');
    }

    const url = requestUrl(req);
    const bearer = verifyBearer(headerValue(req, 'authorization'), token);

    if (url.pathname === '/api/login-codes') {
      if (req.method !== 'POST') return res.status(405).send('Method not allowed');
      // Only the CLI's bearer credential may mint codes, never a browser session.
      if (!bearer) return res.status(403).send('Login codes require the management token');
      const code = issueLoginCode();
      res.setHeader('Cache-Control', 'no-store');
      if (!code) return res.status(429).json({ error: 'Too many outstanding login codes', code: 'TOO_MANY_LOGIN_CODES' });
      return res.json({ code, expiresIn: LOGIN_CODE_TTL_MS / 1000 });
    }

    if (bearer) {
      req.managementAuth = 'bearer';
      return next();
    }

    // Cookies set over loopback HTTP are never honored for TLS requests.
    const cookieName = secure ? TLS_SESSION_COOKIE : LOOPBACK_SESSION_COOKIE;
    const session = verifySession(parseCookies(headerValue(req, 'cookie')).get(cookieName));

    if (url.pathname === '/login') {
      if (req.method === 'POST') return handleLogin(req, res, cookieName, secure);
      if (req.method === 'GET' || req.method === 'HEAD') {
        const target = safeNext(url.searchParams.get('next') || '/');
        // An explicit empty fragment stops browsers carrying #code=... along.
        if (session) return res.redirect(303, target.includes('#') ? target : `${target}#`);
        return sendPage(res, 200, { next: target });
      }
      return res.status(405).send('Method not allowed');
    }

    if (url.pathname === '/logout' && req.method === 'POST') {
      if (!trustedRequestOrigin(req)) return res.status(403).send('Cross-origin logout denied');
      const outcome = session ? revoke(session) : 'ok';
      if (outcome === 'full') {
        return sendPage(res, 503, {
          next: '/',
          error: 'Too many signed-out sessions are still recorded to sign out this one. Rotate the management token and restart the daemon to sign out every browser.',
        });
      }
      res.setHeader('Set-Cookie', `${cookieName}=; Max-Age=0; ${cookieAttributes(secure)}`);
      res.setHeader('Cache-Control', 'no-store');
      if (outcome === 'unsaved') {
        return sendPage(res, 500, {
          next: '/',
          error: 'Signed out, but the revocation could not be saved, so browser sign-in is disabled until the daemon restarts. Rotate the management token to be sure this session cannot be reused.',
        });
      }
      return res.redirect(303, '/login');
    }

    if (!session) {
      const accept = headerValue(req, 'accept') || '';
      if ((req.method === 'GET' || req.method === 'HEAD') && accept.includes('text/html')) {
        return res.redirect(303, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
      }
      return res.status(401).send('Management authentication required');
    }

    if (!SAFE_METHODS.has(req.method) && !trustedRequestOrigin(req)) {
      return res.status(403).send('Cross-origin management mutation denied');
    }

    req.managementAuth = 'cookie';
    next();
  };
}
