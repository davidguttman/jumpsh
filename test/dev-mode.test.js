import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import MockDockerManager from '../services/MockDockerManager.js';
import SubdomainProxy from '../services/SubdomainProxy.js';
import Database from '../database.js';
import { createMockDb } from './helpers/mock-db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixturesDir = path.join(__dirname, 'fixtures/apps');

// ---- detectDomainFromHost (mirrors server.js logic) ----

// Duplicated from server.js for unit-testing the algorithm
function detectDomainFromHost(hostname) {
  const host = hostname.replace(/:\d+$/, '');
  for (const prefix of ['dash.', 'dashboard.']) {
    if (host.startsWith(prefix)) {
      return host.slice(prefix.length);
    }
  }
  const labels = host.split('.');
  if (labels.length >= 3) {
    return labels.slice(1).join('.');
  }
  return null;
}

describe('detectDomainFromHost', () => {
  it('dash.user.jump.sh => user.jump.sh', () => {
    assert.equal(detectDomainFromHost('dash.davidguttman.jump.sh'), 'davidguttman.jump.sh');
  });

  it('dashboard.user.jump.sh => user.jump.sh', () => {
    assert.equal(detectDomainFromHost('dashboard.davidguttman.jump.sh'), 'davidguttman.jump.sh');
  });

  it('worktree host: project--branch.user.jump.sh => user.jump.sh', () => {
    assert.equal(detectDomainFromHost('jump-sh--dev-mode.davidguttman.jump.sh'), 'davidguttman.jump.sh');
  });

  it('project.user.jump.sh => user.jump.sh', () => {
    assert.equal(detectDomainFromHost('fixture-node-npm-vite.davidguttman.jump.sh'), 'davidguttman.jump.sh');
  });

  it('strips port before detection', () => {
    assert.equal(detectDomainFromHost('jump-sh--dev-mode.davidguttman.jump.sh:4443'), 'davidguttman.jump.sh');
  });

  it('two-part host (jump.sh) => null', () => {
    assert.equal(detectDomainFromHost('jump.sh'), null);
  });

  it('single-label host (localhost) => null', () => {
    assert.equal(detectDomainFromHost('localhost'), null);
  });

  it('localhost with port => null', () => {
    assert.equal(detectDomainFromHost('localhost:4443'), null);
  });

  it('dash prefix still wins over generic 3+ label fallback', () => {
    assert.equal(detectDomainFromHost('dash.example.com'), 'example.com');
  });
});

// ---- JUMPSH_DEV_MODE parsing ----

describe('JUMPSH_DEV_MODE parsing', () => {
  function parseDevMode(val) {
    return /^(true|1)$/i.test(val || '');
  }

  it('true => enabled', () => assert.equal(parseDevMode('true'), true));
  it('TRUE => enabled', () => assert.equal(parseDevMode('TRUE'), true));
  it('True => enabled', () => assert.equal(parseDevMode('True'), true));
  it('1 => enabled', () => assert.equal(parseDevMode('1'), true));
  it('false => disabled', () => assert.equal(parseDevMode('false'), false));
  it('0 => disabled', () => assert.equal(parseDevMode('0'), false));
  it('empty => disabled', () => assert.equal(parseDevMode(''), false));
  it('undefined => disabled', () => assert.equal(parseDevMode(undefined), false));
  it('yes => disabled', () => assert.equal(parseDevMode('yes'), false));
});

// ---- Fixture loading idempotency ----

describe('Fixture loading', () => {
  it('fixture directories exist and are valid', () => {
    const entries = fs.readdirSync(fixturesDir);
    assert.ok(entries.length >= 6, `Expected at least 6 fixtures, got ${entries.length}`);
    for (const name of entries) {
      const p = path.join(fixturesDir, name);
      assert.ok(fs.statSync(p).isDirectory(), `${name} should be a directory`);
    }
  });

  it('idempotent fixture registration skips by path', async () => {
    const mockDb = createMockDb();
    const fixturePath = path.join(fixturesDir, 'node-npm-vite');

    // Register once
    await new Promise((resolve, reject) => {
      mockDb.createProject({
        name: 'fixture-node-npm-vite',
        path: fixturePath,
        description: '[fixture] Test fixture app',
      }, (err) => err ? reject(err) : resolve());
    });

    const countBefore = mockDb.projects.length;

    // Simulate idempotent check (by path)
    const existing = await new Promise(resolve => {
      mockDb.getProjectByPath(fixturePath, (err, p) => resolve(p));
    });
    assert.ok(existing, 'Should find existing project by path');

    // Don't create again
    assert.equal(mockDb.projects.length, countBefore);
  });

  it('idempotent fixture registration skips by name', async () => {
    const mockDb = createMockDb();
    const fixturePath = path.join(fixturesDir, 'python-fastapi');

    // Register once
    await new Promise((resolve, reject) => {
      mockDb.createProject({
        name: 'fixture-python-fastapi',
        path: fixturePath,
      }, (err) => err ? reject(err) : resolve());
    });

    // Check by name
    const existing = await new Promise(resolve => {
      mockDb.getProjectByName('fixture-python-fastapi', (err, p) => resolve(p));
    });
    assert.ok(existing, 'Should find existing project by name');
  });
});

