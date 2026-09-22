import { createProxyMiddleware } from 'http-proxy-middleware';
import http from 'node:http';
import { detectProjectType } from './ProjectDetector.js';
import { getContextHostMetadata } from '../lib/context-host.js';
import { classifyHost } from '../lib/host-classification.js';

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
  }

  middleware() {
    return async (req, res, next) => {
      const classified = classifyHost(req.get('host'), this.config);
      if (classified.kind === 'management') return next();
      if (classified.kind !== 'project') return res.status(421).send('Misdirected Request');
      const subdomain = classified.label;

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
        const homeUrl = this.config.formatUrl(this.config.dashboardHost);
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

      // Get the container's port
      const port = await this.docker.getPort(project);
      if (!port) {
        return this.sendUnavailableInterstitial(project, res, false);
      }

      const readiness = await this.getReadiness(project, port);
      if (!readiness.ready) {
        return this.sendUnavailableInterstitial(project, res, true);
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

  getDashboardUrl(project) {
    return this.config.formatUrl(this.config.dashboardHost, `/projects/${project.id}`);
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

  sendUnavailableInterstitial(project, res, starting) {
    const projectName = escapeHtml(project.name);
    const dashboardUrl = this.getDashboardUrl(project);
    const dashboardUrlHtml = escapeHtml(dashboardUrl);
    if (typeof res.set === 'function') res.set('Cache-Control', 'no-store');

    return res.status(503).send(`<!DOCTYPE html>
<html>
  <head>
    <title>${starting ? 'Starting' : 'Unavailable'} ${projectName}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root { color-scheme: light dark; }
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: #e2e8f0; }
      main { width: min(520px, calc(100vw - 48px)); padding: 32px; border: 1px solid rgba(148, 163, 184, 0.25); border-radius: 20px; background: rgba(15, 23, 42, 0.82); box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35); }
      h1 { margin: 0 0 12px; font-size: 1.65rem; }
      p { color: #cbd5e1; line-height: 1.5; }
      a { color: #7dd3fc; }
    </style>
  </head>
  <body>
    <main>
      <h1>${starting ? `${projectName} is starting` : `${projectName} is not running`}</h1>
      <p>Public requests do not start stopped projects. Start it from the authenticated dashboard or CLI.</p>
      <p><a href="${dashboardUrlHtml}">Open project dashboard</a></p>
    </main>
  </body>
</html>`);
  }


  attachUpgrade(server) {
    server.on('upgrade', async (req, socket, head) => {
      const host = req.headers.host;
      if (!host) return socket.destroy();

      const classified = classifyHost(host, this.config);
      if (classified.kind !== 'project') return socket.destroy();
      const subdomain = classified.label;

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
