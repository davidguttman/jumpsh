import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function extractLifecycleScript() {
  const source = fs.readFileSync(new URL('../views/index.ejs', import.meta.url), 'utf8');
  const start = source.indexOf('    function errorMessage');
  const end = source.indexOf('    // Auto-refresh every 30 seconds');
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end).replace(/^ {4}/gm, '');
}

class MockClassList {
  constructor(initial = '') {
    this.values = new Set(initial.split(/\s+/).filter(Boolean));
  }

  add(...names) {
    for (const name of names) this.values.add(name);
  }

  remove(...names) {
    for (const name of names) this.values.delete(name);
  }

  contains(name) {
    return this.values.has(name);
  }

  toString() {
    return [...this.values].join(' ');
  }
}

class MockElement {
  constructor(tagName, attrs = {}) {
    this.tagName = tagName;
    this.attrs = { ...attrs };
    this.dataset = {};
    this.children = [];
    this.parent = null;
    this.textContent = attrs.textContent || '';
    this.disabled = Boolean(attrs.disabled);
    this._innerHTML = '';
    this.classList = new MockClassList(attrs.class || '');
    this.className = attrs.class || '';
    for (const [key, value] of Object.entries(attrs)) this.setAttribute(key, value);
  }

  set className(value) {
    this._className = value;
    this.classList = new MockClassList(value || '');
    this.attrs.class = value || '';
  }

  get className() {
    return this._className || '';
  }

  setAttribute(key, value) {
    this.attrs[key] = String(value);
    if (key === 'id') this.id = String(value);
    if (key === 'class') this.className = String(value);
    if (key.startsWith('data-')) {
      const dataKey = key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[dataKey] = String(value);
    }
  }

  getAttribute(key) {
    return this.attrs[key];
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
  }

  replaceWith(next) {
    next.parent = this.parent;
    this.replacedWith = next;
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index !== -1) this.parent.children.splice(index, 1, next);
  }

  set innerHTML(value) {
    this._innerHTML = value;
    this.firstElementChild = value.includes('<button') ? parseButton(value) : null;
  }

  get innerHTML() {
    return this._innerHTML;
  }

  get outerHTML() {
    const id = this.id ? ` id="${this.id}"` : '';
    const klass = this.className ? ` class="${this.className}"` : '';
    const role = this.attrs.role ? ` role="${this.attrs.role}"` : '';
    const live = this.attrs['aria-live'] ? ` aria-live="${this.attrs['aria-live']}"` : '';
    return `<${this.tagName}${klass}${id}${role}${live}>${this.textContent}</${this.tagName}>`;
  }
}

function parseButton(html) {
  const attrText = html.match(/<button\s+([^>]*)>/)?.[1] || '';
  const textContent = html.match(/<button[^>]*>([\s\S]*?)<\/button>/)?.[1] || '';
  const attrs = { textContent };
  for (const match of attrText.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
    attrs[match[1]] = match[2] ?? '';
  }
  if (/\sdisabled(?:\s|>|$)/.test(attrText)) attrs.disabled = true;
  return new MockElement('button', attrs);
}

