import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// database.js resolves DATA_DIR from os.homedir() at module load time.
// We must set HOME before each dynamic import and use cache-busting.

let tmpHome, originalHome, Database, db;
let importCounter = 0;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-db-'));
  process.env.HOME = tmpHome;
  const mod = await import(`../database.js?t=${++importCounter}`);
  Database = mod.default;
  db = new Database();
  await db.ready();
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function cb(fn) {
  return new Promise((resolve, reject) => {
    fn((err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// ---- CRUD ----

describe('Database CRUD', () => {
  it('creates a project and retrieves it', async () => {
    const id = await cb(done => db.createProject({ name: 'app', path: '/tmp/app', subdomain: 'app' }, done));
    assert.equal(typeof id, 'number');
    const project = await cb(done => db.getProject(id, done));
    assert.equal(project.name, 'app');
    assert.equal(project.path, '/tmp/app');
  });

  it('sets defaults on create', async () => {
    const id = await cb(done => db.createProject({ name: 'app2', path: '/tmp/app2' }, done));
    const p = await cb(done => db.getProject(id, done));
    assert.equal(p.assigned_port, null);
    assert.equal(p.desired_running, 0);
    assert.ok(p.created_at);
    assert.ok(p.updated_at);
    assert.equal(p.is_worktree, 0);
  });

  it('returns null for nonexistent project', async () => {
    const p = await cb(done => db.getProject(999, done));
    assert.equal(p, null);
  });

  it('finds project by subdomain', async () => {
    await cb(done => db.createProject({ name: 'Sub App', path: '/tmp/sub', subdomain: 'subapp' }, done));
    const p = await cb(done => db.getProjectBySubdomain('subapp', done));
    assert.equal(p.name, 'Sub App');
  });

  it('finds project by name (excludes worktrees)', async () => {
    await cb(done => db.createProject({ name: 'myapp', path: '/tmp/myapp' }, done));
    await cb(done => db.createProject({ name: 'myapp', path: '/tmp/myapp-wt', is_worktree: true }, done));
    const p = await cb(done => db.getProjectByName('myapp', done));
    assert.equal(p.path, '/tmp/myapp');
  });

  it('finds project by path', async () => {
    await cb(done => db.createProject({ name: 'pathapp', path: '/tmp/pathapp' }, done));
    const p = await cb(done => db.getProjectByPath('/tmp/pathapp', done));
    assert.equal(p.name, 'pathapp');
  });

  it('findProject tries name then subdomain', async () => {
    await cb(done => db.createProject({ name: 'alpha', path: '/tmp/a', subdomain: 'alpha-sub' }, done));
    const byName = await cb(done => db.findProject('alpha', done));
    assert.equal(byName.name, 'alpha');
    const bySub = await cb(done => db.findProject('alpha-sub', done));
    assert.equal(bySub.subdomain, 'alpha-sub');
  });

  it('getAllProjects excludes worktrees and sorts by name', async () => {
    await cb(done => db.createProject({ name: 'zebra', path: '/tmp/z' }, done));
    await cb(done => db.createProject({ name: 'alpha', path: '/tmp/a' }, done));
    await cb(done => db.createProject({ name: 'wt', path: '/tmp/wt', is_worktree: true, parent_project_id: 1 }, done));
    const all = await cb(done => db.getAllProjects(done));
    assert.equal(all.length, 2);
    assert.equal(all[0].name, 'alpha');
    assert.equal(all[1].name, 'zebra');
  });

  it('getAllProjectsIncludingWorktrees includes worktrees', async () => {
    await cb(done => db.createProject({ name: 'parent', path: '/tmp/p' }, done));
    await cb(done => db.createProject({ name: 'child', path: '/tmp/c', is_worktree: true, parent_project_id: 1 }, done));
    const all = await cb(done => db.getAllProjectsIncludingWorktrees(done));
    assert.equal(all.length, 2);
  });

  it('updates a project', async () => {
    const id = await cb(done => db.createProject({ name: 'upd', path: '/tmp/upd' }, done));
    const before = await cb(done => db.getProject(id, done));
    assert.equal(before.description, null);
    await cb(done => db.updateProject(id, { description: 'new desc' }, done));
    const after = await cb(done => db.getProject(id, done));
    assert.equal(after.description, 'new desc');
    // updated_at should be set (may match created_at if within same ms)
    assert.ok(after.updated_at);
  });

  it('sets desired-running for one or more projects', async () => {
    const first = await cb(done => db.createProject({ name: 'first', path: '/tmp/first' }, done));
    const second = await cb(done => db.createProject({ name: 'second', path: '/tmp/second' }, done));

    await cb(done => db.setDesiredRunning([first, second], true, done));
    assert.equal((await cb(done => db.getProject(first, done))).desired_running, 1);
    assert.equal((await cb(done => db.getProject(second, done))).desired_running, 1);

    await cb(done => db.setDesiredRunning(first, false, done));
    assert.equal((await cb(done => db.getProject(first, done))).desired_running, 0);
    assert.equal((await cb(done => db.getProject(second, done))).desired_running, 1);
  });

  it('deletes a project and its worktrees', async () => {
    const parentId = await cb(done => db.createProject({ name: 'del', path: '/tmp/del' }, done));
    await cb(done => db.createProject({ name: 'wt', path: '/tmp/wt', is_worktree: true, parent_project_id: parentId }, done));
    await cb(done => db.deleteProject(parentId, done));
    const p = await cb(done => db.getProject(parentId, done));
    assert.equal(p, null);
    const wts = await cb(done => db.getWorktreesForProject(parentId, done));
    assert.equal(wts.length, 0);
  });
});

// ---- Worktrees ----

describe('Database worktrees', () => {
  it('upserts a new worktree', async () => {
    const parentId = await cb(done => db.createProject({ name: 'p', path: '/tmp/p' }, done));
    await cb(done => db.upsertWorktree({ name: 'p (feat)', path: '/tmp/feat', subdomain: 'p--feat', parent_project_id: parentId, branch_name: 'feat' }, done));
    const wts = await cb(done => db.getWorktreesForProject(parentId, done));
    assert.equal(wts.length, 1);
    assert.equal(wts[0].subdomain, 'p--feat');
    assert.equal(wts[0].desired_running, 0);
  });

  it('upserts existing worktree without duplicating', async () => {
    const parentId = await cb(done => db.createProject({ name: 'p', path: '/tmp/p' }, done));
    await cb(done => db.upsertWorktree({ name: 'p (feat)', path: '/tmp/feat', subdomain: 'p--feat', parent_project_id: parentId, branch_name: 'feat' }, done));
    await cb(done => db.upsertWorktree({ name: 'p (feat)', path: '/tmp/feat2', subdomain: 'p--feat2', parent_project_id: parentId, branch_name: 'feat' }, done));
    const wts = await cb(done => db.getWorktreesForProject(parentId, done));
    assert.equal(wts.length, 1);
    assert.equal(wts[0].path, '/tmp/feat2');
  });

  it('preserves desired-running on existing worktree upsert when not specified', async () => {
    const parentId = await cb(done => db.createProject({ name: 'p', path: '/tmp/p' }, done));
    await cb(done => db.upsertWorktree({ name: 'p (feat)', path: '/tmp/feat', subdomain: 'p--feat', parent_project_id: parentId, branch_name: 'feat', desired_running: 1 }, done));
    await cb(done => db.upsertWorktree({ name: 'p (feat)', path: '/tmp/feat2', subdomain: 'p--feat2', parent_project_id: parentId, branch_name: 'feat' }, done));

    const wts = await cb(done => db.getWorktreesForProject(parentId, done));
    assert.equal(wts.length, 1);
    assert.equal(wts[0].path, '/tmp/feat2');
    assert.equal(wts[0].desired_running, 1);
  });

  it('deletes a worktree by path', async () => {
    const parentId = await cb(done => db.createProject({ name: 'p', path: '/tmp/p' }, done));
    await cb(done => db.upsertWorktree({ name: 'p (feat)', path: '/tmp/feat', subdomain: 'p--feat', parent_project_id: parentId, branch_name: 'feat' }, done));
    await cb(done => db.deleteWorktree('/tmp/feat', done));
    const wts = await cb(done => db.getWorktreesForProject(parentId, done));
    assert.equal(wts.length, 0);
  });
});

// ---- Port allocation ----

describe('Database port allocation', () => {
  it('getNextPort returns port in range', async () => {
    const port = await cb(done => db.getNextPort(done));
    assert.ok(port >= 10000 && port <= 11999);
  });

  it('excludes used ports', async () => {
    const id = await cb(done => db.createProject({ name: 'portapp', path: '/tmp/portapp' }, done));
    await cb(done => db.updateProject(id, { assigned_port: 10000 }, done));
    const port = await cb(done => db.getNextPort(done));
    assert.notEqual(port, 10000);
  });

  it('releasePort sets assigned_port to null', async () => {
    const id = await cb(done => db.createProject({ name: 'rp', path: '/tmp/rp' }, done));
    await cb(done => db.updateProject(id, { assigned_port: 10050 }, done));
    await cb(done => db.releasePort(id, done));
    const p = await cb(done => db.getProject(id, done));
    assert.equal(p.assigned_port, null);
  });

  it('makePortRange excludes used ports', () => {
    const used = new Set([10000, 10001, 10002]);
    const range = Database.makePortRange(used, 10000, 10010);
    assert.ok(!range.includes(10000));
    assert.ok(!range.includes(10001));
    assert.ok(!range.includes(10002));
    assert.ok(range.includes(10003));
  });

  it('makePortRange returns at most 100 candidates', () => {
    const range = Database.makePortRange(new Set(), 10000, 10999);
    assert.equal(range.length, 100);
  });
});
