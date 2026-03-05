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
import WorktreeScanner from './services/WorktreeScanner.js';
import SubdomainProxy from './services/SubdomainProxy.js';
import { detectProjectType } from './services/ProjectDetector.js';
import { getJumpshDir } from './services/ComposeGenerator.js';
import { devinfo, devwarn, deverror, rotateLogs } from './lib/devlog.js';
import { certsExist, downloadCerts } from './lib/commands/certs.js';
import { checkDockerAvailability } from './services/dockerCommand.js';

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
  } catch {}
  return null;
}

// Detect domain from Host header (strip dashboard prefix)
function detectDomainFromHost(hostname) {
  const host = hostname.replace(/:\d+$/, '');
  for (const prefix of ['dash.', 'dashboard.']) {
    if (host.startsWith(prefix)) {
      return host.slice(prefix.length);
    }
  }
  return null;
}

// Priority: CLI flag (via env) > Cert detection > Env var default > 'jump.sh'
const domain = process.env.JUMPSH_DOMAIN || detectDomainFromCerts() || 'jump.sh';

// Config
const config = {
  port: parseInt(process.env.JUMPSH_PORT, 10) || 4443,
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

// Initialize services
const db = new Database();
const docker = new DockerManager(db);
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
  const detected = detectDomainFromHost(req.get('host') || '');
  if (detected && detected !== config.domain) {
    req.requestConfig = { ...config, domain: detected, dashboardHost: `dash.${detected}` };
    req.requestConfig.formatUrl = formatUrl;
  } else {
    req.requestConfig = config;
  }
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
        const status = await docker.getStatus(project);
        const port = status.running ? await docker.getPort(project) : null;
        const health = docker.getHealthWithProbe(project, status);
        return { ...project, status: status.running ? 'running' : 'stopped', port, health };
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

    res.render('index', {
      projects: mainProjects,
      worktreesByParent,
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
  const { name, path: projectPath, description, override_build_command, override_start_command, override_port, override_docker_image } = req.body;
  const wantsJson = req.headers.accept?.includes('application/json') || req.headers['content-type']?.includes('application/json');

  if (!name || !projectPath) {
    if (wantsJson) return res.status(400).json({ error: 'Name and path are required', code: 'MISSING_FIELDS' });
    return res.status(400).send('Name and path are required');
  }

  // Pre-check for duplicate path
  db.getProjectByPath(projectPath, (pathErr, existingByPath) => {
    if (pathErr) {
      console.error('Pre-check path error:', pathErr.message);
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
      override_port: override_port ? parseInt(override_port, 10) : null,
      override_docker_image: override_docker_image || null,
    }, (err, id) => {
      if (err) {
        console.error('Project creation error:', err.message);
        const mapped = normalizeProjectError(err);
        if (wantsJson) return res.status(mapped.status).json(mapped);
        return res.status(mapped.status).send(mapped.error);
      }

      db.getProject(id, async (err, project) => {
        if (!err && project) {
          // Start watching for worktrees
          worktreeScanner.watchProject(project);
          // Auto-start the project
          await docker.start(project);
        }
      });

      if (wantsJson) return res.json({ ok: true, id });
      res.redirect('/');
    });
  });
});

// Project detail
app.get('/projects/:id', (req, res) => {
  const { id } = req.params;
  
  db.getProject(id, async (err, project) => {
    if (err) {
      console.error(`Project detail DB error (id=${id}):`, err.message);
      return res.status(500).send('Database error');
    }
    if (!project) {
      return res.status(404).send('Project not found');
    }

    const status = await docker.getStatus(project);
    const port = status.running ? await docker.getPort(project) : null;
    const health = docker.getHealthWithProbe(project, status);
    const logs = await docker.getLogs(project, 200);
    const detection = detectProjectType(project.path);

    db.getWorktreesForProject(id, async (err, worktrees) => {
      // Get status for worktrees too
      const worktreesWithStatus = await Promise.all(
        (worktrees || []).map(async (wt) => {
          const wtStatus = await docker.getStatus(wt);
          const wtPort = wtStatus.running ? await docker.getPort(wt) : null;
          const wtHealth = docker.getHealthWithProbe(wt, wtStatus);
          return { ...wt, status: wtStatus.running ? 'running' : 'stopped', port: wtPort, health: wtHealth };
        })
      );

      res.render('project', {
        project: { ...project, status: status.running ? 'running' : 'stopped', port, health },
        worktrees: worktreesWithStatus,
        logs,
        detection,
        config: req.requestConfig
      });
    });
  });
});

