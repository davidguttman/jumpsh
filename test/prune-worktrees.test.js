import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { pruneWorktrees } from '../lib/worktree-prune.js';
import { runPruneWorktreesCommand } from '../lib/commands/prune.js';
import { createMockDb } from './helpers/mock-db.js';
import { makeTmpDir, cleanTmpDir } from './helpers/fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'jumpsh.js');

let tmpDir;

function projectRecord(overrides = {}) {
  return {
    id: 1,
    name: 'app',
    path: path.join(tmpDir, 'app'),
    subdomain: 'app',
    is_worktree: 0,
    ...overrides,
  };
}

function worktreeRecord(overrides = {}) {
  return {
    id: 2,
    name: 'app (feature)',
    path: path.join(tmpDir, 'app', '.worktrees', 'feature'),
    subdomain: 'app--feature',
    parent_project_id: 1,
    branch_name: 'feature',
    is_worktree: 1,
    desired_running: 0,
    ...overrides,
  };
}

function initGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: 'ignore' });
}

function createGitWorktree(projectDir, branch = 'feature') {
  initGitRepo(projectDir);
  const worktreesDir = path.join(projectDir, '.worktrees');
  fs.mkdirSync(worktreesDir);
  const worktreePath = path.join(worktreesDir, branch);
  execSync(`git worktree add ${worktreePath} -b ${branch}`, { cwd: projectDir, stdio: 'ignore' });
  return worktreePath;
}

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  cleanTmpDir(tmpDir);
});

describe('pruneWorktrees', () => {
  it('detects registered worktree records whose paths no longer exist', async () => {
    const missingPath = path.join(tmpDir, 'app', '.worktrees', 'missing');
    const db = createMockDb([
      projectRecord(),
      worktreeRecord({ path: missingPath, branch_name: 'missing' }),
    ]);

    const result = await pruneWorktrees({ db, apply: false });

    assert.equal(result.mode, 'dry-run');
    assert.deepEqual(result.prunable.map(p => p.path), [missingPath]);
    assert.equal(result.prunable[0].reason, 'missing_path');
    assert.equal(db.calls.some(c => c.method === 'deleteWorktree'), false);
  });

  it('detects registered worktree records whose paths are not valid git worktrees', async () => {
    const invalidPath = path.join(tmpDir, 'app', '.worktrees', 'not-git');
    fs.mkdirSync(invalidPath, { recursive: true });
    const db = createMockDb([
      projectRecord(),
      worktreeRecord({ path: invalidPath, branch_name: 'not-git' }),
    ]);

    const result = await pruneWorktrees({ db, apply: false });

    assert.deepEqual(result.prunable.map(p => p.path), [invalidPath]);
    assert.equal(result.prunable[0].reason, 'invalid_git_worktree');
    assert.equal(db.calls.some(c => c.method === 'deleteWorktree'), false);
  });

  it('applies by deleting only stale worktree db records through deleteWorktree(path)', async () => {
    const projectDir = path.join(tmpDir, 'app');
    const validPath = createGitWorktree(projectDir);
    const missingPath = path.join(tmpDir, 'app', '.worktrees', 'old');
    const invalidPath = path.join(tmpDir, 'app', '.worktrees', 'plain-dir');
    fs.mkdirSync(invalidPath, { recursive: true });
    const db = createMockDb([
      projectRecord({ path: projectDir }),
      worktreeRecord({ id: 2, path: validPath }),
      worktreeRecord({ id: 3, path: missingPath, branch_name: 'old' }),
      worktreeRecord({ id: 4, path: invalidPath, branch_name: 'plain-dir' }),
    ]);

    const result = await pruneWorktrees({ db, apply: true });

    assert.equal(result.mode, 'apply');
    assert.deepEqual(result.pruned.map(p => p.path).sort(), [invalidPath, missingPath].sort());
    assert.deepEqual(db.calls.filter(c => c.method === 'deleteWorktree').map(c => c.args[0]).sort(), [invalidPath, missingPath].sort());
    assert.ok(db.projects.find(p => p.path === validPath));
    assert.ok(db.projects.find(p => p.id === 1));
  });

  it('preserves valid worktrees', async () => {
    const projectDir = path.join(tmpDir, 'app');
    const validPath = createGitWorktree(projectDir);
    const db = createMockDb([
      projectRecord({ path: projectDir }),
      worktreeRecord({ path: validPath }),
    ]);

    const result = await pruneWorktrees({ db, apply: true });

    assert.equal(result.prunable.length, 0);
    assert.equal(result.pruned.length, 0);
    assert.equal(result.preserved.length, 1);
    assert.equal(result.preserved[0].path, validPath);
    assert.equal(db.calls.some(c => c.method === 'deleteWorktree'), false);
  });

  it('preserves worktree records marked desired-running instead of pruning blindly', async () => {
    const missingPath = path.join(tmpDir, 'app', '.worktrees', 'running-ish');
    const db = createMockDb([
      projectRecord(),
      worktreeRecord({ path: missingPath, branch_name: 'running-ish', desired_running: 1 }),
    ]);

    const result = await pruneWorktrees({ db, apply: true });

    assert.equal(result.prunable.length, 0);
    assert.equal(result.pruned.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].path, missingPath);
    assert.equal(result.skipped[0].reason, 'desired_running');
    assert.equal(db.calls.some(c => c.method === 'deleteWorktree'), false);
  });

  it('preserves actually running stale worktrees reported by status', async () => {
    const missingPath = path.join(tmpDir, 'app', '.worktrees', 'running');
    const db = createMockDb([
      projectRecord(),
      worktreeRecord({ path: missingPath, branch_name: 'running' }),
    ]);
    const statusCalls = [];

    const result = await pruneWorktrees({
      db,
      apply: true,
      getStatus: async (project) => {
        statusCalls.push(project.path);
        return { running: true };
      },
    });

    assert.deepEqual(statusCalls, [missingPath]);
    assert.equal(result.prunable.length, 0);
    assert.equal(result.pruned.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].path, missingPath);
    assert.equal(result.skipped[0].reason, 'running');
    assert.ok(db.projects.find(p => p.path === missingPath));
    assert.equal(db.calls.some(c => c.method === 'deleteWorktree'), false);
  });

  it('skips stale records when status returns an error object', async () => {
    const missingPath = path.join(tmpDir, 'app', '.worktrees', 'status-error');
    const db = createMockDb([
      projectRecord(),
      worktreeRecord({ path: missingPath, branch_name: 'status-error' }),
    ]);

    const result = await pruneWorktrees({
      db,
      apply: true,
      getStatus: async () => ({ running: false, error: 'docker unavailable' }),
    });

    assert.equal(result.prunable.length, 0);
    assert.equal(result.pruned.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].path, missingPath);
    assert.equal(result.skipped[0].reason, 'status_unknown');
    assert.equal(db.calls.some(c => c.method === 'deleteWorktree'), false);
  });
});

