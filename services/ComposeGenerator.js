import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Get the jumpsh config directory for a project slug.
 * @param {string} slug - Project slug (e.g., 'trade-tracker', 'david-app')
 * @returns {string} Absolute path like ~/.jump.sh/trade-tracker/
 */
export function getJumpshDir(slug) {
  return path.join(os.homedir(), '.jump.sh', slug);
}

/**
 * Generate Dockerfile and docker-compose.yml for a project.
 * Files are stored in ~/.jump.sh/{slug}/ to ensure unique Docker Compose project names.
 *
 * @param {string} projectPath - Absolute path to the project
 * @param {string} slug - Project slug for the config directory (subdomain or slugified name)
 * @param {object} detection - Result from ProjectDetector.detectProjectType()
 * @param {number} assignedPort - Host port to expose
 * @param {{ force?: boolean, overrides?: { build?: string, start?: string, port?: number, dockerImage?: string } }} [opts]
 * @returns {{ composePath: string, dockerfilePath: string, skipped?: boolean }}
 */
export function generateCompose(projectPath, slug, detection, assignedPort, opts = {}) {
  // Apply user overrides: override > detection
  if (opts.overrides) {
    const o = opts.overrides;
    if (o.build) detection = { ...detection, installCommand: o.build };
    if (o.start) detection = { ...detection, devCommand: o.start };
    if (o.port) detection = { ...detection, port: o.port };
    if (o.dockerImage) detection = { ...detection, dockerImage: o.dockerImage };
  }
  const jumpshDir = getJumpshDir(slug);
  const composePath = path.join(jumpshDir, 'docker-compose.yml');
  const dockerfilePath = path.join(jumpshDir, 'Dockerfile');
  const transformedEnvPath = path.join(jumpshDir, '.env.docker');

  // Don't overwrite existing files unless forced
  if (!opts.force && fs.existsSync(composePath) && fs.existsSync(dockerfilePath)) {
    return { composePath, dockerfilePath, skipped: true };
  }

  fs.mkdirSync(jumpshDir, { recursive: true });

  // Generate transformed env file for Docker runtime:
  // rewrite localhost/127.0.0.1 to host.docker.internal so services on host are reachable.
  const projectEnvPath = path.join(projectPath, '.env');
  if (fs.existsSync(projectEnvPath)) {
    try {
      const raw = fs.readFileSync(projectEnvPath, 'utf8');
      const transformed = raw
        .split('\n')
        .map((line) => {
          const t = line.trim();
          if (!t || t.startsWith('#') || !line.includes('=')) return line;
          const i = line.indexOf('=');
          const key = line.slice(0, i);
          const value = line.slice(i + 1)
            .replace(/localhost/g, 'host.docker.internal')
            .replace(/127\.0\.0\.1/g, 'host.docker.internal');
          return `${key}=${value}`;
        })
        .join('\n');
      fs.writeFileSync(transformedEnvPath, transformed + (transformed.endsWith('\n') ? '' : '\n'));
    } catch { /* best effort */ }
  }

  // Write .dockerignore in project root to exclude large/irrelevant directories
  const dockerignorePath = path.join(projectPath, '.dockerignore');
  if (!fs.existsSync(dockerignorePath)) {
    const dockerignore = [
      'node_modules',
      '.git',
      '.jump.sh',
      'dump',
      'data',
      'tmp',
      '.worktrees',
      '*.log',
      '.env*',
      'coverage',
      '.nyc_output',
      'dist',
      'build',
      '.DS_Store',
    ].join('\n');
    fs.writeFileSync(dockerignorePath, dockerignore + '\n');
  }

  // Static sites use nginx image directly — no Dockerfile needed
  const needsDockerfile = detection.type !== 'static';
  const compose = generateComposeYaml(detection, assignedPort, projectPath, jumpshDir);

  if (needsDockerfile) {
    const dockerfile = generateDockerfile(detection);
    if (!fs.existsSync(dockerfilePath) || opts.force) {
      fs.writeFileSync(dockerfilePath, dockerfile);
    }
  }
  if (!fs.existsSync(composePath) || opts.force) {
    fs.writeFileSync(composePath, compose);
  }

  return { composePath, dockerfilePath, skipped: false };
}

function generateDockerfile(detection) {
  if (detection.type === 'node') {
    return generateNodeDockerfile(detection);
  }
  if (detection.type === 'python') {
    return generatePythonDockerfile(detection);
  }
  if (detection.type === 'go') {
    return generateGoDockerfile(detection);
  }
  if (detection.type === 'ruby') {
    return generateRubyDockerfile(detection);
  }
  throw new Error(`Unsupported project type for Dockerfile generation: ${detection.type}`);
}

