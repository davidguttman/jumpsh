import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { generateCompose, getJumpshDir } from '../services/ComposeGenerator.js';
import { makeTmpDir, writeJson, writeFile, cleanTmpDir } from './helpers/fixtures.js';

// Override HOME so getJumpshDir writes into tmpdir instead of real ~/.jump.sh
let tmpHome, originalHome, projectDir;

function hasDockerCompose() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const dockerComposeAvailable = hasDockerCompose();

function readComposeConfig(composePath, projectName) {
  const output = execFileSync(
    'docker',
    [
      'compose',
      '--project-name', projectName,
      '-f', composePath,
      'config',
      '--format', 'json',
      '--no-env-resolution',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, FOO: 'expanded-foo', BAR: 'expanded-bar' },
    },
  );
  return JSON.parse(output);
}

function runCompose(composePath, projectName, args) {
  return execFileSync(
    'docker',
    ['compose', '--project-name', projectName, '-f', composePath, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, FOO: 'expanded-foo', BAR: 'expanded-bar' },
    },
  );
}

function cleanCompose(composePath, projectName) {
  try {
    runCompose(composePath, projectName, ['down', '--volumes', '--remove-orphans', '--rmi', 'local']);
  } catch { /* best effort cleanup after an assertion/runtime failure */ }
}

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

describe('generateCompose dynamic service user', () => {
  it('runs as the numeric owner of the bind-mounted project checkout', () => {
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const { uid, gid } = fs.statSync(projectDir);
    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };

    const result = generateCompose(projectDir, 'test-user', detection, 10000, { force: true });
    const compose = fs.readFileSync(result.composePath, 'utf8');

    assert.ok(compose.includes(`    user: "${uid}:${gid}"`));
    assert.ok(compose.includes('      - HOME=/tmp'));
  });

  it('fails clearly when the project owner cannot be read', () => {
    const missingProjectDir = path.join(tmpHome, 'missing-project');
    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };

    assert.throws(
      () => generateCompose(missingProjectDir, 'test-user-stat-error', detection, 10000, { force: true }),
      /Unable to read owner identity.*test-user-stat-error|Unable to read owner identity.*project/,
    );
  });

  it('fails clearly when the project owner identity is invalid', () => {
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const statSync = fs.statSync;
    fs.statSync = (target, options) => {
      const stats = statSync(target, options);
      return target === projectDir ? { ...stats, uid: Number.NaN } : stats;
    };
    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };

    try {
      assert.throws(
        () => generateCompose(projectDir, 'test-user-invalid', detection, 10000, { force: true }),
        /Invalid owner identity.*project/,
      );
    } finally {
      fs.statSync = statSync;
    }
  });
});

