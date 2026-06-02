import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import MockDockerManager from '../services/MockDockerManager.js';
import SubdomainProxy, { decodeContextHostCandidates } from '../services/SubdomainProxy.js';
import { DNS_LABEL_MAX_LENGTH, encodeContextHost, getContextHostMetadata } from '../lib/context-host.js';
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

// ---- Context-host encode/decode ----

describe('encodeContextHost', () => {
  it('keeps normal context labels unchanged when DNS-safe', () => {
    const metadata = getContextHostMetadata('fixture-static-html', 'jump-sh--dev-mode');

    assert.equal(metadata.label, 'fixture-static-html--jump-sh--dev-mode');
    assert.equal(metadata.isShortened, false);
    assert.equal(
      encodeContextHost('fixture-static-html', 'jump-sh--dev-mode'),
      'fixture-static-html--jump-sh--dev-mode'
    );
  });

  it('shortens long context labels to deterministic DNS-safe aliases', () => {
    const projectSubdomain = 'power-slides';
    const contextSubdomain = 'kamajiremote-first-starter-copy-1511450237200236627';
    const alias = encodeContextHost(projectSubdomain, contextSubdomain);
    const again = encodeContextHost(projectSubdomain, contextSubdomain);

    const metadata = getContextHostMetadata(projectSubdomain, contextSubdomain);

    assert.equal(again, alias, 'alias should be deterministic');
    assert.equal(metadata.label, alias);
    assert.equal(metadata.isShortened, true);
    assert.ok(alias.length <= DNS_LABEL_MAX_LENGTH, `alias should fit DNS label limit: ${alias.length}`);
    assert.notEqual(alias, `${projectSubdomain}--${contextSubdomain}`);
    assert.ok(alias.startsWith('power-slides--kamajiremote'), 'alias should keep readable prefixes');
    assert.match(alias, /--[a-f0-9]{16}$/u, 'alias should include stable hash suffix');
  });
});

describe('decodeContextHostCandidates', () => {
  it('decodes simple encoded host', () => {
    const candidates = decodeContextHostCandidates('fixture-node-npm-vite--jump-sh--dev-mode');
    assert.ok(candidates.length >= 1);
    assert.equal(candidates[0].projectSubdomain, 'fixture-node-npm-vite');
    assert.equal(candidates[0].contextSubdomain, 'jump-sh--dev-mode');
  });

  it('returns empty for label without --', () => {
    assert.deepEqual(decodeContextHostCandidates('fixture-node-npm-vite'), []);
  });

  it('returns empty for empty string', () => {
    assert.deepEqual(decodeContextHostCandidates(''), []);
  });

  it('returns empty when -- is at position 0', () => {
    assert.deepEqual(decodeContextHostCandidates('--suffix'), []);
  });

  it('returns empty when -- is at the end', () => {
    assert.deepEqual(decodeContextHostCandidates('prefix--'), []);
  });

  it('generates multiple candidates for multi-dash labels', () => {
    const candidates = decodeContextHostCandidates('a--b--c');
    // Candidates: a|b--c, a--b|c
    assert.ok(candidates.length >= 2);
    assert.equal(candidates[0].projectSubdomain, 'a');
    assert.equal(candidates[0].contextSubdomain, 'b--c');
  });

  it('roundtrips with encodeContextHost', () => {
    const encoded = encodeContextHost('fixture-static-html', 'jump-sh--dev-mode');
    const candidates = decodeContextHostCandidates(encoded);
    assert.ok(candidates.some(c =>
      c.projectSubdomain === 'fixture-static-html' && c.contextSubdomain === 'jump-sh--dev-mode'
    ));
  });
});

// ---- Context-host routing in SubdomainProxy ----

