import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { execCompose, buildComposeSpawn, checkDockerAvailability } from './dockerCommand.js';
import { detectProjectType } from './ProjectDetector.js';
import { generateCompose, getJumpshDir } from './ComposeGenerator.js';
import { projectInfo, projectError } from '../lib/devlog.js';

// Timeouts (ms)
const DOCKER_BUILD_TIMEOUT = 5 * 60 * 1000; // 5 min for up --build
const DOCKER_CMD_TIMEOUT = 30 * 1000;        // 30s for status/logs/down

const TOTAL_STEPS = 5;
const STEP_LABELS = {
  1: 'Building image...',
  2: 'Creating container...',
  3: 'Starting container...',
  4: 'Waiting for health check...',
  5: 'Ready!'
};

/**
 * Derive a slug from project subdomain or name.
 * @param {object} project - Project object with subdomain and name
 * @returns {string} Slug like 'trade-tracker' or 'david-app'
 */
function getProjectSlug(project) {
  return project.subdomain || project.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

/** Merge parent and child env var JSON strings. Child values win. */
function mergeEnvVars(parentJson, childJson) {
  const map = new Map();
  try {
    if (parentJson) for (const { key, value } of JSON.parse(parentJson)) map.set(key, value);
  } catch {}
  try {
    if (childJson) for (const { key, value } of JSON.parse(childJson)) map.set(key, value);
  } catch {}
  if (map.size === 0) return null;
  return JSON.stringify([...map.entries()].map(([key, value]) => ({ key, value })));
}

/** Extract user overrides from a project record (null values are ignored). */
function getOverrides(project) {
  const o = {};
  if (project.override_build_command) o.build = project.override_build_command;
  if (project.override_start_command) o.start = project.override_start_command;
  if (project.override_port) o.port = project.override_port;
  if (project.override_docker_image) o.dockerImage = project.override_docker_image;
  if (project._mergedEnv) o.env = project._mergedEnv;
  else if (project.override_env) o.env = project.override_env;
  return Object.keys(o).length ? o : null;
}

/**
 * For worktrees, inherit overrides from parent project when the worktree's own
 * override is null. Returns a merged project-like object (does not mutate original).
 */
function mergeParentOverrides(project, parent) {
  if (!parent) return project;
  const fields = ['override_build_command', 'override_start_command', 'override_port', 'override_docker_image'];
  const merged = { ...project };
  for (const f of fields) {
    if (merged[f] == null && parent[f] != null) merged[f] = parent[f];
  }
  return merged;
}

function saveBuildLog(slug, content) {
  try {
    const dir = getJumpshDir(slug);
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, 'build.log');
    fs.writeFileSync(logPath, content);
    return logPath;
  } catch (err) {
    console.error('Failed to save build log:', err.message);
    return null;
  }
}

function readBuildLog(slug) {
  try {
    const logPath = path.join(getJumpshDir(slug), 'build.log');
    if (fs.existsSync(logPath)) return fs.readFileSync(logPath, 'utf8');
  } catch {}
  return null;
}

class DockerManager {
  constructor(db, { spawner = spawn } = {}) {
    this.db = db;
    this.spawner = spawner;
    this.healthStates = new Map(); // projectId -> 'unknown' | 'starting' | 'healthy' | 'unhealthy'
    this.startupListeners = new Map(); // projectId -> Set<callback>
    this.startupSteps = new Map(); // projectId -> current step data
    this._startingProjects = new Set(); // projectIds currently being started
  }

  _emitStartup(projectId, data) {
    const id = projectId.toString();
    this.startupSteps.set(id, data);
    const listeners = this.startupListeners.get(id);
    if (listeners) {
      for (const cb of listeners) cb(data);
    }
    if (data.done) {
      this.startupSteps.delete(id);
    }
  }

  addStartupListener(projectId, callback) {
    const id = projectId.toString();
    if (!this.startupListeners.has(id)) {
      this.startupListeners.set(id, new Set());
    }
    this.startupListeners.get(id).add(callback);
    return () => {
      const set = this.startupListeners.get(id);
      if (set) {
        set.delete(callback);
        if (set.size === 0) this.startupListeners.delete(id);
      }
    };
  }

  getStartupStep(projectId) {
    return this.startupSteps.get(projectId?.toString()) || null;
  }

