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
    if (o.env) detection = { ...detection, overrideEnv: o.env };
  }
  const jumpshDir = getJumpshDir(slug);
  const composePath = path.join(jumpshDir, 'docker-compose.yml');
  const dockerfilePath = path.join(jumpshDir, 'Dockerfile');
  const transformedEnvPath = path.join(jumpshDir, '.env.docker');

  validateComposeBuildPaths(projectPath, jumpshDir, detection);

  // Don't overwrite existing files unless forced
  if (!opts.force && fs.existsSync(composePath) && fs.existsSync(dockerfilePath)) {
    return { composePath, dockerfilePath, skipped: true };
  }

  const projectUser = detection.type === 'static'
    ? null
    : getProjectOwnerIdentity(projectPath);

  fs.mkdirSync(jumpshDir, { recursive: true });

  // Generate transformed env file for Docker runtime:
  // rewrite localhost/127.0.0.1 to host.docker.internal so services on host are reachable.
  // For worktrees without their own .env, fall back to the parent project's .env.
  const ownEnvPath = path.join(projectPath, '.env');
  const envSourcePath = fs.existsSync(ownEnvPath)
    ? ownEnvPath
    : (opts.parentEnvPath && fs.existsSync(opts.parentEnvPath) ? opts.parentEnvPath : null);
  if (envSourcePath) {
    try {
      const raw = fs.readFileSync(envSourcePath, 'utf8');
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

  // Static sites use pre-built images — no Dockerfile needed
  const needsDockerfile = detection.type !== 'static';
  const compose = generateComposeYaml(detection, assignedPort, projectPath, jumpshDir, {
    envSourcePath,
    projectUser,
  });

  if (needsDockerfile) {
    const dockerfile = generateDockerfile(detection, projectPath);
    if (!fs.existsSync(dockerfilePath) || opts.force) {
      fs.writeFileSync(dockerfilePath, dockerfile);
    }
  }
  if (!fs.existsSync(composePath) || opts.force) {
    fs.writeFileSync(composePath, compose);
  }

  return { composePath, dockerfilePath, skipped: false };
}

function validateComposeBuildPaths(projectPath, jumpshDir, detection) {
  if (detection.type === 'static') return;

  const unsupportedPaths = [
    ['project path', projectPath],
    ['jump.sh config path', jumpshDir],
  ].filter(([, value]) => value.includes('$'));

  if (!unsupportedPaths.length) return;

  const details = unsupportedPaths
    .map(([label, value]) => `${label} "${value}"`)
    .join(' and ');
  throw new Error(`Docker Compose cannot build this project because its ${details} contains a literal "$". Docker Compose build/bake re-interprets escaped dollar signs in build context and Dockerfile paths; move the project or choose a slug/HOME path without "$".`);
}

function getProjectOwnerIdentity(projectPath) {
  let stats;
  try {
    stats = fs.statSync(projectPath);
  } catch (error) {
    throw new Error(`Unable to read owner identity for project path "${projectPath}": ${error.message}`, { cause: error });
  }

  const { uid, gid } = stats;
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error(`Invalid owner identity for project path "${projectPath}": expected non-negative integer uid/gid, received uid=${String(uid)}, gid=${String(gid)}`);
  }

  return `${uid}:${gid}`;
}

