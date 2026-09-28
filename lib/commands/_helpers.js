import { detectDashboardHost, detectDomain, detectPort, detectProtocol } from '../domain.js';
import { readManagementToken } from '../management-auth.js';

export function daemonBaseUrl() {
  const protocol = detectProtocol();
  const port = detectPort();
  const domain = detectDomain();
  const dashboardHost = detectDashboardHost(domain);
  const defaultPort = protocol === 'https' ? 443 : 80;
  const portSuffix = port === defaultPort ? '' : `:${port}`;
  return {
    base: `${protocol}://${dashboardHost}${portSuffix}`,
    protocol,
    port,
    domain,
    portSuffix,
  };
}

export function projectUrl(project) {
  const { protocol, domain, portSuffix } = daemonBaseUrl();
  const sub = project.subdomain || project.name;
  return `${protocol}://${sub}.${domain}${portSuffix}`;
}

export async function resolveProject(db, nameOrSubdomain) {
  if (nameOrSubdomain) {
    const project = await new Promise((resolve, reject) => {
      db.findProject(nameOrSubdomain, (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
    if (!project) {
      const err = new Error(`Project not found: ${nameOrSubdomain}`);
      err.code = 'NOT_FOUND';
      err.exitCode = 3;
      throw err;
    }
    return project;
  }

  const cwd = process.cwd();
  const project = await new Promise((resolve, reject) => {
    db.getProjectByPath(cwd, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
  if (project) return project;

  const err = new Error(
    'No project name given and current directory is not a registered project.'
  );
  err.code = 'NO_PROJECT';
  err.exitCode = 2;
  throw err;
}

export async function callDaemon(pathSuffix, { method = 'POST', body, timeoutMs } = {}) {
  const { base, protocol } = daemonBaseUrl();
  // A dashboard hostname can resolve remotely, even when the CLI runs locally.
  // Reject HTTP discovery before reading or attaching the management token.
  if (protocol !== 'https') {
    const err = new Error('CLI management requires HTTPS. Restore daemon certificates before retrying.');
    err.code = 'INSECURE_MANAGEMENT_TRANSPORT';
    err.exitCode = 1;
    throw err;
  }
  const url = `${base}${pathSuffix}`;
  const controller = timeoutMs ? new globalThis.AbortController() : null;
  let timeout = null;
  const init = {
    method,
    redirect: 'error',
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${readManagementToken()}`,
    },
  };
  if (controller) {
    init.signal = controller.signal;
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
  }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let resp;
  try {
    resp = await fetch(url, init);
  } catch (err) {
    const e = new Error(`Could not connect to jump.sh daemon at ${url}`);
    e.cause = err;
    e.code = 'DAEMON_UNREACHABLE';
    e.exitCode = 1;
    throw e;
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  let parsed = null;
  const text = await resp.text();
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  }

  if (!resp.ok) {
    const e = new Error((parsed && parsed.error) || `Daemon responded ${resp.status}`);
    e.code = (parsed && parsed.code) || `HTTP_${resp.status}`;
    e.status = resp.status;
    e.body = parsed;
    e.exitCode = 1;
    throw e;
  }

  return parsed || {};
}
