import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enrichProjectStatus } from '../lib/projectStatus.js';

function dockerStub({ running = false, health = 'unknown', starting = false } = {}) {
  return {
    isStarting: () => starting,
    getStatus: async () => ({ running, containers: running ? [{ State: 'running' }] : [] }),
    getPort: async () => 1234,
    getHealthWithProbe: () => health
  };
}

describe('enrichProjectStatus', () => {
  const project = { id: 1, name: 'test-app' };

  it('marks in-flight starts as starting even before the container runs', async () => {
    const enriched = await enrichProjectStatus(dockerStub({ starting: true }), project);
    assert.equal(enriched.status, 'starting');
    assert.equal(enriched.health, 'starting');
    assert.equal(enriched.port, null);
  });

  it('keeps truly stopped projects stopped', async () => {
    const enriched = await enrichProjectStatus(dockerStub(), project);
    assert.equal(enriched.status, 'stopped');
    assert.equal(enriched.health, 'unknown');
    assert.equal(enriched.port, null);
  });

  it('keeps running healthy projects running', async () => {
    const enriched = await enrichProjectStatus(dockerStub({ running: true, health: 'healthy' }), project);
    assert.equal(enriched.status, 'running');
    assert.equal(enriched.health, 'healthy');
    assert.equal(enriched.port, 1234);
  });

  it('marks health-probe startup as starting', async () => {
    const enriched = await enrichProjectStatus(dockerStub({ running: true, health: 'starting' }), project);
    assert.equal(enriched.status, 'starting');
    assert.equal(enriched.health, 'starting');
    assert.equal(enriched.port, 1234);
  });
});
