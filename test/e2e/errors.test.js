import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectProjectType } from '../../services/ProjectDetector.js';

describe('E2E error scenarios', () => {
  it('invalid project path returns error', () => {
    const r = detectProjectType('/tmp/nonexistent-' + Date.now());
    assert.ok(r.error);
    assert.match(r.error, /does not exist/);
  });

  it('empty directory returns error', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-e2e-'));
    try {
      const r = detectProjectType(tmpDir);
      assert.ok(r.error);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('non-directory path returns error', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-e2e-'));
    const filePath = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(filePath, 'not a dir');
    try {
      const r = detectProjectType(filePath);
      assert.ok(r.error);
      assert.match(r.error, /not a directory/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
