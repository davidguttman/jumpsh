import https from 'https';
import http from 'http';
import { createRequire } from 'module';
import { readAuth, getApiOrigin } from './auth.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json');

/**
 * Make an authenticated API request to the jump.sh control plane.
 *
 * @param {string} method - HTTP method
 * @param {string} apiPath - Path relative to API origin (e.g., '/api/v1/machines')
 * @param {object} [body] - JSON body for POST/PUT/PATCH
 * @returns {Promise<{ status: number, data: any }>}
 * @throws {ApiError} on network or auth failures
 */
export async function apiRequest(method, apiPath, body) {
  const auth = readAuth();
  if (!auth?.token) {
    throw new ApiError('Not logged in. Run `jumpsh login --token <TOKEN>` first.', 401);
  }

  const origin = getApiOrigin();
  const url = `${origin}${apiPath}`;

  return request(method, url, auth.token, body);
}

/**
 * Make an unauthenticated API request.
 */
export async function publicRequest(method, apiPath, body) {
  const origin = getApiOrigin();
  const url = `${origin}${apiPath}`;
  return request(method, url, null, body);
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export { ApiError };

function request(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;

    const headers = {
      'Accept': 'application/json',
      'User-Agent': `jumpsh-cli/${version}`,
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    let bodyStr;
    if (body !== undefined) {
      bodyStr = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const opts = {
      method,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers,
      timeout: 15000,
    };

    const req = client.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = data ? JSON.parse(data) : {};
        } catch {
          parsed = { raw: data };
        }

        if (res.statusCode >= 400) {
          const msg = parsed.error || parsed.message || `HTTP ${res.statusCode}`;
          reject(new ApiError(msg, res.statusCode));
          return;
        }

        resolve({ status: res.statusCode, data: parsed });
      });
    });

    req.on('error', (err) => {
      reject(new ApiError(`API request failed: ${err.message}`, 0));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new ApiError(`API request timed out: ${url}`, 0));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
