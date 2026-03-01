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
      
      // Skip if this is the main localhaus domain
      if (this.isMainDomain(subdomain)) return next();

      // Find project by subdomain
      this.db.getProjectBySubdomain(subdomain, async (err, project) => {
        if (err || !project) {
          return res.status(404).send(`
            <html>
              <head><title>Project Not Found</title></head>
              <body style="font-family: system-ui; padding: 40px; text-align: center;">
                <h1>404 - Project Not Found</h1>
                <p>No project registered for subdomain: <strong>${subdomain}</strong></p>
                <a href="http://${this.config.domain}:${this.config.port}">← Back to Localhaus</a>
              </body>
            </html>
          `);
        }

        // Get the container's port
        const port = await this.docker.getPort(project);
        if (!port) {
          return res.status(503).send(`
            <html>
              <head><title>Project Not Running</title></head>
              <body style="font-family: system-ui; padding: 40px; text-align: center;">
                <h1>503 - Project Not Running</h1>
                <p><strong>${project.name}</strong> is not currently running.</p>
                <a href="http://${this.config.domain}:${this.config.port}/projects/${project.id}">Start Project</a>
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

  extractSubdomain(host) {
    // Remove port if present
    const hostWithoutPort = host.split(':')[0];
    const parts = hostWithoutPort.split('.');
    
    // For localhost-style domains (project.localhost)
    if (parts.length >= 2) {
      return parts[0];
    }
    
    return null;
  }

  isMainDomain(subdomain) {
    return subdomain === 'localhaus' || 
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
