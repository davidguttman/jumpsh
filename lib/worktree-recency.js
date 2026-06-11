import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 2000;

function timeFromIso(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function statMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

async function gitOutput(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return '';
  }
}

function statusPaths(porcelain) {
  const parts = porcelain.split('\0').filter(Boolean);
  const paths = [];

  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (!filePath) continue;

    paths.push(filePath);

    // In -z mode, rename/copy records include the original path as the next
    // NUL-separated token. Skip it; the new path above is the one to stat.
    if ((status[0] === 'R' || status[0] === 'C') && i + 1 < parts.length) {
      i++;
    }
  }

  return paths;
}

export async function getWorktreeRecencyMs(worktree) {
  if (!worktree?.path) return timeFromIso(worktree?.updated_at);

  let latest = Math.max(
    timeFromIso(worktree.updated_at),
    timeFromIso(worktree.created_at),
    statMtimeMs(worktree.path)
  );

  const commitTime = Number((await gitOutput(worktree.path, ['log', '-1', '--format=%ct'])).trim());
  if (Number.isFinite(commitTime) && commitTime > 0) {
    latest = Math.max(latest, commitTime * 1000);
  }

  const porcelain = await gitOutput(worktree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  for (const relativePath of statusPaths(porcelain)) {
    const absolutePath = path.join(worktree.path, relativePath);
    latest = Math.max(
      latest,
      statMtimeMs(absolutePath),
      statMtimeMs(path.dirname(absolutePath))
    );
  }

  return latest;
}

export async function sortWorktreesByRecency(worktrees) {
  const decorated = await Promise.all((worktrees || []).map(async (worktree, index) => ({
    worktree,
    index,
    recency: await getWorktreeRecencyMs(worktree),
  })));

  decorated.sort((a, b) => {
    if (b.recency !== a.recency) return b.recency - a.recency;
    return a.index - b.index;
  });

  return decorated.map(item => item.worktree);
}
