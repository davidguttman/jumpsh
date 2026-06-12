import { createProxyMiddleware } from 'http-proxy-middleware';
import http from 'node:http';
import { detectProjectType } from './ProjectDetector.js';
import { getContextHostMetadata } from '../lib/context-host.js';

const SHORTENED_CONTEXT_ALIAS_RE = /--[a-f0-9]{16}$/u;

/**
 * Decode an encoded context-host label.
 * e.g. "fixture-node-npm-vite--jump-sh--dev-mode"
 * Tries each '--' boundary from left to right and returns candidates.
 */
function decodeContextHostCandidates(label) {
  const candidates = [];
  let idx = 0;
  while (true) {
    const pos = label.indexOf('--', idx);
    if (pos === -1 || pos === 0) break;
    const prefix = label.slice(0, pos);
    const suffix = label.slice(pos + 2);
    if (suffix) candidates.push({ projectSubdomain: prefix, contextSubdomain: suffix });
    idx = pos + 1;
  }
  return candidates;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

class SubdomainProxy {
  constructor(db, docker, config) {
    this.db = db;
    this.docker = docker;
    this.config = config;
    this.proxyCache = new Map();
    this.autoStartPromises = new Map();
    this.autoStartFailures = new Map();
  }

  middleware() {
    return async (req, res, next) => {
      const host = req.get('host');
      if (!host) return next();

      let subdomain = this.extractSubdomain(host);

      // Fallback to X-Forwarded-Host when Host doesn't yield a subdomain
      // (e.g., behind a reverse proxy with changeOrigin: true)
      if (!subdomain || subdomain === 'localhost') {
        const fwdHost = req.get('x-forwarded-host');
        if (fwdHost) {
          subdomain = this.extractSubdomain(fwdHost);
        }
      }

      if (!subdomain) return next();

      // Skip if this is the main dashboard domain
      if (this.isMainDomain(subdomain)) return next();

      // Find project by subdomain (local routes)
      let project = await new Promise(resolve => {
        this.db.getProjectBySubdomain(subdomain, (err, p) => resolve(err ? null : p));
      });

      // Context-host decode fallback: try splitting on '--'
      if (!project && subdomain.includes('--')) {
        const resolved = await this._resolveEncodedSubdomain(subdomain);
        if (resolved) {
          project = resolved.project;
        }
      }

      if (!project) {
          const homeUrl = this.config.formatUrl(`dashboard.${this.config.domain}`);
          return res.status(404).send(`
            <html>
              <head><title>Project Not Found</title></head>
              <body style="font-family: system-ui; padding: 40px; text-align: center;">
                <h1>404 - Project Not Found</h1>
                <p>No project registered for subdomain: <strong>${subdomain}</strong></p>
                <a href="${homeUrl}">← Back to jump.sh</a>
              </body>
            </html>
          `);
      }

      if (this.isProxyStatusRequest(req)) {
        return this.sendProxyStatus(project, res);
      }

      // Get the container's port
      const port = await this.docker.getPort(project);
      if (!port) {
        await this.ensureProjectStarting(project);
        return this.sendAutoStartInterstitial(project, res);
      }

      const readiness = await this.getReadiness(project, port);
      if (!readiness.ready) {
        return this.sendAutoStartInterstitial(project, res);
      }

      // Mock container: serve placeholder instead of proxying
      if (this.docker.isMock) {
        let detection = {};
        try { detection = detectProjectType(project.path); } catch { /* ignore */ }
        const name = escapeHtml(project.name);
        const type = escapeHtml(detection.type || 'unknown');
        const framework = escapeHtml(detection.framework || 'none');
        const projPath = escapeHtml(project.path);
        return res.send(`<!DOCTYPE html>
<html><head><title>${name} - Mock</title></head>
<body style="font-family: system-ui; padding: 2rem; max-width: 600px; margin: 0 auto;">
  <h1>${name}</h1>
  <p><strong>Mock container running</strong> (dev mode)</p>
  <table style="border-collapse: collapse;">
    <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Type</td><td>${type}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Framework</td><td>${framework}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Path</td><td><code>${projPath}</code></td></tr>
    <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Port</td><td>${port}</td></tr>
  </table>
</body></html>`);
      }

      // Get or create proxy for this port
      const proxy = this.getOrCreateProxy(port, project);
      return proxy(req, res, next);
    };
  }

  extractSubdomain(host) {
    // Remove port if present
    const hostWithoutPort = host.split(':')[0];
    const parts = hostWithoutPort.split('.');
    
    // For subdomain-style domains (project.jump.sh)
    if (parts.length >= 2) {
      return parts[0];
    }
    
    return null;
  }

  isMainDomain(subdomain) {
    return subdomain === 'dash' ||
           subdomain === 'dashboard' ||
           subdomain === 'www' ||
           subdomain === this.config.domain.split('.')[0];
  }

  getRequestPath(req) {
    const raw = req.originalUrl || req.url || '/';
    try {
      return new URL(raw, 'http://jump.sh').pathname;
    } catch {
      return raw.split('?')[0] || '/';
    }
  }

  isProxyStatusRequest(req) {
    return this.getRequestPath(req) === '/.jump-sh/proxy-status';
  }

  getProjectId(project) {
    return project?.id?.toString();
  }

  isProjectStarting(project) {
    const id = this.getProjectId(project);
    if (!id) return false;
    if (this.autoStartPromises.has(id)) return true;
    if (typeof this.docker.isStarting === 'function') return Boolean(this.docker.isStarting(project));
    return false;
  }

  async markDesiredRunning(project) {
    if (!project?.id) return;
    if (typeof this.db.updateProject === 'function') {
      await new Promise(resolve => {
        this.db.updateProject(project.id, { desired_running: 1 }, () => resolve());
      });
      return;
    }
    if (typeof this.db.setDesiredRunning === 'function') {
      await new Promise(resolve => {
        this.db.setDesiredRunning(project.id, true, () => resolve());
      });
    }
  }

  async ensureProjectStarting(project) {
    const id = this.getProjectId(project);
    if (!id || this.isProjectStarting(project) || typeof this.docker.start !== 'function') return;

    this.autoStartFailures.delete(id);
    this.autoStartPromises.set(id, Promise.resolve());

    await this.markDesiredRunning(project);

    let startPromise;
    try {
      startPromise = Promise.resolve(this.docker.start(project));
    } catch (err) {
      startPromise = Promise.reject(err);
    }

    this.autoStartPromises.set(id, startPromise);
    startPromise
      .then(result => {
        if (result?.success === false && !result.alreadyStarting) {
          this.autoStartFailures.set(id, result.error || 'Project failed to start');
        }
      })
      .catch(err => {
        this.autoStartFailures.set(id, err?.message || 'Project failed to start');
      })
      .finally(() => {
        this.autoStartPromises.delete(id);
      });
  }

  getDashboardUrl(project) {
    return this.config.formatUrl(`dashboard.${this.config.domain}`, `/projects/${project.id}`);
  }

  getProjectHealth(project, port) {
    if (typeof this.docker.getHealth !== 'function') {
      return port ? 'healthy' : 'unknown';
    }

    const rawHealth = this.docker.getHealth(project.id) || 'unknown';
    if (rawHealth === 'unknown' && port && typeof this.docker.getHealthWithProbe === 'function') {
      return this.docker.getHealthWithProbe(project, { running: true, port }) || 'starting';
    }
    return rawHealth;
  }

  async isHttpTargetReady(port, { timeoutMs = 750 } = {}) {
    if (!port) return false;

    return new Promise(resolve => {
      let settled = false;
      const done = (ready) => {
        if (settled) return;
        settled = true;
        resolve(ready);
      };

      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          Connection: 'close',
          'User-Agent': 'jump.sh-readiness-probe',
        },
      }, response => {
        response.resume();
        done(true);
      });

      req.on('timeout', () => {
        req.destroy();
        done(false);
      });
      req.on('error', () => done(false));
      req.end();
    });
  }

  async getReadiness(project, port) {
    const health = this.getProjectHealth(project, port);
    if (!port) return { ready: false, health };
    if (this.docker.isMock) return { ready: true, health: 'healthy' };
    if (typeof this.docker.getHealth !== 'function') return { ready: true, health };
    if (health !== 'healthy') return { ready: false, health };

    return {
      ready: await this.isHttpTargetReady(port),
      health,
    };
  }

  async sendProxyStatus(project, res) {
    const id = this.getProjectId(project);
    const port = await this.docker.getPort(project);
    const readiness = await this.getReadiness(project, port);
    const health = readiness.health;
    const dashboardUrl = this.getDashboardUrl(project);

    if (port && readiness.ready) {
      return res.json({ running: true, starting: false, port });
    }

    if (port && health === 'unhealthy') {
      return res.status(500).json({
        running: false,
        starting: false,
        port,
        health,
        error: 'Project is unhealthy',
        dashboardUrl,
      });
    }

    const error = this.autoStartFailures.get(id);
    if (error) {
      return res.status(500).json({
        running: false,
        starting: false,
        error,
        dashboardUrl,
      });
    }

    const step = typeof this.docker.getStartupStep === 'function'
      ? this.docker.getStartupStep(project.id)
      : null;

    if (port) {
      return res.json({
        running: false,
        starting: true,
        port,
        health,
        step,
        dashboardUrl,
      });
    }

    return res.json({
      running: false,
      starting: this.isProjectStarting(project),
      step,
      dashboardUrl,
    });
  }

  sendAutoStartInterstitial(project, res) {
    const projectName = escapeHtml(project.name);
    const dashboardUrl = this.getDashboardUrl(project);
    const dashboardUrlHtml = escapeHtml(dashboardUrl);
    const statusUrlJson = JSON.stringify('/.jump-sh/proxy-status');
    const dashboardUrlJson = JSON.stringify(dashboardUrl);
    if (typeof res.set === 'function') res.set('Cache-Control', 'no-store');

    return res.status(503).send(`<!DOCTYPE html>
<html>
  <head>
    <title>Starting ${projectName}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root { color-scheme: light dark; }
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: #e2e8f0; }
      main { width: min(520px, calc(100vw - 48px)); padding: 32px; border: 1px solid rgba(148, 163, 184, 0.25); border-radius: 20px; background: rgba(15, 23, 42, 0.82); box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35); }
      h1 { margin: 0 0 12px; font-size: 1.65rem; }
      p { color: #cbd5e1; line-height: 1.5; }
      .spinner { width: 38px; height: 38px; border: 4px solid rgba(148, 163, 184, 0.3); border-top-color: #38bdf8; border-radius: 999px; animation: spin 0.9s linear infinite; margin-bottom: 22px; }
      .progress { height: 10px; border-radius: 999px; background: rgba(148, 163, 184, 0.22); overflow: hidden; margin: 22px 0 10px; }
      .bar { width: 18%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #38bdf8, #22c55e); transition: width 0.25s ease; }
      .error { color: #fecaca; }
      a { color: #7dd3fc; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <main>
      <div class="spinner" aria-hidden="true"></div>
      <h1>Starting ${projectName}</h1>
      <p id="message">jump.sh is starting this project because you opened its subdomain.</p>
      <div class="progress" role="progressbar" aria-label="Startup progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="18">
        <div id="bar" class="bar"></div>
      </div>
      <p id="detail">Loading… this page will reload automatically when the app is ready.</p>
      <p id="fallback"><a href="${dashboardUrlHtml}">Open project dashboard</a></p>
    </main>
    <script>
      const statusUrl = ${statusUrlJson};
      const dashboardUrl = ${dashboardUrlJson};
      const bar = document.getElementById('bar');
      const detail = document.getElementById('detail');
      const message = document.getElementById('message');
      const progress = document.querySelector('[role="progressbar"]');
      let attempts = 0;

      function setProgress(value) {
        const percent = Math.max(18, Math.min(95, value));
        bar.style.width = percent + '%';
        progress.setAttribute('aria-valuenow', String(percent));
      }

      async function poll() {
        attempts += 1;
        try {
          const response = await fetch(statusUrl, { cache: 'no-store' });
          const status = await response.json();

          if (status.running) {
            setProgress(100);
            detail.textContent = 'Ready — reloading…';
            window.location.reload();
            return;
          }

          if (status.error) {
            document.body.classList.add('failed');
            message.textContent = 'jump.sh could not start this project automatically.';
            detail.className = 'error';
            detail.textContent = status.error + ' ';
            detail.appendChild(document.createElement('br'));
            const link = document.createElement('a');
            link.href = status.dashboardUrl || dashboardUrl;
            link.textContent = 'Open the project dashboard';
            detail.appendChild(link);
            detail.appendChild(document.createTextNode(' to inspect logs or start it manually.'));
            return;
          }

          if (status.step && status.step.totalSteps) {
            setProgress((status.step.step / status.step.totalSteps) * 100);
            detail.textContent = status.step.label || 'Starting…';
          } else {
            setProgress(Math.min(90, 18 + attempts * 4));
            detail.textContent = status.starting ? 'Starting…' : 'Waiting for startup to begin…';
          }
        } catch {
          detail.textContent = 'Waiting for jump.sh to report readiness…';
          setProgress(Math.min(90, 18 + attempts * 3));
        }
        setTimeout(poll, 1000);
      }

      poll();
    </script>
  </body>
</html>`);
  }


  attachUpgrade(server) {
    server.on('upgrade', async (req, socket, head) => {
      const host = req.headers.host;
      if (!host) return socket.destroy();

      let subdomain = this.extractSubdomain(host);

      if (!subdomain || subdomain === 'localhost') {
        const fwdHost = req.headers['x-forwarded-host'];
        if (fwdHost) {
          subdomain = this.extractSubdomain(fwdHost);
        }
      }

      if (!subdomain || this.isMainDomain(subdomain)) return socket.destroy();

      let project = await new Promise(resolve => {
        this.db.getProjectBySubdomain(subdomain, (err, p) => resolve(err ? null : p));
      });

      if (!project && subdomain.includes('--')) {
        const resolved = await this._resolveEncodedSubdomain(subdomain);
        if (resolved) project = resolved.project;
      }

      if (!project) return socket.destroy();

      const port = await this.docker.getPort(project);
      if (!port) return socket.destroy();

      const proxy = this.getOrCreateProxy(port, project);
      proxy.upgrade(req, socket, head);
    });
  }

  getOrCreateProxy(port, project = null) {
    const cacheKey = `port-${port}`;
    
    if (!this.proxyCache.has(cacheKey)) {
      const projectName = project?.name || 'unknown';
      const onProxyReq = (proxyReq, req) => {
        // Forward original host so proxied servers can detect context subdomains
        if (req.headers.host) {
          proxyReq.setHeader('x-forwarded-host', req.headers.host);
        }
      };
      const onProxyError = (err, req, res) => {
        console.error(`Proxy error for ${projectName} (port ${port}):`, err.message);
        if (!res || res.headersSent) return;

        const isConnectionRefused = err.code === 'ECONNREFUSED';
        const errorHtml = `
              <html>
                <head><title>502 - Connection Failed</title></head>
                <body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
                  <h1>502 - Connection Failed</h1>
                  <p>Could not connect to <strong>${projectName}</strong> on port ${port}.</p>
                  ${isConnectionRefused ? `
                  <h3>Possible causes:</h3>
                  <ul>
                    <li><strong>Port mismatch</strong> — App may be listening on a different port internally</li>
                    <li><strong>Still starting</strong> — Container may need more time to boot</li>
                    <li><strong>Crashed</strong> — Check container logs for errors</li>
                  </ul>
                  <h3>Debug steps:</h3>
                  <pre style="background: #f5f5f5; padding: 10px; overflow-x: auto;"># Check container logs
docker compose -f .jump.sh/docker-compose.yml logs

# Check what port app is listening on
docker compose -f .jump.sh/docker-compose.yml exec app ss -tlnp</pre>
                  ` : `<p>Error: ${err.message}</p>`}
                </body>
              </html>
            `;

        if (typeof res.status === 'function' && typeof res.send === 'function') {
          res.status(502).send(errorHtml);
          return;
        }

        if (typeof res.writeHead === 'function' && typeof res.end === 'function') {
          res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(errorHtml);
        }
      };
      const proxy = createProxyMiddleware({
        target: `http://localhost:${port}`,
        changeOrigin: true,
        logLevel: 'silent',
        on: {
          proxyReq: onProxyReq,
          error: onProxyError,
        },
      });
      this.proxyCache.set(cacheKey, proxy);
    }
    
    return this.proxyCache.get(cacheKey);
  }

  /**
   * Try to resolve an encoded subdomain. Shortened aliases must be checked
   * before generic '--' splits because the hash suffix can itself be a valid
   * project subdomain. Normal, non-shortened labels keep the historical split
   * precedence below.
   */
  async _resolveEncodedSubdomain(subdomain) {
    const shortenedAlias = await this._resolveShortenedContextAlias(subdomain);
    if (shortenedAlias) return shortenedAlias;

    const candidates = decodeContextHostCandidates(subdomain);
    for (const { projectSubdomain, contextSubdomain } of candidates) {
      // Dev mode: try prefix as a local project
      if (this.docker.isMock) {
        const project = await new Promise(resolve => {
          this.db.getProjectBySubdomain(projectSubdomain, (err, p) => resolve(err ? null : p));
        });
        if (project) return { project, isContext: false };
      }

      // Try suffix as context project (proxy through to its container)
      const ctxProject = await new Promise(resolve => {
        this.db.getProjectBySubdomain(contextSubdomain, (err, p) => resolve(err ? null : p));
      });
      if (ctxProject) return { project: ctxProject, isContext: true };
    }

    return null;
  }

  async _getAllProjectsForAliasResolution() {
    const method = typeof this.db.getAllProjectsIncludingWorktrees === 'function'
      ? 'getAllProjectsIncludingWorktrees'
      : 'getAllProjects';

    if (typeof this.db[method] !== 'function') return [];

    return new Promise(resolve => {
      this.db[method]((err, projects) => resolve(err ? [] : (projects || [])));
    });
  }

  async _resolveShortenedContextAlias(subdomain) {
    if (!SHORTENED_CONTEXT_ALIAS_RE.test(subdomain)) return null;

    const projects = await this._getAllProjectsForAliasResolution();
    const withSubdomains = projects.filter(project => project?.subdomain);

    for (const targetProject of withSubdomains) {
      for (const contextProject of withSubdomains) {
        const alias = getContextHostMetadata(targetProject.subdomain, contextProject.subdomain);
        if (!alias.isShortened || alias.label !== subdomain) continue;

        if (this.docker.isMock) {
          return { project: targetProject, isContext: false };
        }

        return { project: contextProject, isContext: true };
      }
    }

    return null;
  }

  clearCache() {
    this.proxyCache.clear();
  }
}

export { decodeContextHostCandidates };
export default SubdomainProxy;