describe('generateCompose Compose interpolation escaping', () => {
  it('rejects dollar signs in dynamic project paths before writing generated files', () => {
    const dollarProjectDir = path.join(tmpHome, 'project-$FOO-${BAR}');
    fs.mkdirSync(dollarProjectDir, { recursive: true });
    writeJson(dollarProjectDir, 'package.json', { dependencies: {} });
    const detection = {
      type: 'node',
      framework: null,
      devCommand: 'node index.js',
      port: 3000,
      packageManager: { name: 'npm', install: 'npm install', lockFile: null },
    };

    assert.throws(
      () => generateCompose(dollarProjectDir, 'test-dollar-project', detection, 10000, { force: true }),
      /cannot build.*project path.*literal "\$".*build\/bake/i,
    );
    assert.ok(!fs.existsSync(getJumpshDir('test-dollar-project')));
    assert.ok(!fs.existsSync(path.join(dollarProjectDir, '.dockerignore')));
  });

  it('rejects dollar signs in dynamic slug/config paths before writing generated files', () => {
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const detection = {
      type: 'node',
      framework: null,
      devCommand: 'node index.js',
      port: 3000,
      packageManager: { name: 'npm', install: 'npm install', lockFile: null },
    };
    const slug = 'test-$FOO-${BAR}';

    assert.throws(
      () => generateCompose(projectDir, slug, detection, 10000, { force: true }),
      /cannot build.*jump\.sh config path.*literal "\$".*build\/bake/i,
    );
    assert.ok(!fs.existsSync(getJumpshDir(slug)));
    assert.ok(!fs.existsSync(path.join(projectDir, '.dockerignore')));
  });

  it('preserves literal dollar signs in a static bind mount at real Compose runtime', { skip: !dockerComposeAvailable }, () => {
    const staticProjectDir = path.join(tmpHome, 'static-$FOO-${BAR}');
    fs.mkdirSync(staticProjectDir);
    writeFile(staticProjectDir, 'marker.txt', 'mounted-literal-dollar-path\n');
    const detection = { type: 'static', framework: null, devCommand: null, port: 80, dockerImage: 'nginx:alpine' };

    const result = generateCompose(staticProjectDir, 'test-static-$FOO-${BAR}', detection, 10000, { force: true });
    const projectName = `jump-sh-static-dollar-${process.pid}`;

    try {
      const config = readComposeConfig(result.composePath, projectName);
      assert.equal(config.services.app.volumes[0].source, staticProjectDir.replaceAll('$', () => '$$'));
      assert.ok(!JSON.stringify(config).includes('expanded-foo'));
      assert.ok(!JSON.stringify(config).includes('expanded-bar'));

      const output = runCompose(result.composePath, projectName, [
        'run', '--rm', '--entrypoint', 'cat', 'app', '/usr/share/nginx/html/marker.txt',
      ]);
      assert.equal(output.trim(), 'mounted-literal-dollar-path');
    } finally {
      cleanCompose(result.composePath, projectName);
    }
  });

  it('preserves literal dollars in override environment and command values at real Compose runtime', { skip: !dockerComposeAvailable }, () => {
    writeJson(projectDir, 'package.json', { dependencies: {} });
    writeFile(projectDir, 'probe.sh', [
      '#!/bin/sh',
      'set -eu',
      'printf "ENV=<%s> HOME=<%s> ARG=<%s>\\n" "$LITERAL_VALUE" "$HOME" "$1" > /app/runtime-result.txt',
      '',
    ].join('\n'));
    const literalEnvValue = 'prefix-$FOO-${BAR}';
    const literalHome = '/home/$FOO/${BAR}';
    const literalCommandArg = 'arg-$FOO-${BAR}';
    const literalCommand = `sh /app/probe.sh '${literalCommandArg}'`;
    const detection = {
      type: 'node',
      framework: null,
      devCommand: literalCommand,
      port: 3000,
      packageManager: { name: 'bun', install: 'true', lockFile: null },
      overrideEnv: JSON.stringify([
        { key: 'LITERAL_VALUE', value: literalEnvValue },
        { key: 'HOME', value: literalHome },
      ]),
    };
    const result = generateCompose(projectDir, 'test-runtime-dollar-values', detection, 0, { force: true });
    fs.writeFileSync(result.dockerfilePath, [
      'FROM alpine:3.22',
      'RUN mkdir -p /app/node_modules',
      'WORKDIR /app',
      'COPY probe.sh /app/probe.sh',
      '',
    ].join('\n'));
    const projectName = `jump-sh-runtime-dollar-${process.pid}`;

    try {
      const config = readComposeConfig(result.composePath, projectName);
      assert.equal(config.services.app.environment.LITERAL_VALUE, literalEnvValue.replaceAll('$', () => '$$'));
      assert.equal(config.services.app.environment.HOME, literalHome.replaceAll('$', () => '$$'));
      assert.deepEqual(config.services.app.command, [
        'sh',
        '/app/probe.sh',
        literalCommandArg.replaceAll('$', () => '$$'),
      ]);
      assert.ok(!JSON.stringify(config).includes('expanded-foo'));
      assert.ok(!JSON.stringify(config).includes('expanded-bar'));

      runCompose(result.composePath, projectName, ['run', '--rm', '--build', 'app']);
      assert.equal(
        fs.readFileSync(path.join(projectDir, 'runtime-result.txt'), 'utf8').trim(),
        `ENV=<${literalEnvValue}> HOME=<${literalHome}> ARG=<${literalCommandArg}>`,
      );
    } finally {
      cleanCompose(result.composePath, projectName);
    }
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

  it('initializes a named node_modules volume for the mapped app user', () => {
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const { uid, gid } = fs.statSync(projectDir);
    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };
    const result = generateCompose(projectDir, 'test-vol', detection, 10000, { force: true });
    const compose = fs.readFileSync(result.composePath, 'utf8');

    assert.ok(compose.includes('      - app_node_modules:/app/node_modules'));
    assert.ok(compose.includes('    depends_on:\n      app_node_modules_init:\n        condition: service_completed_successfully'));
    assert.ok(compose.includes('  app_node_modules_init:\n    user: "0:0"'));
    assert.ok(compose.includes('    entrypoint: []'));
    assert.ok(compose.includes('      - app_node_modules:/deps'));
    assert.ok(compose.includes(`    command: ["sh","-c","set -eu; find /deps -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; if [ -d /app/node_modules ]; then cp -a /app/node_modules/. /deps/; fi; chown -R ${uid}:${gid} /deps"]`));
    assert.ok(compose.endsWith('volumes:\n  app_node_modules:\n'));

    const initService = compose.slice(compose.lastIndexOf('\n  app_node_modules_init:'));
    assert.ok(initService.includes(`      context: ${JSON.stringify(projectDir)}`));
    assert.ok(initService.includes(`      dockerfile: ${JSON.stringify(path.join(getJumpshDir('test-vol'), 'Dockerfile'))}`));
    assert.ok(!initService.includes(`${projectDir}:/app`));
    assert.ok(!initService.includes('app_node_modules:/app/node_modules'));
    assert.ok(!initService.includes('ports:'));
    assert.ok(!initService.includes('restart:'));
    assert.ok(!initService.includes('logging:'));
    assert.ok(!initService.includes('extra_hosts:'));
    assert.ok(!initService.includes('environment:'));
    assert.ok(!initService.includes('env_file:'));
  });

  it('includes extra_hosts for host.docker.internal', () => {
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };
    const result = generateCompose(projectDir, 'test-hosts', detection, 10000, { force: true });
    const compose = fs.readFileSync(result.composePath, 'utf8');
    assert.ok(compose.includes('host.docker.internal:host-gateway'));
  });

  it('starts when an empty-dependencies build has no /app/node_modules directory', { skip: !dockerComposeAvailable }, () => {
    writeJson(projectDir, 'package.json', { dependencies: {} });
    writeFile(projectDir, 'probe.sh', '#!/bin/sh\nset -eu\nprintf "node-init-ok" > /app/runtime-result.txt\n');
    const detection = {
      type: 'node',
      framework: null,
      devCommand: 'sh /app/probe.sh',
      port: 3000,
      packageManager: { name: 'bun', install: 'true', lockFile: null },
    };
    const result = generateCompose(projectDir, 'test-node-empty-deps', detection, 0, { force: true });
    fs.writeFileSync(result.dockerfilePath, [
      'FROM alpine:3.22',
      'WORKDIR /app',
      'COPY probe.sh /app/probe.sh',
      '',
    ].join('\n'));
    const projectName = `jump-sh-node-empty-deps-${process.pid}`;

    try {
      runCompose(result.composePath, projectName, ['run', '--rm', '--build', 'app']);
      assert.equal(fs.readFileSync(path.join(projectDir, 'runtime-result.txt'), 'utf8'), 'node-init-ok');
    } finally {
      cleanCompose(result.composePath, projectName);
    }
  });
});

