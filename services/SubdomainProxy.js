import { createProxyMiddleware } from 'http-proxy-middleware';

class SubdomainProxy {
  constructor(db, docker, config) {
    this.db = db;
    this.docker = docker;
    this.config = config;
    this.proxyCache = new Map();
  }

  middleware() {
    return async (req, res, next) => {
      const host = req.get('host');
      if (!host) return next();

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
        const proxy = this.getOrCreateProxy(port, project);
        return proxy(req, res, next);
      });
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

  getOrCreateProxy(port, project = null) {
    const cacheKey = `port-${port}`;
    
    if (!this.proxyCache.has(cacheKey)) {
      const projectName = project?.name || 'unknown';
      const proxy = createProxyMiddleware({
        target: `http://localhost:${port}`,
        changeOrigin: true,
        ws: true,
        logLevel: 'silent',
        onError: (err, req, res) => {
          console.error(`Proxy error for ${projectName} (port ${port}):`, err.message);
          if (!res.headersSent) {
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
            res.status(502).send(errorHtml);
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
