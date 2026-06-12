import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

describe('listing lifecycle reconciliation UI', () => {
  const indexSource = fs.readFileSync(new URL('../views/index.ejs', import.meta.url), 'utf8');
  const serverSource = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

  it('renders an inline row status region for non-blocking lifecycle/detail failures', () => {
    assert.match(indexSource, /class="project-row-status hidden"/);
    assert.match(indexSource, /role="status"/);
    assert.match(indexSource, /showProjectRowStatus\(id, 'Could not load details:/);
    assert.match(indexSource, /showProjectFeedback\(id, 'Start failed:/);
    assert.match(indexSource, /showProjectFeedback\(id, 'Stop failed:/);
  });

  it('does not use alert dialogs for routine listing fetch failures', () => {
    assert.doesNotMatch(indexSource, /alert\s*\(/);
    assert.match(indexSource, /refreshProjectStatus\(id, \{ reason: 'start failure', retry: true, fallbackStatus: 'stopped' \}\)/);
    assert.match(indexSource, /refreshProjectStatus\(id, \{ reason: 'stop failure', retry: true, fallbackStatus: 'running' \}\)/);
  });

  it('has an authoritative status endpoint that returns action HTML for row reconciliation', () => {
    const statusSource = serverSource.slice(
      serverSource.indexOf('function projectStatusSnapshot'),
      serverSource.indexOf('// Start project')
    );

    assert.match(statusSource, /try \{/);
    assert.match(statusSource, /enrichProjectStatus\(docker, project\)/);
    assert.match(serverSource, /function renderProjectActionHtml[\s\S]*res\.render\('partials\/_action_btn'/);
    assert.match(serverSource, /function renderProjectActionHtml[\s\S]*actionHtml\.trim\(\)/);
    assert.match(statusSource, /relatedProjectsForStatus\(project\)/);
    assert.match(statusSource, /projectStatusSnapshot\(req, res, relatedProject\)/);
    assert.match(statusSource, /related/);
    assert.match(statusSource, /catch \(statusErr\)/);
    assert.match(statusSource, /Could not refresh project status/);
  });

  it('adds worktree chip hooks and client reconciliation for related status snapshots', () => {
    assert.match(indexSource, /data-project-worktree-chip="<%= wt\.id %>"/);
    assert.match(indexSource, /function reconcileProjectStatuses/);
    assert.match(indexSource, /statusSnapshotsFromResponse/);
    assert.match(indexSource, /updateWorktreeChips\(snapshot\)/);
  });

  it('routes lifecycle failures through detail feedback and build-log display', () => {
    assert.match(indexSource, /function showProjectDetailStatus/);
    assert.match(indexSource, /function showProjectBuildLog/);
    assert.match(indexSource, /showBuildLogFromResponse\(id, err\.responseData\)/);
    assert.match(indexSource, /data-project-detail-actions/);
  });

  it('does not subscribe hidden worktree startup streams from the listing shell', () => {
    const startupBlock = indexSource.slice(
      indexSource.indexOf('// Subscribe to startup progress for all projects currently starting'),
      indexSource.indexOf('</script>')
    );

    assert.doesNotMatch(startupBlock, /Object\.values\(worktreesByParent\)/);
    assert.match(indexSource, /if \(projectButtons\(id\)\.length === 0\) return null;/);
  });
});
