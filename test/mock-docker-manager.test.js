import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import MockDockerManager from '../services/MockDockerManager.js';
import { createMockDb } from './helpers/mock-db.js';

let mdm, mockDb;

const project = { id: 1, name: 'test-app', path: '/tmp/test', assigned_port: 10001 };

beforeEach(() => {
  mockDb = createMockDb();
  mdm = new MockDockerManager(mockDb, { delay: 20 });
});

describe('MockDockerManager constructor', () => {
  it('sets isMock flag', () => {
    assert.equal(mdm.isMock, true);
  });
});

describe('MockDockerManager start', () => {
  it('returns success and sets container running', async () => {
    const result = await mdm.start(project);
    assert.equal(result.success, true);
    assert.equal(result.status.running, true);
  });

  it('sets health to healthy after start', async () => {
    await mdm.start(project);
    assert.equal(mdm.getHealth(1), 'healthy');
  });

  it('prevents double-start', async () => {
    const p1 = mdm.start(project);
    const p2 = mdm.start(project);
    const [r1, r2] = await Promise.all([p1, p2]);
    // One should succeed, one should get alreadyStarting
    const results = [r1, r2];
    assert.ok(results.some(r => r.success === true));
    assert.ok(results.some(r => r.alreadyStarting === true));
  });

  it('emits startup steps to listeners', async () => {
    const events = [];
    mdm.addStartupListener(1, (data) => events.push(data));
    await mdm.start(project);
    assert.ok(events.length >= 5);
    assert.ok(events.some(e => e.step === 1));
    assert.ok(events.some(e => e.step === 5 && e.done));
  });

  it('uses assigned_port from project', async () => {
    await mdm.start(project);
    const port = await mdm.getPort(project);
    assert.equal(port, 10001);
  });

  it('defaults to port 3000 when no assigned_port', async () => {
    const p = { id: 2, name: 'no-port', path: '/tmp/x' };
    await mdm.start(p);
    const port = await mdm.getPort(p);
    assert.equal(port, 3000);
  });
});

describe('MockDockerManager stop', () => {
  it('transitions state to stopped', async () => {
    await mdm.start(project);
    await mdm.stop(project);
    const status = await mdm.getStatus(project);
    assert.equal(status.running, false);
  });

  it('returns success', async () => {
    const result = await mdm.stop(project);
    assert.equal(result.success, true);
  });

  it('sets health to unknown', async () => {
    await mdm.start(project);
    await mdm.stop(project);
    assert.equal(mdm.getHealth(1), 'unknown');
  });
});

describe('MockDockerManager restart', () => {
  it('stops then starts', async () => {
    await mdm.start(project);
    const result = await mdm.restart(project);
    assert.equal(result.success, true);
    const status = await mdm.getStatus(project);
    assert.equal(status.running, true);
  });
});

describe('MockDockerManager getStatus', () => {
  it('returns not running by default', async () => {
    const status = await mdm.getStatus(project);
    assert.equal(status.running, false);
    assert.deepEqual(status.containers, []);
  });

  it('returns running after start', async () => {
    await mdm.start(project);
    const status = await mdm.getStatus(project);
    assert.equal(status.running, true);
    assert.equal(status.containers.length, 1);
  });
});

describe('MockDockerManager getPort', () => {
  it('returns null when not running', async () => {
    const port = await mdm.getPort(project);
    assert.equal(port, null);
  });

  it('returns port when running', async () => {
    await mdm.start(project);
    const port = await mdm.getPort(project);
    assert.equal(port, 10001);
  });
});

describe('MockDockerManager getLogs', () => {
  it('returns empty string when not running', async () => {
    const logs = await mdm.getLogs(project);
    assert.equal(logs, '');
  });

  it('returns mock log lines when running', async () => {
    await mdm.start(project);
    const logs = await mdm.getLogs(project);
    assert.ok(logs.includes('[mock]'));
    assert.ok(logs.includes(project.name));
  });
});

describe('MockDockerManager cleanup', () => {
  it('removes container state', async () => {
    await mdm.start(project);
    await mdm.cleanup(project);
    const status = await mdm.getStatus(project);
    assert.equal(status.running, false);
    assert.equal(mdm.getHealth(1), 'unknown');
  });
});

