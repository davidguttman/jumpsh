import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { SCHEMA } from '../lib/schema-definition.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'jumpsh.js');

let tmpHome, originalHome, Database, db;
let importCounter = 0;

function cb(fn) {
  return new Promise((resolve, reject) => {
    fn((err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [BIN, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, ...opts.env },
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
    };
  }
}

// ---- Database backward compatibility ----

describe('Database backward compatibility', () => {
  beforeEach(async () => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-compat-'));
    process.env.HOME = tmpHome;
    const mod = await import('../database.js?compat=' + (++importCounter));
    Database = mod.default;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('loads old-format projects missing newer fields (override_env, override_docker_image)', async () => {
    const dataDir = path.join(tmpHome, '.jump.sh');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({
      nextId: 2,
      projects: [{
        id: 1,
        name: 'legacy-app',
        path: '/tmp/legacy',
        subdomain: 'legacy-app',
        assigned_port: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      }],
    }));

    db = new Database();
    await db.ready();

    const project = await cb(done => db.getProject(1, done));
    assert.ok(project, 'should load legacy project');
    assert.equal(project.name, 'legacy-app');

    // Newer fields should be defaulted
    assert.equal(project.override_env, null);
    assert.equal(project.override_docker_image, null);
    assert.equal(project.override_build_command, null);
    assert.equal(project.override_start_command, null);
    assert.equal(project.override_port, null);
    assert.equal(project.description, null);
    assert.equal(project.is_worktree, 0);
    assert.equal(project.branch_name, null);
    assert.equal(project.parent_project_id, null);
    assert.equal(project.desired_running, 0);
  });

  it('getAllProjects applies defaults to legacy records', async () => {
    const dataDir = path.join(tmpHome, '.jump.sh');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({
      nextId: 3,
      projects: [
        {
          id: 1,
          name: 'old-app',
          path: '/tmp/old',
          subdomain: 'old-app',
          assigned_port: null,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 2,
          name: 'new-app',
          path: '/tmp/new',
          subdomain: 'new-app',
          description: 'has all fields',
          parent_project_id: null,
          is_worktree: 0,
          branch_name: null,
          assigned_port: 10001,
          override_build_command: 'npm install',
          override_start_command: 'npm start',
          override_port: 3000,
          override_docker_image: 'node:20',
          override_env: [{ key: 'FOO', value: 'bar' }],
          desired_running: 1,
          created_at: '2024-06-01T00:00:00.000Z',
          updated_at: '2024-06-01T00:00:00.000Z',
        },
      ],
    }));

    db = new Database();
    await db.ready();

    const all = await cb(done => db.getAllProjects(done));
    assert.equal(all.length, 2);

    const legacy = all.find(p => p.name === 'old-app');
    assert.equal(legacy.override_env, null);
    assert.equal(legacy.is_worktree, 0);
    assert.equal(legacy.desired_running, 0);

    const modern = all.find(p => p.name === 'new-app');
    assert.equal(modern.override_docker_image, 'node:20');
    assert.deepEqual(modern.override_env, [{ key: 'FOO', value: 'bar' }]);
  });

  it('findProject applies defaults to legacy records', async () => {
    const dataDir = path.join(tmpHome, '.jump.sh');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({
      nextId: 2,
      projects: [{
        id: 1,
        name: 'find-me',
        path: '/tmp/find',
        subdomain: 'find-me',
        assigned_port: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      }],
    }));

    db = new Database();
    await db.ready();

    const p = await cb(done => db.findProject('find-me', done));
    assert.ok(p);
    assert.equal(p.override_env, null);
    assert.equal(p.override_docker_image, null);
    assert.equal(p.desired_running, 0);
  });
});

// ---- Record shape stability ----