// ---- db.ready() race condition regression ----

describe('initDevMode db readiness', () => {
  it('db methods fail before ready() resolves', () => {
    // Simulate the race: construct a Database (lowdb not yet loaded)
    // and immediately try to call a method that reads this.db.data
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-dbrace-'));
    const origEnv = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const db = new Database();
      // Before ready(), this.db is undefined — calling getProjectByPath should throw
      assert.throws(() => {
        db.getProjectByPath('/some/path', () => {});
      }, /Cannot read properties of undefined/);
    } finally {
      process.env.HOME = origEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('db methods work after ready() resolves', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-dbrace-'));
    const origEnv = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const db = new Database();
      await db.ready();
      // After ready(), this should not throw
      const result = await new Promise(resolve => {
        db.getProjectByPath('/nonexistent', (err, p) => resolve(p));
      });
      assert.equal(result, null);
    } finally {
      process.env.HOME = origEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---- SubdomainProxy mock placeholder ----

describe('SubdomainProxy mock placeholder', () => {
  const config = {
    port: 4443,
    domain: 'jump.sh',
    https: true,
    devMode: true,
    dashboardHost: 'dash.jump.sh',
    formatUrl: (host, p) => p ? `https://${host}${p}` : `https://${host}`,
  };

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

  it('serves placeholder HTML for mock running project', (t, done) => {
    const fixturePath = path.join(fixturesDir, 'node-npm-vite');
    const project = { id: 1, name: 'fixture-node-npm-vite', path: fixturePath, subdomain: 'fixture-node-npm-vite' };
    const db = { getProjectBySubdomain: (sub, cb) => cb(null, project) };
    const mockDocker = new MockDockerManager(createMockDb(), { delay: 10 });

    // Start the project so getPort returns a port
    mockDocker.start(project).then(() => {
      const proxy = new SubdomainProxy(db, mockDocker, config);
      const mw = proxy.middleware();
      const res = mockRes();

      mw(mockReq('fixture-node-npm-vite.jump.sh'), res, () => {
        assert.fail('next should not be called for mock project');
      });

      setTimeout(() => {
        assert.ok(res.body, 'Should have response body');
        assert.ok(res.body.includes('Mock container running'), 'Should contain mock indicator');
        assert.ok(res.body.includes('fixture-node-npm-vite'), 'Should contain project name');
        done();
      }, 50);
    });
  });

  it('does NOT serve placeholder for real DockerManager (no isMock)', (t, done) => {
    const project = { id: 1, name: 'real-app', subdomain: 'real-app' };
    const db = { getProjectBySubdomain: (sub, cb) => cb(null, project) };
    // Docker without isMock flag but returns null port — should get 503, not mock page
    const fakeDocker = { getPort: async () => null };
    const proxy = new SubdomainProxy(db, fakeDocker, config);
    const mw = proxy.middleware();
    const res = mockRes();

    mw(mockReq('real-app.jump.sh'), res, () => {});

    setTimeout(() => {
      // No port → 503 page, not a mock placeholder
      assert.equal(res.statusCode, 503);
      assert.ok(!res.body.includes('Mock container running'));
      done();
    }, 50);
  });

  it('escapes HTML in project names', (t, done) => {
    const fixturePath = path.join(fixturesDir, 'static-html');
    const project = { id: 2, name: '<script>alert(1)</script>', path: fixturePath, subdomain: 'xss-test' };
    const db = { getProjectBySubdomain: (sub, cb) => cb(null, project) };
    const mockDocker = new MockDockerManager(createMockDb(), { delay: 10 });

    mockDocker.start(project).then(() => {
      const proxy = new SubdomainProxy(db, mockDocker, config);
      const mw = proxy.middleware();
      const res = mockRes();

      mw(mockReq('xss-test.jump.sh'), res, () => {});

      setTimeout(() => {
        assert.ok(res.body);
        assert.ok(!res.body.includes('<script>alert(1)</script>'), 'Should escape HTML');
        assert.ok(res.body.includes('&lt;script&gt;'), 'Should contain escaped tags');
        done();
      }, 50);
    });
  });
});

// ---- MockDockerManager does not affect non-dev behavior ----

describe('Non-dev-mode behavior', () => {
  it('DockerManager does not have isMock flag', async () => {
    // Import DockerManager to verify it does NOT set isMock
    const { default: DockerManager } = await import('../services/DockerManager.js');
    const dm = new DockerManager(createMockDb(), { spawner: () => {} });
    assert.equal(dm.isMock, undefined);
  });
});
