import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh private revocation directory per auth instance, never under the real home.
const dirs = [];
export function tmpRevocations() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-revocations-'));
  dirs.push(dir);
  return path.join(dir, 'revoked-sessions');
}

process.on('exit', () => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});