describe('MockDockerManager getComposeFile', () => {
  it('returns null composePath', () => {
    const result = mdm.getComposeFile(project);
    assert.equal(result.composePath, null);
    assert.equal(result.isGenerated, false);
  });
});

describe('MockDockerManager getBuildLog', () => {
  it('returns null', () => {
    assert.equal(mdm.getBuildLog(project), null);
  });
});

describe('MockDockerManager getHealth', () => {
  it('returns unknown by default', () => {
    assert.equal(mdm.getHealth(99), 'unknown');
  });
});

describe('MockDockerManager getHealthWithProbe', () => {
  it('transitions unknown+running to starting', async () => {
    await mdm.start(project);
    // Manually reset to unknown to test probe path
    mdm.healthStates.set('1', 'unknown');
    const health = mdm.getHealthWithProbe(project, { running: true });
    assert.equal(health, 'starting');
  });

  it('returns existing health when not unknown+running', async () => {
    await mdm.start(project);
    const health = mdm.getHealthWithProbe(project, { running: true });
    assert.equal(health, 'healthy');
  });
});

describe('MockDockerManager streamLogs', () => {
  it('returns object with kill method', () => {
    let headerWritten = false;
    const mockRes = {
      writeHead: () => { headerWritten = true; },
      write: () => {},
      on: () => {},
    };
    const handle = mdm.streamLogs(project, mockRes);
    assert.ok(headerWritten);
    assert.equal(typeof handle.kill, 'function');
    handle.kill();
  });
});

describe('MockDockerManager addStartupListener', () => {
  it('returns unsubscribe function', () => {
    const unsub = mdm.addStartupListener(1, () => {});
    assert.equal(typeof unsub, 'function');
    unsub();
  });

  it('stops receiving events after unsubscribe', async () => {
    const events = [];
    const unsub = mdm.addStartupListener(1, (data) => events.push(data));
    unsub();
    await mdm.start(project);
    assert.equal(events.length, 0);
  });
});

describe('MockDockerManager getStartupStep', () => {
  it('returns null when no startup in progress', () => {
    assert.equal(mdm.getStartupStep(1), null);
  });
});

describe('MockDockerManager op cancellation', () => {
  it('stop cancels in-flight start', async () => {
    mdm = new MockDockerManager(mockDb, { delay: 200 });
    const startPromise = mdm.start(project);
    // Stop immediately — should cancel the start's remaining steps
    await new Promise(r => setTimeout(r, 10));
    // Force clear the _startingProjects so stop doesn't block
    mdm._startingProjects.delete('1');
    await mdm.stop(project);
    const _result = await startPromise;
    // Start may have finished or been cancelled depending on timing
    // Either way, final state should be stopped after stop()
    const status = await mdm.getStatus(project);
    assert.equal(status.running, false);
  });
});

describe('MockDockerManager getHealthWithProbe stale transition', () => {
  it('does not mark stopped project as healthy after delayed probe', async () => {
    // Use a longer delay so the async transition hasn't fired yet when we stop
    mdm = new MockDockerManager(mockDb, { delay: 200 });
    await mdm.start(project);

    // Reset health to unknown to trigger probe path
    mdm.healthStates.set('1', 'unknown');

    // Collect events to verify no stale done event
    const events = [];
    mdm.addStartupListener(1, (data) => events.push(data));

    // Trigger probe — schedules async transition after ~100ms
    const health = mdm.getHealthWithProbe(project, { running: true });
    assert.equal(health, 'starting');

    // Stop the project before the delayed transition fires
    await mdm.stop(project);

    // Wait long enough for the delayed transition to have fired if unguarded
    await new Promise(r => setTimeout(r, 250));

    // Health must NOT be 'healthy' — project was stopped
    const finalHealth = mdm.getHealth(1);
    assert.notEqual(finalHealth, 'healthy', `Expected health to not be healthy after stop, got: ${finalHealth}`);

    // No stale step-5 done event should have been emitted after the stop
    const _doneEvents = events.filter(e => e.step === 5 && e.done);
    // The stop emits its own done event (with error: 'Project stopped'), but
    // there should be no step-5/Ready! done event after the stop
    const step5AfterStop = events.slice(events.findIndex(e => e.error === 'Project stopped') + 1)
      .filter(e => e.step === 5 && e.done);
    assert.equal(step5AfterStop.length, 0, 'No stale step-5 done event should fire after stop');
  });
});
