import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { launchBrowser } from '../lib/browser.js';
import { callDaemon } from '../lib/commands/_helpers.js';

const browserModule = new URL('../lib/browser.js', import.meta.url).href;

// Run a real Node process so the event loop decides when it exits.
function runScript(source) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000 });
}

describe('browser launch keeps the CLI alive until the result is known', { timeout: 15000 }, () => {
  it('reports a slow launcher failure instead of exiting early', () => {
    const out = runScript(`
      import { spawn } from 'node:child_process';
      import { launchBrowser } from ${JSON.stringify(browserModule)};
      const ok = await launchBrowser('https://x.test', {
        platform: 'linux',
        spawn: (cmd, args, opts) => spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(3), 300)'], opts),
      });
      console.log(ok ? 'launched' : 'fallback');
    `);
    assert.equal(out.trim(), 'fallback');
  });

  it('reports a slow launcher success', () => {
    const out = runScript(`
      import { spawn } from 'node:child_process';
      import { launchBrowser } from ${JSON.stringify(browserModule)};
      const ok = await launchBrowser('https://x.test', {
        platform: 'linux',
        spawn: (cmd, args, opts) => spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 300)'], opts),
      });
      console.log(ok ? 'launched' : 'fallback');
    `);
    assert.equal(out.trim(), 'launched');
  });

  it('does not unref the launcher before it settles, and stops waiting on a blocking launcher', async () => {
    const events = [];
    const child = new EventEmitter();
    child.unref = () => events.push('unref');
    const result = await launchBrowser('https://x.test', {
      platform: 'linux',
      spawn: () => child,
      timeoutMs: 30,
    }).then((ok) => { events.push(`settled:${ok}`); return ok; });
    // A launcher still running after the timeout is treated as a launched browser.
    assert.equal(result, true);
    assert.deepEqual(events, ['unref', 'settled:true']);
  });

  it('does not unref before a fast exit', async () => {
    const events = [];
    const child = new EventEmitter();
    child.unref = () => events.push('unref');
    const pending = launchBrowser('https://x.test', { platform: 'linux', spawn: () => child });
    assert.deepEqual(events, []);
    child.emit('exit', 0);
    assert.equal(await pending, true);
  });
});

describe('daemon call timeout covers the response body', { timeout: 5000 }, () => {
  it('aborts a response whose body stalls', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-stall-'));
    const saved = Object.fromEntries(['HOME', 'JUMPSH_DOMAIN', 'JUMPSH_DASHBOARD_HOST'].map(key => [key, process.env[key]]));
    const oldFetch = globalThis.fetch;
    const stateDir = path.join(home, '.jump.sh');
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, 'management-token'), 'test-management-token-that-is-long-enough-123\n', { mode: 0o600 });
    fs.writeFileSync(path.join(stateDir, 'server.json'), JSON.stringify({ protocol: 'https', port: 4443 }));
    process.env.HOME = home;
    process.env.JUMPSH_DOMAIN = 'example.test';
    process.env.JUMPSH_DASHBOARD_HOST = 'control.example.test';
    globalThis.fetch = async (_url, init) => ({
      ok: true,
      status: 200,
      // Headers arrived; the body never does unless the request is aborted.
      text: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    });
    const started = Date.now();
    try {
      await assert.rejects(callDaemon('/api/login-codes', { method: 'POST', timeoutMs: 50 }), { code: 'DAEMON_TIMEOUT' });
      assert.ok(Date.now() - started < 2000);
    } finally {
      globalThis.fetch = oldFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('management proxy documentation', () => {
  it('requires a direct HTTPS backend for remote browser management and keeps loopback HTTP local-only', () => {
    const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    assert.doesNotMatch(readme, /connect to the daemon over TLS or loopback/u);
    assert.match(readme, /Remote browser management requires the browser to reach the daemon's own HTTPS listener/u);
    assert.match(readme, /loopback HTTP is local-only/iu);
  });
});
