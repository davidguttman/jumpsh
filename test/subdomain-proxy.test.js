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
  it('rejects requests with no host header', async () => {
    const proxy = new SubdomainProxy({}, {}, config);
    const mw = proxy.middleware();
    const res = mockRes();
    let nextCalled = false;
    await mw(mockReq(undefined), res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 421);
  });

  it('calls next() for main domain', async () => {
    const proxy = new SubdomainProxy({}, {}, config);
    const mw = proxy.middleware();
    let nextCalled = false;
    await mw(mockReq('dash.jump.sh'), mockRes(), () => { nextCalled = true; });
    assert.ok(nextCalled);
  });

  it('rejects single-part hosts', async () => {
    const proxy = new SubdomainProxy({}, {}, config);
    const mw = proxy.middleware();
    const res = mockRes();
    let nextCalled = false;
    await mw(mockReq('localhost'), res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 421);
  });

  it('ignores X-Forwarded-Host on websocket upgrades', async () => {
    let upgradeHandler;
    const server = {
      on(event, handler) {
        assert.equal(event, 'upgrade');
        upgradeHandler = handler;
      },
    };
    let dbCalls = 0;
    const proxy = new SubdomainProxy({
      getProjectBySubdomain: () => { dbCalls++; },
    }, {}, config);
    proxy.attachUpgrade(server);

    let destroyed = false;
    await upgradeHandler({
      headers: {
        host: 'localhost',
        'x-forwarded-host': 'myapp.jump.sh',
      },
    }, {
      destroy() { destroyed = true; },
    }, Buffer.alloc(0));

    assert.equal(destroyed, true);
    assert.equal(dbCalls, 0);
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

// ---- unavailable interstitial ----

describe('SubdomainProxy unavailable interstitial', () => {
  function projectRecord(overrides = {}) {
    return { id: 42, name: 'myapp', subdomain: 'myapp', path: '/tmp/myapp', ...overrides };
  }

  function dbForProject(project, calls = []) {
    return {
      getProjectBySubdomain: (sub, cb) => cb(null, sub === project.subdomain ? project : null),
      updateProject: (id, updates, cb) => { calls.push({ id, updates }); cb(null); },
    };
  }

  function jsonRes() {
    const res = mockRes();
    const headers = {};
    let json = null;
    res.set = (field, value) => { headers[field.toLowerCase()] = value; return res; };
    res.type = (value) => { headers['content-type'] = value; return res; };
    res.json = (value) => { json = value; res.send(JSON.stringify(value)); return res; };
    Object.defineProperties(res, {
      headers: { get: () => headers },
      jsonBody: { get: () => json },
    });
    return res;
  }

  it('does not auto-start a stopped registered project', async () => {
    const project = projectRecord();
    const updateCalls = [];
    let startCalls = 0;
    const db = dbForProject(project, updateCalls);
    const docker = {
      getPort: async () => null,
      isStarting: () => false,
      start: async () => { startCalls++; return { success: true }; },
    };
    const proxy = new SubdomainProxy(db, docker, config);
    const res = mockRes();

    await proxy.middleware()(mockReq('myapp.jump.sh'), res, () => assert.fail('next should not be called'));

    assert.equal(res.statusCode, 503);
    assert.match(res.body, /myapp is not running/);
    assert.match(res.body, /Public requests do not start stopped projects/);
    assert.equal(startCalls, 0);
    assert.deepEqual(updateCalls, []);
  });

  it('never invokes start when the project is already starting', async () => {
    const project = projectRecord();
    let startCalls = 0;
    const db = dbForProject(project);
    const docker = {
      getPort: async () => null,
      isStarting: () => true,
      start: async () => { startCalls++; return { success: true }; },
    };
    const proxy = new SubdomainProxy(db, docker, config);
    const res = mockRes();

    await proxy.middleware()(mockReq('myapp.jump.sh'), res, () => assert.fail('next should not be called'));

    assert.equal(res.statusCode, 503);
    assert.match(res.body, /myapp is not running/);
    assert.equal(startCalls, 0);
  });

  it('returns the interstitial instead of proxying normal requests while HTTP readiness is false', async () => {
    const project = projectRecord();
    const db = dbForProject(project);
    const docker = {
      getPort: async () => 10042,
      getHealth: () => 'healthy',
      isStarting: () => false,
    };
    const proxy = new SubdomainProxy(db, docker, config);
    let proxied = false;
    let readinessCalls = 0;
    proxy.isHttpTargetReady = async (port) => {
      readinessCalls++;
      assert.equal(port, 10042);
      return false;
    };
    proxy.getOrCreateProxy = () => {
      proxied = true;
      return () => {};
    };
    const res = jsonRes();

    await proxy.middleware()(mockReq('myapp.jump.sh'), res, () => assert.fail('next should not be called'));

    assert.equal(readinessCalls, 1);
    assert.equal(proxied, false);
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /myapp is starting/);
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('proxies normal requests when the port is healthy and HTTP-ready', async () => {
    const project = projectRecord();
    const db = dbForProject(project);
    const docker = {
      getPort: async () => 10042,
      getHealth: () => 'healthy',
      isStarting: () => false,
    };
    const proxy = new SubdomainProxy(db, docker, config);
    let proxied = false;
    proxy.isHttpTargetReady = async (port) => {
      assert.equal(port, 10042);
      return true;
    };
    proxy.getOrCreateProxy = (port, proxiedProject) => {
      assert.equal(port, 10042);
      assert.equal(proxiedProject, project);
      return () => { proxied = true; };
    };

    await proxy.middleware()(mockReq('myapp.jump.sh'), mockRes(), () => assert.fail('next should not be called'));

    assert.equal(proxied, true);
  });

  it('preserves normal proxy path when a port is available and readiness passes', async () => {
    const project = projectRecord();
    const db = dbForProject(project);
    const docker = { getPort: async () => 10042, getHealth: () => 'healthy' };
    const proxy = new SubdomainProxy(db, docker, config);
    let proxied = false;
    proxy.isHttpTargetReady = async () => true;
    proxy.getOrCreateProxy = (port, proxiedProject) => {
      assert.equal(port, 10042);
      assert.equal(proxiedProject, project);
      return () => { proxied = true; };
    };

    await proxy.middleware()(mockReq('myapp.jump.sh'), mockRes(), () => assert.fail('next should not be called'));

    assert.equal(proxied, true);
  });
});
