import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ejs from 'ejs';
import path from 'path';

const templatePath = path.resolve('views/partials/_project_detail.ejs');

const WORKTREES = [
  { id: 11, branch_name: 'zeta', subdomain: 'app-zeta', status: 'running', recency_ms: 3000 },
  { id: 12, branch_name: 'alpha', subdomain: 'app-alpha', status: 'stopped', recency_ms: 2000 },
  { id: 13, branch_name: 'mid', subdomain: 'app-mid', status: 'stopped', recency_ms: 1000 },
];

function renderDetail(worktrees) {
  return ejs.renderFile(templatePath, {
    project: {
      id: 1,
      name: 'app',
      path: '/tmp/app',
      subdomain: 'app',
      status: 'running',
      health: 'healthy',
      override_build_command: null,
      override_start_command: null,
      override_port: null,
      override_docker_image: null,
      override_env: null,
    },
    worktrees,
    logs: '',
    detection: {},
    config: { projectUrl: (sub) => `https://${sub}.example.test` },
  });
}

describe('worktree sort markup', () => {
  it('renders a sort control with recency and name options', async () => {
    const html = await renderDetail(WORKTREES);
    assert.match(html, /id="wt-sort-1"/);
    assert.match(html, /aria-label="Sort worktrees"/);
    assert.match(html, /<option value="recency">sort: recent<\/option>/);
    assert.match(html, /<option value="name">sort: name<\/option>/);
  });

  it('omits the sort control when there is only one worktree', async () => {
    const html = await renderDetail(WORKTREES.slice(0, 1));
    assert.doesNotMatch(html, /id="wt-sort-1"/);
    assert.match(html, /data-wt-name="zeta"/);
  });

  it('renders rows in server order with name and recency data attributes', async () => {
    const html = await renderDetail(WORKTREES);
    assert.match(html, /<tr data-wt-name="zeta" data-wt-recency="3000">/);
    assert.match(html, /<tr data-wt-name="alpha" data-wt-recency="2000">/);
    assert.ok(html.indexOf('data-wt-name="zeta"') < html.indexOf('data-wt-name="alpha"'));
    assert.ok(html.indexOf('data-wt-name="alpha"') < html.indexOf('data-wt-name="mid"'));
    assert.match(html, /id="worktrees-tbody-1"/);
  });

  it('mirrors the data attributes onto the log selector options', async () => {
    const html = await renderDetail(WORKTREES);
    assert.match(html, /<option value="11"[^>]*data-wt-name="zeta" data-wt-recency="3000">/);
    assert.match(html, /<option value="12"[^>]*data-wt-name="alpha" data-wt-recency="2000">/);
    assert.match(html, /<option value="13"[^>]*data-wt-name="mid" data-wt-recency="1000">/);
  });

  it('falls back to zero recency when the field is missing', async () => {
    const html = await renderDetail([
      { id: 11, branch_name: 'zeta', subdomain: 'app-zeta', status: 'running' },
      { id: 12, branch_name: 'alpha', subdomain: 'app-alpha', status: 'stopped', recency_ms: 2000 },
    ]);
    assert.match(html, /<tr data-wt-name="zeta" data-wt-recency="0">/);
  });

  it('persists the preference under the jumpsh-wt-sort key', async () => {
    const html = await renderDetail(WORKTREES);
    assert.match(html, /localStorage\.getItem\('jumpsh-wt-sort'\)/);
    assert.match(html, /localStorage\.setItem\('jumpsh-wt-sort', mode\)/);
  });
});

class FakeNode {
  constructor(tagName, dataset) {
    this.tagName = tagName;
    this.dataset = dataset || {};
    this.children = [];
    this.parent = null;
    this.listeners = {};
  }

  appendChild(child) {
    if (child.parent) {
      const index = child.parent.children.indexOf(child);
      if (index !== -1) child.parent.children.splice(index, 1);
    }
    child.parent = this;
    this.children.push(child);
  }

  querySelectorAll(selector) {
    const tag = selector.slice(0, selector.indexOf('['));
    return this.children.filter((child) => child.tagName === tag && 'wtName' in child.dataset);
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }
}

async function extractWorktreeSortScript() {
  const html = await renderDetail(WORKTREES);
  const start = html.indexOf('// --- Worktree sort ---');
  const end = html.indexOf('// --- Init ---');
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return 'var pid = 1;\n' + html.slice(start, end);
}