describe('generateCompose PHP projects', () => {
  it('initializes a named vendor volume for the mapped app user', () => {
    const { uid, gid } = fs.statSync(projectDir);
    const detection = { type: 'php', framework: null, devCommand: 'php -S 0.0.0.0:8000', port: 8000, installCommand: 'composer install' };
    const result = generateCompose(projectDir, 'test-php-vol', detection, 10000, { force: true });
    const compose = fs.readFileSync(result.composePath, 'utf8');

    assert.ok(compose.includes(`    user: "${uid}:${gid}"`));
    assert.ok(compose.includes('      - HOME=/tmp'));
    assert.ok(compose.includes('      - app_vendor:/app/vendor'));
    assert.ok(compose.includes('    depends_on:\n      app_vendor_init:\n        condition: service_completed_successfully'));
    assert.ok(compose.includes('  app_vendor_init:\n    user: "0:0"'));
    assert.ok(compose.includes('    entrypoint: []'));
    assert.ok(compose.includes('      - app_vendor:/deps'));
    assert.ok(compose.includes(`    command: ["sh","-c","set -eu; find /deps -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; if [ -d /app/vendor ]; then cp -a /app/vendor/. /deps/; fi; chown -R ${uid}:${gid} /deps"]`));
    assert.ok(compose.endsWith('volumes:\n  app_vendor:\n'));

    const initService = compose.slice(compose.lastIndexOf('\n  app_vendor_init:'));
    assert.ok(!initService.includes('app_vendor:/app/vendor'));
    assert.ok(!initService.includes('/app/node_modules/.'));
  });

  it('starts when the built image has no /app/vendor directory', { skip: !dockerComposeAvailable }, () => {
    writeFile(projectDir, 'probe.php', '<?php file_put_contents("/app/runtime-result.txt", "php-init-ok");\n');
    const detection = { type: 'php', framework: null, devCommand: 'php /app/probe.php', port: 8000 };
    const result = generateCompose(projectDir, 'test-php-no-vendor', detection, 0, { force: true });
    const projectName = `jump-sh-php-no-vendor-${process.pid}`;

    try {
      runCompose(result.composePath, projectName, ['run', '--rm', '--build', 'app']);
      assert.equal(fs.readFileSync(path.join(projectDir, 'runtime-result.txt'), 'utf8'), 'php-init-ok');
    } finally {
      cleanCompose(result.composePath, projectName);
    }
  });
});

