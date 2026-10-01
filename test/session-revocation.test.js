import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { tmpRevocations } from './helpers/revocations.js';
import { managementAuth, managementRevocationsPath } from '../lib/management-auth.js';

const token = 'test-management-token-that-is-long-enough-123';
const origin = 'https://dash.jump.sh';
const COOKIE = '__Host-jumpsh_session';

function run(auth, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), {
      method, url, headers,
      socket: { encrypted: true, remoteAddress: '192.0.2.1' },
    });
    const res = {
      statusCode: 200, headers: {}, body: null,
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      status(code) { this.statusCode = code; return this; },
      send(value) { this.body = value; resolve({ passed: false, res: this }); return this; },
      json(value) { this.body = value; resolve({ passed: false, res: this }); return this; },
      redirect(status, location) { this.statusCode = status; this.headers.location = location; resolve({ passed: false, res: this }); return this; },
    };
    auth(req, res, () => resolve({ passed: true, res }));
  });
}

async function login(auth, remember = true) {
  const body = `token=${token}${remember ? '&remember=on' : ''}`;
  const { res } = await run(auth, { method: 'POST', url: '/login', body, headers: { origin } });
  assert.equal(res.statusCode, 303);
  return res.headers['set-cookie'].split(';')[0];
}

const authed = async (auth, cookie) => (await run(auth, { url: '/api/projects', headers: { cookie } })).passed;
const logout = (auth, cookie) => run(auth, { method: 'POST', url: '/logout', headers: { cookie, origin } });

describe('persistent logout revocation', () => {
  it('requires an explicit revocation store and defaults it under ~/.jump.sh', () => {
    assert.throws(() => managementAuth({ token, dashboardOrigin: origin }), /revocationPath/u);
    assert.equal(managementRevocationsPath('/home/x'), path.join('/home/x', '.jump.sh', 'revoked-sessions.json'));
  });

  it('keeps a logged-out Remember cookie revoked after a daemon restart', async () => {
    const revocationPath = tmpRevocations();
    const before = managementAuth({ token, dashboardOrigin: origin, revocationPath });
    const copied = await login(before);
    const otherDevice = await login(before);
    assert.equal((await logout(before, copied)).res.statusCode, 303);

    const restarted = managementAuth({ token, dashboardOrigin: origin, revocationPath });
    assert.equal(await authed(restarted, copied), false);
    // Logout is per device, not global.
    assert.equal(await authed(restarted, otherDevice), true);
  });

  it('stores revocations privately without cookie secrets', async () => {
    const revocationPath = tmpRevocations();
    const auth = managementAuth({ token, dashboardOrigin: origin, revocationPath });
    const cookie = await login(auth);
    await logout(auth, cookie);
    assert.equal(fs.statSync(revocationPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(revocationPath)).mode & 0o777, 0o700);
    const stored = fs.readFileSync(revocationPath, 'utf8');
    const signature = cookie.split('.').pop();
    assert.equal(stored.includes(signature), false);
    assert.equal(stored.includes(token), false);
    assert.equal(fs.readdirSync(path.dirname(revocationPath)).length, 1, 'no temp files left behind');
  });

  it('prunes revocations once the session would have expired anyway', async () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const revocationPath = tmpRevocations();
    const auth = managementAuth({ token, dashboardOrigin: origin, revocationPath, now: () => now });
    await logout(auth, await login(auth, false));
    const first = JSON.parse(fs.readFileSync(revocationPath, 'utf8'));
    assert.equal(Object.keys(first.revoked).length, 1);

    now += 25 * 60 * 60 * 1000;
    await logout(auth, await login(auth, false));
    const second = JSON.parse(fs.readFileSync(revocationPath, 'utf8'));
    assert.equal(Object.keys(second.revoked).length, 1, 'expired revocation pruned');

    now += 25 * 60 * 60 * 1000;
    managementAuth({ token, dashboardOrigin: origin, revocationPath, now: () => now });
    const loaded = managementAuth({ token, dashboardOrigin: origin, revocationPath, now: () => now });
    await logout(loaded, await login(loaded, false));
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(revocationPath, 'utf8')).revoked).length, 1);
  });

  it('never evicts unexpired revocations to make room', async () => {
    const revocationPath = tmpRevocations();
    const auth = managementAuth({ token, dashboardOrigin: origin, revocationPath, maxRevocations: 2 });
    const cookies = [await login(auth), await login(auth), await login(auth)];
    assert.equal((await logout(auth, cookies[0])).res.statusCode, 303);
    assert.equal((await logout(auth, cookies[1])).res.statusCode, 303);
    const full = await logout(auth, cookies[2]);
    assert.equal(full.res.statusCode, 503);
    assert.match(full.res.body, /rotate the management token/iu);

    const restarted = managementAuth({ token, dashboardOrigin: origin, revocationPath, maxRevocations: 2 });
    assert.equal(await authed(restarted, cookies[0]), false);
    assert.equal(await authed(restarted, cookies[1]), false);
  });

  it('fails closed when the revocation store is unreadable or corrupt', async () => {
    const revocationPath = tmpRevocations();
    const healthy = managementAuth({ token, dashboardOrigin: origin, revocationPath });
    const cookie = await login(healthy);

    fs.writeFileSync(revocationPath, '{not json', { mode: 0o600 });
    const broken = managementAuth({ token, dashboardOrigin: origin, revocationPath });
    assert.equal(await authed(broken, cookie), false);
    const { res } = await run(broken, { method: 'POST', url: '/login', body: `token=${token}`, headers: { origin } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['set-cookie'], undefined);
    // The CLI bearer credential is unaffected.
    assert.equal((await run(broken, { url: '/api/projects', headers: { authorization: `Bearer ${token}` } })).passed, true);
  });

  it('fails closed when a revocation cannot be persisted', async () => {
    const revocationPath = tmpRevocations();
    const auth = managementAuth({ token, dashboardOrigin: origin, revocationPath });
    const cookie = await login(auth);
    // Make the store unwritable by replacing it with a directory.
    fs.mkdirSync(revocationPath);
    const { res } = await logout(auth, cookie);
    assert.equal(res.statusCode, 500);
    assert.match(res.body, /could not be saved/iu);
    assert.match(res.headers['set-cookie'], /Max-Age=0/u);
    // Still revoked in this process, and no further browser sessions are issued.
    assert.equal(await authed(auth, cookie), false);
    const retry = await run(auth, { method: 'POST', url: '/login', body: `token=${token}`, headers: { origin } });
    assert.equal(retry.res.statusCode, 503);
  });

  it('cookie name is unchanged', async () => {
    const auth = managementAuth({ token, dashboardOrigin: origin, revocationPath: tmpRevocations() });
    assert.ok((await login(auth)).startsWith(`${COOKIE}=`));
  });
});
