import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { detectProjectType } from '../services/ProjectDetector.js';
import { makeTmpDir, writeJson, touchFile, writeFile, cleanTmpDir } from './helpers/fixtures.js';

describe('ProjectDetector --host flag', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds --host for vite projects', () => {
    writeJson(tmpDir, 'package.json', {
      scripts: { dev: 'vite' },
      dependencies: { vite: '^5.0.0' },
    });
    const result = detectProjectType(tmpDir);
    assert.match(result.devCommand, /--host/);
  });

  it('adds --host for next projects', () => {
    writeJson(tmpDir, 'package.json', {
      scripts: { dev: 'next dev' },
      dependencies: { next: '^14.0.0' },
    });
    const result = detectProjectType(tmpDir);
    assert.match(result.devCommand, /--host/);
  });

  it('adds --host for astro projects', () => {
    writeJson(tmpDir, 'package.json', {
      scripts: { dev: 'astro dev' },
      dependencies: { astro: '^4.0.0' },
    });
    const result = detectProjectType(tmpDir);
    assert.match(result.devCommand, /--host/);
  });

  it('adds --host for nuxt projects', () => {
    writeJson(tmpDir, 'package.json', {
      scripts: { dev: 'nuxt dev' },
      dependencies: { nuxt: '^3.0.0' },
    });
    const result = detectProjectType(tmpDir);
    assert.match(result.devCommand, /--host/);
  });

  it('does NOT add --host for nodemon scripts', () => {
    writeJson(tmpDir, 'package.json', {
      scripts: { dev: 'nodemon server.js' },
      dependencies: {},
    });
    const result = detectProjectType(tmpDir);
    assert.doesNotMatch(result.devCommand, /--host/);
  });

  it('does NOT add --host for plain node scripts', () => {
    writeJson(tmpDir, 'package.json', {
      scripts: { dev: 'node server.js' },
      dependencies: {},
    });
    const result = detectProjectType(tmpDir);
    assert.doesNotMatch(result.devCommand, /--host/);
  });

  it('does NOT add --host for ts-node scripts', () => {
    writeJson(tmpDir, 'package.json', {
      scripts: { dev: 'ts-node src/index.ts' },
      dependencies: {},
    });
    const result = detectProjectType(tmpDir);
    assert.doesNotMatch(result.devCommand, /--host/);
  });

  it('does NOT add --host for tsx scripts', () => {
    writeJson(tmpDir, 'package.json', {
      scripts: { dev: 'tsx watch src/index.ts' },
      dependencies: {},
    });
    const result = detectProjectType(tmpDir);
    assert.doesNotMatch(result.devCommand, /--host/);
  });

  it('does NOT add --host for start scripts with node', () => {
    writeJson(tmpDir, 'package.json', {
      scripts: { start: 'node server.js' },
      dependencies: {},
    });
    const result = detectProjectType(tmpDir);
    assert.doesNotMatch(result.devCommand, /--host/);
  });

  it('adds --host for start scripts with webpack-dev-server', () => {
    writeJson(tmpDir, 'package.json', {
      scripts: { start: 'webpack-dev-server' },
      dependencies: {},
    });
    const result = detectProjectType(tmpDir);
    assert.match(result.devCommand, /--host/);
  });

  it('adds --host for non-vite dev script containing vite tool', () => {
    // e.g. a custom script that wraps vite
    writeJson(tmpDir, 'package.json', {
      scripts: { dev: 'cross-env NODE_ENV=dev vite' },
      dependencies: {},
    });
    const result = detectProjectType(tmpDir);
    assert.match(result.devCommand, /--host/);
  });

  it('still adds --host for framework-detected projects (astro dep)', () => {
    writeJson(tmpDir, 'package.json', {
      dependencies: { astro: '^4.0.0' },
    });
    const result = detectProjectType(tmpDir);
    assert.match(result.devCommand, /--host/);
    assert.equal(result.framework, 'astro');
  });
});

// ---- Framework detection ----

