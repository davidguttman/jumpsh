import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ejs from 'ejs';
import path from 'path';

const templatePath = path.resolve('views/partials/_project_detail.ejs');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BASE_NOW = Date.parse('2026-07-14T12:00:00Z');

function renderDetail() {
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
    worktrees: [
      { id: 11, branch_name: 'zeta', subdomain: 'app-zeta', status: 'running', recency_ms: 3000, recency_label: '5 hours ago' },
    ],
    logs: '',
    detection: {},
    config: { projectUrl: (sub) => `https://${sub}.example.test` },
  });
}

async function extractRecencyLabelScript() {
  const html = await renderDetail();
  const start = html.indexOf('// --- Worktree recency labels ---');
  const end = html.indexOf('// --- Worktree sort ---');
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return 'var pid = 1;\nvar state = {};\n' + html.slice(start, end);
}

class FakeRow {
  constructor(recency, serverLabel) {
    this.dataset = { wtRecency: String(recency) };
    this.span = serverLabel === null
      ? null
      : { className: 'wt-recency', textContent: serverLabel };
  }

  querySelector(selector) {
    return selector === '.wt-recency' ? this.span : null;
  }
}

async function makeLabelContext(rows, { hasTbody = true } = {}) {
  const tbody = {
    querySelectorAll(selector) {
      assert.equal(selector, 'tr[data-wt-recency]');
      return rows;
    },
  };
  const timers = [];
  const clock = { now: BASE_NOW };

  const context = {
    document: {
      getElementById(id) {
        if (id === 'worktrees-tbody-1') return hasTbody ? tbody : null;
        return null;
      },
    },
    Date: { now: () => clock.now },
    setInterval: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
  };
  vm.runInNewContext(await extractRecencyLabelScript(), context);

  return {
    timers,
    advance(deltaMs) { clock.now += deltaMs; },
    tick() {
      assert.equal(timers.length, 1);
      timers[0].fn();
    },
  };
}

describe('worktree recency label refresh', () => {
  it('replaces the server-rendered label immediately on init', async () => {
    const row = new FakeRow(BASE_NOW - 5 * HOUR, 'server-rendered');
    await makeLabelContext([row]);
    assert.equal(row.span.textContent, '5 hours ago');
  });

  it('registers a 30 second refresh interval', async () => {
    const { timers } = await makeLabelContext([new FakeRow(BASE_NOW - HOUR, '1 hour ago')]);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 30000);
  });

  it('advances labels as time progresses', async () => {
    const row = new FakeRow(BASE_NOW - 5 * HOUR, '5 hours ago');
    const ctx = await makeLabelContext([row]);

    ctx.advance(2 * HOUR);
    ctx.tick();
    assert.equal(row.span.textContent, '7 hours ago');

    ctx.advance(17 * HOUR);
    ctx.tick();
    assert.equal(row.span.textContent, '1 day ago');
  });

  it('crosses from just now into minutes', async () => {
    const row = new FakeRow(BASE_NOW - 30 * SECOND, 'just now');
    const ctx = await makeLabelContext([row]);
    assert.equal(row.span.textContent, 'just now');

    ctx.advance(45 * SECOND);
    ctx.tick();
    assert.equal(row.span.textContent, '1 minute ago');

    ctx.advance(2 * DAY);
    ctx.tick();
    assert.equal(row.span.textContent, '2 days ago');
  });

  it('keeps the server-rendered fallback for unusable timestamps', async () => {
    const rows = [
      new FakeRow(0, 'fallback zero'),
      new FakeRow('garbage', 'fallback nan'),
      new FakeRow(Number.MAX_VALUE, 'fallback out-of-range'),
      new FakeRow(-5, 'fallback negative'),
    ];
    const ctx = await makeLabelContext(rows);

    ctx.advance(HOUR);
    ctx.tick();
    assert.deepEqual(
      rows.map((row) => row.span.textContent),
      ['fallback zero', 'fallback nan', 'fallback out-of-range', 'fallback negative']
    );
  });

  it('skips rows that have no label span without throwing', async () => {
    const labeled = new FakeRow(BASE_NOW - 2 * HOUR, '2 hours ago');
    const unlabeled = new FakeRow(0, null);
    const ctx = await makeLabelContext([unlabeled, labeled]);

    ctx.advance(HOUR);
    ctx.tick();
    assert.equal(labeled.span.textContent, '3 hours ago');
    assert.equal(unlabeled.span, null);
  });

  it('does not register a timer when the worktree table is absent', async () => {
    const { timers } = await makeLabelContext([], { hasTbody: false });
    assert.equal(timers.length, 0);
  });
});
