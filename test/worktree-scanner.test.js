import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import WorktreeScanner from '../services/WorktreeScanner.js';
import { createMockDb } from './helpers/mock-db.js';
import { makeTmpDir, cleanTmpDir } from './helpers/fixtures.js';

let tmpDir, projectDir, mockDb, mockDocker, scanner;

function initGitRepo(dir) {
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: 'ignore' });
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  mockDb = createMockDb();
  mockDocker = {
    getStatus: async () => ({ running: false }),
    start: async () => ({ success: true }),
    _startCalls: [],
  };
  mockDocker.start = async (p) => { mockDocker._startCalls.push(p); return { success: true }; };
  scanner = new WorktreeScanner(mockDb, mockDocker);
});

afterEach(() => {
  scanner.cleanup();
  cleanTmpDir(tmpDir);
});

describe('WorktreeScanner watchProject', () => {
  it('skips if no .worktrees/ directory', () => {
    const project = { id: 1, path: projectDir, name: 'test', subdomain: 'test' };
    scanner.watchProject(project);
    assert.equal(scanner.watchers.size, 0);
  });

  it('skips duplicate watch for same projectId', () => {
    initGitRepo(projectDir);
    const wtDir = path.join(projectDir, '.worktrees');
    fs.mkdirSync(wtDir);
    const project = { id: 1, path: projectDir, name: 'test', subdomain: 'test' };
    scanner.watchProject(project);
    scanner.watchProject(project);
    assert.equal(scanner.watchers.size, 1);
  });
});