describe('SubdomainProxy context-host routing', () => {
  const config = {
    port: 4443,
    domain: 'jump.sh',
    https: true,
    devMode: true,
    dashboardHost: 'dash.jump.sh',
    formatUrl: (host, p) => p ? `https://${host}${p}` : `https://${host}`,
  };

  function mockReq(host, headers = {}) {
    const allHeaders = { host, ...headers };
    return { get: (h) => allHeaders[h.toLowerCase()] || undefined };
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

  it('resolves encoded host to target project in dev mode', (t, done) => {
    const fixturePath = path.join(fixturesDir, 'node-npm-vite');
    const project = { id: 1, name: 'fixture-node-npm-vite', path: fixturePath, subdomain: 'fixture-node-npm-vite' };
    const context = { id: 2, name: 'jump-sh--dev-mode', subdomain: 'jump-sh--dev-mode' };
    const db = {
      getProjectBySubdomain: (sub, cb) => {
        if (sub === 'fixture-node-npm-vite') return cb(null, project);
        if (sub === 'jump-sh--dev-mode') return cb(null, context);
        cb(null, null);
      }
    };
    const mockDocker = new MockDockerManager(createMockDb(), { delay: 10 });

    mockDocker.start(project).then(() => {
      const proxy = new SubdomainProxy(db, mockDocker, config);
      const mw = proxy.middleware();
      const res = mockRes();

      // Encoded host: fixture-node-npm-vite--jump-sh--dev-mode.jump.sh
      mw(mockReq('fixture-node-npm-vite--jump-sh--dev-mode.jump.sh'), res, () => {
        assert.fail('next should not be called for encoded project');
      });

      setTimeout(() => {
        assert.ok(res.body, 'Should have response body');
        assert.ok(res.body.includes('Mock container running'), 'Should serve mock placeholder');
        assert.ok(res.body.includes('fixture-node-npm-vite'), 'Should contain target project name');
        done();
      }, 50);
    });
  });

  it('resolves encoded host via X-Forwarded-Host fallback', (t, done) => {
    const fixturePath = path.join(fixturesDir, 'static-html');
    const project = { id: 3, name: 'fixture-static-html', path: fixturePath, subdomain: 'fixture-static-html' };
    const db = {
      getProjectBySubdomain: (sub, cb) => {
        if (sub === 'fixture-static-html') return cb(null, project);
        cb(null, null);
      }
    };
    const mockDocker = new MockDockerManager(createMockDb(), { delay: 10 });

    mockDocker.start(project).then(() => {
      const proxy = new SubdomainProxy(db, mockDocker, config);
      const mw = proxy.middleware();
      const res = mockRes();

      // Host is localhost (proxied), X-Forwarded-Host has the real host
      mw(mockReq('localhost:10001', { 'x-forwarded-host': 'fixture-static-html--jump-sh--dev-mode.jump.sh' }), res, () => {
        assert.fail('next should not be called');
      });

      setTimeout(() => {
        assert.ok(res.body, 'Should have response body');
        assert.ok(res.body.includes('fixture-static-html'), 'Should resolve via forwarded host');
        done();
      }, 50);
    });
  });

  it('non-dev mode routes encoded host to context project (suffix match)', (t, done) => {
    const contextProject = { id: 2, name: 'jump-sh--dev-mode', subdomain: 'jump-sh--dev-mode' };
    const db = {
      getProjectBySubdomain: (sub, cb) => {
        if (sub === 'jump-sh--dev-mode') return cb(null, contextProject);
        cb(null, null);
      }
    };
    // Non-mock docker: no port → 503
    const fakeDocker = { getPort: async () => null };
    const proxy = new SubdomainProxy(db, fakeDocker, config);
    const mw = proxy.middleware();
    const res = mockRes();

    mw(mockReq('fixture-node-npm-vite--jump-sh--dev-mode.jump.sh'), res, () => {});

    setTimeout(() => {
      // Context project found but not running → 503
      assert.equal(res.statusCode, 503);
      done();
    }, 50);
  });

  it('resolves shortened context alias to context project in non-dev middleware', (t, done) => {
    const targetProject = { id: 1, name: 'power-slides', subdomain: 'power-slides' };
    const contextProject = {
      id: 2,
      name: 'kamajiremote-first-starter-copy-1511450237200236627',
      subdomain: 'kamajiremote-first-starter-copy-1511450237200236627',
    };
    const alias = encodeContextHost(targetProject.subdomain, contextProject.subdomain);
    let routedProject = null;
    const db = {
      getProjectBySubdomain: (sub, cb) => {
        if (sub === contextProject.subdomain) return cb(null, contextProject);
        cb(null, null);
      },
      getAllProjectsIncludingWorktrees: (cb) => cb(null, [targetProject, contextProject]),
    };
    const fakeDocker = {
      getPort: async (project) => {
        routedProject = project;
        return null;
      },
    };
    const proxy = new SubdomainProxy(db, fakeDocker, config);
    const mw = proxy.middleware();
    const res = mockRes();

    assert.ok(alias.length <= DNS_LABEL_MAX_LENGTH);
    mw(mockReq(`${alias}.jump.sh`), res, () => {});

    setTimeout(() => {
      assert.equal(routedProject?.id, contextProject.id);
      assert.equal(res.statusCode, 503);
      done();
    }, 50);
  });

  it('prioritizes shortened alias before generic hash-like suffix matches in middleware', (t, done) => {
    const targetProject = { id: 1, name: 'power-slides', subdomain: 'power-slides' };
    const contextProject = {
      id: 2,
      name: 'kamajiremote-first-starter-copy-1511450237200236627',
      subdomain: 'kamajiremote-first-starter-copy-1511450237200236627',
    };
    const alias = encodeContextHost(targetProject.subdomain, contextProject.subdomain);
    const hashSubdomain = alias.slice(alias.lastIndexOf('--') + 2);
    const hashLikeProject = { id: 3, name: hashSubdomain, subdomain: hashSubdomain };
    const lookups = [];
    let routedProject = null;
    const db = {
      getProjectBySubdomain: (sub, cb) => {
        lookups.push(sub);
        if (sub === contextProject.subdomain) return cb(null, contextProject);
        if (sub === hashLikeProject.subdomain) return cb(null, hashLikeProject);
        cb(null, null);
      },
      getAllProjectsIncludingWorktrees: (cb) => cb(null, [targetProject, contextProject, hashLikeProject]),
    };
    const fakeDocker = {
      getPort: async (project) => {
        routedProject = project;
        return null;
      },
    };
    const proxy = new SubdomainProxy(db, fakeDocker, config);
    const mw = proxy.middleware();
    const res = mockRes();

    assert.equal(getContextHostMetadata(targetProject.subdomain, contextProject.subdomain).isShortened, true);
    mw(mockReq(`${alias}.jump.sh`), res, () => {});

    setTimeout(() => {
      assert.equal(routedProject?.id, contextProject.id);
      assert.equal(res.statusCode, 503);
      assert.ok(!lookups.includes(hashSubdomain), 'generic hash-suffix split should not run first');
      done();
    }, 50);
  });

  it('resolves shortened context alias to context project in websocket upgrades', (t, done) => {
    const targetProject = { id: 1, name: 'power-slides', subdomain: 'power-slides' };
    const contextProject = {
      id: 2,
      name: 'kamajiremote-first-starter-copy-1511450237200236627',
      subdomain: 'kamajiremote-first-starter-copy-1511450237200236627',
    };
    const alias = encodeContextHost(targetProject.subdomain, contextProject.subdomain);
    const hashSubdomain = alias.slice(alias.lastIndexOf('--') + 2);
    const hashLikeProject = { id: 3, name: hashSubdomain, subdomain: hashSubdomain };
    const db = {
      getProjectBySubdomain: (sub, cb) => {
        if (sub === contextProject.subdomain) return cb(null, contextProject);
        if (sub === hashLikeProject.subdomain) return cb(null, hashLikeProject);
        cb(null, null);
      },
      getAllProjectsIncludingWorktrees: (cb) => cb(null, [targetProject, contextProject, hashLikeProject]),
    };
    const fakeDocker = { getPort: async () => 3210 };
    const proxy = new SubdomainProxy(db, fakeDocker, config);
    const server = new EventEmitter();
    const socket = { destroy: () => assert.fail('socket should not be destroyed') };
    let upgradedProject = null;

    proxy.getOrCreateProxy = (port, project) => ({
      upgrade: () => {
        assert.equal(port, 3210);
        upgradedProject = project;
      },
    });
    proxy.attachUpgrade(server);
    server.emit('upgrade', { headers: { host: `${alias}.jump.sh` } }, socket, Buffer.alloc(0));

    setTimeout(() => {
      assert.equal(upgradedProject?.id, contextProject.id);
      done();
    }, 50);
  });

  it('keeps generic split precedence for normal non-shortened context labels', (t, done) => {
    const firstSuffixContext = { id: 2, name: 'ctx--extra', subdomain: 'ctx--extra' };
    const laterSuffixContext = { id: 3, name: 'extra', subdomain: 'extra' };
    const misleadingNormalPairTarget = { id: 4, name: 'my-app--ctx', subdomain: 'my-app--ctx' };
    let routedProject = null;
    const db = {
      getProjectBySubdomain: (sub, cb) => {
        if (sub === firstSuffixContext.subdomain) return cb(null, firstSuffixContext);
        if (sub === laterSuffixContext.subdomain) return cb(null, laterSuffixContext);
        cb(null, null);
      },
      getAllProjectsIncludingWorktrees: (cb) => cb(null, [misleadingNormalPairTarget, laterSuffixContext, firstSuffixContext]),
    };
    const fakeDocker = {
      getPort: async (project) => {
        routedProject = project;
        return null;
      },
    };
    const proxy = new SubdomainProxy(db, fakeDocker, config);
    const mw = proxy.middleware();
    const res = mockRes();

    assert.equal(getContextHostMetadata('my-app--ctx', 'extra').isShortened, false);
    mw(mockReq('my-app--ctx--extra.jump.sh'), res, () => {});

    setTimeout(() => {
      assert.equal(routedProject?.id, firstSuffixContext.id);
      assert.equal(res.statusCode, 503);
      done();
    }, 50);
  });

  it('normal subdomain routing is unchanged', (t, done) => {
    const fixturePath = path.join(fixturesDir, 'node-npm-vite');
    const project = { id: 1, name: 'fixture-node-npm-vite', path: fixturePath, subdomain: 'fixture-node-npm-vite' };
    const db = {
      getProjectBySubdomain: (sub, cb) => {
        if (sub === 'fixture-node-npm-vite') return cb(null, project);
        cb(null, null);
      }
    };
    const mockDocker = new MockDockerManager(createMockDb(), { delay: 10 });

    mockDocker.start(project).then(() => {
      const proxy = new SubdomainProxy(db, mockDocker, config);
      const mw = proxy.middleware();
      const res = mockRes();

      // Normal (non-encoded) subdomain
      mw(mockReq('fixture-node-npm-vite.jump.sh'), res, () => {
        assert.fail('next should not be called');
      });

      setTimeout(() => {
        assert.ok(res.body, 'Should have response body');
        assert.ok(res.body.includes('fixture-node-npm-vite'), 'Direct subdomain still works');
        done();
      }, 50);
    });
  });

  it('fallback to 404 when decode fails', (t, done) => {
    const db = { getProjectBySubdomain: (sub, cb) => cb(null, null) };
    const fakeDocker = { getPort: async () => null };
    const proxy = new SubdomainProxy(db, fakeDocker, config);
    const mw = proxy.middleware();
    const res = mockRes();

    mw(mockReq('unknown--nonsense.jump.sh'), res, () => {});

    setTimeout(() => {
      assert.equal(res.statusCode, 404);
      done();
    }, 50);
  });

  it('non-dev mode does not try prefix decode (only suffix)', (t, done) => {
    // Project exists as a local subdomain but docker is NOT mock
    const project = { id: 1, name: 'my-app', subdomain: 'my-app' };
    const context = { id: 2, name: 'ctx', subdomain: 'ctx' };
    const lookups = [];
    const db = {
      getProjectBySubdomain: (sub, cb) => {
        lookups.push(sub);
        if (sub === 'my-app') return cb(null, project);
        if (sub === 'ctx') return cb(null, context);
        cb(null, null);
      }
    };
    // Non-mock docker
    const fakeDocker = { getPort: async () => null };
    const proxy = new SubdomainProxy(db, fakeDocker, config);
    const mw = proxy.middleware();
    const res = mockRes();

    mw(mockReq('my-app--ctx.jump.sh'), res, () => {});

    setTimeout(() => {
      // Should NOT have looked up 'my-app' as prefix (isMock is false)
      // First lookup: 'my-app--ctx' (direct, fails)
      // Then decode: skip prefix (not isMock), try suffix 'ctx' → found
      assert.ok(!lookups.includes('my-app'), 'Should not try prefix in non-dev mode');
      assert.ok(lookups.includes('ctx'), 'Should try suffix as context');
      // ctx project found but no port → 503
      assert.equal(res.statusCode, 503);
      done();
    }, 50);
  });
});
