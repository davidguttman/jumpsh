import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { managementAuth } from '../lib/management-auth.js';
import { callDaemon } from '../lib/commands/_helpers.js';

const token = 'test-management-token-that-is-long-enough-123';

// Mint real browser session cookies through the login flow (stateless, token-keyed).
async function mintCookie(encrypted) {
  const loginOrigin = 'https://mint.example.test';
  const auth = managementAuth({ token, dashboardOrigin: loginOrigin });
  const req = Object.assign(Readable.from([Buffer.from(`token=${token}`)]), {
    method: 'POST', url: '/login', headers: { origin: loginOrigin },
    socket: { encrypted, remoteAddress: '127.0.0.1' },
  });
  const res = await new Promise((resolve) => {
    const response = {
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      status() { return this; },
      send() { resolve(this); return this; },
      redirect() { resolve(this); return this; },
    };
    auth(req, response, () => {});
  });
  return res.headers['set-cookie'].split(';')[0];
}
const tlsCookie = await mintCookie(true);
const loopbackCookie = await mintCookie(false);

function request(auth, { origin, referer, cookie, authorization, encrypted = true, remoteAddress = '192.0.2.1', headers = {} } = {}) {
  if (cookie === undefined) cookie = encrypted ? tlsCookie : loopbackCookie;
  let passed = false;
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
  };
  auth({
    method: 'POST',
    headers: { authorization, cookie, origin, referer, ...headers },
    socket: { encrypted, remoteAddress },
  }, response, () => { passed = true; });
  return { passed, ...response };
}

// Exercise the actual server wiring, without importing startup or opening listeners.
function serverAuth(config) {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const formatter = source.slice(source.indexOf('function formatUrl('), source.indexOf('config.formatUrl = formatUrl;'));
  const wiring = source.match(/app\.use\(managementAuth\([\s\S]*?\)\);/u)?.[0];
  assert.ok(wiring, 'server must install management auth');
  let auth;
  vm.runInNewContext(`${formatter}\n${wiring}`, {
    config, managementToken: token, managementAuth,
    app: { use(middleware) { auth = middleware; } },
  });
  return auth;
}

describe('management startup fallback (no listeners)', () => {
  it('resolves the final fallback port at request time, not middleware construction', () => {
    const config = { https: true, port: 443, dashboardHost: 'control.example.test' };
    const auth = serverAuth(config);
    for (const port of [4443, 4444]) {
      config.port = port;
      const origin = `https://control.example.test:${port}`;
      assert.equal(request(auth, { origin }).passed, true);
      assert.equal(request(auth, { referer: `${origin}/projects` }).passed, true);
      assert.equal(request(auth, { origin: 'https://control.example.test' }).statusCode, 403);
      assert.equal(request(auth, { origin: 'https://evil.test', headers: { host: 'evil.test', 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https' } }).statusCode, 403);
    }
  });

  it('resolves fallback protocol for local HTTP, rejecting stale HTTPS origins', () => {
    const config = { https: true, port: 443, dashboardHost: 'control.example.test' };
    const auth = serverAuth(config);
    config.https = false;
    for (const port of [443, 4443, 80]) {
      config.port = port;
      const origin = `http://control.example.test${port === 80 ? '' : `:${port}`}`;
      const local = { encrypted: false, remoteAddress: '127.0.0.1' };
      assert.equal(request(auth, { ...local, origin }).passed, true);
      assert.equal(request(auth, { ...local, referer: `${origin}/projects` }).passed, true);
      assert.equal(request(auth, { ...local, origin: 'https://control.example.test' }).statusCode, 403);
    }
  });

  it('rejects remote plaintext before challenge or credential validation, ignoring forwarded headers', () => {
    const auth = managementAuth({ token, dashboardOrigin: 'http://control.example.test:4443' });
    for (const authorization of ['', `Bearer ${token}`]) {
      for (const remoteAddress of ['192.0.2.1', '::ffff:192.0.2.1', undefined]) {
        const result = request(auth, {
          authorization, encrypted: false, remoteAddress: remoteAddress || '',
          origin: 'http://control.example.test:4443',
          headers: { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https' },
        });
        assert.equal(result.passed, false);
        assert.equal(result.statusCode, 403);
        assert.equal(result.headers['www-authenticate'], undefined);
      }
    }
  });

  it('retains authenticated loopback HTTP and remote TLS access', () => {
    const auth = managementAuth({ token, dashboardOrigin: 'http://control.example.test' });
    for (const remoteAddress of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
      assert.equal(request(auth, { encrypted: false, remoteAddress, origin: 'http://control.example.test' }).passed, true);
      assert.equal(request(auth, { encrypted: false, remoteAddress, cookie: '' }).statusCode, 401);
    }
    assert.equal(request(auth, { authorization: `Bearer ${token}` }).passed, true);
  });
});

describe('CLI fallback transport (mock fetch only)', () => {
  it('never sends credentials to HTTP discovery endpoints and disallows redirects', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-fallback-'));
    const saved = Object.fromEntries(['HOME', 'JUMPSH_DOMAIN', 'JUMPSH_DASHBOARD_HOST'].map(key => [key, process.env[key]]));
    const oldFetch = globalThis.fetch;
    const stateDir = path.join(home, '.jump.sh');
    fs.mkdirSync(stateDir);
    process.env.HOME = home;
    process.env.JUMPSH_DOMAIN = 'example.test';
    process.env.JUMPSH_DASHBOARD_HOST = 'control.example.test';
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(url, 'https://control.example.test:4443/api/projects');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, `Bearer ${token}`);
      return { ok: true, text: async () => '{}' };
    };
    try {
      fs.writeFileSync(path.join(stateDir, 'server.json'), JSON.stringify({ protocol: 'http', port: 4443 }));
      // No token file: transport rejection must happen before reading credentials.
      await assert.rejects(callDaemon('/api/projects'), { code: 'INSECURE_MANAGEMENT_TRANSPORT' });
      assert.equal(calls, 0);
      fs.writeFileSync(path.join(stateDir, 'management-token'), token);
      await assert.rejects(callDaemon('/api/projects'), { code: 'INSECURE_MANAGEMENT_TRANSPORT' });
      assert.equal(calls, 0);
      fs.writeFileSync(path.join(stateDir, 'server.json'), JSON.stringify({ protocol: 'https', port: 4443 }));
      await callDaemon('/api/projects');
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = oldFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
