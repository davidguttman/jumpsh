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
const sessionId = cookie => cookie.split('=')[1].split('.')[2];
const daemon = (revocationDir, extra = {}) => managementAuth({ token, dashboardOrigin: origin, revocationDir, ...extra });
const markers = dir => fs.readdirSync(dir);

describe('persistent logout revocation', () => {
  it('requires an explicit revocation directory and defaults it under ~/.jump.sh', () => {
    assert.throws(() => managementAuth({ token, dashboardOrigin: origin }), /revocationDir/u);
    assert.equal(managementRevocationsPath('/home/x'), path.join('/home/x', '.jump.sh', 'revoked-sessions'));
  });

  it('does not lose revocations when two daemons share one home', async () => {
    const dir = tmpRevocations();
    // Both daemons start before any logout, as with concurrent instances.
    const a = daemon(dir);
    const b = daemon(dir);
    const first = await login(a);
    const second = await login(b);
    assert.equal((await logout(a, first)).res.statusCode, 303);
    assert.equal((await logout(b, second)).res.statusCode, 303);

    const restarted = daemon(dir);
    assert.equal(await authed(restarted, first), false, 'first logout survives the other daemon writing');
    assert.equal(await authed(restarted, second), false);
  });

  it('makes each daemon see revocations made by another immediately', async () => {
    const dir = tmpRevocations();
    const a = daemon(dir);
    const b = daemon(dir);
    const cookie = await login(a);
    assert.equal(await authed(a, cookie), true);
    await logout(b, cookie);
    assert.equal(await authed(a, cookie), false);
  });

  it('keeps a logged-out Remember cookie revoked after a restart, per device only', async () => {
    const dir = tmpRevocations();
    const before = daemon(dir);
    const copied = await login(before);
    const otherDevice = await login(before);
    assert.equal((await logout(before, copied)).res.statusCode, 303);

    const restarted = daemon(dir);
    assert.equal(await authed(restarted, copied), false);
    assert.equal(await authed(restarted, otherDevice), true);
  });

  it('writes one private marker per session with only the id and expiry', async () => {
    const dir = tmpRevocations();
    const auth = daemon(dir);
    const cookie = await login(auth);
    await logout(auth, cookie);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(markers(dir), [sessionId(cookie)], 'no temp files left behind');
    const marker = path.join(dir, sessionId(cookie));
    assert.equal(fs.statSync(marker).mode & 0o777, 0o600);
    const expires = Number(cookie.split('=')[1].split('.')[1]);
    assert.equal(fs.readFileSync(marker, 'utf8'), `${expires}\n`);
  });

  it('logging out twice is idempotent', async () => {
    const dir = tmpRevocations();
    const a = daemon(dir);
    const b = daemon(dir);
    const cookie = await login(a);
    assert.equal((await logout(a, cookie)).res.statusCode, 303);
    // b still trusts the cookie only if it never looks; it must not.
    assert.equal((await logout(b, cookie)).res.statusCode, 303);
    assert.deepEqual(markers(dir), [sessionId(cookie)]);
  });

  it('prunes markers only once their session would have expired anyway', async () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const dir = tmpRevocations();
    const auth = daemon(dir, { now: () => now });
    const short = await login(auth, false);
    const long = await login(auth, true);
    await logout(auth, short);
    await logout(auth, long);
    assert.equal(markers(dir).length, 2);

    now += 25 * 60 * 60 * 1000;
    await logout(auth, await login(auth, false));
    assert.deepEqual(markers(dir).sort(), [sessionId(long), markers(dir).find(m => m !== sessionId(long))].sort());
    assert.equal(markers(dir).includes(sessionId(short)), false, 'expired marker pruned');
    assert.equal(await authed(auth, long), false, 'unexpired marker kept');
  });

  it('removes stale temp files during pruning', async () => {
    const dir = tmpRevocations();
    const auth = daemon(dir);
    await logout(auth, await login(auth));
    const stale = path.join(dir, '.stale.tmp');
    fs.writeFileSync(stale, 'x');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    await logout(auth, await login(auth));
    assert.equal(fs.existsSync(stale), false);
  });

  it('never evicts unexpired revocations to make room', async () => {
    const dir = tmpRevocations();
    const a = daemon(dir, { maxRevocations: 2 });
    const b = daemon(dir, { maxRevocations: 2 });
    const cookies = [await login(a), await login(a), await login(a)];
    assert.equal((await logout(a, cookies[0])).res.statusCode, 303);
    assert.equal((await logout(b, cookies[1])).res.statusCode, 303);
    const full = await logout(a, cookies[2]);
    assert.equal(full.res.statusCode, 503);
    assert.match(full.res.body, /rotate the management token/iu);
    assert.equal(full.res.headers['set-cookie'], undefined);

    const restarted = daemon(dir, { maxRevocations: 2 });
    assert.equal(await authed(restarted, cookies[0]), false);
    assert.equal(await authed(restarted, cookies[1]), false);
  });

  it('fails closed when the revocation directory cannot be read', async () => {
    const dir = tmpRevocations();
    const healthy = daemon(dir);
    const cookie = await login(healthy);

    fs.writeFileSync(dir, 'not a directory', { mode: 0o600 });
    for (const auth of [healthy, daemon(dir)]) {
      assert.equal(await authed(auth, cookie), false);
      const { res } = await run(auth, { method: 'POST', url: '/login', body: `token=${token}`, headers: { origin } });
      assert.equal(res.statusCode, 503);
      assert.equal(res.headers['set-cookie'], undefined);
      // The CLI bearer credential is unaffected.
      assert.equal((await run(auth, { url: '/api/projects', headers: { authorization: `Bearer ${token}` } })).passed, true);
    }
  });

  it('treats an unreadable or malformed marker as revoked', async () => {
    const dir = tmpRevocations();
    const auth = daemon(dir);
    const garbled = await login(auth);
    const unreadable = await login(auth);
    const unaffected = await login(auth);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, sessionId(garbled)), 'garbage', { mode: 0o600 });
    fs.mkdirSync(path.join(dir, sessionId(unreadable)));
    assert.equal(await authed(auth, garbled), false);
    assert.equal(await authed(auth, unreadable), false);
    assert.equal(await authed(auth, unaffected), true);
  });

  it('fails closed when a revocation cannot be persisted', { skip: process.getuid?.() === 0 && 'root ignores directory permissions' }, async () => {
    const dir = tmpRevocations();
    const auth = daemon(dir);
    const cookie = await login(auth);
    const other = await login(auth);
    // A read-only directory: lookups work, marker writes fail.
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.chmodSync(dir, 0o500);
    let res;
    try {
      ({ res } = await logout(auth, cookie));
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    assert.equal(res.statusCode, 500);
    assert.match(res.body, /could not be saved/iu);
    assert.match(res.headers['set-cookie'], /Max-Age=0/u);
    assert.equal(await authed(auth, cookie), false);
    // Browser sign-in is disabled in this daemon until restart.
    assert.equal(await authed(auth, other), false);
    const retry = await run(auth, { method: 'POST', url: '/login', body: `token=${token}`, headers: { origin } });
    assert.equal(retry.res.statusCode, 503);
    assert.deepEqual(markers(dir), [], 'no temp files left behind');
  });

  it('cookie name is unchanged', async () => {
    assert.ok((await login(daemon(tmpRevocations()))).startsWith(`${COOKIE}=`));
  });
});

describe('revocation directory permissions', () => {
  it('removes group and other access from an existing directory', async () => {
    const dir = tmpRevocations();
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.chmodSync(dir, 0o755);
    const auth = daemon(dir);
    await logout(auth, await login(auth));
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  });
});
