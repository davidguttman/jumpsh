import { parseArgs } from 'node:util';
import { spawn } from 'child_process';
import Database from '../../database.js';
import DockerManager from '../../services/DockerManager.js';
import { buildComposeSpawn, requireDocker } from '../../services/dockerCommand.js';

export default async function logs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      follow: { type: 'boolean', default: true },
      'no-follow': { type: 'boolean', default: false },
      lines: { type: 'string', default: '100' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(`Usage: jump.sh logs [name] [--no-follow] [--lines=N]

Tail project container logs.

Arguments:
  name          Project name or subdomain (default: project in current directory)

Options:
  --follow      Follow log output (default: true)
  --no-follow   Print logs and exit
  --lines=N     Number of lines to show (default: 100)
  --help, -h    Show this help
`);
    process.exit(0);
  }

  const follow = !values['no-follow'];
  const lines = parseInt(values.lines, 10) || 100;

  requireDocker();

  const db = new Database();
  await db.ready();

  try {
    const project = await resolveProject(db, positionals[0]);
    const docker = new DockerManager(db);
    const { composePath } = docker.getComposeFile(project.path);

    if (!composePath) {
      console.error(`No compose file found for ${project.name}. Start the project first.`);
      db.close();
      process.exit(1);
    }

    const composeArgs = ['logs', `--tail=${lines}`, '--no-color'];
    if (follow) composeArgs.push('-f');

    const { command, args } = buildComposeSpawn(composeArgs, composePath);
    const child = spawn(command, args, {
      cwd: project.path,
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    child.on('close', (code) => {
      db.close();
      process.exit(code || 0);
    });

    // Forward signals to child
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
  } catch (err) {
    console.error(err.message);
    db.close();
    process.exit(err.exitCode || 1);
  }
}

async function resolveProject(db, nameOrSubdomain) {
  if (nameOrSubdomain) {
    const project = await new Promise((resolve, reject) => {
      db.findProject(nameOrSubdomain, (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
    if (!project) {
      const err = new Error(`Project not found: ${nameOrSubdomain}`);
      err.exitCode = 3;
      throw err;
    }
    return project;
  }

  const cwd = process.cwd();
  const project = await new Promise((resolve, reject) => {
    db.getProjectByPath(cwd, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
  if (project) return project;

  const err = new Error(
    'No project name given and current directory is not a registered project.\n' +
    'Usage: jump.sh logs <name>'
  );
  err.exitCode = 2;
  throw err;
}
