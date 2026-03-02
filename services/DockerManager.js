import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { execCompose, buildComposeSpawn } from './dockerCommand.js';
import { detectProjectType } from './ProjectDetector.js';
import { generateCompose } from './ComposeGenerator.js';
import { projectInfo, projectWarn, projectError } from '../lib/devlog.js';

// Timeouts (ms)
const DOCKER_BUILD_TIMEOUT = 5 * 60 * 1000; // 5 min for up --build
const DOCKER_CMD_TIMEOUT = 30 * 1000;        // 30s for status/logs/down

class DockerManager {
  constructor(db) {
    this.db = db;
    this.healthStates = new Map(); // projectId -> 'unknown' | 'starting' | 'healthy' | 'unhealthy'
  }

  /**
   * Find the compose file for a project.
   * Checks: project root docker-compose.yml/yaml, then .jump.sh/docker-compose.yml
   * @returns {{ composePath: string|null, isGenerated: boolean }}
   */
  getComposeFile(projectPath) {
    const rootYml = path.join(projectPath, 'docker-compose.yml');
    const rootYaml = path.join(projectPath, 'docker-compose.yaml');
    const jumpshYml = path.join(projectPath, '.jump.sh', 'docker-compose.yml');

    if (fs.existsSync(rootYml)) return { composePath: rootYml, isGenerated: false };
    if (fs.existsSync(rootYaml)) return { composePath: rootYaml, isGenerated: false };
    if (fs.existsSync(jumpshYml)) return { composePath: jumpshYml, isGenerated: true };

    return { composePath: null, isGenerated: false };
  }

  async start(project) {
    const { id, path: projectPath, name } = project;

    let { composePath, isGenerated } = this.getComposeFile(projectPath);

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
        const result = generateCompose(projectPath, detection, assignedPort);
        composePath = result.composePath;
        if (result.skipped) {
          console.log(`Using existing .jump.sh/docker-compose.yml for ${name}`);
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
        const refreshed = generateCompose(projectPath, detection, assignedPort, { force: true });
        composePath = refreshed.composePath;
      } catch (err) {
        return { success: false, error: `Compose refresh failed: ${err.message}` };
      }
    }

    try {
      await execCompose(
        ['up', '-d', '--build'],
        composePath,
        { cwd: projectPath, timeout: DOCKER_BUILD_TIMEOUT }
      );
      const status = await this.getStatus(project);
      projectInfo(projectPath, 'Container started', { name });
      const port = await this.getPort(project);
      if (port) {
        this.healthStates.set(id.toString(), 'starting');
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
          generateCompose(projectPath, detection, newPort, { force: true });
          console.log(`Retrying with port ${newPort}...`);
          // Retry once
          await execCompose(
            ['up', '-d', '--build'],
            composePath,
            { cwd: projectPath, timeout: DOCKER_BUILD_TIMEOUT }
          );
          const retryStatus = await this.getStatus(project);
          projectInfo(projectPath, 'Container started after port retry', { name, port: newPort });
          const retryPort = await this.getPort(project);
          if (retryPort) {
            this.healthStates.set(id.toString(), 'starting');
            this._probeHealth(project, retryPort);
          }
          return { success: true, status: retryStatus };
        } catch (retryError) {
          projectError(projectPath, 'Port conflict retry failed', { name, error: retryError.message });
          return { success: false, error: `Port conflict retry failed: ${retryError.message}` };
        }
      }
      projectError(projectPath, 'Container start failed', { name, error: error.message });
      return { success: false, error: error.message };
    }
  }

  async stop(project) {
    const { path: projectPath } = project;
    const { composePath } = this.getComposeFile(projectPath);
    this.healthStates.set(project.id.toString(), 'unknown');

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

  async getStatus(project) {
    const { path: projectPath } = project;
    const { composePath } = this.getComposeFile(projectPath);

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
    const { composePath } = this.getComposeFile(projectPath);

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
    const { composePath } = this.getComposeFile(projectPath);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const { command, args } = buildComposeSpawn(['logs', '-f', '--no-color'], composePath);
    const child = spawn(command, args, { cwd: projectPath });

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
        return;
      }

      if (await this._canConnect(port)) {
        this.healthStates.set(id, 'healthy');
        console.log(`✓ ${project.name} health check passed on port ${port}`);
        return;
      }

      await new Promise(r => setTimeout(r, 500));
    }

    this.healthStates.set(id, 'unhealthy');
    console.log(`✗ ${project.name} health check failed after 60s`);
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

  getHealth(projectId) {
    return this.healthStates.get(projectId?.toString()) || 'unknown';
  }
}

export default DockerManager;
