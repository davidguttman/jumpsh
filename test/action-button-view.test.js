import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import path from 'path';

const templatePath = path.resolve('views/partials/_action_btn.ejs');

describe('_action_btn partial', () => {
  it('renders a disabled progress button for starting projects', async () => {
    const html = await ejs.renderFile(templatePath, { id: 1, status: 'starting' });
    assert.match(html, /Starting\.\.\./);
    assert.match(html, /disabled/);
    assert.doesNotMatch(html, /onclick="startProject/);
  });

  it('keeps truly stopped projects startable', async () => {
    const html = await ejs.renderFile(templatePath, { id: 1, status: 'stopped' });
    assert.match(html, /onclick="startProject\(1\)"/);
    assert.match(html, />Start</);
  });
});
