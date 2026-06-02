export function createMockDb(initialProjects = []) {
  let nextId = initialProjects.length ? Math.max(...initialProjects.map(p => p.id)) + 1 : 1;
  const projects = [...initialProjects];
  const calls = [];

  function track(method, args) {
    calls.push({ method, args: [...args] });
  }

  return {
    calls,
    projects,
    ready() { return Promise.resolve(); },
    getProject(id, cb) {
      track('getProject', [id]);
      const numId = parseInt(id, 10);
      cb(null, projects.find(p => p.id === numId) || null);
    },
    getProjectBySubdomain(sub, cb) {
      track('getProjectBySubdomain', [sub]);
      cb(null, projects.find(p => p.subdomain === sub) || null);
    },
    getProjectByName(name, cb) {
      track('getProjectByName', [name]);
      cb(null, projects.find(p => p.name === name && !p.is_worktree) || null);
    },
    getProjectByPath(projectPath, cb) {
      track('getProjectByPath', [projectPath]);
      cb(null, projects.find(p => p.path === projectPath) || null);
    },
    getAllProjects(cb) {
      track('getAllProjects', []);
      cb(null, projects.filter(p => !p.is_worktree).sort((a, b) => a.name.localeCompare(b.name)));
    },
    getAllProjectsIncludingWorktrees(cb) {
      track('getAllProjectsIncludingWorktrees', []);
      cb(null, [...projects].sort((a, b) => a.id - b.id));
    },
    getNextPort(cb) {
      track('getNextPort', []);
      cb(null, 10042);
    },
    updateProject(id, updates, cb) {
      track('updateProject', [id, updates]);
      const p = projects.find(x => x.id === parseInt(id, 10));
      if (p) Object.assign(p, updates);
      cb(null);
    },
    setDesiredRunning(ids, desired, cb) {
      track('setDesiredRunning', [ids, desired]);
      const wanted = new Set((Array.isArray(ids) ? ids : [ids]).map(id => parseInt(id, 10)));
      for (const p of projects) {
        if (wanted.has(p.id)) p.desired_running = desired ? 1 : 0;
      }
      cb(null);
    },
    releasePort(id, cb) {
      track('releasePort', [id]);
      cb(null);
    },
    getWorktreesForProject(id, cb) {
      track('getWorktreesForProject', [id]);
      const numId = parseInt(id, 10);
      cb(null, projects.filter(p => p.parent_project_id === numId));
    },
    upsertWorktree(wt, cb) {
      track('upsertWorktree', [wt]);
      const existing = projects.find(p => p.name === wt.name);
      if (existing) {
        Object.assign(existing, wt);
      } else {
        projects.push({ id: nextId++, is_worktree: 1, desired_running: 0, ...wt });
      }
      cb(null);
    },
    deleteWorktree(path, cb) {
      track('deleteWorktree', [path]);
      const idx = projects.findIndex(p => p.path === path && p.is_worktree);
      if (idx !== -1) projects.splice(idx, 1);
      cb(null);
    },
    createProject(project, cb) {
      track('createProject', [project]);
      const id = nextId++;
      projects.push({ id, ...project });
      cb(null, id);
    },
  };
}