describe('runPruneWorktreesCommand', () => {
  it('uses the daemon API for apply when the daemon is available', async () => {
    let daemonCall;
    const result = await runPruneWorktreesCommand({
      apply: true,
      shouldTryDaemonFn: () => true,
      daemonStateFn: () => ({ running: true, discovered: true }),
      callDaemonFn: async (pathSuffix, options) => {
        daemonCall = { pathSuffix, options };
        return { action: 'prune-worktrees', mode: 'apply', pruned: [{ path: '/tmp/stale' }], counts: { pruned: 1 } };
      },
      localPruneFn: async () => {
        throw new Error('local prune should not run');
      },
    });

    assert.equal(daemonCall.pathSuffix, '/api/prune/worktrees');
    assert.equal(daemonCall.options.method, 'POST');
    assert.deepEqual(daemonCall.options.body, { apply: true });
    assert.equal(result.mode, 'apply');
    assert.equal(result.counts.pruned, 1);
  });

  it('falls back to local apply only when the daemon is unreachable', async () => {
    let localCalled = false;
    const unreachable = new Error('no daemon');
    unreachable.code = 'DAEMON_UNREACHABLE';

    const result = await runPruneWorktreesCommand({
      apply: true,
      shouldTryDaemonFn: () => true,
      daemonStateFn: () => ({ running: false, discovered: true }),
      callDaemonFn: async () => { throw unreachable; },
      localPruneFn: async ({ apply }) => {
        localCalled = true;
        return { action: 'prune-worktrees', mode: apply ? 'apply' : 'dry-run', counts: { pruned: 0 } };
      },
    });

    assert.equal(localCalled, true);
    assert.equal(result.mode, 'apply');
  });

  it('does not fall back to local apply when a running daemon is unreachable', async () => {
    const unreachable = new Error('no daemon');
    unreachable.code = 'DAEMON_UNREACHABLE';

    await assert.rejects(
      runPruneWorktreesCommand({
        apply: true,
        shouldTryDaemonFn: () => true,
        daemonStateFn: () => ({ running: true, discovered: true }),
        callDaemonFn: async () => { throw unreachable; },
        localPruneFn: async () => {
          throw new Error('local prune should not run while daemon is known running');
        },
      }),
      /no daemon/
    );
  });

  it('keeps dry-run local even when daemon is available', async () => {
    let localCalled = false;
    const result = await runPruneWorktreesCommand({
      apply: false,
      shouldTryDaemonFn: () => true,
      daemonStateFn: () => ({ running: true, discovered: true }),
      callDaemonFn: async () => {
        throw new Error('daemon should not run for dry-run');
      },
      localPruneFn: async ({ apply }) => {
        localCalled = true;
        return { action: 'prune-worktrees', mode: apply ? 'apply' : 'dry-run', counts: { pruned: 0 } };
      },
    });

    assert.equal(localCalled, true);
    assert.equal(result.mode, 'dry-run');
  });
});

describe('jump.sh prune worktrees CLI', () => {
  it('prints command help', () => {
    const stdout = execFileSync('node', [BIN, 'prune', '--help'], { encoding: 'utf8' });
    assert.ok(stdout.includes('jump.sh prune'));
    assert.ok(stdout.includes('worktrees'));
    assert.ok(stdout.includes('--json'));
    assert.ok(stdout.includes('--yes'));
  });

  it('emits JSON dry-run output by default without deleting records', () => {
    const home = path.join(tmpDir, 'home');
    const dbDir = path.join(home, '.jump.sh');
    const stalePath = path.join(tmpDir, 'app', '.worktrees', 'old');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dbDir, 'projects.json'), JSON.stringify({
      nextId: 3,
      projects: [projectRecord(), worktreeRecord({ path: stalePath, branch_name: 'old' })],
    }));

    const stdout = execFileSync('node', [BIN, 'prune', 'worktrees', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
      timeout: 10000,
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.mode, 'dry-run');
    assert.equal(parsed.counts.prunable, 1);
    assert.equal(parsed.prunable[0].path, stalePath);
    const data = JSON.parse(fs.readFileSync(path.join(dbDir, 'projects.json'), 'utf8'));
    assert.equal(data.projects.length, 2);
  });
});