function generateNodeDockerfile(detection) {
  const pm = detection.packageManager || { name: 'npm', install: 'npm install' };
  const installCmd = detection.installCommand || pm.install;

  // Copy lock files alongside package.json
  const copyFiles = ['package.json'];
  if (pm.lockFile) copyFiles.push(pm.lockFile);
  const copyLine = `COPY ${copyFiles.join(' ')} ./`;

  // For bun, use oven/bun image (unless overridden)
  const baseImage = detection.dockerImage || (pm.name === 'bun' ? 'oven/bun:latest' : 'node:20-slim');

  // For pnpm, need to enable corepack
  const pnpmSetup = pm.name === 'pnpm' ? '\nRUN corepack enable' : '';

  // Build tools for native modules (node-gyp needs python3, make, g++)
  // oven/bun is Debian-based too, so apt-get works for both
  const buildTools = pm.name === 'bun'
    ? ''
    : '\nRUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*';

  return `# Auto-generated by jump.sh — do not edit
FROM ${baseImage}${buildTools}
WORKDIR /app${pnpmSetup}
${copyLine}
RUN ${installCmd}
COPY . .
CMD ${formatCmd(detection.devCommand)}
`;
}

function generatePythonDockerfile(detection) {
  const installCmd = detection.installCommand || 'pip install -r requirements.txt';
  const copyLine = installCmd.includes('pyproject')
    ? 'COPY pyproject.toml ./\nCOPY setup.py* setup.cfg* ./'
    : 'COPY requirements.txt ./';

  const baseImage = detection.dockerImage || 'python:3.12-slim';
  return `# Auto-generated by jump.sh — do not edit
FROM ${baseImage}
WORKDIR /app
${copyLine}
RUN ${installCmd}
COPY . .
CMD ${formatCmd(detection.devCommand)}
`;
}

/**
 * Format a dev command as a Dockerfile CMD.
 * Uses exec form ["a","b"] for simple commands, shell form for commands
 * with shell metacharacters (pipes, redirects, &&, etc.)
 */
function formatCmd(devCommand) {
  if (/[|&;<>\`$"'\\]/.test(devCommand)) {
    // Shell metacharacters present — use shell form so sh interprets them
    return `["sh", "-c", ${JSON.stringify(devCommand)}]`;
  }
  return JSON.stringify(devCommand.split(' '));
}

function generateRubyDockerfile(detection) {
  const baseImage = detection.dockerImage || 'ruby:3.2';
  return `# Auto-generated by jump.sh — do not edit
FROM ${baseImage}
RUN apt-get update && apt-get install -y build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Gemfile Gemfile.lock* ./
RUN bundle install
COPY . .
CMD ${formatCmd(detection.devCommand)}
`;
}

function generateGoDockerfile(detection = {}) {
  const baseImage = detection.dockerImage || 'golang:1.22-alpine';
  return `# Auto-generated by jump.sh — do not edit
FROM ${baseImage}
WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
CMD ["go", "run", "."]
`;
}

function generateComposeYaml(detection, assignedPort, projectPath, jumpshDir) {
  const internalPort = detection.port;

  // Static sites: use nginx image directly, mount project to nginx html dir
  if (detection.type === 'static') {
    return `# Auto-generated by jump.sh — do not edit
services:
  app:
    image: ${detection.dockerImage || 'nginx:alpine'}
    ports:
      - "${assignedPort}:${internalPort}"
    volumes:
      - ${projectPath}:/usr/share/nginx/html:ro
    extra_hosts:
      - "host.docker.internal:host-gateway"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
`;
  }

  // Volumes need absolute paths since compose file is in ~/.jump.sh/{slug}/
  const volumes = [`      - ${projectPath}:/app`];

  // For Node, add anonymous volume to prevent host node_modules overwrite
  if (detection.type === 'node') {
    volumes.push('      - /app/node_modules');
  }

  const envVars = [];
  if (detection.type === 'node') {
    envVars.push('      - NODE_ENV=development');
    envVars.push('      - HOST=0.0.0.0');
  }
  if (detection.type === 'python') {
    envVars.push('      - PYTHONDONTWRITEBYTECODE=1');
    envVars.push('      - PYTHONUNBUFFERED=1');
  }

  const envSection = envVars.length
    ? `\n    environment:\n${envVars.join('\n')}`
    : '';

  // Only include env_file entries for files that exist (use absolute paths)
  const envFiles = [];
  if (fs.existsSync(path.join(projectPath, '.env'))) {
    envFiles.push(`      - ${path.join(projectPath, '.env')}`);
  }
  if (fs.existsSync(path.join(jumpshDir, '.env.docker'))) {
    envFiles.push(`      - ${path.join(jumpshDir, '.env.docker')}`);
  }
  const envFileSection = envFiles.length
    ? `\n    env_file:\n${envFiles.join('\n')}`
    : '';

  return `# Auto-generated by jump.sh — do not edit
services:
  app:
    build:
      context: ${projectPath}
      dockerfile: ${path.join(jumpshDir, 'Dockerfile')}
    ports:
      - "${assignedPort}:${internalPort}"
    volumes:
${volumes.join('\n')}${envFileSection}${envSection}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    command: ${detection.devCommand}
`;
}

export default { generateCompose, getJumpshDir };
