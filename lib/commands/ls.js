import Database from '../../database.js';
import DockerManager from '../../services/DockerManager.js';
import { isDockerAvailable } from '../../services/dockerCommand.js';
import { projectUrl } from './_helpers.js';

export default async function ls(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: jump.sh ls [--json]

List all registered projects with their status.

Options:
  --json        Emit machine-readable JSON output
  --help, -h    Show this help
`);
    process.exit(0);
  }

  const json = argv.includes('--json');

  const db = new Database();
  await db.ready();

  try {
    const dockerAvailable = isDockerAvailable();

    const projects = await new Promise((resolve, reject) => {
      db.getAllProjectsIncludingWorktrees((err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });

    if (projects.length === 0) {
      if (json) {
        console.log(JSON.stringify({ projects: [], dockerAvailable }));
      } else {
        console.log('No projects registered. Run `jump.sh add .` in a project directory.');
      }
      db.close();
      return;
    }

    // Get status for all projects (or show unknown if Docker unavailable)
    let withStatus;
    if (dockerAvailable) {
      const docker = new DockerManager(db);
      withStatus = await Promise.all(
        projects.map(async (p) => {
          const status = await docker.getStatus(p);
          const port = status.running ? await docker.getPort(p) : null;
          return { ...p, running: status.running, statusStr: status.running ? 'running' : 'stopped', port };
        })
      );
    } else {
      withStatus = projects.map(p => ({ ...p, running: false, statusStr: 'unknown', port: null }));
    }

    if (json) {
      const out = withStatus.map(p => ({
        id: p.id,
        name: p.name,
        subdomain: p.subdomain,
        path: p.path,
        url: projectUrl(p),
        status: p.statusStr,
        running: p.running,
        port: p.port,
        is_worktree: !!p.is_worktree,
        parent_project_id: p.parent_project_id || null,
        branch_name: p.branch_name || null,
      }));
      console.log(JSON.stringify({ projects: out, dockerAvailable }));
      db.close();
      return;
    }

    // Separate main projects and worktrees
    const mainProjects = withStatus.filter(p => !p.is_worktree);
    const worktreesByParent = {};
    for (const p of withStatus.filter(p => p.is_worktree)) {
      if (!worktreesByParent[p.parent_project_id]) {
        worktreesByParent[p.parent_project_id] = [];
      }
      worktreesByParent[p.parent_project_id].push(p);
    }

    // Calculate column widths
    const allRows = [];
    for (const p of mainProjects) {
      allRows.push({ name: p.name, subdomain: p.subdomain, statusStr: p.statusStr, port: p.port, path: p.path, indent: '' });
      const worktrees = worktreesByParent[p.id] || [];
      for (const wt of worktrees) {
        allRows.push({ name: wt.branch_name, subdomain: wt.subdomain, statusStr: wt.statusStr, port: wt.port, path: wt.path, indent: '  ' });
      }
    }

    const nameW = Math.max(4, ...allRows.map(r => (r.indent + r.name).length));
    const subW = Math.max(9, ...allRows.map(r => r.subdomain.length));
    const statusW = 7;
    const portW = 5;

    // Header
    console.log(
      'NAME'.padEnd(nameW) + '  ' +
      'SUBDOMAIN'.padEnd(subW) + '  ' +
      'STATUS'.padEnd(statusW) + '  ' +
      'PORT'.padEnd(portW) + '  ' +
      'PATH'
    );

    // Rows
    for (const r of allRows) {
      const portStr = r.port ? String(r.port) : '-';
      console.log(
        (r.indent + r.name).padEnd(nameW) + '  ' +
        r.subdomain.padEnd(subW) + '  ' +
        r.statusStr.padEnd(statusW) + '  ' +
        portStr.padEnd(portW) + '  ' +
        r.path
      );
    }

    if (!dockerAvailable) {
      console.log('');
      console.log('Note: Docker is not available. Status cannot be determined.');
      console.log('Install or start Docker to manage project containers.');
    }
  } catch (err) {
    console.error(`Failed to list projects: ${err.message}`);
    db.close();
    process.exit(1);
  }

  db.close();
}
