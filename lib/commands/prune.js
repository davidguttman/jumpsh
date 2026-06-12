import { parseArgs } from 'node:util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from '../../database.js';
import DockerManager from '../../services/DockerManager.js';
import { isDockerAvailable } from '../../services/dockerCommand.js';
import { isDaemonRunning } from '../daemon-status.js';
import { pruneWorktrees } from '../worktree-prune.js';
import { callDaemon } from './_helpers.js';

const HELP = `
jump.sh prune — safely clean stale jump.sh records

Usage: jump.sh prune worktrees [--json] [--yes|--apply]

Subcommands:
  worktrees      Prune registered worktree records whose paths are missing or invalid

Options:
  --json         Emit machine-readable JSON output
  --yes, --apply Actually delete stale database records (default is dry-run)
  --help, -h     Show this help
`.trim();

function printText(result) {
  if (result.mode === 'dry-run') {
    console.log('Dry run: no database records were deleted. Re-run with --yes or --apply to prune.');
  } else {
    console.log(`Pruned ${result.counts.pruned} stale worktree record(s).`);
  }

  if (result.prunable.length > 0) {
    console.log('');
    console.log(result.mode === 'dry-run' ? 'Would prune:' : 'Pruned:');
    for (const project of result.prunable) {
      console.log(`  - ${project.name} (${project.reason}): ${project.path}`);
    }
  } else {
    console.log('No stale worktree records found.');
  }

  if (result.skipped.length > 0) {
    console.log('');
    console.log('Skipped:');
    for (const project of result.skipped) {
      console.log(`  - ${project.name} (${project.reason}): ${project.path}`);
    }
  }
}

function serverJsonPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.jump.sh', 'server.json');
}

export function getDaemonPruneState({ isDaemonRunningFn = isDaemonRunning, homeDir = os.homedir() } = {}) {
  return {
    running: isDaemonRunningFn(),
    discovered: fs.existsSync(serverJsonPath(homeDir)),
  };
}

export function shouldTryDaemonPrune({ apply, daemonState = null } = {}) {
  if (!apply) return false;
  const state = daemonState || getDaemonPruneState();
  return state.running || state.discovered;
}

async function runLocalPruneWorktrees({ apply }) {
  const db = new Database();
  await db.ready();

  try {
    const docker = isDockerAvailable() ? new DockerManager(db) : null;
    return await pruneWorktrees({
      db,
      apply,
      getStatus: docker ? project => docker.getStatus(project) : null,
    });
  } finally {
    db.close();
  }
}

export async function runPruneWorktreesCommand({
  apply = false,
  callDaemonFn = callDaemon,
  localPruneFn = runLocalPruneWorktrees,
  shouldTryDaemonFn = shouldTryDaemonPrune,
  daemonStateFn = getDaemonPruneState,
} = {}) {
  const daemonState = apply ? daemonStateFn() : { running: false, discovered: false };
  if (apply && shouldTryDaemonFn({ apply, daemonState })) {
    try {
      return await callDaemonFn('/api/prune/worktrees', {
        method: 'POST',
        body: { apply: true },
        timeoutMs: 5000,
      });
    } catch (err) {
      if (err.code !== 'DAEMON_UNREACHABLE') throw err;
      if (daemonState.running) throw err;
      // Safe fallback: only use direct DB mutation when no running daemon is confirmed.
    }
  }

  return localPruneFn({ apply });
}

export default async function prune(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  const subcommand = argv[0];
  if (subcommand !== 'worktrees') {
    console.error(subcommand ? `Unknown prune subcommand: ${subcommand}` : 'Usage: jump.sh prune worktrees [--json] [--yes|--apply]');
    console.error('Run "jump.sh prune --help" for usage.');
    process.exit(2);
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      json: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
    },
    strict: true,
  });

  try {
    const result = await runPruneWorktreesCommand({
      apply: values.yes || values.apply,
    });

    if (values.json) {
      console.log(JSON.stringify(result));
    } else {
      printText(result);
    }
  } catch (err) {
    if (values.json) {
      console.log(JSON.stringify({
        ok: false,
        action: 'prune-worktrees',
        error: err.message,
        code: err.code || 'PRUNE_FAILED',
      }));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode || 1);
  }
}
