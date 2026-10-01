import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  managementAuth,
  managementAccessLines,
  managementTokenPath,
} from '../lib/management-auth.js';

const token = 'test-management-token-that-is-long-enough-123';
const origin = 'https://dash.jump.sh';
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

function makeRes() {
  const headers = {};
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  return {
    statusCode: 200,
    body: null,
    headers,
    done,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    send(value) { this.body = value; resolveDone(); return this; },
    redirect(status, location) { this.statusCode = status; headers.location = location; resolveDone(); return this; },
  };
}

async function run(auth, opts) {
  const req = makeReq(opts);
  const res = makeRes();
  let passed = false;
  await Promise.race([
    Promise.resolve(auth(req, res, () => { passed = true; })),
    res.done,
  ]);
  // Allow async body handlers to finish.
  if (!passed && res.body === null && !res.headers.location) await res.done;
  return { passed, req, res };
}

function setCookies(res) {
  const value = res.headers['set-cookie'];
  return Array.isArray(value) ? value : value ? [value] : [];
}

function cookiePair(res) {
  const header = setCookies(res).find(c => c.startsWith(`${TLS_COOKIE}=`));
  assert.ok(header, 'session cookie must be set');
  return header.split(';')[0];
}

async function login(auth, { remember = false, now } = {}) {
  const body = new URLSearchParams({ token, next: '/projects/1', ...(remember ? { remember: 'on' } : {}) }).toString();
  const result = await run(auth, {
    method: 'POST', url: '/login', body,
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    now,
  });
  return result;
}

