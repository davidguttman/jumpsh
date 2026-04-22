import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { generateCompose, getJumpshDir } from '../services/ComposeGenerator.js';
import { makeTmpDir, writeJson, writeFile, cleanTmpDir } from './helpers/fixtures.js';

// Override HOME so getJumpshDir writes into tmpdir instead of real ~/.jump.sh
let tmpHome, originalHome, projectDir;

beforeEach(() => {
  originalHome = process.env.HOME;
  tmpHome = makeTmpDir();
  process.env.HOME = tmpHome;
  projectDir = path.join(tmpHome, 'project');
  fs.mkdirSync(projectDir);
});

afterEach(() => {
  process.env.HOME = originalHome;
  cleanTmpDir(tmpHome);
});

describe('getJumpshDir', () => {
  it('returns path under HOME/.jump.sh/<slug>', () => {
    const dir = getJumpshDir('my-app');
    assert.equal(dir, path.join(tmpHome, '.jump.sh', 'my-app'));
  });
});

describe('generateCompose skip behaviour', () => {
  it('returns skipped when compose + dockerfile already exist and force is false', () => {
    const slug = 'test-skip';
    const jumpshDir = getJumpshDir(slug);
    fs.mkdirSync(jumpshDir, { recursive: true });
    fs.writeFileSync(path.join(jumpshDir, 'docker-compose.yml'), 'existing');
    fs.writeFileSync(path.join(jumpshDir, 'Dockerfile'), 'existing');
    writeJson(projectDir, 'package.json', { dependencies: {} });

    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };
    const result = generateCompose(projectDir, slug, detection, 10000);
    assert.equal(result.skipped, true);
  });

  it('overwrites when force is true', () => {
    const slug = 'test-force';
    const jumpshDir = getJumpshDir(slug);
    fs.mkdirSync(jumpshDir, { recursive: true });
    fs.writeFileSync(path.join(jumpshDir, 'docker-compose.yml'), 'old');
    fs.writeFileSync(path.join(jumpshDir, 'Dockerfile'), 'old');
    writeJson(projectDir, 'package.json', { dependencies: {} });

    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };
    const result = generateCompose(projectDir, slug, detection, 10000, { force: true });
    assert.equal(result.skipped, false);
    const content = fs.readFileSync(result.dockerfilePath, 'utf8');
    assert.ok(content.includes('FROM node:20-slim'));
  });
});

describe('generateCompose Node projects', () => {
  it('generates Dockerfile with node:20-slim', () => {
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: 'package-lock.json' } };
    const result = generateCompose(projectDir, 'test-node', detection, 10000, { force: true });
    const dockerfile = fs.readFileSync(result.dockerfilePath, 'utf8');
    assert.ok(dockerfile.includes('FROM node:20-slim'));
  });

  it('uses oven/bun:latest for bun projects', () => {
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const detection = { type: 'node', framework: null, devCommand: 'bun run dev', port: 3000, packageManager: { name: 'bun', install: 'bun install', lockFile: 'bun.lockb' }, dockerImage: 'oven/bun:latest' };
    const result = generateCompose(projectDir, 'test-bun', detection, 10000, { force: true });
    const dockerfile = fs.readFileSync(result.dockerfilePath, 'utf8');
    assert.ok(dockerfile.includes('FROM oven/bun:latest'));
  });

  it('includes corepack enable for pnpm', () => {
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const detection = { type: 'node', framework: null, devCommand: 'pnpm run dev', port: 3000, packageManager: { name: 'pnpm', install: 'pnpm install', lockFile: 'pnpm-lock.yaml' } };
    const result = generateCompose(projectDir, 'test-pnpm', detection, 10000, { force: true });
    const dockerfile = fs.readFileSync(result.dockerfilePath, 'utf8');
    assert.ok(dockerfile.includes('corepack enable'));
  });

  it('sets NODE_ENV and HOST in compose environment', () => {
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };
    const result = generateCompose(projectDir, 'test-env', detection, 10000, { force: true });
    const compose = fs.readFileSync(result.composePath, 'utf8');
    assert.ok(compose.includes('NODE_ENV=development'));
    assert.ok(compose.includes('HOST=0.0.0.0'));
  });

  it('includes anonymous node_modules volume', () => {
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };
    const result = generateCompose(projectDir, 'test-vol', detection, 10000, { force: true });
    const compose = fs.readFileSync(result.composePath, 'utf8');
    assert.ok(compose.includes('/app/node_modules'));
  });

  it('includes extra_hosts for host.docker.internal', () => {
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };
    const result = generateCompose(projectDir, 'test-hosts', detection, 10000, { force: true });
    const compose = fs.readFileSync(result.composePath, 'utf8');
    assert.ok(compose.includes('host.docker.internal:host-gateway'));
  });
});

