function dbCall(db, method, ...args) {
  return new Promise((resolve, reject) => {
    db[method](...args, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function isDesired(project) {
  return project?.desired_running === 1 || project?.desired_running === true;
}

async function getFreshDesiredProject(db, project) {
  if (!project?.id || typeof db.getProject !== 'function') {
    return isDesired(project) ? project : null;
  }

  const freshProject = await dbCall(db, 'getProject', project.id);
  return isDesired(freshProject) ? freshProject : null;
}

async function setDesiredRunning(db, projectsOrIds, desired) {
  const ids = [...new Set((projectsOrIds || []).map(p => typeof p === 'object' ? p.id : p).filter(id => id != null))];
  if (ids.length === 0) return;

  if (typeof db.setDesiredRunning === 'function') {
    await dbCall(db, 'setDesiredRunning', ids, desired);
    return;
  }

  await Promise.all(ids.map(id => dbCall(db, 'updateProject', id, { desired_running: desired ? 1 : 0 })));
}

function logFailure(logger, message, err) {
  const text = err?.message ? `${message}: ${err.message}` : message;
  if (typeof logger?.error === 'function') logger.error(text);
  else if (typeof logger === 'function') logger(text);
}

function startWorktreeAndMark(db, docker, wt, logger) {
  return Promise.resolve(docker.start(wt))
    .then(result => {
      if (result?.success || result?.alreadyStarting) {
        return setDesiredRunning(db, [wt], true);
      }
      logFailure(logger, `Worktree start failed for ${wt.path || wt.name}`, { message: result?.error || 'unknown error' });
      return null;
    })
    .catch(err => {
      logFailure(logger, `Worktree start failed for ${wt.path || wt.name}`, err);
    });
}

function stopWorktree(wt, docker, logger) {
  return Promise.resolve(docker.stop(wt)).catch(err => {
    logFailure(logger, `Worktree stop failed for ${wt.path || wt.name}`, err);
  });
}

export async function startProjectWithWorktrees(db, docker, project, { logger = console } = {}) {
  const result = await docker.start(project);
  const started = result?.success || result?.alreadyStarting;
  const worktreeStartPromises = [];
  let worktrees = [];

  if (!started) return { result, worktrees, worktreeStartPromises };

  await setDesiredRunning(db, [project], true);

  if (!project.is_worktree) {
    worktrees = await dbCall(db, 'getWorktreesForProject', project.id).catch(err => {
      logFailure(logger, `Failed to load worktrees for ${project.name}`, err);
      return [];
    }) || [];

    await setDesiredRunning(db, worktrees, true);
    for (const wt of worktrees) {
      worktreeStartPromises.push(startWorktreeAndMark(db, docker, wt, logger));
    }
  }

  return { result, worktrees, worktreeStartPromises };
}

export async function stopProjectWithWorktrees(db, docker, project, { logger = console } = {}) {
  const result = await docker.stop(project);
  if (!result?.success) return { result, worktreeStopPromises: [], worktrees: [] };

  let worktrees = [];
  if (!project.is_worktree) {
    worktrees = await dbCall(db, 'getWorktreesForProject', project.id).catch(err => {
      logFailure(logger, `Failed to load worktrees for ${project.name}`, err);
      return [];
    }) || [];
  }

  await setDesiredRunning(db, [project, ...worktrees], false);
  const worktreeStopPromises = worktrees.map(wt => stopWorktree(wt, docker, logger));
  return { result, worktrees, worktreeStopPromises };
}

export async function restartProjectWithWorktrees(db, docker, project, { logger = console } = {}) {
  const worktrees = project.is_worktree ? [] : await dbCall(db, 'getWorktreesForProject', project.id).catch(err => {
    logFailure(logger, `Failed to load worktrees for ${project.name}`, err);
    return [];
  }) || [];

  await Promise.all([project, ...worktrees].map(p => docker.stop(p)));

  const result = await docker.start(project);
  if (!result?.success && !result?.alreadyStarting) {
    return { result, worktrees, worktreeStartPromises: [] };
  }

  await setDesiredRunning(db, [project, ...worktrees], true);
  const worktreeStartPromises = worktrees.map(wt => startWorktreeAndMark(db, docker, wt, logger));
  return { result, worktrees, worktreeStartPromises };
}

export async function autoStartDesiredProjects(db, docker, { logger = console } = {}) {
  const projects = await dbCall(db, 'getAllProjectsIncludingWorktrees');
  const desiredProjects = (projects || [])
    .filter(isDesired)
    .sort((a, b) => {
      if (!!a.is_worktree !== !!b.is_worktree) return a.is_worktree ? 1 : -1;
      return a.id - b.id;
    });

  const attempted = new Set();
  const results = [];

  for (const project of desiredProjects) {
    const id = project.id?.toString();
    if (!id || attempted.has(id)) continue;
    attempted.add(id);

    try {
      if (typeof docker.isStarting === 'function' && docker.isStarting(project)) {
        results.push({ project, skipped: 'starting' });
        continue;
      }

      const status = await docker.getStatus(project);
      if (status?.running) {
        results.push({ project, skipped: 'running' });
        continue;
      }

      const freshProject = await getFreshDesiredProject(db, project);
      if (!freshProject) {
        results.push({ project, skipped: 'not-desired' });
        continue;
      }

      const result = await docker.start(freshProject);
      if (result?.success || result?.alreadyStarting) {
        await setDesiredRunning(db, [freshProject], true);
        results.push({ project: freshProject, result });
      } else {
        logFailure(logger, `Auto-start failed for ${project.name}`, { message: result?.error || 'unknown error' });
        results.push({ project, result, failed: true });
      }
    } catch (err) {
      logFailure(logger, `Auto-start failed for ${project.name}`, err);
      results.push({ project, error: err, failed: true });
    }
  }

  return results;
}
