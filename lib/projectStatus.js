export async function enrichProjectStatus(docker, project) {
  const rawStatus = await docker.getStatus(project);
  const isStarting = typeof docker.isStarting === 'function' && docker.isStarting(project);
  const port = rawStatus.running ? await docker.getPort(project) : null;
  const health = isStarting ? 'starting' : docker.getHealthWithProbe(project, rawStatus);
  const status = isStarting || health === 'starting'
    ? 'starting'
    : (rawStatus.running ? 'running' : 'stopped');

  return { ...project, status, port, health };
}
