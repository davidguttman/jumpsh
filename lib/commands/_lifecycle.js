import { parseArgs } from 'node:util';
import Database from '../../database.js';
import { isDaemonRunning } from '../daemon-status.js';
import { resolveProject, callDaemon, projectUrl } from './_helpers.js';

const VERBS = {
  start:   { gerund: 'Starting',   past: 'Started'   },
  stop:    { gerund: 'Stopping',   past: 'Stopped'   },
  restart: { gerund: 'Restarting', past: 'Restarted' },
};

function help(action) {
  return `Usage: jump.sh ${action} [name] [--json]

${action.charAt(0).toUpperCase() + action.slice(1)} a project's containers via the jump.sh daemon.

Arguments:
  name          Project name or subdomain (default: project in current directory)

Options:
  --json        Emit machine-readable JSON output
  --help, -h    Show this help
`;
}

function emitError(json, payload, exitCode) {
  if (json) {
    console.log(JSON.stringify({ ok: false, ...payload }));
  } else {
    console.error(`Error: ${payload.error}`);
  }
  process.exit(exitCode || 1);
}

export async function runLifecycle(action, argv) {
  const verbs = VERBS[action];
  if (!verbs) throw new Error(`Unknown lifecycle action: ${action}`);

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(help(action));
    process.exit(0);
  }

  const json = values.json;
  const target = positionals[0];

  if (!isDaemonRunning()) {
    return emitError(json, {
      action,
      error: 'jump.sh daemon is not running',
      code: 'DAEMON_NOT_RUNNING',
    }, 1);
  }

  const db = new Database();
  await db.ready();

  let project;
  try {
    project = await resolveProject(db, target);
  } catch (err) {
    db.close();
    return emitError(json, {
      action,
      error: err.message,
      code: err.code || 'RESOLVE_FAILED',
    }, err.exitCode || 2);
  }
  db.close();

  let result;
  try {
    result = await callDaemon(`/projects/${project.id}/${action}`);
  } catch (err) {
    return emitError(json, {
      action,
      name: project.name,
      subdomain: project.subdomain,
      error: err.message,
      code: err.code || 'DAEMON_ERROR',
      ...(err.body && err.body.buildLog ? { buildLog: err.body.buildLog } : {}),
    }, err.exitCode || 1);
  }

  const url = projectUrl(project);

  if (json) {
    const payload = {
      ok: true,
      action,
      id: project.id,
      name: project.name,
      subdomain: project.subdomain,
      url,
    };
    if (result && result.status) payload.status = result.status;
    if (result && result.health) payload.health = result.health;
    console.log(JSON.stringify(payload));
    return;
  }

  if (action === 'stop') {
    console.log(`${verbs.past}: ${project.name}`);
  } else {
    console.log(`${verbs.past}: ${project.name} (${url})`);
  }
}