describe('browser token login', () => {
  it('redirects unauthenticated HTML navigation to the login page without a Basic challenge', async () => {
    const auth = managementAuth({ token, dashboardOrigin: origin });
    const { passed, res } = await run(auth, { url: '/projects/1?tab=logs', headers: { accept: 'text/html,application/xhtml+xml' } });
    assert.equal(passed, false);
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, `/login?next=${encodeURIComponent('/projects/1?tab=logs')}`);
    assert.equal(res.headers['www-authenticate'], undefined);
  });

  it('returns 401 without WWW-Authenticate for unauthenticated API, static, and EventSource requests', async () => {
    const auth = managementAuth({ token, dashboardOrigin: origin });
    for (const [url, accept] of [
      ['/api/projects', 'application/json'],
      ['/api/projects', '*/*'],
      ['/styles.css', 'text/css'],
      ['/projects/1/logs/stream', 'text/event-stream'],
    ]) {
      const { passed, res } = await run(auth, { url, headers: { accept } });
      assert.equal(passed, false, url);
      assert.equal(res.statusCode, 401, url);
      assert.equal(res.headers['www-authenticate'], undefined, url);
    }
  });

  it('no longer accepts Basic credentials', async () => {
    const auth = managementAuth({ token, dashboardOrigin: origin });
    const basic = `Basic ${Buffer.from(`jump:${token}`).toString('base64')}`;
    const { passed, res } = await run(auth, { url: '/api/projects', headers: { authorization: basic } });
    assert.equal(passed, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['www-authenticate'], undefined);
  });

  it('renders a styled Token / Remember this device / Connect page', async () => {
    const auth = managementAuth({ token, dashboardOrigin: origin });
    const { passed, res } = await run(auth, { url: '/login?next=%2Fadd', headers: { accept: 'text/html' } });
    assert.equal(passed, false);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/u);
    assert.match(res.headers['cache-control'], /no-store/u);
    assert.match(res.body, /<style>/u);
    assert.match(res.body, /<form[^>]*method="post"[^>]*action="\/login"/u);
    assert.match(res.body, /<label[^>]*for="token"[^>]*>Token<\/label>/u);
    assert.match(res.body, /type="password"[^>]*name="token"|name="token"[^>]*type="password"/u);
    assert.match(res.body, /type="checkbox"[^>]*name="remember"|name="remember"[^>]*type="checkbox"/u);
    assert.match(res.body, /Remember this device/u);
    assert.match(res.body, />Connect</u);
    assert.match(res.body, /name="next" value="\/add"/u);
    assert.equal(res.body.includes(token), false);
  });

  it('shows clear feedback for an invalid token and sets no cookie', async () => {
    const auth = managementAuth({ token, dashboardOrigin: origin });
    const { res } = await run(auth, {
      method: 'POST', url: '/login', body: 'token=wrong&next=%2F',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.statusCode, 401);
    assert.match(res.body, /role="alert"/u);
    assert.match(res.body, /token is not valid/iu);
    assert.equal(res.headers['www-authenticate'], undefined);
    assert.deepEqual(setCookies(res), []);
  });

  it('issues a Secure HttpOnly host-only SameSite session cookie when remember is off', async () => {
    const auth = managementAuth({ token, dashboardOrigin: origin });
    const { res } = await login(auth);
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/projects/1');
    const [cookie] = setCookies(res);
    assert.match(cookie, new RegExp(`^${TLS_COOKIE}=`, 'u'));
    assert.match(cookie, /; Path=\//u);
    assert.match(cookie, /; Secure/u);
    assert.match(cookie, /; HttpOnly/u);
    assert.match(cookie, /; SameSite=Lax/u);
    assert.doesNotMatch(cookie, /Domain=/iu);
    assert.doesNotMatch(cookie, /Max-Age|Expires/iu);
    assert.equal(cookie.includes(token), false);
  });

  it('issues a bounded persistent cookie when remember is on', async () => {
    const auth = managementAuth({ token, dashboardOrigin: origin });
    const { res } = await login(auth, { remember: true });
    const [cookie] = setCookies(res);
    const maxAge = Number(cookie.match(/; Max-Age=(\d+)/u)?.[1]);
    assert.ok(maxAge > 0 && maxAge <= 30 * 24 * 60 * 60, `bounded Max-Age, got ${maxAge}`);
    assert.match(cookie, /; Secure; HttpOnly; SameSite=Lax/u);
  });

  it('authenticates navigation, API, and EventSource requests with the cookie', async () => {
    const auth = managementAuth({ token, dashboardOrigin: origin });
    const cookie = cookiePair((await login(auth)).res);
    for (const [url, accept] of [['/', 'text/html'], ['/api/projects', 'application/json'], ['/projects/1/logs/stream', 'text/event-stream']]) {
      const { passed, req } = await run(auth, { url, headers: { accept, cookie: `other=1; ${cookie}` } });
      assert.equal(passed, true, url);
      assert.equal(req.managementAuth, 'cookie');
    }
  });

  it('redirects an already-authenticated login page visit to next', async () => {
    const auth = managementAuth({ token, dashboardOrigin: origin });
    const cookie = cookiePair((await login(auth)).res);
    const { res } = await run(auth, { url: '/login?next=%2Fadd', headers: { cookie, accept: 'text/html' } });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/add');
  });

  it('rejects tampered, foreign, and wrong-transport cookies', async () => {
    const auth = managementAuth({ token, dashboardOrigin: origin });
    const cookie = cookiePair((await login(auth)).res);
    const value = cookie.slice(TLS_COOKIE.length + 1);
    const tampered = value.slice(0, -2) + (value.endsWith('AA') ? 'BB' : 'AA');
    for (const header of [
      `${TLS_COOKIE}=${tampered}`,
      `jumpsh_session=${value}`,
      `${TLS_COOKIE}=garbage`,
    ]) {
      const { passed, res } = await run(auth, { url: '/api/projects', headers: { cookie: header } });
      assert.equal(passed, false, header);
      assert.equal(res.statusCode, 401, header);
    }
  });

  it('expires cookies server-side even if the browser keeps them', async () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const auth = managementAuth({ token, dashboardOrigin: origin, now: () => now });
    const sessionCookie = cookiePair((await login(auth)).res);
    const rememberCookie = cookiePair((await login(auth, { remember: true })).res);
    now += 25 * 60 * 60 * 1000;
    assert.equal((await run(auth, { url: '/api/projects', headers: { cookie: sessionCookie } })).passed, false);
    assert.equal((await run(auth, { url: '/api/projects', headers: { cookie: rememberCookie } })).passed, true);
    now += 30 * 24 * 60 * 60 * 1000;
    assert.equal((await run(auth, { url: '/api/projects', headers: { cookie: rememberCookie } })).passed, false);
  });

  it('invalidates browser authentication when the token rotates', async () => {
    const cookie = cookiePair((await login(managementAuth({ token, dashboardOrigin: origin }))).res);
    const rotated = managementAuth({ token: 'rotated-management-token-that-is-long-enough', dashboardOrigin: origin });
    const { passed, res } = await run(rotated, { url: '/api/projects', headers: { cookie } });
    assert.equal(passed, false);
    assert.equal(res.statusCode, 401);
  });

  it('requires the exact configured Origin or Referer for login', async () => {
    const auth = managementAuth({ token, dashboardOrigin: origin });
    const body = `token=${token}`;
    for (const headers of [
      {},
      { origin: 'https://evil.test' },
      { origin: 'https://dash.jump.sh.evil.test' },
      { origin: 'https://app.jump.sh' },
      { referer: 'https://dash.jump.sh.evil.test/login' },
      { origin: 'null', referer: `${origin}/login` },
    ]) {
      const { res } = await run(auth, { method: 'POST', url: '/login', body, headers });
      assert.equal(res.statusCode, 403, JSON.stringify(headers));
      assert.deepEqual(setCookies(res), []);
    }
    const { res } = await run(auth, { method: 'POST', url: '/login', body, headers: { referer: `${origin}/login` } });
    assert.equal(res.statusCode, 303);
  });

  it('requires the exact configured Origin or Referer for cookie-auth mutations and exempts bearer', async () => {
    const auth = managementAuth({ token, dashboardOrigin: origin });
    const cookie = cookiePair((await login(auth)).res);
    for (const headers of [
      { cookie },
      { cookie, origin: 'https://dash.jump.sh.evil.test' },
      { cookie, origin: 'https://app.jump.sh' },
      { cookie, referer: 'https://dash.jump.sh.evil.test/projects/1' },
      { cookie, origin: 'https://evil.test', referer: `${origin}/projects/1` },
    ]) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const { passed, res } = await run(auth, { method, url: '/projects/1/start', headers });
        assert.equal(passed, false);
        assert.equal(res.statusCode, 403);
      }
    }
    assert.equal((await run(auth, { method: 'POST', url: '/projects/1/start', headers: { cookie, origin } })).passed, true);
    assert.equal((await run(auth, { method: 'DELETE', url: '/projects/1', headers: { cookie, referer: `${origin}/` } })).passed, true);
    assert.equal((await run(auth, { method: 'POST', url: '/projects/1/start', headers: { authorization: `Bearer ${token}` } })).passed, true);
  });

  it('logs out by clearing the cookie and revoking the session, with an origin check', async () => {
    const auth = managementAuth({ token, dashboardOrigin: origin });
    const cookie = cookiePair((await login(auth, { remember: true })).res);

    const crossSite = await run(auth, { method: 'POST', url: '/logout', headers: { cookie, origin: 'https://evil.test' } });
    assert.equal(crossSite.res.statusCode, 403);
    assert.equal((await run(auth, { url: '/api/projects', headers: { cookie } })).passed, true);

    const { res } = await run(auth, { method: 'POST', url: '/logout', headers: { cookie, origin } });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/login');
    const [cleared] = setCookies(res);
    assert.match(cleared, new RegExp(`^${TLS_COOKIE}=;`, 'u'));
    assert.match(cleared, /Max-Age=0/u);
    assert.match(cleared, /; Secure; HttpOnly; SameSite=Lax/u);
    assert.equal((await run(auth, { url: '/api/projects', headers: { cookie } })).passed, false);
  });

  it('only redirects to safe same-origin relative paths after login', async () => {
    const auth = managementAuth({ token, dashboardOrigin: origin });
    for (const next of ['https://evil.test/', '//evil.test/', '/\\evil.test', 'javascript:alert(1)', '/login', '']) {
      const body = new URLSearchParams({ token, next }).toString();
      const { res } = await run(auth, { method: 'POST', url: '/login', body, headers: { origin } });
      assert.equal(res.headers.location, '/', next);
    }
  });

  it('escapes the next value in the login page', async () => {
    const auth = managementAuth({ token, dashboardOrigin: origin });
    const { res } = await run(auth, { url: `/login?next=${encodeURIComponent('/"><script>x</script>')}` });
    assert.equal(res.body.includes('<script>x'), false);
  });

  it('uses a non-Secure host-only cookie only for direct loopback HTTP', async () => {
    const local = 'http://dash.jump.sh';
    const auth = managementAuth({ token, dashboardOrigin: local });
    const { res } = await run(auth, {
      method: 'POST', url: '/login', body: `token=${token}`,
      headers: { origin: local }, encrypted: false, remoteAddress: '127.0.0.1',
    });
    assert.equal(res.statusCode, 303);
    const [cookie] = setCookies(res);
    assert.match(cookie, /^jumpsh_session=/u);
    assert.doesNotMatch(cookie, /Secure|Domain=/u);
    assert.match(cookie, /; HttpOnly; SameSite=Lax/u);
    const pair = cookie.split(';')[0];
    assert.equal((await run(auth, { url: '/', headers: { cookie: pair }, encrypted: false, remoteAddress: '127.0.0.1' })).passed, true);
    // A loopback-HTTP cookie must not authenticate TLS requests.
    assert.equal((await run(auth, { url: '/', headers: { cookie: pair } })).passed, false);
  });

  it('rejects remote plaintext login before reading credentials', async () => {
    const auth = managementAuth({ token, dashboardOrigin: 'http://dash.jump.sh' });
    for (const url of ['/login', '/logout']) {
      const { res } = await run(auth, {
        method: url === '/login' ? 'GET' : 'POST', url,
        headers: { origin: 'http://dash.jump.sh' }, encrypted: false,
      });
      assert.equal(res.statusCode, 403);
    }
    const { res } = await run(auth, {
      method: 'POST', url: '/login', body: `token=${token}`,
      headers: { origin: 'http://dash.jump.sh' }, encrypted: false,
    });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(setCookies(res), []);
  });

  it('rejects oversized login bodies', async () => {
    const auth = managementAuth({ token, dashboardOrigin: origin });
    const { res } = await run(auth, { method: 'POST', url: '/login', body: `token=${'a'.repeat(20000)}`, headers: { origin } });
    assert.equal(res.statusCode, 413);
  });
});

describe('CLI access instructions', () => {
  it('describes token login without printing the token or a username', () => {
    const home = '/home/example';
    const lines = managementAccessLines(home);
    assert.ok(lines.some(line => line.includes(managementTokenPath(home))));
    assert.ok(lines.some(line => /token/iu.test(line)));
    assert.equal(lines.some(line => /username|password/iu.test(line)), false);
  });
});

describe('dashboard logout control', () => {
  it('posts to /logout from the shared header', async () => {
    const ejs = (await import('ejs')).default;
    const html = await ejs.renderFile(new URL('../views/partials/_header.ejs', import.meta.url).pathname, {});
    assert.match(html, /<form[^>]*method="post"[^>]*action="\/logout"/u);
    assert.match(html, /<button type="submit">log out<\/button>/u);
  });
});