describe('WorktreeScanner scanWorktrees', () => {
  it('returns empty when no .worktrees/ dir', async () => {
    const project = { id: 1, path: projectDir, name: 'test', subdomain: 'test' };
    const result = await scanner.scanWorktrees(project);
    assert.deepEqual(result, []);
  });

  it('skips entries without .git marker', async () => {
    initGitRepo(projectDir);
    const wtDir = path.join(projectDir, '.worktrees');
    fs.mkdirSync(wtDir);
    // Create a plain directory (not a worktree)
    fs.mkdirSync(path.join(wtDir, 'not-a-worktree'));

    const project = { id: 1, path: projectDir, name: 'test', subdomain: 'test' };
    const result = await scanner.scanWorktrees(project);
    assert.equal(result.length, 0);
  });

  it('detects valid git worktree and generates correct subdomain', async () => {
    initGitRepo(projectDir);
    const wtDir = path.join(projectDir, '.worktrees');
    fs.mkdirSync(wtDir);
    execSync(`git worktree add ${path.join(wtDir, 'feature-x')} -b feature-x`, {
      cwd: projectDir,
      stdio: 'ignore',
    });

    const project = { id: 1, path: projectDir, name: 'test', subdomain: 'myapp' };
    const result = await scanner.scanWorktrees(project);
    assert.equal(result.length, 1);
    assert.equal(result[0].branch_name, 'feature-x');
    assert.equal(result[0].subdomain, 'myapp--feature-x');

    // Verify upsertWorktree was called
    const upsertCalls = mockDb.calls.filter(c => c.method === 'upsertWorktree');
    assert.equal(upsertCalls.length, 1);
  });

  it('does not clear an existing worktree desired-running flag during a non-desired parent scan', async () => {
    initGitRepo(projectDir);
    const wtDir = path.join(projectDir, '.worktrees');
    fs.mkdirSync(wtDir);
    const worktreePath = path.join(wtDir, 'feature-x');
    execSync(`git worktree add ${worktreePath} -b feature-x`, {
      cwd: projectDir,
      stdio: 'ignore',
    });
    mockDb.projects.push({
      id: 2,
      name: 'test (feature-x)',
      path: worktreePath,
      subdomain: 'myapp--feature-x',
      parent_project_id: 1,
      branch_name: 'feature-x',
      is_worktree: 1,
      desired_running: 1,
    });

    const project = { id: 1, path: projectDir, name: 'test', subdomain: 'myapp', desired_running: 0 };
    await scanner.scanWorktrees(project);

    assert.equal(mockDb.projects.find(p => p.id === 2).desired_running, 1);
    const upsertCall = mockDb.calls.find(c => c.method === 'upsertWorktree');
    assert.equal(Object.hasOwn(upsertCall.args[0], 'desired_running'), false);
  });

  it('preserves an explicitly stopped existing worktree during a desired parent scan', async () => {
    initGitRepo(projectDir);
    const wtDir = path.join(projectDir, '.worktrees');
    fs.mkdirSync(wtDir);
    const worktreePath = path.join(wtDir, 'feature-x');
    execSync(`git worktree add ${worktreePath} -b feature-x`, {
      cwd: projectDir,
      stdio: 'ignore',
    });
    mockDb.projects.push({
      id: 2,
      name: 'test (feature-x)',
      path: worktreePath,
      subdomain: 'myapp--feature-x',
      parent_project_id: 1,
      branch_name: 'feature-x',
      is_worktree: 1,
      desired_running: 0,
    });

    const project = { id: 1, path: projectDir, name: 'test', subdomain: 'myapp', desired_running: 1 };
    await scanner.scanWorktrees(project);

    assert.equal(mockDb.projects.find(p => p.id === 2).desired_running, 0);
    assert.equal(mockDocker._startCalls.length, 0);
    const upsertCall = mockDb.calls.find(c => c.method === 'upsertWorktree');
    assert.equal(Object.hasOwn(upsertCall.args[0], 'desired_running'), false);
  });

  it('continues scanAllProjects when parent status lookup fails', async () => {
    initGitRepo(projectDir);
    const wtDir = path.join(projectDir, '.worktrees');
    fs.mkdirSync(wtDir);
    const worktreePath = path.join(wtDir, 'feature-x');
    execSync(`git worktree add ${worktreePath} -b feature-x`, {
      cwd: projectDir,
      stdio: 'ignore',
    });
    mockDb.projects.push({ id: 1, path: projectDir, name: 'test', subdomain: 'test', is_worktree: 0 });
    mockDocker.getStatus = async () => { throw new Error('status unavailable'); };

    const originalError = console.error;
    console.error = () => {};
    try {
      const result = await scanner.scanAllProjects();
      assert.equal(result.length, 1);
      assert.equal(result[0].length, 1);
    } finally {
      console.error = originalError;
    }

    assert.equal(mockDocker._startCalls.length, 0);
    assert.equal(mockDb.calls.some(c => c.method === 'upsertWorktree'), true);
  });

  it('keeps scanning other projects when one project scan fails', async () => {
    const badProjectDir = path.join(tmpDir, 'bad-project');
    fs.mkdirSync(badProjectDir);
    fs.writeFileSync(path.join(badProjectDir, '.worktrees'), 'not a directory');

    const goodProjectDir = path.join(tmpDir, 'good-project');
    fs.mkdirSync(goodProjectDir);
    initGitRepo(goodProjectDir);
    fs.mkdirSync(path.join(goodProjectDir, '.worktrees'));

    mockDb.projects.push(
      { id: 1, path: badProjectDir, name: 'bad', subdomain: 'bad', is_worktree: 0 },
      { id: 2, path: goodProjectDir, name: 'good', subdomain: 'good', is_worktree: 0 },
    );

    const originalError = console.error;
    console.error = () => {};
    try {
      const result = await scanner.scanAllProjects();
      assert.equal(result.length, 2);
    } finally {
      console.error = originalError;
    }

    assert.equal(scanner.watchers.has(2), true);
  });

  it('removes stale worktrees from db', async () => {
    initGitRepo(projectDir);
    const wtDir = path.join(projectDir, '.worktrees');
    fs.mkdirSync(wtDir);

    // Pre-populate db with a worktree that doesn't exist on disk
    mockDb.projects.push({
      id: 99,
      name: 'test (old-branch)',
      path: path.join(wtDir, 'old-branch'),
      subdomain: 'test--old-branch',
      parent_project_id: 1,
      is_worktree: 1,
    });

    const project = { id: 1, path: projectDir, name: 'test', subdomain: 'test' };
    await scanner.scanWorktrees(project);

    // Wait for async db callback
    await new Promise(r => setTimeout(r, 20));

    const deleteCalls = mockDb.calls.filter(c => c.method === 'deleteWorktree');
    assert.equal(deleteCalls.length, 1);
    assert.ok(deleteCalls[0].args[0].includes('old-branch'));
  });
});

describe('WorktreeScanner unwatchProject', () => {
  it('closes watcher and removes from map', () => {
    initGitRepo(projectDir);
    const wtDir = path.join(projectDir, '.worktrees');
    fs.mkdirSync(wtDir);
    const project = { id: 1, path: projectDir, name: 'test', subdomain: 'test' };
    scanner.watchProject(project);
    assert.equal(scanner.watchers.size, 1);
    scanner.unwatchProject(1);
    assert.equal(scanner.watchers.size, 0);
  });
});

describe('WorktreeScanner cleanup', () => {
  it('closes all watchers', () => {
    initGitRepo(projectDir);
    const wtDir = path.join(projectDir, '.worktrees');
    fs.mkdirSync(wtDir);

    const project2Dir = path.join(tmpDir, 'project2');
    fs.mkdirSync(project2Dir);
    initGitRepo(project2Dir);
    fs.mkdirSync(path.join(project2Dir, '.worktrees'));

    scanner.watchProject({ id: 1, path: projectDir, name: 'p1', subdomain: 'p1' });
    scanner.watchProject({ id: 2, path: project2Dir, name: 'p2', subdomain: 'p2' });
    assert.equal(scanner.watchers.size, 2);

    scanner.cleanup();
    assert.equal(scanner.watchers.size, 0);
  });
});
