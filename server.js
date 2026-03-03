import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';
import fs from 'fs';
import os from 'os';

import net from 'net';
import Database from './database.js';
import DockerManager from './services/DockerManager.js';
import WorktreeScanner from './services/WorktreeScanner.js';
import SubdomainProxy from './services/SubdomainProxy.js';
import { devinfo, devwarn, deverror, rotateLogs } from './lib/devlog.js';
import { RemoteSyncer } from './lib/remote/syncer.js';
import { certsExist, downloadCerts } from './lib/commands/certs.js';

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

// Config
const config = {
  port: parseInt(process.env.JUMPSH_PORT, 10) || 4443,
  domain: process.env.JUMPSH_DOMAIN || 'jump.sh',
  https: process.env.JUMPSH_HTTPS !== 'false',
  certPath,
  dashboardHost: process.env.JUMPSH_DASHBOARD_HOST || `dash.${process.env.JUMPSH_DOMAIN || 'jump.sh'}`
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
const remoteSyncer = new RemoteSyncer();
subdomainProxy.setRemoteSyncer(remoteSyncer);

const app = express();

// Subdomain proxy (must be first)
app.use(subdomainProxy.middleware());

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

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
      config 
    });
  });
});

// Add project form
app.get('/add', (req, res) => {
  const folderOptions = listProjectFolders();
  res.render('add', { config, folderOptions });
});

// Create project
app.post('/projects', (req, res) => {
  const { name, path: projectPath, description } = req.body;
  
  if (!name || !projectPath) {
    return res.status(400).send('Name and path are required');
  }

  db.createProject({ name, path: projectPath, description }, (err, id) => {
    if (err) {
      return res.status(500).send(`Error creating project: ${err.message}`);
    }

    db.getProject(id, async (err, project) => {
      if (!err && project) {
        // Start watching for worktrees
        worktreeScanner.watchProject(project);
        // Auto-start the project
        await docker.start(project);
      }
    });

    res.redirect('/');
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
        config
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
      res.status(500).json({ error: result.error });
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
    } else {
      res.status(500).json({ error: result.error });
    }
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

function listProjectFolders() {
  const roots = [
    path.join(os.homedir(), 'play', 'web'),
    path.join(os.homedir(), 'play', 'js'),
    path.join(os.homedir(), 'play', 'native'),
  ];
  const out = [];
  for (const root of roots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
        .slice(0, 400)
        .map(d => path.join(root, d.name));
      out.push(...entries);
    } catch {}
  }
  return out.slice(0, 800);
}


if (config.https && !certsExist()) {
  console.warn(`HTTPS enabled and certs missing at ${config.certPath}; downloading from jump.sh...`);
  try {
    await downloadCerts();
  } catch (e) {
    console.error(`Automatic cert download failed: ${e.message}`);
  }
}

let server;
if (config.https) {
  const keyPath = path.join(config.certPath, 'server-key.pem');
  const certFile = path.join(config.certPath, 'server.pem');

  if (!fs.existsSync(keyPath) || !fs.existsSync(certFile)) {
    console.warn(
      `JUMPSH_HTTPS=true but certs not found at ${config.certPath}\n` +
      `Place cert files (server.pem and server-key.pem) in ${config.certPath}.\n` +
      `Falling back to HTTP.`
    );
    config.https = false;
    server = http.createServer(app);
  } else {
    const httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certFile)
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
  console.log(`
╔═══════════════════════════════════════════╗
║            jump.sh v0.1.0                 ║
╠═══════════════════════════════════════════╣
║  Dashboard: ${dashboardUrl}
║  Projects:  ${formatUrl(`*.${config.domain}`)}
║  Protocol:  ${protocol.toUpperCase()}
╚═══════════════════════════════════════════╝
  `);

  // Start watching all projects for worktrees
  worktreeScanner.scanAllProjects();

  // Start remote route sync (loads cache + periodic refresh if logged in)
  remoteSyncer.start();
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
    remoteSyncer.stop();
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
  console.log('Received SIGHUP, rescanning worktrees + remote routes...');
  devinfo('SIGHUP received, rescanning worktrees and remote routes');
  worktreeScanner.scanAllProjects();
  remoteSyncer.refresh();
});
