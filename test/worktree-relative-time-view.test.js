import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import path from 'path';

const templatePath = path.resolve('views/partials/_project_detail.ejs');

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

describe('worktree relative time labels', () => {
  it('renders the recency label in each worktree row', async () => {
    const html = await renderDetail([
      { id: 11, branch_name: 'zeta', subdomain: 'app-zeta', status: 'running', recency_ms: 3000, recency_label: '5 hours ago' },
      { id: 12, branch_name: 'alpha', subdomain: 'app-alpha', status: 'stopped', recency_ms: 2000, recency_label: '2 days ago' },
    ]);
    assert.match(html, /<span class="wt-recency"[^>]*>5 hours ago<\/span>/);
    assert.match(html, /<span class="wt-recency"[^>]*>2 days ago<\/span>/);
  });

  it('places the label in the branch cell after the link', async () => {
    const html = await renderDetail([
      { id: 11, branch_name: 'zeta', subdomain: 'app-zeta', status: 'running', recency_ms: 3000, recency_label: '5 hours ago' },
    ]);
    const linkIndex = html.indexOf('<code>zeta</code>');
    const labelIndex = html.indexOf('5 hours ago');
    const cellEnd = html.indexOf('</td>', linkIndex);
    assert.ok(linkIndex !== -1 && labelIndex !== -1 && cellEnd !== -1);
    assert.ok(linkIndex < labelIndex);
    assert.ok(labelIndex < cellEnd);
  });

  it('exposes the absolute timestamp as a title attribute', async () => {
    const recencyMs = Date.parse('2026-07-14T07:00:00Z');
    const html = await renderDetail([
      { id: 11, branch_name: 'zeta', subdomain: 'app-zeta', status: 'running', recency_ms: recencyMs, recency_label: '5 hours ago' },
    ]);
    assert.match(html, /title="2026-07-14T07:00:00\.000Z"/);
  });

  it('omits the label when recency_label is missing or empty', async () => {
    const html = await renderDetail([
      { id: 11, branch_name: 'zeta', subdomain: 'app-zeta', status: 'running', recency_ms: 0 },
      { id: 12, branch_name: 'alpha', subdomain: 'app-alpha', status: 'stopped', recency_ms: 2000, recency_label: '' },
    ]);
    assert.doesNotMatch(html, /class="wt-recency"/);
  });

  it('escapes label content', async () => {
    const html = await renderDetail([
      { id: 11, branch_name: 'zeta', subdomain: 'app-zeta', status: 'running', recency_ms: 1000, recency_label: '<img src=x>' },
    ]);
    assert.doesNotMatch(html, /<span class="wt-recency"[^>]*><img/);
    assert.match(html, /&lt;img src=x&gt;/);
  });
});
