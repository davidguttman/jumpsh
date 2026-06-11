import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { localCertStatus } from '../lib/cert-status.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'jumpsh.js');

async function generateCert(dir, { days = 365, commonName = 'test.jump.sh' } = {}) {
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  await execFileAsync('openssl', [
    'req',
    '-x509',
    '-newkey', 'rsa:2048',
    '-nodes',
    '-keyout', keyPath,
    '-out', certPath,
    '-days', String(days),
    '-subj', `/CN=${commonName}`,
  ]);
  return {
    certPem: fs.readFileSync(certPath, 'utf8'),
    keyPem: fs.readFileSync(keyPath, 'utf8'),
  };
}

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [BIN, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, ...opts.env },
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
    };
  }
}

async function withCertServer(files, fn) {
  const server = http.createServer((req, res) => {
    if (req.url === '/certs/server.pem') {
      res.writeHead(200, { 'Content-Type': 'application/x-pem-file' });
      res.end(files.certPem);
      return;
    }
    if (req.url === '/certs/server-key.pem') {
      res.writeHead(200, { 'Content-Type': 'application/x-pem-file' });
      res.end(files.keyPem);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('local cert lifecycle helper', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-cert-lifecycle-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('classifies missing and malformed local certs as unhealthy', () => {
    assert.deepEqual(localCertStatus({
      certPath: path.join(tmpDir, 'missing-fullchain.pem'),
      keyPath: path.join(tmpDir, 'missing-privkey.pem'),
    }), {
      status: 'missing',
      ready: false,
      expires_at: null,
    });

    const certPath = path.join(tmpDir, 'fullchain.pem');
    const keyPath = path.join(tmpDir, 'privkey.pem');
    fs.writeFileSync(certPath, 'not a certificate');
    fs.writeFileSync(keyPath, 'not a key');

    const status = localCertStatus({ certPath, keyPath });
    assert.equal(status.status, 'malformed');
    assert.equal(status.ready, false);
    assert.equal(status.expires_at, null);
  });

  it('classifies valid certs and exposes expiry', async () => {
    const { certPem, keyPem } = await generateCert(tmpDir);
    const certPath = path.join(tmpDir, 'fullchain.pem');
    const keyPath = path.join(tmpDir, 'privkey.pem');
    fs.writeFileSync(certPath, certPem);
    fs.writeFileSync(keyPath, keyPem);

    const status = localCertStatus({ certPath, keyPath });
    assert.equal(status.status, 'valid');
    assert.equal(status.ready, true);
    assert.match(status.expires_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('classifies mismatched cert and private key pairs as unhealthy', async () => {
    const firstDir = path.join(tmpDir, 'first');
    const secondDir = path.join(tmpDir, 'second');
    fs.mkdirSync(firstDir);
    fs.mkdirSync(secondDir);
    const { certPem } = await generateCert(firstDir);
    const { keyPem } = await generateCert(secondDir);
    const certPath = path.join(tmpDir, 'fullchain.pem');
    const keyPath = path.join(tmpDir, 'privkey.pem');
    fs.writeFileSync(certPath, certPem);
    fs.writeFileSync(keyPath, keyPem);

    const status = localCertStatus({ certPath, keyPath });
    assert.equal(status.status, 'mismatched');
    assert.equal(status.ready, false);
    assert.equal(status.expires_at, null);
  });
});

describe('jump.sh status cert fields', () => {
  let homeDir;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-home-'));
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('includes cert_status and expires_at in --json when local remote certs exist', async () => {
    const certDir = path.join(homeDir, '.jump.sh', 'certs', 'alice');
    fs.mkdirSync(certDir, { recursive: true });
    const { certPem, keyPem } = await generateCert(certDir, { commonName: '*.alice.jump.sh' });
    fs.writeFileSync(path.join(certDir, 'fullchain.pem'), certPem);
    fs.writeFileSync(path.join(certDir, 'privkey.pem'), keyPem);

    const r = runCli(['status', '--json'], { env: { HOME: homeDir } });
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);

    assert.equal(parsed.remote, true);
    assert.equal(parsed.domain, 'alice.jump.sh');
    assert.equal(parsed.cert_status, 'valid');
    assert.match(parsed.expires_at, /^\d{4}-\d{2}-\d{2}T/);
  });
});


describe('jump.sh certs default download validation and atomic writes', () => {
  let homeDir;
  let originalHome;
  let originalOrigin;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-home-'));
    originalHome = process.env.HOME;
    originalOrigin = process.env.JUMPSH_ORIGIN;
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOrigin === undefined) delete process.env.JUMPSH_ORIGIN;
    else process.env.JUMPSH_ORIGIN = originalOrigin;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('rejects invalid default downloads without replacing existing certs or printing success', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-source-cert-'));
    const certsDir = path.join(homeDir, '.jump.sh', 'certs');
    const certPath = path.join(certsDir, 'server.pem');
    const keyPath = path.join(certsDir, 'server-key.pem');
    fs.mkdirSync(certsDir, { recursive: true });
    fs.writeFileSync(certPath, 'existing cert');
    fs.writeFileSync(keyPath, 'existing key');

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      const { keyPem } = await generateCert(sourceDir);
      await withCertServer({ certPem: 'not a certificate', keyPem }, async (origin) => {
        process.env.JUMPSH_ORIGIN = origin;
        const { downloadCerts } = await import(`../lib/commands/certs.js?default-invalid-${Date.now()}`);
        await assert.rejects(
          () => downloadCerts(),
          /failed validation: malformed/i,
        );
      });

      assert.equal(fs.readFileSync(certPath, 'utf8'), 'existing cert');
      assert.equal(fs.readFileSync(keyPath, 'utf8'), 'existing key');
      assert.equal(fs.readdirSync(certsDir).some((name) => name.startsWith('.tmp-download-')), false);
      assert.equal(logs.some((line) => line.includes('Certificates installed successfully')), false);
    } finally {
      console.log = originalLog;
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it('installs valid default downloads only after validation', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-source-cert-'));
    try {
      const { certPem, keyPem } = await generateCert(sourceDir, { commonName: '*.jump.sh' });
      await withCertServer({ certPem, keyPem }, async (origin) => {
        process.env.JUMPSH_ORIGIN = origin;
        const { downloadCerts } = await import(`../lib/commands/certs.js?default-valid-${Date.now()}`);
        await downloadCerts();
      });

      const certsDir = path.join(homeDir, '.jump.sh', 'certs');
      assert.equal(fs.readFileSync(path.join(certsDir, 'server.pem'), 'utf8'), certPem);
      assert.equal(fs.readFileSync(path.join(certsDir, 'server-key.pem'), 'utf8'), keyPem);
      assert.equal(fs.readdirSync(certsDir).some((name) => name.startsWith('.tmp-download-')), false);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});

describe('HTTPS startup cert refresh selection', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-startup-certs-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refreshes a registered user cert instead of the legacy default cert when that cert is unhealthy', async () => {
    const userDir = path.join(tmpDir, 'certs', 'nac');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'fullchain.pem'), 'not a certificate');
    fs.writeFileSync(path.join(userDir, 'privkey.pem'), 'not a private key');

    const calls = [];
    const { ensureHttpsCerts } = await import(`../lib/commands/certs.js?startup-user-refresh-${Date.now()}`);
    const result = await ensureHttpsCerts({
      certsDir: path.join(tmpDir, 'certs'),
      domain: 'nac.jump.sh',
      downloadDefault: async () => calls.push(['default']),
      downloadUser: async (username) => calls.push(['user', username]),
      log: () => {},
    });

    assert.deepEqual(calls, [['user', 'nac']]);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].kind, 'remote');
    assert.equal(result.results[0].username, 'nac');
    assert.equal(result.results[0].before.status, 'malformed');
  });

  it('refreshes a registered user cert when the domain is known but local user cert files are missing', async () => {
    const certsDir = path.join(tmpDir, 'certs');
    fs.mkdirSync(certsDir, { recursive: true });

    const calls = [];
    const { ensureHttpsCerts } = await import(`../lib/commands/certs.js?startup-user-missing-${Date.now()}`);
    const result = await ensureHttpsCerts({
      certsDir,
      domain: 'nac.jump.sh',
      downloadDefault: async () => calls.push(['default']),
      downloadUser: async (username) => calls.push(['user', username]),
      log: () => {},
    });

    assert.deepEqual(calls, [['user', 'nac']]);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].kind, 'remote');
    assert.equal(result.results[0].username, 'nac');
    assert.equal(result.results[0].before.status, 'missing');
  });

  it('preserves legacy default cert download behavior when no registered user is detected', async () => {
    const certsDir = path.join(tmpDir, 'certs');
    fs.mkdirSync(certsDir, { recursive: true });

    const calls = [];
    const { ensureHttpsCerts } = await import(`../lib/commands/certs.js?startup-default-refresh-${Date.now()}`);
    const result = await ensureHttpsCerts({
      certsDir,
      domain: 'jump.sh',
      downloadDefault: async () => calls.push(['default']),
      downloadUser: async (username) => calls.push(['user', username]),
      log: () => {},
    });

    assert.deepEqual(calls, [['default']]);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].kind, 'default');
    assert.equal(result.results[0].before.status, 'missing');
  });

  it('refreshes every unhealthy cert pair the server would serve, and a failed refresh does not block the rest', async () => {
    const certsDir = path.join(tmpDir, 'certs');
    for (const username of ['alice', 'bob']) {
      const userDir = path.join(certsDir, username);
      fs.mkdirSync(userDir, { recursive: true });
      fs.writeFileSync(path.join(userDir, 'fullchain.pem'), 'not a certificate');
      fs.writeFileSync(path.join(userDir, 'privkey.pem'), 'not a private key');
    }
    fs.writeFileSync(path.join(certsDir, 'server.pem'), 'not a certificate');
    fs.writeFileSync(path.join(certsDir, 'server-key.pem'), 'not a private key');

    const calls = [];
    const { ensureHttpsCerts } = await import(`../lib/commands/certs.js?startup-multi-refresh-${Date.now()}`);
    const result = await ensureHttpsCerts({
      certsDir,
      domain: 'alice.jump.sh',
      downloadDefault: async () => calls.push(['default']),
      downloadUser: async (username) => {
        calls.push(['user', username]);
        if (username === 'alice') throw new Error('api unreachable');
      },
      log: () => {},
    });

    assert.deepEqual(calls.sort(), [['default'], ['user', 'alice'], ['user', 'bob']]);
    const alice = result.results.find((r) => r.username === 'alice');
    const bob = result.results.find((r) => r.username === 'bob');
    const fallback = result.results.find((r) => r.kind === 'default');
    assert.equal(alice.error, 'api unreachable');
    assert.equal(bob.error, undefined);
    assert.ok(fallback);
  });
});

