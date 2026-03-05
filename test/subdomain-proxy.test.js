import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import SubdomainProxy from '../services/SubdomainProxy.js';

const config = {
  port: 4443,
  domain: 'jump.sh',
  https: true,
  dashboardHost: 'dash.jump.sh',
  formatUrl: (host, p) => p ? `https://${host}${p}` : `https://${host}`,
};

// ---- extractSubdomain ----

describe('SubdomainProxy extractSubdomain', () => {
  const proxy = new SubdomainProxy({}, {}, config);

  it('extracts subdomain from standard host', () => {
    assert.equal(proxy.extractSubdomain('myapp.jump.sh'), 'myapp');
  });

  it('strips port before extracting', () => {
    assert.equal(proxy.extractSubdomain('myapp.jump.sh:4443'), 'myapp');
  });

  it('returns null for bare domain (single part)', () => {
    assert.equal(proxy.extractSubdomain('localhost'), null);
  });

  it('extracts worktree subdomain with double-dash', () => {
    assert.equal(proxy.extractSubdomain('myapp--feature.jump.sh'), 'myapp--feature');
  });

  it('returns first part for two-part domain', () => {
    assert.equal(proxy.extractSubdomain('jump.sh'), 'jump');
  });
});

// ---- isMainDomain ----

describe('SubdomainProxy isMainDomain', () => {
  const proxy = new SubdomainProxy({}, {}, config);

  it('returns true for "dash"', () => {
    assert.equal(proxy.isMainDomain('dash'), true);
  });

  it('returns true for "dashboard"', () => {
    assert.equal(proxy.isMainDomain('dashboard'), true);
  });

  it('returns true for "www"', () => {
    assert.equal(proxy.isMainDomain('www'), true);
  });

  it('returns true for domain prefix ("jump")', () => {
    assert.equal(proxy.isMainDomain('jump'), true);
  });

  it('returns false for project subdomain', () => {
    assert.equal(proxy.isMainDomain('myapp'), false);
  });
});

// ---- middleware ----

function mockReq(host) {
  return { get: (h) => h === 'host' ? host : undefined };
}

function mockRes() {
  let _status = null;
  let _body = null;
  return {
    status(code) { _status = code; return this; },
    send(body) { _body = body; },
    get statusCode() { return _status; },
    get body() { return _body; },
  };
}

describe('SubdomainProxy middleware', () => {
  it('calls next() when no host header', async () => {
    const proxy = new SubdomainProxy({}, {}, config);
    const mw = proxy.middleware();
    let nextCalled = false;
    await mw(mockReq(undefined), mockRes(), () => { nextCalled = true; });
    assert.ok(nextCalled);
  });

  it('calls next() for main domain', async () => {
    const proxy = new SubdomainProxy({}, {}, config);
    const mw = proxy.middleware();
    let nextCalled = false;
    await mw(mockReq('dash.jump.sh'), mockRes(), () => { nextCalled = true; });
    assert.ok(nextCalled);
  });

  it('calls next() when subdomain is null (single-part host)', async () => {
    const proxy = new SubdomainProxy({}, {}, config);
    const mw = proxy.middleware();
    let nextCalled = false;
    await mw(mockReq('localhost'), mockRes(), () => { nextCalled = true; });
    assert.ok(nextCalled);
  });

  it('returns 404 when project not found', (t, done) => {
    const db = { getProjectBySubdomain: (sub, cb) => cb(null, null) };
    const proxy = new SubdomainProxy(db, {}, config);
    const mw = proxy.middleware();
    const res = mockRes();
    mw(mockReq('unknown.jump.sh'), res, () => {
      assert.fail('next should not be called');
    });
    // db callback is sync, so check after microtask
    setTimeout(() => {
      assert.equal(res.statusCode, 404);
      done();
    }, 10);
  });

  it('returns 503 when project has no port', (t, done) => {
    const project = { id: 1, name: 'myapp' };
    const db = { getProjectBySubdomain: (sub, cb) => cb(null, project) };
    const docker = { getPort: async () => null };
    const proxy = new SubdomainProxy(db, docker, config);
    const mw = proxy.middleware();
    const res = mockRes();
    mw(mockReq('myapp.jump.sh'), res, () => {
      assert.fail('next should not be called');
    });
    setTimeout(() => {
      assert.equal(res.statusCode, 503);
      done();
    }, 20);
  });
});

// ---- cache ----

describe('SubdomainProxy cache', () => {
  it('getOrCreateProxy returns same proxy for same port', () => {
    const proxy = new SubdomainProxy({}, {}, config);
    const p1 = proxy.getOrCreateProxy(10000);
    const p2 = proxy.getOrCreateProxy(10000);
    assert.equal(p1, p2);
  });

  it('clearCache makes next call create new proxy', () => {
    const proxy = new SubdomainProxy({}, {}, config);
    const p1 = proxy.getOrCreateProxy(10000);
    proxy.clearCache();
    const p2 = proxy.getOrCreateProxy(10000);
    assert.notEqual(p1, p2);
  });
});
