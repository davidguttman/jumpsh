import path from 'path';
import Database from '../../database.js';
import DockerManager from '../../services/DockerManager.js';

export default async function start(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: jumpsh start [name]

Start a project's Docker containers.

Arguments:
  name    Project name or subdomain (default: project in current directory)
`);
    process.exit(0);
  }

  const db = new Database();
  await new Promise(resolve => setTimeout(resolve, 100));

  try {
    const project = await resolveProject(db, argv[0]);
    const docker = new DockerManager(db);

    console.log(`Starting ${project.name}...`);
    const result = await docker.start(project);

    if (result.success) {
      console.log(`Started: ${project.name} (${project.subdomain}.jump.sh)`);
    } else {
      console.error(`Failed to start: ${result.error}`);
      db.close();
      process.exit(1);
    }
  } catch (err) {
    console.error(err.message);
    db.close();
    process.exit(err.exitCode || 1);
  }

  db.close();
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

  // Try current directory
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
    'Usage: jumpsh start <name>'
  );
  err.exitCode = 2;
  throw err;
}