  _detectStep(line, currentStep) {
    const lower = line.toLowerCase();
    if (/\bstarted\b/.test(lower)) return Math.max(currentStep, 3);
    if (/\bstarting\b/.test(lower)) return Math.max(currentStep, 3);
    if (/\bcreated?\b/.test(lower)) return Math.max(currentStep, 2);
    if (/\bcreating\b/.test(lower)) return Math.max(currentStep, 2);
    return currentStep;
  }

  _execComposeStreaming(args, composePath, opts, projectId) {
    return new Promise((resolve, reject) => {
      const { command, args: spawnArgs } = buildComposeSpawn(args, composePath);
      const child = this.spawner(command, spawnArgs, { cwd: opts.cwd });
      let stdout = '';
      let stderr = '';
      let currentStep = 1;

      const processLine = (line) => {
        if (!line.trim()) return;
        this._emitStartup(projectId, { buildLine: line });
        const newStep = this._detectStep(line, currentStep);
        if (newStep > currentStep) {
          currentStep = newStep;
          this._emitStartup(projectId, { step: currentStep, totalSteps: TOTAL_STEPS, label: STEP_LABELS[currentStep] });
        }
      };

      child.stdout.on('data', (data) => {
        stdout += data;
        data.toString().split('\n').forEach(processLine);
      });
      child.stderr.on('data', (data) => {
        stderr += data;
        data.toString().split('\n').forEach(processLine);
      });

      const timer = setTimeout(() => {
        child.kill();
        reject(Object.assign(new Error('Docker compose timed out'), { stdout, stderr }));
      }, opts.timeout || DOCKER_BUILD_TIMEOUT);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr });
        else reject(Object.assign(new Error(`Docker compose failed (exit ${code})`), { stdout, stderr }));
      });
    });
  }

  /**
   * Find the compose file for a project.
   * Checks: project root docker-compose.yml/yaml, then ~/.jump.sh/{slug}/docker-compose.yml
   * @param {object} project - Project object with path, subdomain, name
   * @returns {{ composePath: string|null, isGenerated: boolean }}
   */
  getComposeFile(project) {
    const projectPath = project.path;
    const slug = getProjectSlug(project);
    
    const rootYml = path.join(projectPath, 'docker-compose.yml');
    const rootYaml = path.join(projectPath, 'docker-compose.yaml');
    const jumpshYml = path.join(getJumpshDir(slug), 'docker-compose.yml');

    if (fs.existsSync(rootYml)) return { composePath: rootYml, isGenerated: false };
    if (fs.existsSync(rootYaml)) return { composePath: rootYaml, isGenerated: false };
    if (fs.existsSync(jumpshYml)) return { composePath: jumpshYml, isGenerated: true };

    return { composePath: null, isGenerated: false };
  }

  async start(project) {
    const { id, path: projectPath, name } = project;
    const idStr = id.toString();

    // Prevent double-start: if already starting, return early
    if (this._startingProjects.has(idStr)) {
      return { success: false, error: 'Already starting', alreadyStarting: true };
    }
    this._startingProjects.add(idStr);

    try {
      return await this._doStart(project);
    } finally {
      this._startingProjects.delete(idStr);
    }
  }

  async _doStart(project) {
    // Check Docker availability before attempting anything
    const dockerCheck = await checkDockerAvailability();
    if (!dockerCheck.available) {
      return { success: false, error: dockerCheck.error };
    }

    // For worktrees, inherit overrides from parent project
    if (project.is_worktree && project.parent_project_id && this.db) {
      const parent = await new Promise((resolve) => {
        this.db.getProject(project.parent_project_id, (err, p) => resolve(err ? null : p));
      });
      project = mergeParentOverrides(project, parent);
    }

    const { id, path: projectPath, name } = project;
    const slug = getProjectSlug(project);

    // Worktrees inherit env overrides from parent, merged with their own
    if (project.parent_project_id && this.db) {
      try {
        const parent = await new Promise((resolve, reject) => {
          this.db.getProject(project.parent_project_id, (err, p) => err ? reject(err) : resolve(p));
        });
        if (parent) {
          const merged = mergeEnvVars(parent.override_env, project.override_env);
          if (merged) project._mergedEnv = merged;
        }
      } catch {}
    }

    let { composePath, isGenerated } = this.getComposeFile(project);

    // No compose file found — try auto-generation
    if (!composePath) {
      const detection = detectProjectType(projectPath);

      if (detection.error) {
        return { success: false, error: detection.error };
      }
      if (detection.needsManualConfig) {
        return { success: false, error: detection.message };
      }

      // Get or assign a port
      let assignedPort = project.assigned_port;
      if (!assignedPort && this.db) {
        try {
          assignedPort = await new Promise((resolve, reject) => {
            this.db.getNextPort((err, port) => {
              if (err) return reject(err);
              resolve(port);
            });
          });
          // Persist the assigned port
          await new Promise((resolve, reject) => {
            this.db.updateProject(id, { assigned_port: assignedPort }, (err) => {
              if (err) return reject(err);
              resolve();
            });
          });
        } catch (err) {
          return { success: false, error: `Port allocation failed: ${err.message}` };
        }
      }
      if (!assignedPort) assignedPort = 10000;

      try {
        const overrides = getOverrides(project);
        const result = generateCompose(projectPath, slug, detection, assignedPort, { overrides });
        composePath = result.composePath;
        if (result.skipped) {
          console.log(`Using existing ~/.jump.sh/${slug}/docker-compose.yml for ${name}`);
        } else {
          console.log(`Auto-generated compose files for ${name} (${detection.type}/${detection.framework || 'generic'}) on port ${assignedPort}`);
        }
      } catch (err) {
        return { success: false, error: `Compose generation failed: ${err.message}` };
      }
    }

    // Existing auto-generated compose file: refresh it to apply latest generator fixes
    // (env transforms, port mappings, logging/options), while leaving user-owned root compose files untouched.
    if (composePath && isGenerated) {
      const detection = detectProjectType(projectPath);
      if (detection.error) {
        return { success: false, error: detection.error };
      }
      if (detection.needsManualConfig) {
        return { success: false, error: detection.message };
      }

      let assignedPort = project.assigned_port;
      if (!assignedPort && this.db) {
        try {
          assignedPort = await new Promise((resolve, reject) => {
            this.db.getNextPort((err, port) => err ? reject(err) : resolve(port));
          });
          await new Promise((resolve, reject) => {
            this.db.updateProject(id, { assigned_port: assignedPort }, (err) => err ? reject(err) : resolve());
          });
        } catch (err) {
          return { success: false, error: `Port allocation failed: ${err.message}` };
        }
      }
      if (!assignedPort) assignedPort = 10000;

      try {
        const overrides = getOverrides(project);
        const refreshed = generateCompose(projectPath, slug, detection, assignedPort, { force: true, overrides });
        composePath = refreshed.composePath;
      } catch (err) {
        return { success: false, error: `Compose refresh failed: ${err.message}` };
      }
    }

    try {
      this.healthStates.set(id.toString(), 'starting');
      this._emitStartup(id, { step: 1, totalSteps: TOTAL_STEPS, label: STEP_LABELS[1] });

      await this._execComposeStreaming(
        ['up', '-d', '--build'],
        composePath,
        { cwd: projectPath, timeout: DOCKER_BUILD_TIMEOUT },
        id
      );
      const status = await this.getStatus(project);
      projectInfo(projectPath, 'Container started', { name });
      const port = await this.getPort(project);
      if (port) {
        this._emitStartup(id, { step: 4, totalSteps: TOTAL_STEPS, label: STEP_LABELS[4] });
        this._probeHealth(project, port);
      }
      return { success: true, status };
    } catch (error) {
      // Detect Docker port conflict and retry once with a new port
      const portConflict = /[Bb]ind.*?(\d+).*?failed|port is already allocated/.test(error.stderr || error.message);
      if (portConflict && project.assigned_port && this.db) {
        console.log(`Port ${project.assigned_port} conflict detected, retrying with a new port...`);
        try {
          // Release the old port
          await new Promise((resolve, reject) => {
            this.db.releasePort(id, (err) => err ? reject(err) : resolve());
          });
          // Get a new port
          const newPort = await new Promise((resolve, reject) => {
            this.db.getNextPort((err, port) => err ? reject(err) : resolve(port));
          });
          await new Promise((resolve, reject) => {
            this.db.updateProject(id, { assigned_port: newPort }, (err) => err ? reject(err) : resolve());
          });
          // Regenerate compose with new port
          const detection = detectProjectType(projectPath);
          const overrides = getOverrides(project);
          generateCompose(projectPath, slug, detection, newPort, { force: true, overrides });
          console.log(`Retrying with port ${newPort}...`);
          // Retry once
          this._emitStartup(id, { step: 1, totalSteps: TOTAL_STEPS, label: STEP_LABELS[1] });
          await this._execComposeStreaming(
            ['up', '-d', '--build'],
            composePath,
            { cwd: projectPath, timeout: DOCKER_BUILD_TIMEOUT },
            id
          );
          const retryStatus = await this.getStatus(project);
          projectInfo(projectPath, 'Container started after port retry', { name, port: newPort });
          const retryPort = await this.getPort(project);
          if (retryPort) {
            this._emitStartup(id, { step: 4, totalSteps: TOTAL_STEPS, label: STEP_LABELS[4] });
            this._probeHealth(project, retryPort);
          }
          return { success: true, status: retryStatus };
        } catch (retryError) {
          const retryBuildOutput = [retryError.stdout, retryError.stderr].filter(Boolean).join('\n');
          saveBuildLog(slug, retryBuildOutput);
          const retryContainerError = `[container] Port conflict retry failed: ${retryError.message}`;
          projectError(projectPath, 'Port conflict retry failed', { name, error: retryError.message });
          this.healthStates.set(id.toString(), 'unhealthy');
          this._emitStartup(id, { error: retryContainerError, buildLog: retryBuildOutput, done: true });
          return { success: false, error: retryContainerError, buildLog: retryBuildOutput };
        }
      }
      const buildOutput = [error.stdout, error.stderr].filter(Boolean).join('\n');
      saveBuildLog(slug, buildOutput);
      const containerError = `[container] ${error.message}`;
      projectError(projectPath, 'Container start failed', { name, error: error.message });
      this.healthStates.set(id.toString(), 'unhealthy');
      this._emitStartup(id, { error: containerError, buildLog: buildOutput, done: true });
      return { success: false, error: containerError, buildLog: buildOutput };
    }
  }

  async stop(project) {
    const { path: projectPath } = project;
    const { composePath } = this.getComposeFile(project);
    this.healthStates.set(project.id.toString(), 'unknown');
    this._emitStartup(project.id, { error: 'Project stopped', done: true });

    try {
      await execCompose(['down'], composePath, { cwd: projectPath, timeout: DOCKER_CMD_TIMEOUT });
      projectInfo(projectPath, 'Container stopped', { name: project.name });
      return { success: true };
    } catch (error) {
      projectError(projectPath, 'Container stop failed', { name: project.name, error: error.message });
      return { success: false, error: error.message };
    }
  }

  async restart(project) {
    await this.stop(project);
    return this.start(project);
  }

  /**
   * Full cleanup: remove containers + volumes, and delete generated compose dir.
   * Used when a project is being deleted.
   */
  async cleanup(project) {
    const { path: projectPath } = project;
    const { composePath, isGenerated } = this.getComposeFile(project);
    this.healthStates.delete(project.id.toString());

    // Remove containers and volumes
    if (composePath) {
      try {
        await execCompose(['down', '-v'], composePath, { cwd: projectPath, timeout: DOCKER_CMD_TIMEOUT });
        projectInfo(projectPath, 'Container cleaned up', { name: project.name });
      } catch (error) {
        projectError(projectPath, 'Container cleanup failed', { name: project.name, error: error.message });
        // Continue with directory cleanup even if down fails
      }
    }

    // Remove auto-generated ~/.jump.sh/{slug}/ directory
    if (isGenerated) {
      const slug = getProjectSlug(project);
      const jumpshDir = getJumpshDir(slug);
      try {
        fs.rmSync(jumpshDir, { recursive: true, force: true });
        projectInfo(projectPath, 'Removed generated compose dir', { dir: jumpshDir });
      } catch (error) {
        projectError(projectPath, 'Failed to remove compose dir', { dir: jumpshDir, error: error.message });
      }
    }

    return { success: true };
  }

  async getStatus(project) {
    const { path: projectPath } = project;
    const { composePath } = this.getComposeFile(project);

    try {
      const { stdout } = await execCompose(
        ['ps', '--format', 'json'],
        composePath,
        { cwd: projectPath, timeout: DOCKER_CMD_TIMEOUT }
      );

      if (!stdout.trim()) {
        return { running: false, containers: [] };
      }

      const containers = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);

      const running = containers.some(c =>
        c.State === 'running' || c.Status?.includes('Up')
      );

      return { running, containers };
    } catch (error) {
      return { running: false, containers: [], error: error.message };
    }
  }

  async getPort(project) {
    const status = await this.getStatus(project);
    if (!status.running || !status.containers.length) return null;

    const container = status.containers[0];

    if (container.Publishers?.length) {
      const pub = container.Publishers.find(p => p.PublishedPort);
      if (pub) return pub.PublishedPort;
    }

    if (container.Ports) {
      const match = container.Ports.match(/0\.0\.0\.0:(\d+)/);
      if (match) return parseInt(match[1], 10);
    }

    return null;
  }

  async getLogs(project, lines = 100) {
    const { path: projectPath } = project;
    const { composePath } = this.getComposeFile(project);

    try {
      const { stdout } = await execCompose(
        ['logs', `--tail=${lines}`, '--no-color'],
        composePath,
        { cwd: projectPath, timeout: DOCKER_CMD_TIMEOUT }
      );
      return stdout;
    } catch (error) {
      return `Error getting logs: ${error.message}`;
    }
  }

  streamLogs(project, res) {
    const { path: projectPath } = project;
    const { composePath } = this.getComposeFile(project);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const { command, args } = buildComposeSpawn(['logs', '-f', '--no-color'], composePath);
    const child = this.spawner(command, args, { cwd: projectPath });

    child.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          res.write(`data: ${JSON.stringify({ line })}\n\n`);
        }
      }
    });

    child.stderr.on('data', (data) => {
      res.write(`data: ${JSON.stringify({ line: data.toString(), error: true })}\n\n`);
    });

    child.on('close', () => {
      res.write(`data: ${JSON.stringify({ closed: true })}\n\n`);
      res.end();
    });

    res.on('close', () => {
      child.kill();
    });

    return child;
  }
  async _probeHealth(project, port) {
    const id = project.id.toString();
    const maxAttempts = 120; // 60 seconds at 500ms intervals

    for (let i = 0; i < maxAttempts; i++) {
      const status = await this.getStatus(project);
      if (!status.running) {
        this.healthStates.set(id, 'unknown');
        this._emitStartup(project.id, { error: 'Container stopped unexpectedly', done: true });
        return;
      }

      if (await this._canConnect(port)) {
        this.healthStates.set(id, 'healthy');
        console.log(`✓ ${project.name} health check passed on port ${port}`);
        this._emitStartup(project.id, { step: 5, totalSteps: TOTAL_STEPS, label: STEP_LABELS[5], done: true });
        return;
      }

      await new Promise(r => setTimeout(r, 500));
    }

    this.healthStates.set(id, 'unhealthy');
    console.log(`✗ ${project.name} health check failed after 60s`);
    this._emitStartup(project.id, { error: 'Health check failed after 60s', done: true });
  }

  async _canConnect(port) {
    return new Promise(resolve => {
      const socket = new net.Socket();
      socket.setTimeout(1000);

      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });

      socket.on('error', () => resolve(false));
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.connect(port, '127.0.0.1');
    });
  }

  getBuildLog(project) {
    const slug = getProjectSlug(project);
    return readBuildLog(slug);
  }

  getHealth(projectId) {
    return this.healthStates.get(projectId?.toString()) || 'unknown';
  }

  /**
   * Like getHealth, but if a project is running with 'unknown' health
   * (e.g. after server restart), trigger a background probe and return
   * 'starting' so the UI shows a spinner instead of broken links.
   */
  getHealthWithProbe(project, status) {
    const health = this.getHealth(project.id);
    if (health === 'unknown' && status.running) {
      this.healthStates.set(project.id.toString(), 'starting');
      this._emitStartup(project.id, { step: 4, totalSteps: TOTAL_STEPS, label: STEP_LABELS[4] });
      this.getPort(project).then(port => {
        if (port) this._probeHealth(project, port);
      });
      return 'starting';
    }
    return health;
  }
}

export default DockerManager;
