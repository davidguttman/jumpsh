import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

describe('server project creation route', () => {
  it('uses desired-running lifecycle helper for project creation auto-start', () => {
    const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const createRoute = source.slice(
      source.indexOf("app.post('/projects',"),
      source.indexOf("// Project detail partial")
    );

    assert.match(createRoute, /startProjectWithWorktrees\(db, docker, project\)/);
    assert.doesNotMatch(createRoute, /docker\.start\(project\)/);
  });
});
