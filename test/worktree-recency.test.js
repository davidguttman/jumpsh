import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { sortWorktreesByRecency } from '../lib/worktree-recency.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-recency-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function git(cwd, args, env = {}) {
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });
}

function commit(cwd, message, date) {
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
}

function makeRepoWithWorktrees() {
  const repo = path.join(tmpDir, 'repo');
  const worktreesDir = path.join(repo, '.worktrees');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  commit(repo, 'base', '2020-01-01T00:00:00Z');
  fs.mkdirSync(worktreesDir);

  const oldPath = path.join(worktreesDir, 'old');
  git(repo, ['worktree', 'add', oldPath, '-b', 'old']);
  fs.writeFileSync(path.join(oldPath, 'old.txt'), 'old\n');
  commit(oldPath, 'old work', '2021-01-01T00:00:00Z');

  const newPath = path.join(worktreesDir, 'new');
  git(repo, ['worktree', 'add', newPath, '-b', 'new', 'main']);
  fs.writeFileSync(path.join(newPath, 'new.txt'), 'new\n');
  commit(newPath, 'new work', '2022-01-01T00:00:00Z');

  return { oldPath, newPath };
}

describe('worktree recency sorting', () => {
  it('sorts clean worktrees by most recent commit first', async () => {
    const { oldPath, newPath } = makeRepoWithWorktrees();

    const sorted = await sortWorktreesByRecency([
      { branch_name: 'old', path: oldPath },
      { branch_name: 'new', path: newPath },
    ]);

    assert.deepEqual(sorted.map(wt => wt.branch_name), ['new', 'old']);
  });

  it('uses dirty file modification time ahead of commit time', async () => {
    const { oldPath, newPath } = makeRepoWithWorktrees();
    const dirtyFile = path.join(oldPath, 'old.txt');
    fs.writeFileSync(dirtyFile, 'dirty\n');
    const future = new Date('2030-01-01T00:00:00Z');
    fs.utimesSync(dirtyFile, future, future);

    const sorted = await sortWorktreesByRecency([
      { branch_name: 'new', path: newPath },
      { branch_name: 'old', path: oldPath },
    ]);

    assert.deepEqual(sorted.map(wt => wt.branch_name), ['old', 'new']);
  });
});
