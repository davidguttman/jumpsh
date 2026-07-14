import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const detailSource = fs.readFileSync(new URL('../views/partials/_project_detail.ejs', import.meta.url), 'utf8');
const indexSource = fs.readFileSync(new URL('../views/index.ejs', import.meta.url), 'utf8');

const BASE_NOW = Date.parse('2026-07-14T12:00:00Z');

// The real per-project state registry plus the recency-label init, exactly as
// _activateScripts re-runs them on every expand.
function extractDetailActivationScript() {
  const registryStart = detailSource.indexOf('var ns = window._pd');
  const registryEndMarker = 'var state = ns[pid];';
  const registryEnd = detailSource.indexOf(registryEndMarker);
  const recencyStart = detailSource.indexOf('// --- Worktree recency labels ---');
  const recencyEnd = detailSource.indexOf('// --- Worktree sort ---');
  assert.notEqual(registryStart, -1);
  assert.notEqual(registryEnd, -1);
  assert.notEqual(recencyStart, -1);
  assert.notEqual(recencyEnd, -1);

  const registry = detailSource.slice(registryStart, registryEnd + registryEndMarker.length);
  const recency = detailSource.slice(recencyStart, recencyEnd);
  return '(function() {\nvar pid = 1;\n' + registry + '\n' + recency + '\n})();';
}

function extractCleanupScript() {
  const start = indexSource.indexOf('_cleanupDetail(name) {');
  assert.notEqual(start, -1);
  const end = indexSource.indexOf('\n        }', start);
  assert.notEqual(end, -1);
  const method = indexSource.slice(start, end + '\n        }'.length);
  return 'var listing = {\n  _projectIds: { app: 1 },\n  detailCache: {},\n' + method + '\n};';
}

function makeContext() {
  const activeTimers = new Map();
  let nextTimerId = 1;
  const tbody = { querySelectorAll: () => [] };

  const context = {
    window: {},
    document: {
      getElementById(id) {
        return id === 'worktrees-tbody-1' ? tbody : null;
      },
      querySelector(selector) {
        return selector === '[data-project-name="app"]' ? {} : null;
      },
    },
    Date: { now: () => BASE_NOW, parse: Date.parse },
    setInterval(fn, ms) {
      const id = nextTimerId++;
      activeTimers.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      activeTimers.delete(id);
    },
  };
  vm.runInNewContext(extractCleanupScript(), context);

  return {
    activeTimers,
    expand() {
      vm.runInNewContext(extractDetailActivationScript(), context);
    },
    collapse() {
      context.listing._cleanupDetail('app');
    },
    state() {
      return context.window._pd && context.window._pd[1];
    },
  };
}

describe('worktree recency timer lifecycle', () => {
  it('expand starts exactly one recency timer and stores it on detail state', () => {
    const ctx = makeContext();
    ctx.expand();
    assert.equal(ctx.activeTimers.size, 1);
    assert.equal(ctx.state().wtRecencyTimer, [...ctx.activeTimers.keys()][0]);
  });

  it('re-running the detail script while state exists does not add a timer', () => {
    const ctx = makeContext();
    ctx.expand();
    ctx.expand();
    assert.equal(ctx.activeTimers.size, 1);
  });

  it('collapse clears the timer, nulls it on state, and drops the state entry', () => {
    const ctx = makeContext();
    ctx.expand();
    const state = ctx.state();

    ctx.collapse();
    assert.equal(ctx.activeTimers.size, 0);
    assert.equal(state.wtRecencyTimer, null);
    assert.equal(ctx.state(), undefined);
  });

  it('collapse/re-expand cycles leave exactly one active timer', () => {
    const ctx = makeContext();
    ctx.expand();
    for (let cycle = 0; cycle < 3; cycle++) {
      ctx.collapse();
      ctx.expand();
    }
    assert.equal(ctx.activeTimers.size, 1);
  });
});
