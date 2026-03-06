import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocket } from 'ws';
import getPort from 'get-port';
import SubdomainProxy from '../services/SubdomainProxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures/apps/node-npm-vite');

function httpGet(port, urlPath, host) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: urlPath, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

describe('Vite HMR through SubdomainProxy', () => {
  let viteProcess, vitePort;
  let proxyServer, proxyPort;
  let subdomainProxy;

  before(async () => {
    vitePort = await getPort();
    proxyPort = await getPort();

    // Start real Vite dev server from fixture
    viteProcess = spawn('npx', ['vite', '--port', String(vitePort), '--strictPort'], {
      cwd: FIXTURE_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Vite startup timeout')), 15000);
      let output = '';
      const onData = (data) => {
        output += data.toString();
        if (output.includes('Local:') || output.includes('ready in')) {
          clearTimeout(timeout);
          resolve();
        }
      };
      viteProcess.stdout.on('data', onData);
      viteProcess.stderr.on('data', onData);
      viteProcess.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Vite exited with code ${code}: ${output}`));
      });
    });

    // Set up proxy server
    const config = {
      port: proxyPort,
      domain: 'test.local',
      https: false,
      formatUrl: (host, p) => `http://${host}${p || ''}`,
    };

    const project = { id: 1, name: 'vite-app', subdomain: 'vite-app', path: FIXTURE_DIR };
    const db = {
      getProjectBySubdomain: (sub, cb) =>
        sub === 'vite-app' ? cb(null, project) : cb(null, null),
    };
    const docker = { getPort: async () => vitePort, isMock: false };

    subdomainProxy = new SubdomainProxy(db, docker, config);
    const app = express();
    app.use(subdomainProxy.middleware());

    proxyServer = http.createServer(app);
    subdomainProxy.attachUpgrade(proxyServer);
    await new Promise((resolve) => proxyServer.listen(proxyPort, resolve));
  });

  after(async () => {
    if (viteProcess) {
      viteProcess.kill();
      await new Promise((resolve) => viteProcess.on('exit', resolve));
    }
    if (proxyServer) {
      await new Promise((resolve) => proxyServer.close(resolve));
    }
  });

  it('serves Vite page through proxy', async () => {
    const { statusCode, body } = await httpGet(proxyPort, '/', 'vite-app.test.local');
    assert.equal(statusCode, 200);
    assert.ok(body.includes('Fixture Vite'), 'should contain page title');
  });

  it('proxies WebSocket upgrade for HMR', async () => {
    const ws = new WebSocket(`ws://localhost:${proxyPort}/`, ['vite-hmr'], {
      headers: { host: 'vite-app.test.local' },
    });

    // Connection must open
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', (err) => reject(new Error(`WebSocket error: ${err.message}`)));
      setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000);
    });

    // Must stay open for 3 seconds (no reload-triggering disconnects)
    let closeCount = 0;
    await new Promise((resolve, reject) => {
      ws.on('close', () => {
        closeCount++;
        reject(new Error('WebSocket closed unexpectedly (would trigger reload)'));
      });
      setTimeout(() => {
        ws.close();
        resolve();
      }, 3000);
    });

    assert.equal(closeCount, 0, 'WebSocket should not close during observation period');
  });
});
