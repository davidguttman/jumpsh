import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMockDb } from './helpers/mock-db.js';
import {
  autoStartDesiredProjects,
  restartProjectWithWorktrees,
  startProjectWithWorktrees,
  stopProjectWithWorktrees,
} from '../lib/desired-running.js';

function createDocker({ runningIds = [], startingIds = [], failStartIds = [] } = {}) {
  const running = new Set(runningIds.map(String));
  const starting = new Set(startingIds.map(String));
  const failStarts = new Set(failStartIds.map(String));
  const calls = [];

  return {
    calls,
    isStarting(project) {
      calls.push(['isStarting', project.id]);
      return starting.has(String(project.id));
    },
    async getStatus(project) {
      calls.push(['getStatus', project.id]);
      return { running: running.has(String(project.id)) };
    },
    async start(project) {
      calls.push(['start', project.id]);
      if (failStarts.has(String(project.id))) return { success: false, error: 'boom' };
      running.add(String(project.id));
      return { success: true };
    },
    async stop(project) {
      calls.push(['stop', project.id]);
      running.delete(String(project.id));
      return { success: true };
    },
  };
}

function projects() {
  return [
    { id: 1, name: 'parent', path: '/p', subdomain: 'parent', is_worktree: 0, desired_running: 0 },
    { id: 2, name: 'parent (feat)', path: '/p/.worktrees/feat', subdomain: 'parent--feat', parent_project_id: 1, is_worktree: 1, desired_running: 0 },
    { id: 3, name: 'parent (bug)', path: '/p/.worktrees/bug', subdomain: 'parent--bug', parent_project_id: 1, is_worktree: 1, desired_running: 0 },
  ];
}

describe('desired-running lifecycle helpers', () => {
  it('marks parent and known worktrees desired-running after a successful start', async () => {
    const db = createMockDb(projects());
    const docker = createDocker();

    const result = await startProjectWithWorktrees(db, docker, db.projects[0]);
    await Promise.all(result.worktreeStartPromises);

    assert.deepEqual(docker.calls.filter(c => c[0] === 'start').map(c => c[1]), [1, 2, 3]);
    assert.deepEqual(db.projects.map(p => p.desired_running), [1, 1, 1]);
  });

  it('clears desired-running for parent and known worktrees after a successful stop', async () => {
    const db = createMockDb(projects().map(p => ({ ...p, desired_running: 1 })));
    const docker = createDocker({ runningIds: [1, 2, 3] });

    const result = await stopProjectWithWorktrees(db, docker, db.projects[0]);
    await Promise.all(result.worktreeStopPromises);

    assert.deepEqual(docker.calls.filter(c => c[0] === 'stop').map(c => c[1]), [1, 2, 3]);
    assert.deepEqual(db.projects.map(p => p.desired_running), [0, 0, 0]);
  });

  it('restart sets the restarted parent/worktree set desired-running', async () => {
    const db = createMockDb(projects());
    const docker = createDocker({ runningIds: [1, 2, 3] });

    const result = await restartProjectWithWorktrees(db, docker, db.projects[0]);
    await Promise.all(result.worktreeStartPromises);

    assert.equal(result.result.success, true);
    assert.deepEqual(docker.calls.filter(c => c[0] === 'stop').map(c => c[1]), [1, 2, 3]);
    assert.deepEqual(docker.calls.filter(c => c[0] === 'start').map(c => c[1]), [1, 2, 3]);
    assert.deepEqual(db.projects.map(p => p.desired_running), [1, 1, 1]);
  });

  it('auto-starts desired projects once, skipping running and starting records', async () => {
    const db = createMockDb([
      { id: 1, name: 'parent', is_worktree: 0, desired_running: 1 },
      { id: 2, name: 'child', parent_project_id: 1, is_worktree: 1, desired_running: 1 },
      { id: 3, name: 'already-running', is_worktree: 0, desired_running: 1 },
      { id: 4, name: 'already-starting', is_worktree: 0, desired_running: 1 },
      { id: 5, name: 'not-desired', is_worktree: 0, desired_running: 0 },
    ]);
    const docker = createDocker({ runningIds: [3], startingIds: [4] });

    const results = await autoStartDesiredProjects(db, docker);

    assert.deepEqual(docker.calls.filter(c => c[0] === 'start').map(c => c[1]), [1, 2]);
    assert.equal(results.length, 4);
    assert.equal(results.find(r => r.project.id === 3).skipped, 'running');
    assert.equal(results.find(r => r.project.id === 4).skipped, 'starting');
  });

  it('logs auto-start failures without throwing', async () => {
    const db = createMockDb([{ id: 1, name: 'bad', is_worktree: 0, desired_running: 1 }]);
    const docker = createDocker({ failStartIds: [1] });
    const logs = [];

    const results = await autoStartDesiredProjects(db, docker, { logger: { error: msg => logs.push(msg) } });

    assert.equal(results[0].failed, true);
    assert.equal(db.projects[0].desired_running, 1);
    assert.match(logs[0], /Auto-start failed for bad: boom/);
  });

  it('does not start a project if desired-running is cleared during restore', async () => {
    const stored = [{ id: 1, name: 'stopped-during-restore', is_worktree: 0, desired_running: 1 }];
    const calls = [];
    const db = {
      getAllProjectsIncludingWorktrees(cb) {
        calls.push(['getAllProjectsIncludingWorktrees']);
        cb(null, stored.map(p => ({ ...p })));
      },
      getProject(id, cb) {
        calls.push(['getProject', id]);
        cb(null, stored.find(p => p.id === Number(id)) || null);
      },
      setDesiredRunning(ids, desired, cb) {
        calls.push(['setDesiredRunning', ids, desired]);
        const wanted = new Set((Array.isArray(ids) ? ids : [ids]).map(Number));
        for (const project of stored) {
          if (wanted.has(project.id)) project.desired_running = desired ? 1 : 0;
        }
        cb(null);
      },
    };
    const docker = {
      isStarting() {
        calls.push(['isStarting']);
        return false;
      },
      async getStatus() {
        calls.push(['getStatus']);
        stored[0].desired_running = 0;
        return { running: false };
      },
      async start() {
        calls.push(['start']);
        stored[0].desired_running = 1;
        return { success: true };
      },
    };

    const results = await autoStartDesiredProjects(db, docker);

    assert.equal(calls.some(c => c[0] === 'start'), false);
    assert.equal(stored[0].desired_running, 0);
    assert.equal(results[0].skipped, 'not-desired');
  });
});
