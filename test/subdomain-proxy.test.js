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

// ---- auto-start interstitial ----

describe('SubdomainProxy auto-start interstitial', () => {
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

  it('auto-starts a stopped registered project and returns an interstitial', async () => {
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
    assert.match(res.body, /Starting myapp/);
    assert.match(res.body, /\.jump-sh\/proxy-status/);
    assert.match(res.body, /Loading/);
    assert.equal(startCalls, 1);
    assert.deepEqual(updateCalls, [{ id: 42, updates: { desired_running: 1 } }]);
  });

  it('does not trigger duplicate starts when the project is already starting', async () => {
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
    assert.match(res.body, /Starting myapp/);
    assert.equal(startCalls, 0);
  });

  it('serves same-origin proxy status for readiness polling once healthy', async () => {
    const project = projectRecord();
    const db = dbForProject(project);
    const docker = {
      getPort: async () => 10042,
      getHealth: () => 'healthy',
      isStarting: () => false,
      getStartupStep: () => null,
    };
    const proxy = new SubdomainProxy(db, docker, config);
    let readinessCalls = 0;
    proxy.isHttpTargetReady = async (port) => {
      readinessCalls++;
      assert.equal(port, 10042);
      return true;
    };
    const req = { get: (h) => h === 'host' ? 'myapp.jump.sh' : undefined, url: '/.jump-sh/proxy-status' };
    const res = jsonRes();

    await proxy.middleware()(req, res, () => assert.fail('next should not be called'));

    assert.equal(readinessCalls, 1);
    assert.equal(res.statusCode, null);
    assert.deepEqual(res.jsonBody, { running: true, starting: false, port: 10042 });
  });

  it('keeps proxy status starting when health is healthy but HTTP readiness is false', async () => {
    const project = projectRecord();
    const db = dbForProject(project);
    const docker = {
      getPort: async () => 10042,
      getHealth: () => 'healthy',
      isStarting: () => false,
      getStartupStep: () => null,
    };
    const proxy = new SubdomainProxy(db, docker, config);
    proxy.isHttpTargetReady = async () => false;
    const req = { get: (h) => h === 'host' ? 'myapp.jump.sh' : undefined, url: '/.jump-sh/proxy-status' };
    const res = jsonRes();

    await proxy.middleware()(req, res, () => assert.fail('next should not be called'));

    assert.equal(res.statusCode, null);
    assert.deepEqual(res.jsonBody, {
      running: false,
      starting: true,
      port: 10042,
      health: 'healthy',
      step: null,
      dashboardUrl: 'https://dashboard.jump.sh/projects/42',
    });
  });

  it('keeps proxy status starting while a port exists but health is still starting', async () => {
    const project = projectRecord();
    const step = { step: 4, totalSteps: 5, label: 'Waiting for health check...' };
    const db = dbForProject(project);
    const docker = {
      getPort: async () => 10042,
      getHealth: () => 'starting',
      isStarting: () => false,
      getStartupStep: () => step,
    };
    const proxy = new SubdomainProxy(db, docker, config);
    const req = { get: (h) => h === 'host' ? 'myapp.jump.sh' : undefined, url: '/.jump-sh/proxy-status' };
    const res = jsonRes();

    await proxy.middleware()(req, res, () => assert.fail('next should not be called'));

    assert.equal(res.statusCode, null);
    assert.deepEqual(res.jsonBody, {
      running: false,
      starting: true,
      port: 10042,
      health: 'starting',
      step,
      dashboardUrl: 'https://dashboard.jump.sh/projects/42',
    });
  });

  it('triggers a health probe for unknown health with an available port', async () => {
    const project = projectRecord();
    const db = dbForProject(project);
    let probeCalls = 0;
    const docker = {
      getPort: async () => 10042,
      getHealth: () => 'unknown',
      getHealthWithProbe: (p, status) => {
        probeCalls++;
        assert.equal(p, project);
        assert.deepEqual(status, { running: true, port: 10042 });
        return 'starting';
      },
      isStarting: () => false,
      getStartupStep: () => null,
    };
    const proxy = new SubdomainProxy(db, docker, config);
    const req = { get: (h) => h === 'host' ? 'myapp.jump.sh' : undefined, url: '/.jump-sh/proxy-status' };
    const res = jsonRes();

    await proxy.middleware()(req, res, () => assert.fail('next should not be called'));

    assert.equal(probeCalls, 1);
    assert.equal(res.statusCode, null);
    assert.deepEqual(res.jsonBody, {
      running: false,
      starting: true,
      port: 10042,
      health: 'starting',
      step: null,
      dashboardUrl: 'https://dashboard.jump.sh/projects/42',
    });
  });

  it('reports unhealthy port-backed projects as proxy status failures', async () => {
    const project = projectRecord();
    const db = dbForProject(project);
    const docker = {
      getPort: async () => 10042,
      getHealth: () => 'unhealthy',
      isStarting: () => false,
      getStartupStep: () => null,
    };
    const proxy = new SubdomainProxy(db, docker, config);
    const req = { get: (h) => h === 'host' ? 'myapp.jump.sh' : undefined, url: '/.jump-sh/proxy-status' };
    const res = jsonRes();

    await proxy.middleware()(req, res, () => assert.fail('next should not be called'));

    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.jsonBody, {
      running: false,
      starting: false,
      port: 10042,
      health: 'unhealthy',
      error: 'Project is unhealthy',
      dashboardUrl: 'https://dashboard.jump.sh/projects/42',
    });
  });

  it('reports start failures through the proxy status endpoint', async () => {
    const project = projectRecord();
    const db = dbForProject(project);
    const docker = {
      getPort: async () => null,
      isStarting: () => false,
      start: async () => ({ success: false, error: 'Docker unavailable' }),
    };
    const proxy = new SubdomainProxy(db, docker, config);
    const first = mockRes();
    await proxy.middleware()(mockReq('myapp.jump.sh'), first, () => assert.fail('next should not be called'));
    await new Promise(resolve => setTimeout(resolve, 0));

    const req = { get: (h) => h === 'host' ? 'myapp.jump.sh' : undefined, url: '/.jump-sh/proxy-status' };
    const res = jsonRes();
    await proxy.middleware()(req, res, () => assert.fail('next should not be called'));

    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.jsonBody, {
      running: false,
      starting: false,
      error: 'Docker unavailable',
      dashboardUrl: 'https://dashboard.jump.sh/projects/42',
    });
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
    assert.match(res.body, /Starting myapp/);
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