describe('ProjectDetector framework detection', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanTmpDir(tmpDir); });

  it('detects Next.js via dependency', () => {
    writeJson(tmpDir, 'package.json', { dependencies: { next: '*' } });
    const r = detectProjectType(tmpDir);
    assert.equal(r.type, 'node');
    assert.equal(r.framework, 'next');
  });

  it('detects Nuxt via dependency', () => {
    writeJson(tmpDir, 'package.json', { dependencies: { nuxt: '*' } });
    const r = detectProjectType(tmpDir);
    assert.equal(r.type, 'node');
    assert.equal(r.framework, 'nuxt');
  });

  it('detects Vite via dependency', () => {
    writeJson(tmpDir, 'package.json', { dependencies: { vite: '*' } });
    const r = detectProjectType(tmpDir);
    assert.equal(r.type, 'node');
    assert.equal(r.framework, 'vite');
  });

  it('detects Astro via dependency', () => {
    writeJson(tmpDir, 'package.json', { dependencies: { astro: '*' } });
    const r = detectProjectType(tmpDir);
    assert.equal(r.type, 'node');
    assert.equal(r.framework, 'astro');
  });

  it('detects Express as plain node (no framework)', () => {
    writeJson(tmpDir, 'package.json', {
      dependencies: { express: '*' },
      scripts: { start: 'node server.js' },
    });
    const r = detectProjectType(tmpDir);
    assert.equal(r.type, 'node');
    assert.equal(r.framework, null);
  });

  it('detects Fastify as plain node (no framework)', () => {
    writeJson(tmpDir, 'package.json', {
      dependencies: { fastify: '*' },
      scripts: { start: 'node server.js' },
    });
    const r = detectProjectType(tmpDir);
    assert.equal(r.type, 'node');
    assert.equal(r.framework, null);
  });

  it('detects SvelteKit via @sveltejs/kit dependency', () => {
    writeJson(tmpDir, 'package.json', { devDependencies: { '@sveltejs/kit': '*', svelte: '*', vite: '*' } });
    const r = detectProjectType(tmpDir);
    assert.equal(r.type, 'node');
    assert.equal(r.framework, 'sveltekit');
    assert.equal(r.port, 5173);
    assert.match(r.devCommand, /--host/);
  });

  it('prioritises sveltekit over vite when both present', () => {
    writeJson(tmpDir, 'package.json', {
      devDependencies: { '@sveltejs/kit': '*', vite: '*' },
    });
    const r = detectProjectType(tmpDir);
    assert.equal(r.framework, 'sveltekit');
  });

  it('prioritises astro over vite when both present', () => {
    writeJson(tmpDir, 'package.json', {
      dependencies: { astro: '*', vite: '*' },
    });
    const r = detectProjectType(tmpDir);
    assert.equal(r.framework, 'astro');
  });
});

// ---- Package manager detection ----

describe('ProjectDetector package managers', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanTmpDir(tmpDir); });

  it('detects bun via bun.lockb', () => {
    writeJson(tmpDir, 'package.json', { dependencies: {} });
    touchFile(tmpDir, 'bun.lockb');
    const r = detectProjectType(tmpDir);
    assert.equal(r.packageManager.name, 'bun');
  });

  it('detects bun via bun.lock', () => {
    writeJson(tmpDir, 'package.json', { dependencies: {} });
    touchFile(tmpDir, 'bun.lock');
    const r = detectProjectType(tmpDir);
    assert.equal(r.packageManager.name, 'bun');
  });

  it('detects pnpm via pnpm-lock.yaml', () => {
    writeJson(tmpDir, 'package.json', { dependencies: {} });
    touchFile(tmpDir, 'pnpm-lock.yaml');
    const r = detectProjectType(tmpDir);
    assert.equal(r.packageManager.name, 'pnpm');
  });

  it('detects yarn via yarn.lock', () => {
    writeJson(tmpDir, 'package.json', { dependencies: {} });
    touchFile(tmpDir, 'yarn.lock');
    const r = detectProjectType(tmpDir);
    assert.equal(r.packageManager.name, 'yarn');
  });

  it('detects npm via package-lock.json', () => {
    writeJson(tmpDir, 'package.json', { dependencies: {} });
    touchFile(tmpDir, 'package-lock.json');
    const r = detectProjectType(tmpDir);
    assert.equal(r.packageManager.name, 'npm');
  });

  it('defaults to npm when no lockfile', () => {
    writeJson(tmpDir, 'package.json', { dependencies: {} });
    const r = detectProjectType(tmpDir);
    assert.equal(r.packageManager.name, 'npm');
    assert.equal(r.packageManager.lockFile, null);
  });
});

