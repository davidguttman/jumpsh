import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectProjectType } from '../services/ProjectDetector.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-test-'));
}

function writeJson(dir, filename, obj) {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(obj));
}

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