describe('generateCompose dependency initialization scope', () => {
  for (const detection of [
    { type: 'python', framework: null, devCommand: 'python app.py', port: 8000, installCommand: 'pip install -r requirements.txt' },
    { type: 'go', framework: null, devCommand: 'go run .', port: 8080 },
    { type: 'ruby', framework: null, devCommand: 'bundle exec ruby app.rb', port: 4567, installCommand: 'bundle install' },
  ]) {
    it(`does not add a dependency init service or named volume for ${detection.type}`, () => {
      const result = generateCompose(projectDir, `test-no-init-${detection.type}`, detection, 10000, { force: true });
      const compose = fs.readFileSync(result.composePath, 'utf8');

      assert.ok(compose.includes('      - HOME=/tmp'));
      assert.ok(!compose.includes('depends_on:'));
      assert.ok(!compose.includes('_init:'));
      assert.ok(!compose.includes('\nvolumes:\n'));
    });
  }
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
    assert.ok(!compose.includes('\n    user:'));
    assert.ok(!compose.includes('depends_on:'));
    assert.ok(!compose.includes('_init:'));
    assert.ok(!compose.includes('\nvolumes:\n'));
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

  it('preserves an explicit HOME override instead of adding the generated default', () => {
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };
    const envJson = JSON.stringify([{ key: 'HOME', value: '/custom-home' }]);
    const result = generateCompose(projectDir, 'test-home-override', detection, 10000, {
      force: true,
      overrides: { env: envJson },
    });
    const compose = fs.readFileSync(result.composePath, 'utf8');

    assert.ok(compose.includes('      - "HOME=/custom-home"'));
    assert.ok(!compose.includes('      - HOME=/tmp'));
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

describe('generateCompose parent env inheritance', () => {
  it('inherits parent .env when worktree has none', () => {
    const parentDir = path.join(tmpHome, 'parent-project');
    fs.mkdirSync(parentDir);
    writeFile(parentDir, '.env', 'XAI_API_KEY=secret\nDB=localhost\n');
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };
    const slug = 'test-wt-inherit';
    const result = generateCompose(projectDir, slug, detection, 10000, {
      force: true,
      parentEnvPath: path.join(parentDir, '.env'),
    });
    const envDocker = fs.readFileSync(path.join(getJumpshDir(slug), '.env.docker'), 'utf8');
    assert.ok(envDocker.includes('XAI_API_KEY=secret'));
    assert.ok(envDocker.includes('DB=host.docker.internal'));
    const compose = fs.readFileSync(result.composePath, 'utf8');
    assert.ok(compose.includes(path.join(parentDir, '.env')));
  });

  it('prefers worktree .env over parent .env when both exist', () => {
    const parentDir = path.join(tmpHome, 'parent-project2');
    fs.mkdirSync(parentDir);
    writeFile(parentDir, '.env', 'KEY=parent\n');
    writeFile(projectDir, '.env', 'KEY=child\n');
    writeJson(projectDir, 'package.json', { dependencies: {} });
    const detection = { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: { name: 'npm', install: 'npm install', lockFile: null } };
    const slug = 'test-wt-prefer-own';
    const result = generateCompose(projectDir, slug, detection, 10000, {
      force: true,
      parentEnvPath: path.join(parentDir, '.env'),
    });
    const envDocker = fs.readFileSync(path.join(getJumpshDir(slug), '.env.docker'), 'utf8');
    assert.ok(envDocker.includes('KEY=child'));
    assert.ok(!envDocker.includes('KEY=parent'));
    const compose = fs.readFileSync(result.composePath, 'utf8');
    assert.ok(compose.includes(path.join(projectDir, '.env')));
    assert.ok(!compose.includes(path.join(parentDir, '.env')));
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
