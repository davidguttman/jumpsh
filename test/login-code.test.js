import { describe, it, beforeEach, afterEach } from 'node:test';
import { tmpRevocations } from './helpers/revocations.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers';
import { Readable } from 'node:stream';
import { managementAuth } from '../lib/management-auth.js';
import { launchBrowser } from '../lib/browser.js';
import open, { requestLoginCode } from '../lib/commands/open.js';

const token = 'test-management-token-that-is-long-enough-123';
const origin = 'https://dash.jump.sh';
const bearer = `Bearer ${token}`;
const TLS_COOKIE = '__Host-jumpsh_session';

function makeReq({ method = 'GET', url = '/', headers = {}, body, encrypted = true, remoteAddress = '192.0.2.1' } = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  Object.assign(req, {
    method, url, headers: normalized,
    socket: { encrypted, remoteAddress },
    get(name) { return normalized[name.toLowerCase()]; },
  });
  return req;
}

async function run(auth, opts) {
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const headers = {};
  const res = {
    statusCode: 200, body: null, headers,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    send(value) { this.body = value; resolveDone(); return this; },
    json(value) { this.body = value; headers['content-type'] = 'application/json'; resolveDone(); return this; },
    redirect(status, location) { this.statusCode = status; headers.location = location; resolveDone(); return this; },
  };
  const req = makeReq(opts);
  let passed = false;
  auth(req, res, () => { passed = true; resolveDone(); });
  await done;
  return { passed, req, res };
}

async function issue(auth) {
  const { res } = await run(auth, { method: 'POST', url: '/api/login-codes', headers: { authorization: bearer, accept: 'application/json' } });
  return res;
}

function exchange(auth, code, headers = { origin }, next = '/add?dir=%2Fsrc') {
  const body = new URLSearchParams({ code, next }).toString();
  return run(auth, {
    method: 'POST', url: '/login', body,
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...headers },
  });
}