// ---- Python detection ----

describe('ProjectDetector Python projects', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanTmpDir(tmpDir); });

  it('detects Flask via requirements.txt', () => {
    writeFile(tmpDir, 'requirements.txt', 'flask==3.0\n');
    const r = detectProjectType(tmpDir);
    assert.equal(r.type, 'python');
    assert.equal(r.framework, 'flask');
  });

  it('detects FastAPI via requirements.txt', () => {
    writeFile(tmpDir, 'requirements.txt', 'fastapi\nuvicorn\n');
    const r = detectProjectType(tmpDir);
    assert.equal(r.type, 'python');
    assert.equal(r.framework, 'fastapi');
  });

  it('detects Django via manage.py', () => {
    writeFile(tmpDir, 'requirements.txt', 'django\n');
    writeFile(tmpDir, 'manage.py', '#!/usr/bin/env python\n');
    const r = detectProjectType(tmpDir);
    assert.equal(r.type, 'python');
    assert.equal(r.framework, 'django');
  });

  it('detects Python via pyproject.toml', () => {
    writeFile(tmpDir, 'pyproject.toml', '[project]\nname = "myapp"\n');
    const r = detectProjectType(tmpDir);
    assert.equal(r.type, 'python');
    assert.equal(r.installCommand, 'pip install -e .');
  });

  it('detects Flask case-insensitively', () => {
    writeFile(tmpDir, 'requirements.txt', 'Flask==3.0\n');
    const r = detectProjectType(tmpDir);
    assert.equal(r.framework, 'flask');
  });
});

// ---- Ruby detection ----

describe('ProjectDetector Ruby projects', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanTmpDir(tmpDir); });

  it('detects Rails via Gemfile + config.ru', () => {
    writeFile(tmpDir, 'Gemfile', "gem 'rails'\n");
    writeFile(tmpDir, 'config.ru', '');
    const r = detectProjectType(tmpDir);
    assert.equal(r.type, 'ruby');
    assert.equal(r.framework, 'rails');
  });

  it('detects generic Ruby via Gemfile without config.ru', () => {
    writeFile(tmpDir, 'Gemfile', "gem 'sinatra'\n");
    const r = detectProjectType(tmpDir);
    assert.equal(r.type, 'ruby');
    assert.equal(r.framework, null);
  });
});

// ---- Go detection ----

describe('ProjectDetector Go projects', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanTmpDir(tmpDir); });

  it('detects Go project via go.mod', () => {
    writeFile(tmpDir, 'go.mod', 'module example.com/myapp\n');
    const r = detectProjectType(tmpDir);
    assert.equal(r.type, 'go');
    assert.equal(r.port, 8080);
  });
});

// ---- Static site detection ----

describe('ProjectDetector static sites', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanTmpDir(tmpDir); });

  it('detects static site with index.html', () => {
    writeFile(tmpDir, 'index.html', '<html></html>');
    const r = detectProjectType(tmpDir);
    assert.equal(r.type, 'static');
    assert.equal(r.port, 80);
  });

  it('returns error for empty directory', () => {
    const r = detectProjectType(tmpDir);
    assert.ok(r.error);
  });
});

// ---- Port detection ----

