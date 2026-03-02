import { createProxyMiddleware } from 'http-proxy-middleware';

class SubdomainProxy {
  constructor(db, docker, config) {
    this.db = db;
    this.docker = docker;
    this.config = config;
    this.proxyCache = new Map();
    this._remoteSyncer = null;
  }

  /**
   * Set the RemoteSyncer instance for remote route lookups.
   */
  setRemoteSyncer(syncer) {
    this._remoteSyncer = syncer;
  }

  middleware() {
    return async (req, res, next) => {
      const host = req.get('host');
      if (!host) return next();

      // Check remote routes first (full hostname match, e.g., "my-app.dmg.jump.sh")
      const remotePort = this._lookupRemoteRoute(host);
      if (remotePort) {
        const proxy = this.getOrCreateProxy(remotePort);
        return proxy(req, res, next);
      }

      const subdomain = this.extractSubdomain(host);
      if (!subdomain) return next();

      // Skip if this is the main dashboard domain
      if (this.isMainDomain(subdomain)) return next();

      // Find project by subdomain (local routes)
      this.db.getProjectBySubdomain(subdomain, async (err, project) => {
        if (err || !project) {
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

        // Get the container's port
        const port = await this.docker.getPort(project);
        if (!port) {
          const projectUrl = this.config.formatUrl(`dashboard.${this.config.domain}`, `/projects/${project.id}`);
          return res.status(503).send(`
            <html>
              <head><title>Project Not Running</title></head>
              <body style="font-family: system-ui; padding: 40px; text-align: center;">
                <h1>503 - Project Not Running</h1>
                <p><strong>${project.name}</strong> is not currently running.</p>
                <a href="${projectUrl}">Start Project</a>
              </body>
            </html>
          `);
        }

        // Get or create proxy for this port
        const proxy = this.getOrCreateProxy(port);
        return proxy(req, res, next);
      });
    };
  }

  /**
   * Look up a remote route by full hostname (e.g., "my-app.dmg.jump.sh").
   * Returns the target port or null.
   */
  _lookupRemoteRoute(host) {
    if (!this._remoteSyncer) return null;
    const hostWithoutPort = host.split(':')[0];
    return this._remoteSyncer.getHostMap().get(hostWithoutPort) || null;
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
    return subdomain === 'dashboard' ||
           subdomain === 'www' ||
           subdomain === this.config.domain.split('.')[0];
  }

  getOrCreateProxy(port) {
    const cacheKey = `port-${port}`;
    
    if (!this.proxyCache.has(cacheKey)) {
      const proxy = createProxyMiddleware({
        target: `http://localhost:${port}`,
        changeOrigin: true,
        ws: true,
        logLevel: 'silent',
        onError: (err, req, res) => {
          console.error(`Proxy error for port ${port}:`, err.message);
          if (!res.headersSent) {
            res.status(502).send('Proxy error - container may still be starting');
          }
        }
      });
      this.proxyCache.set(cacheKey, proxy);
    }
    
    return this.proxyCache.get(cacheKey);
  }

  clearCache() {
    this.proxyCache.clear();
  }
}

export default SubdomainProxy;
