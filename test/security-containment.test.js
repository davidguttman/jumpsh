import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureManagementToken,
  managementAccessLines,
  managementAuth,
  managementTokenPath,
  MANAGEMENT_USER,
} from '../lib/management-auth.js';
import { classifyHost } from '../lib/host-classification.js';
import { callDaemon, daemonBaseUrl } from '../lib/commands/_helpers.js';
import { detectDashboardHost, formatDashUrl } from '../lib/domain.js';
import { generateCompose } from '../services/ComposeGenerator.js';
import DockerManager, { writeJumpComposeOverride } from '../services/DockerManager.js';

function req(headers = {}, extra = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method: 'GET',
    headers: normalized,
    get(name) { return normalized[name.toLowerCase()]; },
    ...extra,
  };
}

function res() {
  const headers = {};
  return {
    statusCode: 200,
    body: null,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    send(value) { this.body = value; return this; },
    get headers() { return headers; },
  };
}

function authenticate(auth, request) {
  let passed = false;
  const response = res();
  auth(request, response, () => { passed = true; });
  return { passed, response };
}

describe('management containment auth', () => {
  let home;
  let token;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-token-'));
    token = ensureManagementToken({ homeDir: home });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('creates and preserves a random token with private permissions', () => {
    const stateDir = path.join(home, '.jump.sh');
    const tokenPath = path.join(stateDir, 'management-token');
    assert.equal(managementTokenPath(home), tokenPath);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);

    fs.chmodSync(stateDir, 0o755);
    fs.chmodSync(tokenPath, 0o644);
    assert.equal(ensureManagementToken({ homeDir: home }), token);
    assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
  });

  it('creates different tokens for independent installations', () => {
    const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-token-other-'));
    try {
      assert.notEqual(ensureManagementToken({ homeDir: otherHome }), token);
    } finally {
      fs.rmSync(otherHome, { recursive: true, force: true });
    }
  });

  it('is ensured by both install and daemon startup for installs and upgrades', () => {
    const installSource = fs.readFileSync(new URL('../lib/commands/install.js', import.meta.url), 'utf8');
    const openSource = fs.readFileSync(new URL('../lib/commands/open.js', import.meta.url), 'utf8');
    const serverSource = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    assert.match(installSource, /ensureManagementToken\(\)/u);
    assert.match(installSource, /managementAccessLines\(\)/u);
    assert.match(openSource, /managementAccessLines\(\)/u);
    assert.match(serverSource, /ensureManagementToken\(\)/u);
  });

  it('prints only the browser username and token-file location', () => {
    const lines = managementAccessLines(home);
    assert.deepEqual(lines, [
      `Dashboard username: ${MANAGEMENT_USER}`,
      `Dashboard password: read ${managementTokenPath(home)}`,
    ]);
    assert.equal(lines.some(line => line.includes(token)), false);
    assert.equal(lines.some(line => /https?:\/\/[^\s]*@/u.test(line)), false);
  });

  it('denies unauthenticated dashboard, API, static, log, SSE and mutation requests', () => {
    const auth = managementAuth({ token, dashboardOrigin: 'https://dash.jump.sh' });
    for (const route of ['/', '/api/projects', '/styles.css', '/projects/1/logs', '/projects/1/logs/stream', '/projects/1/startup', '/projects']) {
      const { passed, response } = authenticate(auth, req({}, { url: route, method: route === '/projects' ? 'POST' : 'GET' }));
      assert.equal(passed, false, route);
      assert.equal(response.statusCode, 401, route);
      assert.match(response.headers['www-authenticate'], /^Basic /u);
    }
  });

  it('accepts valid bearer and Basic credentials, and rejects bad credentials', () => {
    const auth = managementAuth({ token, dashboardOrigin: 'https://dash.jump.sh' });
    for (const authorization of [
      `Bearer ${token}`,
      `Basic ${Buffer.from(`${MANAGEMENT_USER}:${token}`).toString('base64')}`,
    ]) {
      assert.equal(authenticate(auth, req({ authorization })).passed, true);
    }

    for (const authorization of [
      'Bearer wrong',
      `Basic ${Buffer.from(`other:${token}`).toString('base64')}`,
      `Basic ${Buffer.from(`${MANAGEMENT_USER}:wrong`).toString('base64')}`,
    ]) {
      const { passed, response } = authenticate(auth, req({ authorization }));
      assert.equal(passed, false);
      assert.equal(response.statusCode, 401);
    }
  });

  it('requires the exact dashboard Origin or Referer for Basic mutations and exempts bearer', () => {
    const dashboardOrigin = 'https://dash.jump.sh';
    const auth = managementAuth({ token, dashboardOrigin });
    const basic = `Basic ${Buffer.from(`${MANAGEMENT_USER}:${token}`).toString('base64')}`;

    for (const headers of [
      { authorization: basic },
      { authorization: basic, origin: 'https://dash.jump.sh.evil.test' },
      { authorization: basic, referer: 'https://dash.jump.sh.evil.test/projects/1' },
      { authorization: basic, origin: 'https://evil.test', referer: 'https://dash.jump.sh/projects/1' },
    ]) {
      const { passed, response } = authenticate(auth, req(headers, { method: 'POST' }));
      assert.equal(passed, false);
      assert.equal(response.statusCode, 403);
    }

    assert.equal(authenticate(auth, req({ authorization: basic, origin: dashboardOrigin }, { method: 'POST' })).passed, true);
    assert.equal(authenticate(auth, req({ authorization: basic, referer: `${dashboardOrigin}/projects/1` }, { method: 'POST' })).passed, true);
    assert.equal(authenticate(auth, req({ authorization: `Bearer ${token}` }, { method: 'POST' })).passed, true);
  });
});

