import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from './database.js';
import DockerManager from './services/DockerManager.js';
import WorktreeScanner from './services/WorktreeScanner.js';
import SubdomainProxy from './services/SubdomainProxy.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Config
const config = {
  port: process.env.LOCALHAUS_PORT || 5050,
  domain: process.env.LOCALHAUS_DOMAIN || 'localhost',
  https: process.env.LOCALHAUS_HTTPS === 'true'
};

// Initialize services
const db = new Database();
const docker = new DockerManager();
const worktreeScanner = new WorktreeScanner(db);
const subdomainProxy = new SubdomainProxy(db, docker, config);

const app = express();

// Subdomain proxy (must be first)
app.use(subdomainProxy.middleware());

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ============ Routes ============

// Dashboard
app.get('/', async (req, res) => {
  db.getAllProjectsIncludingWorktrees(async (err, projects) => {
    if (err) {
      return res.status(500).send('Database error');
    }

    // Get status for each project
    const projectsWithStatus = await Promise.all(
      (projects || []).map(async (project) => {
        const status = await docker.getStatus(project);
        const port = status.running ? await docker.getPort(project) : null;
        return { ...project, status: status.running ? 'running' : 'stopped', port };
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
  res.render('add', { config });
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
    
    // Start watching for worktrees
    db.getProject(id, (err, project) => {
      if (!err && project) {
        worktreeScanner.watchProject(project);
      }
    });

    res.redirect('/');
  });
});

// Project detail
app.get('/projects/:id', (req, res) => {
  const { id } = req.params;
  
  db.getProject(id, async (err, project) => {
    if (err || !project) {
      return res.status(404).send('Project not found');
    }

    const status = await docker.getStatus(project);
    const port = status.running ? await docker.getPort(project) : null;
    const logs = await docker.getLogs(project, 200);

    db.getWorktreesForProject(id, async (err, worktrees) => {
      // Get status for worktrees too
      const worktreesWithStatus = await Promise.all(
        (worktrees || []).map(async (wt) => {
          const wtStatus = await docker.getStatus(wt);
          const wtPort = wtStatus.running ? await docker.getPort(wt) : null;
          return { ...wt, status: wtStatus.running ? 'running' : 'stopped', port: wtPort };
        })
      );

      res.render('project', { 
        project: { ...project, status: status.running ? 'running' : 'stopped', port },
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
      res.json({ success: true, status: result.status });
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
app.delete('/projects/:id', (req, res) => {
  const { id } = req.params;
  
  worktreeScanner.unwatchProject(parseInt(id));
  
  db.deleteProject(id, (err) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true });
  });
});

// API: Get all projects with status
app.get('/api/projects', async (req, res) => {
  db.getAllProjectsIncludingWorktrees(async (err, projects) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    const projectsWithStatus = await Promise.all(
      (projects || []).map(async (project) => {
        const status = await docker.getStatus(project);
        const port = status.running ? await docker.getPort(project) : null;
        return { ...project, status: status.running ? 'running' : 'stopped', port };
      })
    );

    res.json(projectsWithStatus);
  });
});

// ============ Start Server ============

const server = app.listen(config.port, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║           🏠 Localhaus v0.1.0             ║
╠═══════════════════════════════════════════╣
║  Dashboard: http://${config.domain}:${config.port}
║  Domain:    *.${config.domain}
╚═══════════════════════════════════════════╝
  `);

  // Start watching all projects for worktrees
  worktreeScanner.scanAllProjects();
});

// Cleanup on shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  worktreeScanner.cleanup();
  server.close();
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  worktreeScanner.cleanup();
  server.close();
  process.exit(0);
});