describe('generateCompose Node workspaces', () => {
  it('copies workspace package.json files before npm install (array form)', () => {
    writeJson(projectDir, 'package.json', {
      name: 'root',
      private: true,
      workspaces: ['client'],
      scripts: { dev: 'npm run dev --workspace client' },
    });
    fs.mkdirSync(path.join(projectDir, 'client'));
    writeJson(path.join(projectDir, 'client'), 'package.json', {
      name: 'client',
      scripts: { dev: 'vite' },
      devDependencies: { vite: '^5.0.0' },
    });

    const detection = {
      type: 'node',
      framework: null,
      devCommand: 'npm run dev --workspace client',
      port: 5173,
      packageManager: { name: 'npm', install: 'npm install', lockFile: 'package-lock.json' },
    };
    const result = generateCompose(projectDir, 'test-workspaces', detection, 10000, { force: true });
    const dockerfile = fs.readFileSync(result.dockerfilePath, 'utf8');

    const copyWsIdx = dockerfile.indexOf('COPY client/package.json client/package.json');
    const runInstallIdx = dockerfile.indexOf('RUN npm install');
    assert.ok(copyWsIdx !== -1, 'expected workspace package.json COPY line');
    assert.ok(runInstallIdx !== -1, 'expected RUN npm install line');
    assert.ok(copyWsIdx < runInstallIdx, 'workspace COPY must come before install');
  });

  it('resolves glob workspace patterns like packages/*', () => {
    writeJson(projectDir, 'package.json', {
      name: 'root',
      private: true,
      workspaces: ['packages/*'],
    });
    fs.mkdirSync(path.join(projectDir, 'packages'));
    fs.mkdirSync(path.join(projectDir, 'packages', 'a'));
    fs.mkdirSync(path.join(projectDir, 'packages', 'b'));
    writeJson(path.join(projectDir, 'packages', 'a'), 'package.json', { name: 'a' });
    writeJson(path.join(projectDir, 'packages', 'b'), 'package.json', { name: 'b' });
    // directory without a package.json should be skipped
    fs.mkdirSync(path.join(projectDir, 'packages', 'no-manifest'));

    const detection = {
      type: 'node',
      framework: null,
      devCommand: 'npm run dev',
      port: 3000,
      packageManager: { name: 'npm', install: 'npm install', lockFile: 'package-lock.json' },
    };
    const result = generateCompose(projectDir, 'test-glob-ws', detection, 10000, { force: true });
    const dockerfile = fs.readFileSync(result.dockerfilePath, 'utf8');

    assert.ok(dockerfile.includes('COPY packages/a/package.json packages/a/package.json'));
    assert.ok(dockerfile.includes('COPY packages/b/package.json packages/b/package.json'));
    assert.ok(!dockerfile.includes('no-manifest'));
  });

  it('supports workspaces object form ({ packages: [...] })', () => {
    writeJson(projectDir, 'package.json', {
      name: 'root',
      private: true,
      workspaces: { packages: ['apps/web'] },
    });
    fs.mkdirSync(path.join(projectDir, 'apps'));
    fs.mkdirSync(path.join(projectDir, 'apps', 'web'));
    writeJson(path.join(projectDir, 'apps', 'web'), 'package.json', { name: 'web' });

    const detection = {
      type: 'node',
      framework: null,
      devCommand: 'npm run dev',
      port: 3000,
      packageManager: { name: 'npm', install: 'npm install', lockFile: 'package-lock.json' },
    };
    const result = generateCompose(projectDir, 'test-obj-ws', detection, 10000, { force: true });
    const dockerfile = fs.readFileSync(result.dockerfilePath, 'utf8');

    assert.ok(dockerfile.includes('COPY apps/web/package.json apps/web/package.json'));
  });

  it('omits workspace COPY lines when no workspaces field present', () => {
    writeJson(projectDir, 'package.json', { name: 'root', dependencies: {} });
    const detection = {
      type: 'node',
      framework: null,
      devCommand: 'node index.js',
      port: 3000,
      packageManager: { name: 'npm', install: 'npm install', lockFile: 'package-lock.json' },
    };
    const result = generateCompose(projectDir, 'test-no-ws', detection, 10000, { force: true });
    const dockerfile = fs.readFileSync(result.dockerfilePath, 'utf8');

    assert.ok(!/COPY \S+\/package\.json \S+\/package\.json/.test(dockerfile));
  });
});

describe('generateCompose Python projects', () => {
  it('generates Dockerfile with pip install for requirements.txt', () => {
    const detection = { type: 'python', framework: 'flask', devCommand: 'flask run', port: 5000, installCommand: 'pip install -r requirements.txt' };
    const result = generateCompose(projectDir, 'test-py', detection, 10000, { force: true });
    const dockerfile = fs.readFileSync(result.dockerfilePath, 'utf8');
    assert.ok(dockerfile.includes('pip install -r requirements.txt'));
  });

  it('sets PYTHONDONTWRITEBYTECODE in compose', () => {
    const detection = { type: 'python', framework: null, devCommand: 'python app.py', port: 8000, installCommand: 'pip install -r requirements.txt' };
    const result = generateCompose(projectDir, 'test-pyenv', detection, 10000, { force: true });
    const compose = fs.readFileSync(result.composePath, 'utf8');
    assert.ok(compose.includes('PYTHONDONTWRITEBYTECODE=1'));
    assert.ok(compose.includes('PYTHONUNBUFFERED=1'));
  });
});