describe('Database record shape stability', () => {
  beforeEach(async () => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-shape-'));
    process.env.HOME = tmpHome;
    const mod = await import('../database.js?shape=' + (++importCounter));
    Database = mod.default;
    db = new Database();
    await db.ready();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('createProject returns record with all expected fields', async () => {
    const id = await cb(done => db.createProject({
      name: 'test-app',
      path: '/tmp/test',
    }, done));

    const record = await cb(done => db.getProject(id, done));
    const expectedFields = [
      'id', 'name', 'path', 'subdomain', 'description',
      'parent_project_id', 'is_worktree', 'branch_name',
      'assigned_port', 'override_build_command', 'override_start_command',
      'override_port', 'override_docker_image', 'override_env',
      'desired_running', 'created_at', 'updated_at',
    ];

    for (const field of expectedFields) {
      assert.ok(field in record, 'Missing field: ' + field);
    }
  });

  it('record has correct default values', async () => {
    const id = await cb(done => db.createProject({
      name: 'defaults-test',
      path: '/tmp/defaults',
    }, done));

    const record = await cb(done => db.getProject(id, done));
    assert.equal(record.description, null);
    assert.equal(record.parent_project_id, null);
    assert.equal(record.is_worktree, 0);
    assert.equal(record.branch_name, null);
    assert.equal(record.assigned_port, null);
    assert.equal(record.override_build_command, null);
    assert.equal(record.override_start_command, null);
    assert.equal(record.override_port, null);
    assert.equal(record.override_docker_image, null);
    assert.equal(record.override_env, null);
    assert.equal(record.desired_running, 0);
  });
});

// ---- Project schema snapshot ----

describe('Project schema snapshot', () => {
  it('SCHEMA keys match expected snapshot', () => {
    const expectedKeys = [
      'id',
      'name',
      'path',
      'subdomain',
      'description',
      'parent_project_id',
      'is_worktree',
      'branch_name',
      'assigned_port',
      'override_build_command',
      'override_start_command',
      'override_port',
      'override_docker_image',
      'override_env',
      'desired_running',
      'created_at',
      'updated_at',
      'schema_version',
    ].sort();

    const actualKeys = Object.keys(SCHEMA).sort();
    assert.deepEqual(actualKeys, expectedKeys,
      'SCHEMA keys changed unexpectedly -- update this snapshot if the change is intentional');
  });

  it('all SCHEMA fields have required, type, and default properties', () => {
    for (const [key, field] of Object.entries(SCHEMA)) {
      assert.ok('required' in field, key + ' missing "required" property');
      assert.ok('type' in field, key + ' missing "type" property');
      assert.ok('default' in field, key + ' missing "default" property');
    }
  });
});

// ---- CLI output contract stability ----

describe('CLI output contracts', () => {
  it('--help output contains expected sections', () => {
    const r = runCli(['--help']);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('Usage'), 'help should contain Usage');
    assert.ok(r.stdout.includes('jump.sh'), 'help should mention jump.sh');
  });

  it('--version output format is stable', () => {
    const r = runCli(['--version']);
    assert.equal(r.exitCode, 0);
    assert.match(
      r.stdout.trim(),
      /^jump\.sh \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
      'version output should be "jump.sh X.Y.Z" with optional SemVer suffixes',
    );
  });

  it('add --json output shape is stable', () => {
    const projectDir = path.join(__dirname, '..');
    const r = runCli(['add', projectDir, '--json']);
    assert.equal(r.exitCode, 0);

    const parsed = JSON.parse(r.stdout);

    assert.ok('path' in parsed, 'should have path');
    assert.ok('detected' in parsed, 'should have detected');
    assert.ok('suggested' in parsed, 'should have suggested');
    assert.ok('type' in parsed.detected, 'detected should have type');
    assert.ok('name' in parsed.suggested, 'suggested should have name');
    assert.ok('subdomain' in parsed.suggested, 'suggested should have subdomain');
  });

  it('add --help output mentions expected flags', () => {
    const r = runCli(['add', '--help']);
    assert.equal(r.exitCode, 0);
    const expectedFlags = ['--name', '--json', '--yes', '--build', '--start', '--port', '--image', '--env'];
    for (const flag of expectedFlags) {
      assert.ok(r.stdout.includes(flag), 'add --help should mention ' + flag);
    }
  });
});