describe('single-use login codes', () => {
  it('issues a short-lived opaque code only to bearer-authenticated callers', async () => {
    const auth = managementAuth({ revocationDir: tmpRevocations(), token, dashboardOrigin: origin });
    const res = await issue(auth);
    assert.equal(res.statusCode, 200);
    assert.match(res.body.code, /^[A-Za-z0-9_-]{43}$/u);
    assert.ok(res.body.expiresIn > 0 && res.body.expiresIn <= 60);
    assert.match(res.headers['cache-control'], /no-store/u);
    assert.equal(JSON.stringify(res.body).includes(token), false);

    const cookie = (await exchange(auth, res.body.code)).res.headers['set-cookie'].split(';')[0];
    for (const headers of [{}, { cookie, origin }]) {
      const denied = await run(auth, { method: 'POST', url: '/api/login-codes', headers });
      assert.equal(denied.passed, false);
      assert.ok([401, 403].includes(denied.res.statusCode), JSON.stringify(headers));
      assert.equal(denied.res.body?.code, undefined);
    }
  });

  it('exchanges a code once for the same session cookie, then rejects replay', async () => {
    const auth = managementAuth({ revocationDir: tmpRevocations(), token, dashboardOrigin: origin });
    const { code } = (await issue(auth)).body;

    const first = await exchange(auth, code);
    assert.equal(first.res.statusCode, 200);
    assert.deepEqual(first.res.body, { ok: true, next: '/add?dir=%2Fsrc' });
    const cookie = first.res.headers['set-cookie'];
    assert.match(cookie, new RegExp(`^${TLS_COOKIE}=`, 'u'));
    assert.match(cookie, /; Path=\/; Secure; HttpOnly; SameSite=Lax$/u);
    assert.equal((await run(auth, { url: '/api/projects', headers: { cookie: cookie.split(';')[0] } })).passed, true);

    const replay = await exchange(auth, code);
    assert.equal(replay.res.statusCode, 401);
    assert.equal(replay.res.body.ok, false);
    assert.equal(replay.res.headers['set-cookie'], undefined);
  });

  it('consumes atomically under concurrent exchanges', async () => {
    const auth = managementAuth({ revocationDir: tmpRevocations(), token, dashboardOrigin: origin });
    const { code } = (await issue(auth)).body;
    const results = await Promise.all([exchange(auth, code), exchange(auth, code), exchange(auth, code)]);
    assert.deepEqual(results.map(r => r.res.statusCode).sort(), [200, 401, 401]);
  });

  it('rejects expired codes', async () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const auth = managementAuth({ revocationDir: tmpRevocations(), token, dashboardOrigin: origin, now: () => now });
    const { code, expiresIn } = (await issue(auth)).body;
    now += expiresIn * 1000;
    assert.equal((await exchange(auth, code)).res.statusCode, 401);
  });

  it('rejects unknown codes and codes from another installation', async () => {
    const other = managementAuth({ revocationDir: tmpRevocations(), token: 'another-management-token-that-is-long-enough', dashboardOrigin: origin });
    const { code } = (await issue(other)).body;
    const auth = managementAuth({ revocationDir: tmpRevocations(), token, dashboardOrigin: origin });
    for (const candidate of [code, 'A'.repeat(43), 'short', '']) {
      assert.equal((await exchange(auth, candidate)).res.statusCode, 401, candidate);
    }
  });

  it('requires the exact configured origin for exchange without consuming the code', async () => {
    const auth = managementAuth({ revocationDir: tmpRevocations(), token, dashboardOrigin: origin });
    const { code } = (await issue(auth)).body;
    for (const headers of [{}, { origin: 'https://evil.test' }, { origin: 'https://app.jump.sh' }, { referer: 'https://dash.jump.sh.evil.test/login' }]) {
      const { res } = await exchange(auth, code, headers);
      assert.equal(res.statusCode, 403, JSON.stringify(headers));
      assert.equal(res.headers['set-cookie'], undefined);
    }
    assert.equal((await exchange(auth, code)).res.statusCode, 200);
  });

  it('bounds outstanding codes and frees slots on expiry', async () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const auth = managementAuth({ revocationDir: tmpRevocations(), token, dashboardOrigin: origin, now: () => now });
    let issued = 0;
    let res;
    while ((res = await issue(auth)).statusCode === 200) {
      issued++;
      assert.ok(issued <= 64, 'outstanding codes must be bounded');
    }
    assert.equal(res.statusCode, 429);
    assert.ok(issued >= 4, `allows several concurrent codes, got ${issued}`);
    now += 61 * 1000;
    assert.equal((await issue(auth)).statusCode, 200);
  });

  it('rejects remote plaintext issuance and exchange', async () => {
    const auth = managementAuth({ revocationDir: tmpRevocations(), token, dashboardOrigin: 'http://dash.jump.sh' });
    const issueRes = await run(auth, { method: 'POST', url: '/api/login-codes', headers: { authorization: bearer }, encrypted: false });
    assert.equal(issueRes.res.statusCode, 403);
    const exchangeRes = await run(auth, { method: 'POST', url: '/login', body: 'code=x', headers: { origin: 'http://dash.jump.sh' }, encrypted: false });
    assert.equal(exchangeRes.res.statusCode, 403);
  });

  it('drops any login-code fragment when redirecting an already signed-in browser', async () => {
    const auth = managementAuth({ revocationDir: tmpRevocations(), token, dashboardOrigin: origin });
    const { code } = (await issue(auth)).body;
    const cookie = (await exchange(auth, code)).res.headers['set-cookie'].split(';')[0];
    const { res } = await run(auth, { url: '/login?next=%2Fadd', headers: { cookie } });
    assert.equal(res.statusCode, 303);
    // An explicit empty fragment stops browsers carrying #code=... to the target.
    assert.equal(res.headers.location, '/add#');
  });

  it('login page strips the fragment before exchanging it via same-origin POST', async () => {
    const auth = managementAuth({ revocationDir: tmpRevocations(), token, dashboardOrigin: origin });
    const { res } = await run(auth, { url: '/login' });
    const script = res.body.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
    assert.ok(script, 'login page has an inline exchange script');
    const strip = script.indexOf('history.replaceState');
    const post = script.indexOf("fetch('/login'");
    assert.ok(strip >= 0 && post > strip, 'fragment removed before exchange');
    assert.match(script, /method: 'POST'/u);
    assert.match(script, /credentials: 'same-origin'/u);
    assert.doesNotMatch(script, /localStorage|sessionStorage/u);
    // Manual token entry stays available as the fallback.
    assert.match(res.body, /name="token"/u);
  });
});

describe('browser launching', () => {
  it('passes the URL as a single argument without a shell', async () => {
    const calls = [];
    const fakeSpawn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const child = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => child.emit('exit', 0));
      return child;
    };
    const url = 'https://dash.jump.sh/login?next=%2F#code=abc";rm -rf ~;"';
    assert.equal(await launchBrowser(url, { platform: 'linux', spawn: fakeSpawn }), true);
    assert.equal(await launchBrowser(url, { platform: 'darwin', spawn: fakeSpawn }), true);
    assert.deepEqual(calls.map(c => [c.cmd, c.args]), [['xdg-open', [url]], ['open', [url]]]);
    for (const call of calls) assert.notEqual(call.opts?.shell, true);
  });

  it('reports failure when the launcher is missing or exits non-zero', async () => {
    const failing = (event, value) => () => {
      const child = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => child.emit(event, value));
      return child;
    };
    assert.equal(await launchBrowser('https://x.test', { platform: 'linux', spawn: failing('error', new Error('ENOENT')) }), false);
    assert.equal(await launchBrowser('https://x.test', { platform: 'linux', spawn: failing('exit', 3) }), false);
  });
});