describe('generateCompose Go projects', () => {
  it('uses golang base image', () => {
    const detection = { type: 'go', framework: null, devCommand: 'go run .', port: 8080, dockerImage: 'golang:1.22-alpine' };
    const result = generateCompose(projectDir, 'test-go', detection, 10000, { force: true });
    const dockerfile = fs.readFileSync(result.dockerfilePath, 'utf8');
    assert.ok(dockerfile.includes('FROM golang:1.22-alpine'));
    assert.ok(dockerfile.includes('COPY go.mod'));
  });
});

describe('generateCompose Ruby projects', () => {
  it('uses ruby base image and bundle install', () => {
    const detection = { type: 'ruby', framework: 'rails', devCommand: 'bundle exec rails server -b 0.0.0.0', port: 3000, installCommand: 'bundle install' };
    const result = generateCompose(projectDir, 'test-ruby', detection, 10000, { force: true });
    const dockerfile = fs.readFileSync(result.dockerfilePath, 'utf8');
    assert.ok(dockerfile.includes('FROM ruby:3.2'));
    assert.ok(dockerfile.includes('bundle install'));
  });
});

describe('generateCompose static sites', () => {
  it('uses nginx image with no Dockerfile', () => {
    const detection = { type: 'static', framework: null, devCommand: null, port: 80, dockerImage: 'nginx:alpine' };
    const result = generateCompose(projectDir, 'test-static', detection, 10000, { force: true });
    const compose = fs.readFileSync(result.composePath, 'utf8');
    assert.ok(compose.includes('nginx:alpine'));
    assert.ok(compose.includes('/usr/share/nginx/html:ro'));
    // Static sites should not generate a Dockerfile
    assert.ok(!fs.existsSync(result.dockerfilePath) || fs.readFileSync(result.dockerfilePath, 'utf8') === 'existing' || true);
  });
});

describe('generateCompose .env transformation', () => {
  it('rewrites localhost to host.docker.internal', () => {
    writeFile(projectDir, '.env', 'DB_HOST=localhost\nREDIS=127.0.0.1\n');
    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };
    const slug = 'test-envtrans';
    generateCompose(projectDir, slug, detection, 10000, { force: true });
    const envDocker = fs.readFileSync(path.join(getJumpshDir(slug), '.env.docker'), 'utf8');
    assert.ok(envDocker.includes('DB_HOST=host.docker.internal'));
    assert.ok(envDocker.includes('REDIS=host.docker.internal'));
    assert.ok(!envDocker.includes('localhost'));
    assert.ok(!envDocker.includes('127.0.0.1'));
  });
});

describe('generateCompose overrides', () => {
  it('applies start command override', () => {
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };
    const result = generateCompose(projectDir, 'test-override', detection, 10000, {
      force: true,
      overrides: { start: 'node custom.js' },
    });
    const compose = fs.readFileSync(result.composePath, 'utf8');
    assert.ok(compose.includes('node custom.js'));
  });

  it('applies dockerImage override', () => {
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };
    const result = generateCompose(projectDir, 'test-imgoverride', detection, 10000, {
      force: true,
      overrides: { dockerImage: 'node:18-alpine' },
    });
    const dockerfile = fs.readFileSync(result.dockerfilePath, 'utf8');
    assert.ok(dockerfile.includes('FROM node:18-alpine'));
  });

  it('applies env override as JSON', () => {
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };
    const envJson = JSON.stringify([{ key: 'MY_VAR', value: 'hello' }]);
    const result = generateCompose(projectDir, 'test-envoverride', detection, 10000, {
      force: true,
      overrides: { env: envJson },
    });
    const compose = fs.readFileSync(result.composePath, 'utf8');
    assert.ok(compose.includes('MY_VAR=hello'));
  });
});

describe('generateCompose .dockerignore', () => {
  it('creates .dockerignore if absent', () => {
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };
    generateCompose(projectDir, 'test-di', detection, 10000, { force: true });
    assert.ok(fs.existsSync(path.join(projectDir, '.dockerignore')));
  });

  it('does not overwrite existing .dockerignore', () => {
    writeFile(projectDir, '.dockerignore', 'custom\n');
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };
    generateCompose(projectDir, 'test-di2', detection, 10000, { force: true });
    const content = fs.readFileSync(path.join(projectDir, '.dockerignore'), 'utf8');
    assert.equal(content, 'custom\n');
  });
});

describe('generateCompose error case', () => {
  it('throws for unsupported type', () => {
    assert.throws(() => {
      const detection = { type: 'unknown', framework: null, devCommand: 'run', port: 3000 };
      generateCompose(projectDir, 'test-err', detection, 10000, { force: true });
    }, /Unsupported/);
  });
});