describe('downloadCertsForUser cert validation and atomic writes', () => {
  let homeDir;
  let originalHome;
  let originalFetch;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-home-'));
    originalHome = process.env.HOME;
    originalFetch = globalThis.fetch;
    process.env.HOME = homeDir;
    delete process.env.JUMPSH_API;
    delete process.env.JUMPSH_API_ORIGIN;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    globalThis.fetch = originalFetch;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('rejects API responses that are not ready without writing files', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ ready: false, cert_status: 'expired', expires_at: '2026-06-01T00:00:00.000Z' }),
    });

    const { downloadCertsForUser } = await import(`../lib/ssh-register.js?download-reject-${Date.now()}`);
    await assert.rejects(
      () => downloadCertsForUser('alice'),
      /not ready|expired/i,
    );

    assert.equal(fs.existsSync(path.join(homeDir, '.jump.sh', 'certs', 'alice', 'fullchain.pem')), false);
    assert.equal(fs.existsSync(path.join(homeDir, '.jump.sh', 'certs', 'alice', 'privkey.pem')), false);
  });

  it('rejects mismatched API cert/key pairs without writing files', async () => {
    const firstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-source-cert-first-'));
    const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-source-cert-second-'));
    try {
      const { certPem } = await generateCert(firstDir, { commonName: '*.alice.jump.sh' });
      const { keyPem } = await generateCert(secondDir, { commonName: '*.alice.jump.sh' });
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ ready: true, cert_status: 'valid', cert_pem: certPem, key_pem: keyPem }),
      });

      const { downloadCertsForUser } = await import(`../lib/ssh-register.js?download-mismatch-${Date.now()}`);
      await assert.rejects(
        () => downloadCertsForUser('alice'),
        /do not match/i,
      );

      assert.equal(fs.existsSync(path.join(homeDir, '.jump.sh', 'certs', 'alice', 'fullchain.pem')), false);
      assert.equal(fs.existsSync(path.join(homeDir, '.jump.sh', 'certs', 'alice', 'privkey.pem')), false);
    } finally {
      fs.rmSync(firstDir, { recursive: true, force: true });
      fs.rmSync(secondDir, { recursive: true, force: true });
    }
  });

  it('writes valid downloads atomically and returns expiry metadata', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-source-cert-'));
    try {
      const { certPem, keyPem } = await generateCert(sourceDir, { commonName: '*.alice.jump.sh' });
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ ready: true, cert_status: 'valid', cert_pem: certPem, key_pem: keyPem }),
      });

      const { downloadCertsForUser } = await import(`../lib/ssh-register.js?download-valid-${Date.now()}`);
      const result = await downloadCertsForUser('alice');

      assert.equal(result.certDir, path.join(homeDir, '.jump.sh', 'certs', 'alice'));
      assert.equal(result.cert_status, 'valid');
      assert.match(result.expires_at, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(fs.readFileSync(path.join(result.certDir, 'fullchain.pem'), 'utf8'), certPem);
      assert.equal(fs.readFileSync(path.join(result.certDir, 'privkey.pem'), 'utf8'), keyPem);
      assert.equal(fs.readdirSync(result.certDir).some((name) => name.startsWith('.tmp-')), false);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});