describe('ProjectDetector port detection', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanTmpDir(tmpDir); });

  it('parses --port flag from dev script', () => {
    writeJson(tmpDir, 'package.json', {
      scripts: { dev: 'node server.js --port 4000' },
      dependencies: {},
    });
    const r = detectProjectType(tmpDir);
    assert.equal(r.port, 4000);
  });

  it('uses webpack default port 8080', () => {
    writeJson(tmpDir, 'package.json', {
      scripts: { start: 'webpack serve' },
      dependencies: {},
    });
    const r = detectProjectType(tmpDir);
    assert.equal(r.port, 8080);
  });

  it('uses parcel default port 1234', () => {
    writeJson(tmpDir, 'package.json', {
      scripts: { start: 'parcel index.html' },
      dependencies: {},
    });
    const r = detectProjectType(tmpDir);
    assert.equal(r.port, 1234);
  });

  it('defaults to 3000 when no port info', () => {
    writeJson(tmpDir, 'package.json', {
      scripts: { dev: 'node server.js' },
      dependencies: {},
    });
    const r = detectProjectType(tmpDir);
    assert.equal(r.port, 3000);
  });

  it('does not parse PORT= env prefix (unsupported)', () => {
    writeJson(tmpDir, 'package.json', {
      scripts: { dev: 'PORT=4000 node server.js' },
      dependencies: {},
    });
    const r = detectProjectType(tmpDir);
    // PORT=N env prefix is not currently parsed by detectPortFromScript
    assert.equal(r.port, 3000);
  });
});

// ---- Error handling ----

describe('ProjectDetector error handling', () => {
  it('returns error for non-absolute path', () => {
    const r = detectProjectType('relative/path');
    assert.ok(r.error);
    assert.match(r.error, /absolute/);
  });

  it('returns error for nonexistent path', () => {
    const r = detectProjectType('/tmp/definitely-does-not-exist-' + Date.now());
    assert.ok(r.error);
    assert.match(r.error, /does not exist/);
  });
});

// ---- PHP detection ----

describe('ProjectDetector PHP detection', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanTmpDir(tmpDir); });

  it('detects Laravel project', () => {
    writeJson(tmpDir, 'composer.json', { require: { 'laravel/framework': '^11.0' } });
    fs.writeFileSync(path.join(tmpDir, 'artisan'), '#!/usr/bin/env php');
    const result = detectProjectType(tmpDir);
    assert.equal(result.type, 'php');
    assert.equal(result.framework, 'laravel');
    assert.match(result.devCommand, /artisan serve/);
    assert.equal(result.port, 8000);
  });

  it('detects Symfony project via symfony.lock', () => {
    writeJson(tmpDir, 'composer.json', { require: { 'symfony/framework-bundle': '^7.0' } });
    fs.writeFileSync(path.join(tmpDir, 'symfony.lock'), '{}');
    const result = detectProjectType(tmpDir);
    assert.equal(result.type, 'php');
    assert.equal(result.framework, 'symfony');
    assert.match(result.devCommand, /php -S.*public/);
    assert.equal(result.port, 8000);
  });

  it('detects Symfony project via config/bundles.php', () => {
    writeJson(tmpDir, 'composer.json', { require: {} });
    fs.mkdirSync(path.join(tmpDir, 'config'));
    fs.writeFileSync(path.join(tmpDir, 'config', 'bundles.php'), '<?php return [];');
    const result = detectProjectType(tmpDir);
    assert.equal(result.type, 'php');
    assert.equal(result.framework, 'symfony');
  });

  it('detects plain PHP with composer.json', () => {
    writeJson(tmpDir, 'composer.json', { require: {} });
    const result = detectProjectType(tmpDir);
    assert.equal(result.type, 'php');
    assert.equal(result.framework, null);
    assert.match(result.devCommand, /php -S/);
    assert.equal(result.port, 8000);
    assert.equal(result.installCommand, 'composer install');
  });

  it('detects plain PHP files without composer.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'index.php'), '<?php echo "hi";');
    const result = detectProjectType(tmpDir);
    assert.equal(result.type, 'php');
    assert.equal(result.framework, null);
    assert.equal(result.installCommand, null);
  });

  it('extracts PHP extensions from composer.json', () => {
    writeJson(tmpDir, 'composer.json', {
      require: { 'ext-pdo': '*', 'ext-mbstring': '*', 'laravel/framework': '^11.0' },
    });
    fs.writeFileSync(path.join(tmpDir, 'artisan'), '#!/usr/bin/env php');
    const result = detectProjectType(tmpDir);
    assert.deepEqual(result.phpExtensions, ['pdo', 'mbstring']);
  });
});
