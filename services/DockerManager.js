import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

class DockerManager {
  constructor() {
    this.runningContainers = new Map(); // projectId -> containerId
  }

  async start(project) {
    const { id, path: projectPath, name } = project;
    
    // Check if docker-compose.yml exists
    const composePath = path.join(projectPath, 'docker-compose.yml');
    const composeYamlPath = path.join(projectPath, 'docker-compose.yaml');
    
    if (!fs.existsSync(composePath) && !fs.existsSync(composeYamlPath)) {
      // TODO: Auto-generate with nixpacks
      return { success: false, error: 'No docker-compose.yml found. Auto-generation coming soon.' };
    }

    try {
      await execAsync('docker compose up -d --build', { cwd: projectPath });
      const status = await this.getStatus(project);
      return { success: true, status };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async stop(project) {
    const { path: projectPath } = project;
    
    try {
      await execAsync('docker compose down', { cwd: projectPath });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async restart(project) {
    await this.stop(project);
    return this.start(project);
  }

  async getStatus(project) {
    const { path: projectPath } = project;
    
    try {
      const { stdout } = await execAsync(
        'docker compose ps --format json',
        { cwd: projectPath }
      );
      
      if (!stdout.trim()) {
        return { running: false, containers: [] };
      }

      // Parse JSON lines (one per container)
      const containers = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
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
    
    // Try to get port from Publishers array
    if (container.Publishers?.length) {
      const pub = container.Publishers.find(p => p.PublishedPort);
      if (pub) return pub.PublishedPort;
    }

    // Try parsing from Ports string (e.g., "0.0.0.0:3000->3000/tcp")
    if (container.Ports) {
      const match = container.Ports.match(/0\.0\.0\.0:(\d+)/);
      if (match) return parseInt(match[1], 10);
    }

    return null;
  }

  async getLogs(project, lines = 100) {
    const { path: projectPath } = project;
    
    try {
      const { stdout } = await execAsync(
        `docker compose logs --tail=${lines} --no-color`,
        { cwd: projectPath }
      );
      return stdout;
    } catch (error) {
      return `Error getting logs: ${error.message}`;
    }
  }

  // SSE log streaming
  streamLogs(project, res) {
    const { path: projectPath } = project;
    
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const child = spawn('docker', ['compose', 'logs', '-f', '--no-color'], {
      cwd: projectPath
    });

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

    // Cleanup on client disconnect
    res.on('close', () => {
      child.kill();
    });

    return child;
  }
}

export default DockerManager;
