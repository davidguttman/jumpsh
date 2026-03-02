import { parseArgs } from 'node:util';
import fs from 'fs';
import path from 'path';
import Database from '../../database.js';
import DockerManager from '../../services/DockerManager.js';

export default async function remove(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      clean: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(`Usage: jumpsh remove <name> [--clean] [--force]

Unregister a project from jump.sh.

Arguments:
  name        Project name or subdomain

Options:
  --clean     Also delete the .jump.sh/ generated directory
  --force     Skip confirmation when containers are running
  --help, -h  Show this help
`);
    process.exit(0);
  }

  const name = positionals[0];
  if (!name) {
    console.error('Usage: jumpsh remove <name> [--clean] [--force]');
    process.exit(2);
  }

  const db = new Database();
  await db.ready();

  try {
    const project = await new Promise((resolve, reject) => {
      db.findProject(name, (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    if (!project) {
      console.error(`Project not found: ${name}`);
      db.close();
      process.exit(3);
    }

    // Check if running
    const docker = new DockerManager(db);
    const status = await docker.getStatus(project);
    if (status.running) {
      if (!values.force) {
        console.error(`Project '${project.name}' has running containers. Use --force to stop and remove.`);
        db.close();
        process.exit(1);
      }
      console.log(`Stopping containers for ${project.name}...`);
      await docker.stop(project);
    }

    // Delete from DB
    await new Promise((resolve, reject) => {
      db.deleteProject(project.id, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    console.log(`Removed: ${project.name}`);

    // Optionally clean generated directory
    if (values.clean) {
      const jumpshDir = path.join(project.path, '.jump.sh');
      if (fs.existsSync(jumpshDir)) {
        fs.rmSync(jumpshDir, { recursive: true });
        console.log(`Cleaned: ${jumpshDir}`);
      }
    }
  } catch (err) {
    console.error(`Failed to remove project: ${err.message}`);
    db.close();
    process.exit(1);
  }

  db.close();
}