function generateDockerfile(detection, projectPath) {
  if (detection.type === 'node') {
    return generateNodeDockerfile(detection, projectPath);
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
  if (detection.type === 'php') {
    return generatePhpDockerfile(detection);
  }
  throw new Error(`Unsupported project type for Dockerfile generation: ${detection.type}`);
}

function generateNodeDockerfile(detection, projectPath) {
  const pm = detection.packageManager || { name: 'npm', install: 'npm install' };
  const installCmd = detection.installCommand || pm.install;

  // Copy lock files alongside package.json
  const copyFiles = ['package.json'];
  if (pm.lockFile) copyFiles.push(pm.lockFile);
  const copyLine = `COPY ${copyFiles.join(' ')} ./`;

  // Workspace package.json files must be present before `npm install` so that
  // workspace dependencies get installed. Without this, `vite` (declared in
  // a workspace's package.json) is never installed and `npm run dev --workspace foo`
  // fails with "vite: not found".
  const workspaceCopyLines = projectPath
    ? getWorkspaceManifestCopyLines(projectPath)
    : '';

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
${copyLine}${workspaceCopyLines}
RUN ${installCmd}
COPY . .
CMD ${formatCmd(detection.devCommand)}
`;
}

function getWorkspacePackagePaths(projectPath) {
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(pkgPath)) return [];
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const patterns = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : Array.isArray(pkg.workspaces?.packages)
        ? pkg.workspaces.packages
        : [];
    if (!patterns.length) return [];

    const paths = [];
    for (const pattern of patterns) {
      if (typeof pattern !== 'string') continue;
      const p = pattern.replace(/^\.\//, '').replace(/\/$/, '');
      if (!p) continue;
      if (p.includes('*')) {
        const idx = p.indexOf('*');
        const parent = p.slice(0, idx).replace(/\/$/, '');
        const parentPath = parent ? path.join(projectPath, parent) : projectPath;
        if (!fs.existsSync(parentPath)) continue;
        let entries;
        try {
          entries = fs.readdirSync(parentPath, { withFileTypes: true });
        } catch { continue; }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('.')) continue;
          const wsPath = parent ? `${parent}/${entry.name}` : entry.name;
          const wsPkg = path.join(projectPath, wsPath, 'package.json');
          if (fs.existsSync(wsPkg)) paths.push(wsPath);
        }
      } else {
        const wsPkg = path.join(projectPath, p, 'package.json');
        if (fs.existsSync(wsPkg)) paths.push(p);
      }
    }
    return Array.from(new Set(paths));
  } catch {
    return [];
  }
}

function getWorkspaceManifestCopyLines(projectPath) {
  const paths = getWorkspacePackagePaths(projectPath);
  if (!paths.length) return '';
  return '\n' + paths
    .map((ws) => `COPY ${ws}/package.json ${ws}/package.json`)
    .join('\n');
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
  if (/[|&;<>`$"'\\]/.test(devCommand)) {
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

function generatePhpDockerfile(detection) {
  const baseImage = detection.dockerImage || 'php:8.3-cli';
  const extensions = detection.phpExtensions || [];
  const extInstall = extensions.length
    ? `\nRUN docker-php-ext-install ${extensions.join(' ')}`
    : '';

  const installSection = detection.installCommand
    ? `\nCOPY --from=composer:latest /usr/bin/composer /usr/bin/composer\nCOPY composer.json composer.lock* ./\nRUN composer install --no-interaction --no-scripts`
    : '';

  const cmd = detection.devCommand
    ? `\nCMD ${formatCmd(detection.devCommand)}`
    : '';

  return `# Auto-generated by jump.sh — do not edit
FROM ${baseImage}${extInstall}
WORKDIR /app${installSection}
COPY . .${cmd}
`;
}

function serializeComposeScalar(value) {
  return JSON.stringify(String(value).replaceAll('$', () => '$$'));
}

function generateComposeYaml(detection, assignedPort, projectPath, jumpshDir, opts = {}) {
  const internalPort = detection.port;

  // Static sites: use nginx image directly, mount project to nginx html dir
  if (detection.type === 'static') {
    return `# Auto-generated by jump.sh — do not edit
services:
  app:
    image: ${serializeComposeScalar(detection.dockerImage || 'nginx:alpine')}
    ports:
      - "127.0.0.1:${assignedPort}:${internalPort}"
    volumes:
      - ${serializeComposeScalar(`${projectPath}:/usr/share/nginx/html:ro`)}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
`;
  }

  const dependencyVolume = detection.type === 'node'
    ? { name: 'app_node_modules', mountPath: '/app/node_modules', sourcePath: '/app/node_modules', initService: 'app_node_modules_init' }
    : detection.type === 'php'
      ? { name: 'app_vendor', mountPath: '/app/vendor', sourcePath: '/app/vendor', initService: 'app_vendor_init' }
      : null;

  // Volumes need absolute paths since compose file is in ~/.jump.sh/{slug}/
  const volumes = [`      - ${serializeComposeScalar(`${projectPath}:/app`)}`];
  if (dependencyVolume) {
    volumes.push(`      - ${dependencyVolume.name}:${dependencyVolume.mountPath}`);
  }

  const envVars = [`      - PORT=${internalPort}`];
  const overrideEnvVars = [];
  let hasHomeOverride = false;
  if (detection.overrideEnv) {
    try {
      const userEnvVars = JSON.parse(detection.overrideEnv);
      for (const { key, value } of userEnvVars) {
        if (key && value !== undefined) {
          overrideEnvVars.push(`      - ${serializeComposeScalar(`${key}=${value}`)}`);
          if (key === 'HOME') hasHomeOverride = true;
        }
      }
    } catch { /* ignore invalid JSON */ }
  }
  if (!hasHomeOverride) {
    envVars.push('      - HOME=/tmp');
  }
  if (detection.type === 'node') {
    envVars.push('      - NODE_ENV=development');
    envVars.push('      - HOST=0.0.0.0');
  }
  if (detection.type === 'python') {
    envVars.push('      - PYTHONDONTWRITEBYTECODE=1');
    envVars.push('      - PYTHONUNBUFFERED=1');
  }
  // User overrides take precedence over generated defaults and env_file values.
  envVars.push(...overrideEnvVars);

  const envSection = envVars.length
    ? `\n    environment:\n${envVars.join('\n')}`
    : '';

  // Only include env_file entries for files that exist (use absolute paths).
  // For worktrees, inherit the parent's .env when the worktree has none.
  const envFiles = [];
  const ownEnv = path.join(projectPath, '.env');
  if (fs.existsSync(ownEnv)) {
    envFiles.push(`      - ${serializeComposeScalar(ownEnv)}`);
  } else if (opts.envSourcePath && fs.existsSync(opts.envSourcePath)) {
    envFiles.push(`      - ${serializeComposeScalar(opts.envSourcePath)}`);
  }
  if (fs.existsSync(path.join(jumpshDir, '.env.docker'))) {
    envFiles.push(`      - ${serializeComposeScalar(path.join(jumpshDir, '.env.docker'))}`);
  }
  const envFileSection = envFiles.length
    ? `\n    env_file:\n${envFiles.join('\n')}`
    : '';

  const dependsOnSection = dependencyVolume
    ? `\n    depends_on:\n      ${dependencyVolume.initService}:\n        condition: service_completed_successfully`
    : '';

  const dependencyInitCommand = dependencyVolume
    ? [
      'set -eu',
      'find /deps -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
      `if [ -d ${dependencyVolume.sourcePath} ]; then cp -a ${dependencyVolume.sourcePath}/. /deps/; fi`,
      `chown -R ${opts.projectUser} /deps`,
    ].join('; ')
    : '';

  const dependencyInitSection = dependencyVolume
    ? `  ${dependencyVolume.initService}:
    user: "0:0"
    build:
      context: ${serializeComposeScalar(projectPath)}
      dockerfile: ${serializeComposeScalar(path.join(jumpshDir, 'Dockerfile'))}
    entrypoint: []
    volumes:
      - ${dependencyVolume.name}:/deps
    command: ${JSON.stringify(['sh', '-c', dependencyInitCommand])}
`
    : '';

  const namedVolumesSection = dependencyVolume
    ? `volumes:\n  ${dependencyVolume.name}:\n`
    : '';

  return `# Auto-generated by jump.sh — do not edit
services:
  app:
    network_mode: bridge
    user: "${opts.projectUser}"
    build:
      context: ${serializeComposeScalar(projectPath)}
      dockerfile: ${serializeComposeScalar(path.join(jumpshDir, 'Dockerfile'))}
    ports:
      - "127.0.0.1:${assignedPort}:${internalPort}"
    volumes:
${volumes.join('\n')}${dependsOnSection}${envFileSection}${envSection}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    command: ${serializeComposeScalar(detection.devCommand)}
${dependencyInitSection}${namedVolumesSection}`;
}

export default { generateCompose, getJumpshDir };