function makeContext() {
  const row = new MockElement('div', { class: 'project-row stopped', 'data-project-id': '1' });
  row.dataset.projectStatus = 'stopped';

  const listButton = parseButton('<button class="btn btn-danger" id="project-btn-1" data-project-action-btn="1" data-project-status="running" onclick="stopProject(1)">Stop</button>');
  const detailButton = parseButton('<button class="btn btn-danger" id="project-btn-1" data-project-action-btn="1" data-project-status="running" onclick="stopProject(1)">Stop</button>');
  const worktreeButton = parseButton('<button class="btn btn-danger btn-sm" id="project-btn-2" data-project-action-btn="2" data-project-status="running" onclick="stopProject(2)">Stop</button>');
  const worktreeChip = new MockElement('a', {
    class: 'wt-chip',
    'data-project-worktree-chip': '2',
    'data-project-worktree-url': 'https://branch.example.test',
    href: 'https://branch.example.test',
    textContent: 'branch'
  });

  const listParent = new MockElement('span');
  const detailActions = new MockElement('div', { 'data-project-detail-actions': '1' });
  const worktreeParent = new MockElement('td');
  const chipParent = new MockElement('span');
  listParent.appendChild(listButton);
  detailActions.appendChild(detailButton);
  worktreeParent.appendChild(worktreeButton);
  chipParent.appendChild(worktreeChip);

  const detailStatus = new MockElement('span', {
    id: 'project-detail-status-1',
    class: 'project-detail-status hidden',
    role: 'status',
    'aria-live': 'polite'
  });

  const buttons = [listButton, detailButton, worktreeButton];
  const document = {
    querySelector(selector) {
      if (selector === '.project-row[data-project-id="1"]') return row;
      if (selector === '.project-row[data-project-id="2"]') return null;
      if (selector === '[data-project-detail-actions="1"]') return detailActions;
      if (selector === '[data-project-detail-actions="2"]') return null;
      return null;
    },
    querySelectorAll(selector) {
      const actionId = selector.match(/\[data-project-action-btn="([^"]+)"\]/)?.[1];
      if (actionId) return buttons.filter(button => button.getAttribute('data-project-action-btn') === actionId);
      const chipId = selector.match(/\[data-project-worktree-chip="([^"]+)"\]/)?.[1];
      if (chipId === '2') return [worktreeChip];
      return [];
    },
    getElementById(id) {
      if (id === 'project-detail-status-1') return detailStatus;
      return null;
    },
    createElement(tagName) {
      return new MockElement(tagName);
    }
  };

  const context = {
    document,
    window: {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout,
    EventSource: class {},
    console
  };
  vm.runInNewContext(extractLifecycleScript(), context);
  return { context, row, listButton, detailButton, worktreeButton, worktreeChip, detailActions };
}

describe('listing lifecycle DOM helpers', () => {
  it('does not mutate the parent project row when reconciling a worktree button', () => {
    const { context, row } = makeContext();

    context.updateRowStatusClass('2', 'running');

    assert.equal(row.dataset.projectStatus, 'stopped');
    assert.equal(row.classList.contains('running'), false);
    assert.equal(row.classList.contains('stopped'), true);
  });

  it('replaces both list and detail buttons during reconciliation', () => {
    const { context, listButton, detailButton, detailActions } = makeContext();
    const startHtml = '<button class="btn btn-success" id="project-btn-1" data-project-action-btn="1" data-project-status="stopped" onclick="startProject(1)">Start</button>';

    context.replaceProjectButtons('1', 'stopped', startHtml);

    assert.equal(listButton.replacedWith.getAttribute('data-project-status'), 'stopped');
    assert.equal(detailButton.replacedWith.getAttribute('data-project-status'), 'stopped');
    assert.match(detailActions.innerHTML, /project-detail-status-1/);
    assert.match(detailActions.innerHTML, /Start/);
    assert.doesNotMatch(detailActions.innerHTML, /Restart/);
  });



  it('reconciles related worktree controls from a parent status refresh', async () => {
    const { context, row, listButton, worktreeButton, worktreeChip } = makeContext();
    context.fetch = async (url) => {
      assert.equal(url, '/api/projects/1/status');
      return {
        ok: true,
        json: async () => ({
          success: true,
          id: 1,
          status: 'running',
          health: 'healthy',
          actionHtml: '<button class="btn btn-danger" id="project-btn-1" data-project-action-btn="1" data-project-status="running" onclick="stopProject(1)">Stop</button>',
          related: [
            {
              id: 1,
              status: 'running',
              health: 'healthy',
              actionHtml: '<button class="btn btn-danger" id="project-btn-1" data-project-action-btn="1" data-project-status="running" onclick="stopProject(1)">Stop</button>'
            },
            {
              id: 2,
              isWorktree: true,
              status: 'stopped',
              health: 'unknown',
              actionHtml: '<button class="btn btn-success" id="project-btn-2" data-project-action-btn="2" data-project-status="stopped" onclick="startProject(2)">Start</button>'
            }
          ]
        })
      };
    };

    await context.refreshProjectStatus('1');

    assert.equal(row.dataset.projectStatus, 'running');
    assert.equal(listButton.replacedWith.getAttribute('data-project-status'), 'running');
    assert.equal(worktreeButton.replacedWith.getAttribute('data-project-status'), 'stopped');
    assert.equal(worktreeButton.replacedWith.classList.contains('btn-sm'), true);
    assert.equal(worktreeChip.replacedWith.tagName, 'span');
    assert.equal(worktreeChip.replacedWith.classList.contains('wt-chip-inactive'), true);
  });

  it('does not open startup SSE when no controls exist for a hidden worktree', () => {
    const { context } = makeContext();
    let opened = 0;
    context.EventSource = class {
      constructor() { opened += 1; }
    };

    assert.equal(context.subscribeProjectStartup('999'), null);
    assert.equal(opened, 0);
  });
});
