import path from 'path';
import fs from 'fs';
import slugify from 'slugify';
import Database from '../../database.js';
import { detectProjectType } from '../../services/ProjectDetector.js';
import WorktreeScanner from '../../services/WorktreeScanner.js';

export default async function add(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: jump.sh add [path]

Register a project folder with jump.sh. docker-compose.yml is optional.

Arguments:
  path    Path to project directory (default: current directory)
`);
    process.exit(0);
  }

  const targetPath = path.resolve(argv[0] || '.');

  if (!fs.existsSync(targetPath)) {
    console.error(`Path does not exist: ${targetPath}`);
    process.exit(1);
  }
  if (!fs.statSync(targetPath).isDirectory()) {
    console.error(`Not a directory: ${targetPath}`);
    process.exit(1);
  }

  const detection = detectProjectType(targetPath);
  if (detection.error) {
    console.error(`Could not detect project type: ${detection.error}`);
    process.exit(1);
  }

  const projectName = path.basename(targetPath);
  let subdomain = slugify(projectName, { lower: true, strict: true });

  const db = new Database();
  await db.ready();

  try {
    // Check if already registered
    const existing = await new Promise((resolve, reject) => {
      db.getProjectByPath(targetPath, (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
    if (existing) {
      console.log(`Already registered: ${existing.name} (${existing.subdomain}.jump.sh)`);
      db.close();
      return;
    }

    // Check subdomain collision, append numeric suffix if needed
    let candidate = subdomain;
    let suffix = 1;
    while (true) {
      const taken = await new Promise((resolve, reject) => {
        db.getProjectBySubdomain(candidate, (err, row) => {
          if (err) return reject(err);
          resolve(row);
        });
      });
      if (!taken) break;
      suffix++;
      candidate = `${subdomain}-${suffix}`;
    }
    if (candidate !== subdomain) {
      console.log(`Subdomain '${subdomain}' is taken, using '${candidate}' instead.`);
      subdomain = candidate;
    }

    const id = await new Promise((resolve, reject) => {
      db.createProject({
        name: projectName,
        path: targetPath,
        subdomain,
        description: `${detection.type}${detection.framework ? '/' + detection.framework : ''} project`,
      }, (err, lastID) => {
        if (err) return reject(err);
        resolve(lastID);
      });
    });

    console.log(`Added: ${projectName}`);
    console.log(`  Subdomain: ${subdomain}.jump.sh`);
    console.log(`  Type:      ${detection.type}${detection.framework ? '/' + detection.framework : ''}`);
    console.log(`  Path:      ${targetPath}`);

    // Scan for worktrees
    const project = await new Promise((resolve, reject) => {
      db.getProject(id, (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    const scanner = new WorktreeScanner(db);
    const worktrees = await scanner.scanWorktrees(project);
    if (worktrees.length > 0) {
      console.log(`  Worktrees: ${worktrees.length} found`);
      for (const wt of worktrees) {
        console.log(`    - ${wt.branch_name} (${wt.subdomain}.jump.sh)`);
      }
    }
  } catch (err) {
    console.error(`Failed to add project: ${err.message}`);
    db.close();
    process.exit(1);
  }

  db.close();
}