async function makeSortContext(savedSort, storageOverride) {
  const tbody = new FakeNode('tbody');
  const logSelect = new FakeNode('select');
  logSelect.appendChild(new FakeNode('option', {})); // parent project option
  for (const wt of WORKTREES) {
    tbody.appendChild(new FakeNode('tr', { wtName: wt.branch_name, wtRecency: String(wt.recency_ms) }));
    logSelect.appendChild(new FakeNode('option', { wtName: wt.branch_name, wtRecency: String(wt.recency_ms) }));
  }
  const sortEl = new FakeNode('select');

  const stored = {};
  if (savedSort !== null) stored['jumpsh-wt-sort'] = savedSort;

  const context = {
    document: {
      getElementById(id) {
        if (id === 'wt-sort-1') return sortEl;
        if (id === 'worktrees-tbody-1') return tbody;
        if (id === 'logs-tabs-1') return logSelect;
        return null;
      },
    },
    localStorage: storageOverride || {
      getItem: (key) => (key in stored ? stored[key] : null),
      setItem: (key, value) => { stored[key] = String(value); },
    },
  };
  vm.runInNewContext(await extractWorktreeSortScript(), context);
  return { tbody, logSelect, sortEl, stored };
}

function names(parent) {
  return parent.children.filter((c) => 'wtName' in c.dataset).map((c) => c.dataset.wtName);
}

function changeSort(sortEl, value) {
  sortEl.value = value;
  sortEl.listeners.change.call(sortEl);
}

describe('worktree sort behavior', () => {
  it('defaults to recency and keeps the server order', async () => {
    const { tbody, logSelect, sortEl } = await makeSortContext(null);
    assert.equal(sortEl.value, 'recency');
    assert.deepEqual(names(tbody), ['zeta', 'alpha', 'mid']);
    assert.deepEqual(names(logSelect), ['zeta', 'alpha', 'mid']);
  });

  it('restores a persisted name preference on init', async () => {
    const { tbody, logSelect, sortEl } = await makeSortContext('name');
    assert.equal(sortEl.value, 'name');
    assert.deepEqual(names(tbody), ['alpha', 'mid', 'zeta']);
    assert.deepEqual(names(logSelect), ['alpha', 'mid', 'zeta']);
  });

  it('keeps the parent project first in the log selector after sorting', async () => {
    const { logSelect } = await makeSortContext('name');
    assert.equal('wtName' in logSelect.children[0].dataset, false);
  });

  it('ignores unknown persisted values', async () => {
    const { tbody, sortEl } = await makeSortContext('bogus');
    assert.equal(sortEl.value, 'recency');
    assert.deepEqual(names(tbody), ['zeta', 'alpha', 'mid']);
  });

  it('persists and applies a switch to name order', async () => {
    const { tbody, logSelect, sortEl, stored } = await makeSortContext(null);
    changeSort(sortEl, 'name');
    assert.equal(stored['jumpsh-wt-sort'], 'name');
    assert.deepEqual(names(tbody), ['alpha', 'mid', 'zeta']);
    assert.deepEqual(names(logSelect), ['alpha', 'mid', 'zeta']);
  });

  it('switching back to recency restores most-recent-first order', async () => {
    const { tbody, logSelect, sortEl, stored } = await makeSortContext('name');
    changeSort(sortEl, 'recency');
    assert.equal(stored['jumpsh-wt-sort'], 'recency');
    assert.deepEqual(names(tbody), ['zeta', 'alpha', 'mid']);
    assert.deepEqual(names(logSelect), ['zeta', 'alpha', 'mid']);
  });

  it('survives throwing localStorage: defaults to recency, sorting still works', async () => {
    const throwingStorage = {
      getItem() { throw new Error('SecurityError: storage disabled'); },
      setItem() { throw new Error('SecurityError: storage disabled'); },
    };

    // Init must complete without throwing (a throw here would abort the
    // enclosing detail script before log binding/streaming)
    const { tbody, logSelect, sortEl } = await makeSortContext(null, throwingStorage);
    assert.equal(sortEl.value, 'recency');
    assert.deepEqual(names(tbody), ['zeta', 'alpha', 'mid']);

    // Sorting keeps working even though persistence fails
    changeSort(sortEl, 'name');
    assert.deepEqual(names(tbody), ['alpha', 'mid', 'zeta']);
    assert.deepEqual(names(logSelect), ['alpha', 'mid', 'zeta']);

    changeSort(sortEl, 'recency');
    assert.deepEqual(names(tbody), ['zeta', 'alpha', 'mid']);
  });
});