// Start project
app.post('/projects/:id/start', (req, res) => {
  const { id } = req.params;
  
  db.getProject(id, async (err, project) => {
    if (err || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const result = await docker.start(project);
    if (result.alreadyStarting) {
      return res.status(409).json({ error: 'Project is already starting' });
    }
    if (result.success) {
      const status = await docker.getStatus(project);
      const health = docker.getHealthWithProbe(project, status);
      res.json({ success: true, status: result.status, health });

      // Auto-start worktrees (fire-and-forget)
      db.getWorktreesForProject(id, (err, worktrees) => {
        if (err || !worktrees) return;
        for (const wt of worktrees) {
          docker.start(wt);
        }
      });
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

    const result = await docker.stop(project);
    if (result.success) {
      res.json({ success: true });

      // Auto-stop worktrees (fire-and-forget)
      db.getWorktreesForProject(id, (err, worktrees) => {
        if (err || !worktrees) return;
        for (const wt of worktrees) {
          docker.stop(wt);
        }
      });
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

    // Gather worktrees
    const worktrees = await new Promise((resolve) => {
      db.getWorktreesForProject(id, (err, wts) => resolve(err ? [] : wts || []));
    });

    // Stop all (main + worktrees)
    await Promise.all([project, ...worktrees].map(p => docker.stop(p)));

    // Start all (main + worktrees)
    const result = await docker.start(project);
    if (!result.success) {
      return res.status(500).json({ error: result.error, buildLog: result.buildLog || null });
    }

    // Fire-and-forget worktree starts
    for (const wt of worktrees) {
      docker.start(wt);
    }

    const status = await docker.getStatus(project);
    const health = docker.getHealthWithProbe(project, status);
    res.json({ success: true, status: result.status, health });
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
    try { fs.unlinkSync(dockerfilePath); } catch {}

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
    const status = await docker.getStatus(project);
    const port = status.running ? await docker.getPort(project) : null;
    const health = docker.getHealthWithProbe(project, status);
    res.json({ ...project, status: status.running ? 'running' : 'stopped', port, health });
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
        const status = await docker.getStatus(project);
        const port = status.running ? await docker.getPort(project) : null;
        const health = docker.getHealthWithProbe(project, status);
        return { ...project, status: status.running ? 'running' : 'stopped', port, health };
      })
    );

    res.json(projectsWithStatus);
  });
});

// ============ Detect Project Type API ============

app.get('/api/detect', (req, res) => {
  var projectPath = req.query.path;
  if (!projectPath) {
    return res.status(400).json({ error: 'path query parameter is required' });
  }

  var resolved = path.resolve(projectPath);
  try {
    var stat = fs.statSync(resolved);
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
    var detection = detectProjectType(resolved);
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
    } catch {}
    return { pid, name };
  } catch {
    return null;
  }
}

// ============ Start Server ============

async function findNextAvailablePort(startPort, maxDelta = 25) {
  for (let p = startPort + 1; p <= startPort + maxDelta; p++) {
    try {
      await probePort(p);
      return p;
    } catch {}
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
      console.log(`[SNI] Loaded ${label} certs from ${dir} (${cert})`);
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
  } catch {}

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

// Check port availability before binding
try {
  await probePort(config.port);
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    const holder = await identifyPortHolder(config.port);
    if (holder) {
      const isJumpsh = holder.name === 'node' || holder.name === 'jumpsh';
      if (isJumpsh) {
        console.warn(`Port ${config.port} is already in use by PID ${holder.pid}.`);
      } else {
        console.warn(`Port ${config.port} is in use by process ${holder.pid} (${holder.name}).`);
      }
    } else {
      console.warn(`Port ${config.port} is already in use.`);
    }
    const nextPort = await findNextAvailablePort(config.port);
    if (!nextPort) {
      deverror('Port conflict with no fallback', { port: config.port, holder });
      process.exit(4);
    }
    console.warn(`Falling back to available port ${nextPort}.`);
    config.port = nextPort;
  } else {
    throw err;
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

server.listen(config.port, () => {
  devinfo('Server started', { port: config.port, protocol, domain: config.domain });
  const pad = (s, w = 48) => s + ' '.repeat(Math.max(0, w - s.length));
  const title = 'jump.sh v' + pkg.version;
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

  // Start watching all projects for worktrees
  worktreeScanner.scanAllProjects();

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
