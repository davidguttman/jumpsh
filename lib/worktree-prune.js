import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function dbCall(db, method, ...args) {
  return new Promise((resolve, reject) => {
    db[method](...args, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function isWorktree(project) {
  return project.is_worktree === 1 || project.is_worktree === true;
}

function isDesiredRunning(project) {
  return project.desired_running === 1 || project.desired_running === true;
}

function summarize(project, reason = null) {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    subdomain: project.subdomain,
    parent_project_id: project.parent_project_id || null,
    branch_name: project.branch_name || null,
    reason,
  };
}

export async function isValidGitWorktree(worktreePath) {
  let stat;
  try {
    stat = fs.statSync(worktreePath);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }

  if (!stat.isDirectory()) return false;

  try {
    const { stdout: insideStdout } = await execFileAsync(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: worktreePath, timeout: 5000 }
    );
    if (insideStdout.trim() !== 'true') return false;

    const { stdout: topLevelStdout } = await execFileAsync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: worktreePath, timeout: 5000 }
    );
    const topLevel = fs.realpathSync(topLevelStdout.trim());
    const current = fs.realpathSync(worktreePath);
    return path.normalize(topLevel) === path.normalize(current);
  } catch {
    return false;
  }
}

async function staleReason(project) {
  if (!fs.existsSync(project.path)) return 'missing_path';
  if (!(await isValidGitWorktree(project.path))) return 'invalid_git_worktree';
  return null;
}

export async function pruneWorktrees({ db, apply = false, getStatus = null } = {}) {
  if (!db) throw new Error('Database instance is required');

  if (typeof db.ready === 'function') await db.ready();

  const projects = await dbCall(db, 'getAllProjectsIncludingWorktrees');
  const worktrees = (projects || []).filter(isWorktree);
  const prunable = [];
  const pruned = [];
  const skipped = [];
  const preserved = [];

  for (const project of worktrees) {
    if (isDesiredRunning(project)) {
      skipped.push(summarize(project, 'desired_running'));
      continue;
    }

    const reason = await staleReason(project);
    if (!reason) {
      preserved.push(summarize(project, 'valid_git_worktree'));
      continue;
    }

    if (getStatus) {
      try {
        const status = await getStatus(project);
        if (status?.error) {
          skipped.push(summarize(project, 'status_unknown'));
          continue;
        }
        if (status?.running) {
          skipped.push(summarize(project, 'running'));
          continue;
        }
      } catch {
        skipped.push(summarize(project, 'status_unknown'));
        continue;
      }
    }

    prunable.push(summarize(project, reason));
  }

  if (apply) {
    for (const project of prunable) {
      await dbCall(db, 'deleteWorktree', project.path);
      pruned.push(project);
    }
  }

  return {
    action: 'prune-worktrees',
    mode: apply ? 'apply' : 'dry-run',
    dryRun: !apply,
    prunable,
    pruned,
    skipped,
    preserved,
    counts: {
      scanned: worktrees.length,
      prunable: prunable.length,
      pruned: pruned.length,
      skipped: skipped.length,
      preserved: preserved.length,
    },
  };
}
