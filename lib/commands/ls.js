import Database from '../../database.js';
import DockerManager from '../../services/DockerManager.js';

export default async function ls(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: jump.sh ls

List all registered projects with their status.
`);
    process.exit(0);
  }

  const db = new Database();
  await db.ready();

  try {
    const docker = new DockerManager(db);

    const projects = await new Promise((resolve, reject) => {
      db.getAllProjectsIncludingWorktrees((err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });

    if (projects.length === 0) {
      console.log('No projects registered. Run `jump.sh add .` in a project directory.');
      db.close();
      return;
    }

    // Get status for all projects
    const withStatus = await Promise.all(
      projects.map(async (p) => {
        const status = await docker.getStatus(p);
        const port = status.running ? await docker.getPort(p) : null;
        return { ...p, running: status.running, port };
      })
    );

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
      allRows.push({ name: p.name, subdomain: p.subdomain, running: p.running, port: p.port, path: p.path, indent: '' });
      const worktrees = worktreesByParent[p.id] || [];
      for (const wt of worktrees) {
        allRows.push({ name: wt.branch_name, subdomain: wt.subdomain, running: wt.running, port: wt.port, path: wt.path, indent: '  ' });
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
      const statusStr = r.running ? 'running' : 'stopped';
      const portStr = r.port ? String(r.port) : '-';
      console.log(
        (r.indent + r.name).padEnd(nameW) + '  ' +
        r.subdomain.padEnd(subW) + '  ' +
        statusStr.padEnd(statusW) + '  ' +
        portStr.padEnd(portW) + '  ' +
        r.path
      );
    }
  } catch (err) {
    console.error(`Failed to list projects: ${err.message}`);
    db.close();
    process.exit(1);
  }

  db.close();
}
