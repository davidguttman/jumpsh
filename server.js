import dotenv from 'dotenv';
import pkg from './package.json' with { type: 'json' };
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';
import tls from 'tls';
import fs from 'fs';
import os from 'os';

import net from 'net';
import Database from './database.js';
import DockerManager from './services/DockerManager.js';
import MockDockerManager from './services/MockDockerManager.js';
import WorktreeScanner from './services/WorktreeScanner.js';
import SubdomainProxy from './services/SubdomainProxy.js';
import { detectProjectType } from './services/ProjectDetector.js';
import { getJumpshDir } from './services/ComposeGenerator.js';
import { devinfo, deverror, rotateLogs } from './lib/devlog.js';
import { certsExist, downloadCerts } from './lib/commands/certs.js';
import { localCertStatus } from './lib/cert-status.js';
import { checkDockerAvailability } from './services/dockerCommand.js';
import { enrichProjectStatus } from './lib/projectStatus.js';
import {
  autoStartDesiredProjects,
  restartProjectWithWorktrees,
  startProjectWithWorktrees,
  stopProjectWithWorktrees,
} from './lib/desired-running.js';

dotenv.config({ quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve paths with tilde expansion (Node does not expand ~ in env vars)
function resolvePath(p) {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

const certPath = resolvePath(
  process.env.JUMPSH_CERT_PATH || '~/.jump.sh/certs'
);

// Auto-detect domain from cert subdirectories (e.g. certs/username/ → username.jump.sh)
function detectDomainFromCerts() {
  try {
    const entries = fs.readdirSync(certPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subdir = path.join(certPath, entry.name);
      const hasLegacy = fs.existsSync(path.join(subdir, 'server-key.pem')) &&
                        fs.existsSync(path.join(subdir, 'server.pem'));
      const hasNew = fs.existsSync(path.join(subdir, 'privkey.pem')) &&
                     fs.existsSync(path.join(subdir, 'fullchain.pem'));
      if (hasLegacy || hasNew) {
        return `${entry.name}.jump.sh`;
      }
    }
  } catch { /* ignore */ }
  return null;
}

// Detect domain from Host header (strip first label to get base domain)
function detectDomainFromHost(hostname) {
  const host = hostname.replace(/:\d+$/, '');
  // Explicit dashboard prefixes
  for (const prefix of ['dash.', 'dashboard.']) {
    if (host.startsWith(prefix)) {
      return host.slice(prefix.length);
    }
  }
  // For any subdomain host with 3+ labels (e.g. project.user.jump.sh),
  // derive base domain as everything after the first label
  const labels = host.split('.');
  if (labels.length >= 3) {
    return labels.slice(1).join('.');
  }
  return null;
}

// Priority: CLI flag (via env) > Cert detection > Env var default > 'jump.sh'
const domain = process.env.JUMPSH_DOMAIN || detectDomainFromCerts() || 'jump.sh';

// Config
const explicitPort = process.env.JUMPSH_PORT_EXPLICIT === '1' || process.env.JUMPSH_PORT;
const config = {
  port: parseInt(process.env.JUMPSH_PORT, 10) || (process.env.JUMPSH_HTTPS === 'false' ? 80 : 443),
  explicitPort: !!explicitPort,
  domain,
  https: process.env.JUMPSH_HTTPS !== 'false',
  certPath,
  dashboardHost: process.env.JUMPSH_DASHBOARD_HOST || `dash.${domain}`
};

/**
 * Format a URL, omitting the port when it's the default for the protocol
 * (443 for HTTPS, 80 for HTTP).
 */
function formatUrl(host, pathStr = '') {
  const proto = config.https ? 'https' : 'http';
  const defaultPort = config.https ? 443 : 80;
  const portSuffix = config.port === defaultPort ? '' : `:${config.port}`;
  return `${proto}://${host}${portSuffix}${pathStr}`;
}
config.formatUrl = formatUrl;

// Dev mode: explicit opt-in only (JUMPSH_DEV_MODE=true|1, case-insensitive)
const devMode = /^(true|1)$/i.test(process.env.JUMPSH_DEV_MODE || '');
config.devMode = devMode;

// Initialize services
const db = new Database();
const docker = devMode ? new MockDockerManager(db) : new DockerManager(db);
const worktreeScanner = new WorktreeScanner(db, docker);
const subdomainProxy = new SubdomainProxy(db, docker, config);

const app = express();

// Subdomain proxy (must be first)
app.use(subdomainProxy.middleware());

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Per-request domain detection from Host header
app.use((req, res, next) => {
  const hostHeader = req.get('x-forwarded-host') || req.get('host') || '';
  const detected = detectDomainFromHost(hostHeader);
  if (detected && detected !== config.domain) {
    req.requestConfig = { ...config, domain: detected, dashboardHost: `dash.${detected}` };
    req.requestConfig.formatUrl = formatUrl;
  } else {
    req.requestConfig = config;
  }

  // In dev mode, detect context subdomain for encoded project links
  if (devMode) {
    const host = hostHeader.replace(/:\d+$/, '');
    const firstLabel = host.split('.')[0];
    if (firstLabel && firstLabel !== 'dash' && firstLabel !== 'dashboard' && firstLabel !== 'www'
        && firstLabel !== 'localhost' && firstLabel !== req.requestConfig.domain.split('.')[0]) {
      req.requestConfig = { ...req.requestConfig, contextSubdomain: firstLabel };
    }
  }

  // Helper: generate project URL, using encoded context host when applicable
  const rc = req.requestConfig;
  rc.projectUrl = function(projectSubdomain) {
    if (rc.contextSubdomain) {
      return formatUrl(projectSubdomain + '--' + rc.contextSubdomain + '.' + rc.domain);
    }
    return formatUrl(projectSubdomain + '.' + rc.domain);
  };

  next();
});

// ============ Routes ============

// Dashboard
app.get('/', async (req, res) => {
  db.getAllProjectsIncludingWorktrees(async (err, projects) => {
    if (err) {
      console.error('Dashboard DB error:', err.message);
      return res.status(500).send('Database error');
    }

    // Get status for each project
    const projectsWithStatus = await Promise.all(
      (projects || []).map(async (project) => {
        return enrichProjectStatus(docker, project);
      })
    );

    // Separate main projects and worktrees
    const mainProjects = projectsWithStatus.filter(p => !p.is_worktree);
    const worktreesByParent = {};
    for (const p of projectsWithStatus.filter(p => p.is_worktree)) {
      if (!worktreesByParent[p.parent_project_id]) {
        worktreesByParent[p.parent_project_id] = [];
      }
      worktreesByParent[p.parent_project_id].push(p);
    }

    // Pass expandName for client-side auto-expand on load
    const expandName = req.query.expand || null;

    res.render('index', {
      projects: mainProjects,
      worktreesByParent,
      expandName,
      config: req.requestConfig
    });
  });
});

// Add project form
app.get('/add', (req, res) => {
  res.render('add', { config: req.requestConfig, homeDir: os.homedir(), prefillDir: req.query.dir || '' });
});

// Normalize a creation error into { status, error, field?, code? }
function normalizeProjectError(err) {
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('unique constraint') || msg.includes('unique_violation')) {
    if (msg.includes('subdomain')) return { status: 409, error: 'A project with this subdomain already exists. Choose a different name.', field: 'name', code: 'DUPLICATE_SUBDOMAIN' };
    if (msg.includes('name')) return { status: 409, error: 'A project with this name already exists. Choose a different name.', field: 'name', code: 'DUPLICATE_NAME' };
    return { status: 409, error: 'A project with these details already exists.', code: 'DUPLICATE' };
  }
  return { status: 500, error: 'Something went wrong while creating the project. Please try again.', code: 'INTERNAL' };
}

// Create project
app.post('/projects', (req, res) => {
  const { name, path: projectPath, description, override_build_command, override_start_command, override_port, override_docker_image, override_env } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json') || req.headers['content-type']?.includes('application/json');

  if (!name || !projectPath) {
    if (wantsJson) return res.status(400).json({ error: 'Name and path are required', code: 'MISSING_FIELDS' });
    return res.status(400).send('Name and path are required');
  }

  // Pre-check for duplicate path
  db.getProjectByPath(projectPath, (pathErr, existingByPath) => {
    if (pathErr) {
      console.error('Pre-check path error:', pathErr.message);
      const dbErr = { status: 500, error: 'Database error during path validation', code: 'DB_ERROR' };
      if (wantsJson) return res.status(dbErr.status).json(dbErr);
      return res.status(dbErr.status).send(dbErr.error);
    }
    if (existingByPath) {
      const err = { status: 409, error: `This directory is already registered as "${existingByPath.name}".`, field: 'path', code: 'DUPLICATE_PATH' };
      if (wantsJson) return res.status(err.status).json(err);
      return res.status(err.status).send(err.error);
    }

    db.createProject({
      name, path: projectPath, description,
      override_build_command: override_build_command || null,
      override_start_command: override_start_command || null,
      override_port: override_port ? (Number.isInteger(+override_port) && +override_port >= 1 && +override_port <= 65535 ? parseInt(override_port, 10) : null) : null,
      override_docker_image: override_docker_image || null,
      override_env: override_env || null,
    }, (err, id) => {
      if (err) {
        console.error('Project creation error:', err.message);
        const mapped = normalizeProjectError(err);
        if (wantsJson) return res.status(mapped.status).json(mapped);
        return res.status(mapped.status).send(mapped.error);
      }

      db.getProject(id, (err, project) => {
        if (err) {
          console.error('Project lookup after creation failed:', err.message);
        }
        if (!err && project) {
          // Start watching for worktrees
          worktreeScanner.watchProject(project);
          // Auto-start the project, but redirect as soon as the in-flight state is visible.
          startProjectWithWorktrees(db, docker, project).catch((startErr) => {
            console.error("Auto-start failed for project " + id + ":", startErr.message);
          });
        }

        if (wantsJson) return res.json({ ok: true, id });
        res.redirect('/');
      });
    });
  });
});

// Project detail partial — returns rendered HTML fragment for AJAX expand
app.get('/projects/:id/detail-partial', (req, res) => {
  const { id } = req.params;

  db.getProject(id, async (err, project) => {
    if (err) return res.status(500).send('Database error');
    if (!project) return res.status(404).send('Project not found');

    const enriched = await enrichProjectStatus(docker, project);

    const logs = await docker.getLogs(enriched, 200);
    const detection = detectProjectType(enriched.path);

    const worktrees = await new Promise((resolve) => {
      db.getWorktreesForProject(id, async (wtErr, wts) => {
        if (wtErr || !wts) return resolve([]);
        const enrichedWts = await Promise.all(wts.map(async (wt) => {
          return enrichProjectStatus(docker, wt);
        }));
        resolve(enrichedWts);
      });
    });

    res.render('partials/_detail_fragment', {
      project: enriched,
      worktrees,
      logs,
      detection,
      config: req.requestConfig
    });
  });
});

// Project detail — redirect to unified listing with expand
app.get('/projects/:id', (req, res) => {
  const { id } = req.params;

  db.getProject(id, (err, project) => {
    if (err) return res.status(500).send('Database error');
    if (!project) return res.status(404).send('Project not found');
    res.redirect(302, `/?expand=${encodeURIComponent(project.name)}`);
  });
});

// Start project
app.post('/projects/:id/start', (req, res) => {
  const { id } = req.params;
  
  db.getProject(id, async (err, project) => {
    if (err || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { result } = await startProjectWithWorktrees(db, docker, project);
    if (result.alreadyStarting) {
      const enriched = await enrichProjectStatus(docker, project);
      return res.status(202).json({ success: true, alreadyStarting: true, status: enriched.status, health: enriched.health });
    }
    if (result.success) {
      const enriched = await enrichProjectStatus(docker, project);
      res.json({ success: true, status: enriched.status, health: enriched.health });
    } else {
      res.status(500).json({ error: result.error, buildLog: result.buildLog || null });
    }
  });
});

// Stop project
app.post('/projects/:id/stop', (req, res) => {
  const { id } = req.params;

  db.getProject(id, async (err, project) => {
    if (err || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { result } = await stopProjectWithWorktrees(db, docker, project);
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: result.error });
    }
  });
});

// Restart project
app.post('/projects/:id/restart', (req, res) => {
  const { id } = req.params;

  db.getProject(id, async (err, project) => {
    if (err || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { result } = await restartProjectWithWorktrees(db, docker, project);
    if (!result.success && !result.alreadyStarting) {
      return res.status(500).json({ error: result.error, buildLog: result.buildLog || null });
    }

    const enriched = await enrichProjectStatus(docker, project);
    res.json({ success: true, status: enriched.status, health: enriched.health });
  });
});

// Get log history (JSON)
app.get('/projects/:id/logs', (req, res) => {
  const { id } = req.params;
  const lines = parseInt(req.query.lines) || 200;

  db.getProject(id, async (err, project) => {
    if (err || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const logs = await docker.getLogs(project, lines);
    const logLines = logs ? logs.split('\n').filter(l => l.trim()) : [];
    res.json({ lines: logLines });
  });
});

// Stream logs (SSE)
app.get('/projects/:id/logs/stream', (req, res) => {
  const { id } = req.params;
  
  db.getProject(id, (err, project) => {
    if (err || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    docker.streamLogs(project, res);
  });
});

// Startup progress (SSE)
app.get('/projects/:id/startup', (req, res) => {
  const { id } = req.params;

  db.getProject(id, (err, project) => {
    if (err || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const health = docker.getHealth(project.id);
    if (health === 'healthy') {
      res.write(`data: ${JSON.stringify({ step: 5, totalSteps: 5, label: 'Ready!', done: true })}\n\n`);
      res.end();
      return;
    }
    if (health === 'unhealthy') {
      res.write(`data: ${JSON.stringify({ error: 'Health check failed', done: true })}\n\n`);
      res.end();
      return;
    }

    // Send current step if available
    const currentStep = docker.getStartupStep(project.id);
    if (currentStep) {
      res.write(`data: ${JSON.stringify(currentStep)}\n\n`);
    }

    const unsubscribe = docker.addStartupListener(project.id, (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (data.done) {
        unsubscribe();
        res.end();
      }
    });

    req.on('close', unsubscribe);
  });
});

// Build log (saved from last failed build)
app.get('/api/projects/:id/build-log', (req, res) => {
  const { id } = req.params;

  db.getProject(id, (err, project) => {
    if (err || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const buildLog = docker.getBuildLog(project);
    if (buildLog) {
      res.json({ buildLog });
    } else {
      res.json({ buildLog: null });
    }
  });
});

// Delete project
app.delete('/projects/:id', async (req, res) => {
  const { id } = req.params;

  db.getProject(id, async (err, project) => {
    if (err || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Clean up Docker containers + volumes and generated compose dir
    await docker.cleanup(project);

    worktreeScanner.unwatchProject(parseInt(id));

    db.deleteProject(id, (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true });
    });
  });
});

// Update project overrides
app.patch('/api/projects/:id', (req, res) => {
  const { id } = req.params;
  const allowed = ['override_build_command', 'override_start_command', 'override_port', 'override_docker_image', 'override_env'];
  const updates = {};
  for (const key of allowed) {
    if (key in req.body) {
      // null clears the override, otherwise use the value
      updates[key] = req.body[key] === null ? null : req.body[key];
    }
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid override fields provided' });
  }

  db.getProject(id, (err, project) => {
    if (err || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Delete cached Dockerfile when any override changes so it regenerates on next start
    const slug = project.subdomain || project.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const dockerfilePath = path.join(getJumpshDir(slug), 'Dockerfile');
    try { fs.unlinkSync(dockerfilePath); } catch { /* ignore */ }

    db.updateProject(id, updates, (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      db.getProject(id, async (err, updated) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(updated);

        // Auto-restart if container is running
        const status = await docker.getStatus(updated);
        if (status.running) {
          docker.restart(updated);
        }

        // Also restart running worktrees (they inherit parent overrides)
        if (!updated.is_worktree) {
          db.getWorktreesForProject(id, async (err, worktrees) => {
            if (err || !worktrees) return;
            for (const wt of worktrees) {
              const wtStatus = await docker.getStatus(wt);
              if (wtStatus.running) docker.restart(wt);
            }
          });
        }
      });
    });
  });
});

// API: Get single project with status
app.get('/api/projects/:id', async (req, res) => {
  const { id } = req.params;
  db.getProject(id, async (err, project) => {
    if (err || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(await enrichProjectStatus(docker, project));
  });
});

// API: Get all projects with status
app.get('/api/projects', async (req, res) => {
  db.getAllProjectsIncludingWorktrees(async (err, projects) => {
    if (err) {
      console.error('API projects DB error:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }

    const projectsWithStatus = await Promise.all(
      (projects || []).map(async (project) => {
        return enrichProjectStatus(docker, project);
      })
    );

    res.json(projectsWithStatus);
  });
});

// ============ Detect Project Type API ============

app.get('/api/detect', (req, res) => {
  const projectPath = req.query.path;
  if (!projectPath) {
    return res.status(400).json({ error: 'path query parameter is required' });
  }

  const resolved = path.resolve(projectPath);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Directory not found' });
    }
    return res.status(400).json({ error: err.message });
  }

  try {
    const detection = detectProjectType(resolved);
    res.json(detection);
  } catch (err) {
    res.status(500).json({ error: 'Detection failed: ' + err.message });
  }
});

// ============ Browse Folders API ============

app.get('/api/browse', (req, res) => {
  const requestedPath = req.query.path || '/';
  const resolved = path.resolve(requestedPath);

  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const directories = entries
      .filter(d => {
        if (d.name.startsWith('.')) return false;
        if (d.isDirectory()) return true;
        if (d.isSymbolicLink()) {
          try {
            return fs.statSync(path.join(resolved, d.name)).isDirectory();
          } catch { return false; }
        }
        return false;
      })
      .map(d => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    res.json({
      current: resolved,
      parent: path.dirname(resolved),
      directories
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Directory not found' });
    }
    if (err.code === 'EACCES') {
      return res.status(403).json({ error: 'Permission denied' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ============ Docker Status API ============

app.get('/api/docker-status', async (req, res) => {
  const result = await checkDockerAvailability();
  res.json(result);
});

// ============ Port Conflict Detection ============

function probePort(port) {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.once('error', (err) => {
      if (err.code === 'EADDRINUSE') return reject(err);
      reject(err);
    });
    tester.once('listening', () => {
      tester.close(() => resolve());
    });
    tester.listen(port);
  });
}

async function identifyPortHolder(port) {
  const { execSync } = await import('child_process');
  try {
    const pid = execSync(`lsof -i :${port} -t 2>/dev/null`, { encoding: 'utf8' }).trim().split('\n')[0];
    if (!pid) return null;
    let name = '';
    try {
      name = execSync(`ps -p ${pid} -o comm= 2>/dev/null`, { encoding: 'utf8' }).trim();
    } catch { /* ignore */ }
    return { pid, name };
  } catch {
    // ignore
    return null;
  }
}

// ============ Start Server ============

async function findNextAvailablePort(startPort, maxDelta = 25) {
  for (let p = startPort + 1; p <= startPort + maxDelta; p++) {
    try {
      await probePort(p);
      return p;
    } catch { /* port not available */ }
  }
  return null;
}


if (config.https && !certsExist()) {
  console.warn(`HTTPS enabled and certs missing at ${config.certPath}; downloading from jump.sh...`);
  try {
    await downloadCerts();
  } catch (e) {
    console.error(`Automatic cert download failed: ${e.message}`);
  }
}

// ============ TLS / SNI Setup ============

function loadCertPair(dir, label) {
  // Try legacy naming first, then new naming from register flow
  const pairs = [
    { key: 'server-key.pem', cert: 'server.pem' },
    { key: 'privkey.pem', cert: 'fullchain.pem' },
  ];
  for (const { key, cert } of pairs) {
    const keyFile = path.join(dir, key);
    const certFile = path.join(dir, cert);
    if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
      const status = localCertStatus({ certPath: certFile, keyPath: keyFile });
      if (status.status !== 'valid') {
        const expires = status.expires_at ? `, expires ${status.expires_at}` : '';
        console.warn(`[SNI] ${label} certs in ${dir} are ${status.status}${expires}, skipping`);
        continue;
      }
      console.log(`[SNI] Loaded ${label} certs from ${dir} (${cert}, expires ${status.expires_at})`);
      return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
    }
  }
  console.warn(`[SNI] ${label} certs not found in ${dir}, skipping`);
  return null;
}

let server;
if (config.https) {
  // Default cert (*.jump.sh)
  const defaultCert = loadCertPair(config.certPath, 'default (*.jump.sh)');

  // Load certs from all subdirectories (e.g. certs/username/ → *.username.jump.sh)
  const sniContexts = {};
  let firstSubCert = null;
  try {
    const entries = fs.readdirSync(config.certPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subdir = path.join(config.certPath, entry.name);
      const pair = loadCertPair(subdir, `*.${entry.name}.jump.sh`);
      if (pair) {
        sniContexts[entry.name] = tls.createSecureContext(pair);
        if (!firstSubCert) firstSubCert = pair;
      }
    }
  } catch { /* ignore cert read errors */ }

  if (!defaultCert && !firstSubCert) {
    console.warn(
      `JUMPSH_HTTPS=true but no certs found.\n` +
      `Place cert files (server.pem and server-key.pem) in ${config.certPath}.\n` +
      `Falling back to HTTP.`
    );
    config.https = false;
    server = http.createServer(app);
  } else {
    const primary = defaultCert || firstSubCert;

    const httpsOptions = {
      ...primary,
      SNICallback: (hostname, cb) => {
        // Match *.{name}.jump.sh hostnames against discovered certs
        for (const name of Object.keys(sniContexts)) {
          if (hostname.endsWith(`.${name}.jump.sh`) || hostname === `${name}.jump.sh`) {
            return cb(null, sniContexts[name]);
          }
        }
        // Fall through to default cert
        cb(null);
      }
    };
    server = https.createServer(httpsOptions, app);
  }
} else {
  server = http.createServer(app);
}

// Wire WebSocket upgrades through the subdomain proxy
subdomainProxy.attachUpgrade(server);

// Check port availability before binding
try {
  await probePort(config.port);
} catch (err) {
  if (config.explicitPort) {
    // Explicit --port or JUMPSH_PORT: no fallback, fail hard
    if (err.code === 'EADDRINUSE') {
      const holder = await identifyPortHolder(config.port);
      if (holder) {
        console.error(`Port ${config.port} is in use by process ${holder.pid} (${holder.name}).`);
      } else {
        console.error(`Port ${config.port} is already in use.`);
      }
      console.error(`Cannot bind to explicitly requested port ${config.port}. Free the port or choose a different one with --port.`);
      process.exit(4);
    } else if (err.code === 'EACCES') {
      console.error(`Permission denied binding to port ${config.port}.`);
      console.error(`Ports below 1024 typically require elevated privileges. Try: sudo setcap cap_net_bind_service=+ep "$(which node)"`);
      process.exit(4);
    }
    throw err;
  }

  // No explicit port: graceful fallback
  if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
    const reason = err.code === 'EACCES' ? 'permission denied' : 'already in use';
    if (err.code === 'EADDRINUSE') {
      const holder = await identifyPortHolder(config.port);
      if (holder) {
        console.warn(`Port ${config.port} ${reason} (PID ${holder.pid}, ${holder.name}).`);
      } else {
        console.warn(`Port ${config.port} ${reason}.`);
      }
    } else {
      console.warn(`Port ${config.port} ${reason}.`);
    }
    // Fall back to high port range
    const fallbackStart = 4443;
    try {
      await probePort(fallbackStart);
      config.port = fallbackStart;
    } catch {
      const nextPort = await findNextAvailablePort(fallbackStart);
      if (!nextPort) {
        deverror('Port conflict with no fallback', { port: config.port });
        process.exit(4);
      }
      config.port = nextPort;
    }
    console.warn(`Falling back to port ${config.port}.`);
  } else {
    throw err;
  }
}

// ============ Docker Preflight Check ============
if (!devMode) {
  const dockerCheck = await checkDockerAvailability();
  const composeCmd = (await import('./services/dockerCommand.js')).getComposeCommand();

  if (!dockerCheck.available || !composeCmd) {
    const missing = [];
    if (!dockerCheck.available) missing.push('docker');
    if (!composeCmd) missing.push('docker compose');

    const msg = `${missing.join(' and ')} not available`;
    const help = !dockerCheck.available
      ? dockerCheck.error
      : 'docker-compose not found. Install Docker Desktop or docker-compose.';
    const lines = [msg, '', ...help.split('\n')];
    const width = Math.max(...lines.map(l => l.length)) + 4;
    const pad = (s) => s + ' '.repeat(Math.max(0, width - s.length));
    console.error('');
    console.error('╔' + '═'.repeat(width + 2) + '╗');
    for (const line of lines) {
      console.error('║ ' + pad(line) + ' ║');
    }
    console.error('╚' + '═'.repeat(width + 2) + '╝');
    console.error('');
    process.exit(5);
  }
}

// Rotate logs on startup
rotateLogs();

// Schedule periodic log rotation (every 6 hours)
const LOG_ROTATION_INTERVAL = 6 * 60 * 60 * 1000;
const rotationTimer = setInterval(rotateLogs, LOG_ROTATION_INTERVAL);
rotationTimer.unref();

const protocol = config.https ? 'https' : 'http';
const dashboardUrl = formatUrl(config.dashboardHost);

const serverJsonPath = path.join(os.homedir(), '.jump.sh', 'server.json');

async function initDevMode() {
  const fixturesDir = path.join(__dirname, 'test/fixtures/apps');
  let entries;
  try {
    entries = fs.readdirSync(fixturesDir);
  } catch (err) {
    console.warn('[dev] Could not read fixtures directory:', err.message);
    return;
  }

  let loaded = 0;
  for (const name of entries) {
    const fixturePath = path.join(fixturesDir, name);
    try {
      if (!fs.statSync(fixturePath).isDirectory()) continue;
    } catch { continue; }

    // Idempotent: skip if already registered by path or name
    const existingByPath = await new Promise(resolve => {
      db.getProjectByPath(fixturePath, (err, p) => resolve(p));
    });
    if (existingByPath) { loaded++; continue; }

    const projectName = `fixture-${name}`;
    const existingByName = await new Promise(resolve => {
      db.getProjectByName(projectName, (err, p) => resolve(p));
    });
    if (existingByName) { loaded++; continue; }

    try {
      await new Promise((resolve, reject) => {
        db.createProject({
          name: projectName,
          path: fixturePath,
          description: '[fixture] Test fixture app',
        }, (err) => err ? reject(err) : resolve());
      });
      loaded++;
    } catch (err) {
      console.error(`[dev] Failed to load fixture ${name}:`, err.message);
    }
  }

  console.log(`[dev] ${loaded} fixture apps ready`);
}

server.listen(config.port, async () => {
  // Write server.json so the CLI can discover the actual port
  try {
    fs.mkdirSync(path.dirname(serverJsonPath), { recursive: true });
    fs.writeFileSync(serverJsonPath, JSON.stringify({ port: config.port, protocol }));
  } catch (err) {
    console.warn('Could not write server.json:', err.message);
  }

  await db.ready();

  if (devMode) {
    await initDevMode();
  }

  devinfo('Server started', { port: config.port, protocol, domain: config.domain, devMode });
  const pad = (s, w = 48) => s + ' '.repeat(Math.max(0, w - s.length));
  const title = 'jump.sh v' + pkg.version + (devMode ? ' [DEV MODE]' : '');
  const center = (s, w = 48) => { const l = Math.floor((w - s.length) / 2); return ' '.repeat(l) + s + ' '.repeat(Math.max(0, w - l - s.length)); };
  console.log(`
╔══════════════════════════════════════════════════╗
║ ${center(title)} ║
╠══════════════════════════════════════════════════╣
║ ${pad('Dashboard: ' + dashboardUrl)} ║
║ ${pad('Projects:  ' + formatUrl(`*.${config.domain}`))} ║
║ ${pad('Protocol:  ' + protocol.toUpperCase())} ║
╚══════════════════════════════════════════════════╝
  `);

  // Start watching all projects for worktrees, then restore containers that were desired-running.
  await worktreeScanner.scanAllProjects();
  autoStartDesiredProjects(db, docker).catch(err => {
    console.error('Failed to auto-start desired projects:', err.message);
  });

});

// ============ Signal Handling ============

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down...`);
  devinfo('Shutdown initiated', { signal });

  // Force-kill timeout
  const forceTimer = setTimeout(() => {
    deverror('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  try {
    // Remove server.json so CLI knows the server is not running
    try { fs.unlinkSync(serverJsonPath); } catch { /* ignore */ }

    server.close();

    // Stop all running Docker containers
    const projects = await new Promise((resolve) => {
      db.getAllProjectsIncludingWorktrees((err, rows) => resolve(rows || []));
    });
    for (const project of projects) {
      const status = await docker.getStatus(project);
      if (status.running) {
        console.log(`Stopping container for ${project.name}...`);
        await docker.stop(project);
      }
    }

    worktreeScanner.cleanup();
    clearInterval(rotationTimer);
    await new Promise((resolve) => db.close(resolve));
    devinfo('Shutdown complete');
  } catch (err) {
    deverror('Error during shutdown', { error: err.message });
  }

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('SIGHUP', () => {
  console.log('Received SIGHUP, rescanning worktrees...');
  devinfo('SIGHUP received, rescanning worktrees');
  worktreeScanner.scanAllProjects();
});