describe('strict host classification', () => {
  const config = { domain: 'alice.jump.sh', dashboardHost: 'dash.alice.jump.sh' };

  it('accepts only the exact dashboard host and one valid project label', () => {
    assert.deepEqual(classifyHost('dash.alice.jump.sh', config), { kind: 'management' });
    assert.deepEqual(classifyHost('DASH.ALICE.JUMP.SH:4443', config), { kind: 'management' });
    assert.deepEqual(classifyHost('app.alice.jump.sh', config), { kind: 'project', label: 'app' });
    assert.deepEqual(classifyHost('dashboard.alice.jump.sh', config), { kind: 'project', label: 'dashboard' });
  });

  it('rejects unrelated, malformed, multi-label and suffix-confused hosts', () => {
    for (const host of [
      'dash.alice.jump.sh.evil.test',
      'alice.jump.sh',
      'a.b.alice.jump.sh',
      '-bad.alice.jump.sh',
      'bad-.alice.jump.sh',
      'd%61sh.alice.jump.sh',
      'user@dash.alice.jump.sh',
      'dash.alice.jump.sh:0',
      'dash.alice.jump.sh:65536',
      'dash.alice.jump.sh.',
      'localhost',
    ]) {
      assert.equal(classifyHost(host, config).kind, 'invalid', host);
    }
  });
});