describe('jump.sh open with a login code', () => {
  let home;
  let saved;
  let logs;
  let errors;
  let oldLog;
  let oldError;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-open-'));
    saved = Object.fromEntries(['HOME', 'JUMPSH_DOMAIN', 'JUMPSH_DASHBOARD_HOST'].map(key => [key, process.env[key]]));
    process.env.HOME = home;
    process.env.JUMPSH_DOMAIN = 'example.test';
    process.env.JUMPSH_DASHBOARD_HOST = 'control.example.test';
    const stateDir = path.join(home, '.jump.sh');
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, 'management-token'), `${token}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(stateDir, 'server.json'), JSON.stringify({ protocol: 'https', port: 4443 }));
    logs = [];
    errors = [];
    oldLog = console.log;
    oldError = console.error;
    console.log = (...args) => logs.push(args.join(' '));
    console.error = (...args) => errors.push(args.join(' '));
  });

  afterEach(() => {
    console.log = oldLog;
    console.error = oldError;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  function output() {
    return [...logs, ...errors].join('\n');
  }

  it('requests a code with the bearer credential and never puts the token in a URL', async () => {
    const oldFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, init) => {
      request = { url, init };
      return { ok: true, text: async () => JSON.stringify({ code: 'C'.repeat(43), expiresIn: 60 }) };
    };
    try {
      assert.equal(await requestLoginCode(), 'C'.repeat(43));
    } finally {
      globalThis.fetch = oldFetch;
    }
    assert.equal(request.url, 'https://control.example.test:4443/api/login-codes');
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.headers.Authorization, bearer);
    assert.equal(request.url.includes(token), false);
  });

  it('opens the login page with only the code in the fragment, preserving the add destination', async () => {
    const code = 'C'.repeat(43);
    const launched = [];
    await open(['add'], {
      cwd: '/work/my app',
      issueCode: async () => code,
      launch: async (url) => { launched.push(url); return true; },
    });
    const expectedNext = encodeURIComponent(`/add?dir=${encodeURIComponent('/work/my app')}`);
    assert.deepEqual(launched, [`https://control.example.test:4443/login?next=${expectedNext}#code=${code}`]);
    const url = new URL(launched[0]);
    assert.equal(url.hash, `#code=${code}`);
    assert.equal(url.search.includes(code), false);
    assert.equal(launched[0].includes(token), false);
    assert.equal(output().includes(code), false);
    assert.equal(output().includes(token), false);
    assert.match(output(), /https:\/\/control\.example\.test:4443\/add\?dir=/u);
  });

  it('opens the dashboard root when no destination is given', async () => {
    const launched = [];
    await open([], { issueCode: async () => 'D'.repeat(43), launch: async (url) => { launched.push(url); return true; } });
    assert.equal(launched[0], `https://control.example.test:4443/login?next=%2F#code=${'D'.repeat(43)}`);
  });

  it('falls back to manual token entry when code issuance fails', async () => {
    const launched = [];
    await open([], {
      issueCode: async () => { throw Object.assign(new Error('Could not connect'), { code: 'DAEMON_UNREACHABLE' }); },
      launch: async (url) => { launched.push(url); return true; },
    });
    assert.deepEqual(launched, ['https://control.example.test:4443/']);
    assert.match(output(), /paste the token from .*management-token/u);
    assert.equal(output().includes(token), false);
  });

  it('falls back to manual instructions without leaking the code when the browser cannot open', async () => {
    const code = 'E'.repeat(43);
    await open([], { issueCode: async () => code, launch: async () => false });
    assert.match(output(), /Could not open browser\. Visit: https:\/\/control\.example\.test:4443\/$/mu);
    assert.match(output(), /paste the token from .*management-token/u);
    assert.equal(output().includes(code), false);
  });

  it('does not request a code over plaintext HTTP', async () => {
    fs.writeFileSync(path.join(home, '.jump.sh', 'server.json'), JSON.stringify({ protocol: 'http', port: 80 }));
    const oldFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; throw new Error('unexpected'); };
    const launched = [];
    try {
      await open([], { launch: async (url) => { launched.push(url); return true; } });
    } finally {
      globalThis.fetch = oldFetch;
    }
    assert.equal(fetched, false);
    assert.deepEqual(launched, ['http://control.example.test/']);
    assert.match(output(), /paste the token from/u);
  });
});
