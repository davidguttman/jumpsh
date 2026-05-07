import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { EventEmitter } from 'node:events';
import DockerManager from '../services/DockerManager.js';
import { createMockDb } from './helpers/mock-db.js';
import { createMockSpawner } from './helpers/mock-spawner.js';
import { makeTmpDir, cleanTmpDir, writeFile } from './helpers/fixtures.js';

let dm, mockDb, tmpDir;

beforeEach(() => {
  mockDb = createMockDb();
  dm = new DockerManager(mockDb, { spawner: createMockSpawner() });
  tmpDir = makeTmpDir();
});

afterEach(() => {
  cleanTmpDir(tmpDir);
});

// ---- Pure / internal methods ----

describe('DockerManager _detectStep', () => {
  it('returns step 2 for "Created"', () => {
    assert.equal(dm._detectStep('Container xyz Created', 1), 2);
  });

  it('returns step 2 for "creating"', () => {
    assert.equal(dm._detectStep('Creating container abc', 1), 2);
  });

  it('returns step 3 for "Started"', () => {
    assert.equal(dm._detectStep('Container xyz Started', 1), 3);
  });

  it('returns step 3 for "starting"', () => {
    assert.equal(dm._detectStep('Starting container', 1), 3);
  });

  it('returns currentStep for unrecognised line', () => {
    assert.equal(dm._detectStep('random output', 1), 1);
  });

  it('never decreases step', () => {
    assert.equal(dm._detectStep('Created', 3), 3);
  });
});

describe('DockerManager getHealth', () => {
  it('returns unknown by default', () => {
    assert.equal(dm.getHealth(42), 'unknown');
  });

  it('returns set health state', () => {
    dm.healthStates.set('42', 'healthy');
    assert.equal(dm.getHealth(42), 'healthy');
  });
});

describe('DockerManager startup listeners', () => {
  it('addStartupListener + _emitStartup calls callback', () => {
    const received = [];
    dm.addStartupListener(1, (data) => received.push(data));
    dm._emitStartup(1, { step: 1 });
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { step: 1 });
  });

  it('unsubscribe removes listener', () => {
    const received = [];
    const unsub = dm.addStartupListener(1, (data) => received.push(data));
    unsub();
    dm._emitStartup(1, { step: 2 });
    assert.equal(received.length, 0);
  });

  it('getStartupStep returns null for unknown id', () => {
    assert.equal(dm.getStartupStep(999), null);
  });

  it('getStartupStep returns current step data', () => {
    dm._emitStartup(5, { step: 2, label: 'Creating...' });
    const step = dm.getStartupStep(5);
    assert.equal(step.step, 2);
  });

  it('_emitStartup with done clears step data', () => {
    dm._emitStartup(5, { step: 3 });
    dm._emitStartup(5, { done: true });
    assert.equal(dm.getStartupStep(5), null);
  });
});

// ---- getComposeFile ----

describe('DockerManager getComposeFile', () => {
  it('returns root docker-compose.yml when present', () => {
    writeFile(tmpDir, 'docker-compose.yml', 'services:\n');
    const project = { path: tmpDir, subdomain: 'test', name: 'test' };
    const { composePath, isGenerated } = dm.getComposeFile(project);
    assert.equal(composePath, path.join(tmpDir, 'docker-compose.yml'));
    assert.equal(isGenerated, false);
  });

  it('returns root docker-compose.yaml when present', () => {
    writeFile(tmpDir, 'docker-compose.yaml', 'services:\n');
    const project = { path: tmpDir, subdomain: 'test2', name: 'test2' };
    const { composePath, isGenerated } = dm.getComposeFile(project);
    assert.equal(composePath, path.join(tmpDir, 'docker-compose.yaml'));
    assert.equal(isGenerated, false);
  });

  it('returns null when no compose file found', () => {
    const project = { path: tmpDir, subdomain: 'nofile', name: 'nofile' };
    const { composePath } = dm.getComposeFile(project);
    assert.equal(composePath, null);
  });
});

// ---- start() double-start prevention ----

describe('DockerManager start double-start', () => {
  it('prevents double-start for same project', async () => {
    const project = { id: 1, path: tmpDir, name: 'test', subdomain: 'test' };
    // Manually set _startingProjects to simulate in-progress start
    dm._startingProjects.add('1');

    const result = await dm.start(project);
    assert.equal(result.success, false);
    assert.equal(result.alreadyStarting, true);

    dm._startingProjects.delete('1');
  });

  it('reports when a project start is in progress', () => {
    const project = { id: 1, path: tmpDir, name: 'test', subdomain: 'test' };
    dm._startingProjects.add('1');
    assert.equal(dm.isStarting(project), true);
    dm._startingProjects.delete('1');
    assert.equal(dm.isStarting(project), false);
  });
});


// ---- streamLogs ----

describe('DockerManager streamLogs', () => {
  it('starts a bounded follow stream without replaying historical logs', () => {
    const spawner = createMockSpawner();
    const composeCalls = [];
    const mgr = new DockerManager(mockDb, {
      spawner,
      composeSpawnBuilder: (args, composePath) => {
        composeCalls.push({ args, composePath });
        return {
          command: 'docker',
          args: ['compose', ...(composePath ? ['-f', composePath] : []), ...args]
        };
      }
    });
    writeFile(tmpDir, 'docker-compose.yml', 'services:\n');
    const project = { id: 1, path: tmpDir, name: 'test', subdomain: 'test' };
    const res = new EventEmitter();
    res.writeHead = (code, headers) => {
      res.statusCode = code;
      res.headers = headers;
    };
    const writes = [];
    res.write = (chunk) => {
      writes.push(chunk);
    };
    res.flushHeaders = () => {
      res.flushedHeaders = true;
    };
    res.end = () => {
      res.ended = true;
    };

    const child = mgr.streamLogs(project, res);

    assert.equal(res.flushedHeaders, true);
    assert.equal(writes[0], ': connected\n\n');
    assert.ok(!writes[0].startsWith('data:'));
    assert.equal(child.pid, 12345);
    assert.equal(composeCalls.length, 1);
    assert.deepEqual(composeCalls[0], {
      args: ['logs', '--tail=0', '-f', '--no-color'],
      composePath: path.join(tmpDir, 'docker-compose.yml')
    });
    assert.deepEqual(spawner.calls[0].args, [
      'compose',
      '-f',
      path.join(tmpDir, 'docker-compose.yml'),
      'logs',
      '--tail=0',
      '-f',
      '--no-color'
    ]);
  });
});

// ---- DI spawner verification ----

describe('DockerManager uses injected spawner', () => {
  it('passes spawner to constructor', () => {
    const customSpawner = () => {};
    const mgr = new DockerManager(mockDb, { spawner: customSpawner });
    assert.equal(mgr.spawner, customSpawner);
  });

  it('defaults to real spawn when no spawner given', () => {
    const mgr = new DockerManager(mockDb);
    assert.equal(typeof mgr.spawner, 'function');
  });
});