describe('custom dashboard host URLs', () => {
  it('uses JUMPSH_DASHBOARD_HOST for centralized dashboard URL formatting', () => {
    const env = { JUMPSH_DASHBOARD_HOST: 'control.example.test' };
    assert.equal(detectDashboardHost('alice.jump.sh', env), 'control.example.test');
    assert.equal(formatDashUrl('alice.jump.sh', 443, 'https', env), 'https://control.example.test');
    assert.equal(formatDashUrl('alice.jump.sh', 4443, 'https', env), 'https://control.example.test:4443');
  });

  it('uses the custom host in daemonBaseUrl', () => {
    const oldHost = process.env.JUMPSH_DASHBOARD_HOST;
    process.env.JUMPSH_DASHBOARD_HOST = 'control.example.test';
    try {
      assert.equal(daemonBaseUrl().base, 'https://control.example.test');
    } finally {
      if (oldHost === undefined) delete process.env.JUMPSH_DASHBOARD_HOST;
      else process.env.JUMPSH_DASHBOARD_HOST = oldHost;
    }
  });

  it('routes daemon, open, status, install, upgrade and registration formatting through the helper', () => {
    const helpersSource = fs.readFileSync(new URL('../lib/commands/_helpers.js', import.meta.url), 'utf8');
    const openSource = fs.readFileSync(new URL('../lib/commands/open.js', import.meta.url), 'utf8');
    const statusSource = fs.readFileSync(new URL('../lib/commands/status.js', import.meta.url), 'utf8');
    const installSource = fs.readFileSync(new URL('../lib/commands/install.js', import.meta.url), 'utf8');
    const upgradeSource = fs.readFileSync(new URL('../lib/commands/upgrade.js', import.meta.url), 'utf8');
    const registerSource = fs.readFileSync(new URL('../lib/commands/register.js', import.meta.url), 'utf8');

    assert.match(helpersSource, /detectDashboardHost\(domain\)/u);
    for (const source of [openSource, statusSource, installSource, upgradeSource, registerSource]) {
      assert.match(source, /formatDashUrl\(/u);
    }
  });
});

describe('CLI auth and port containment', () => {
  it('automatically adds bearer auth to daemon calls', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-cli-token-'));
    const token = 'test-management-token-that-is-long-enough-123';
    const stateDir = path.join(home, '.jump.sh');
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, 'management-token'), `${token}\n`, { mode: 0o600 });
    const oldHome = process.env.HOME;
    const oldFetch = globalThis.fetch;
    process.env.HOME = home;
    let authorization;
    globalThis.fetch = async (_url, init) => {
      authorization = init.headers.Authorization;
      return { ok: true, text: async () => '{}' };
    };
    try {
      await callDaemon('/api/projects', { method: 'GET' });
      assert.equal(authorization, `Bearer ${token}`);
    } finally {
      globalThis.fetch = oldFetch;
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('binds generated published ports to loopback', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-compose-home-'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-compose-project-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const generated = generateCompose(project, 'secure-app', {
        type: 'static', framework: null, port: 80, dockerImage: 'nginx:alpine',
      }, 10042, { force: true });
      const compose = fs.readFileSync(generated.composePath, 'utf8');
      assert.match(compose, /127\.0\.0\.1:10042:80/u);
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('binds jump-owned user-compose overrides to loopback', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-override-home-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const overridePath = writeJumpComposeOverride(
        { name: 'secure app', subdomain: 'secure-app' },
        { serviceName: 'web', assignedPort: 10043, internalPort: 3000, replacePorts: true },
      );
      const compose = fs.readFileSync(overridePath, 'utf8');
      assert.match(compose, /ports: !override/u);
      assert.match(compose, /host_ip: 127\.0\.0\.1/u);
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('preserves user-owned compose port mappings for main projects', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-user-compose-home-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-user-compose-project-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const composePath = path.join(projectDir, 'docker-compose.yml');
    const original = 'services:\n  app:\n    ports:\n      - "0.0.0.0:9000:3000"\n';
    fs.writeFileSync(composePath, original);
    try {
      const docker = new DockerManager(null);
      docker._selectComposeService = async () => 'app';
      docker._inspectComposeService = async () => ({ found: true, hasPublishedPorts: true, internalPort: 3000 });
      const result = await docker._prepareUserComposeRuntime({
        id: 1,
        name: 'user-app',
        subdomain: 'user-app',
        path: projectDir,
      }, composePath, null);
      assert.deepEqual(result, { composePath });
      assert.equal(fs.readFileSync(composePath, 'utf8'), original);
      assert.equal(fs.existsSync(path.join(home, '.jump.sh', 'user-app', 'docker-compose.jump.yml')), false);
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
