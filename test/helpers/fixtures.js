import fs from 'fs';
import os from 'os';
import path from 'path';

export function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-test-'));
}

export function writeJson(dir, filename, obj) {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(obj));
}

export function touchFile(dir, filename) {
  fs.writeFileSync(path.join(dir, filename), '');
}

export function writeFile(dir, filename, content) {
  fs.writeFileSync(path.join(dir, filename), content);
}

export function cleanTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
