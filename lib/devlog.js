import fs from 'fs';
import path from 'path';
import os from 'os';

const JUMPSH_DIR = path.join(os.homedir(), '.jump.sh');
const LOGS_DIR = path.join(JUMPSH_DIR, 'logs');
const DEV_LOG_PATH = path.join(LOGS_DIR, 'dev.log');
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 3;

function ensureLogsDir() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function rotate(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_SIZE) return;
  } catch {
    return; // file doesn't exist yet
  }

  // Shift existing rotated files
  for (let i = MAX_FILES; i >= 1; i--) {
    const from = i === 1 ? filePath : `${filePath}.${i - 1}`;
    const to = `${filePath}.${i}`;
    try {
      if (fs.existsSync(from)) {
        fs.renameSync(from, to);
      }
    } catch { /* best effort */ }
  }
}

export function rotateLogs() {
  ensureLogsDir();
  rotate(DEV_LOG_PATH);
  rotate(path.join(LOGS_DIR, 'daemon.log'));
  rotate(path.join(LOGS_DIR, 'daemon.err'));
}

export function devlog(level, msg, data) {
  ensureLogsDir();
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (data !== undefined) entry.data = data;

  try {
    fs.appendFileSync(DEV_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch { /* best effort */ }
}

export function devinfo(msg, data) { devlog('info', msg, data); }
export function devwarn(msg, data) { devlog('warn', msg, data); }
export function deverror(msg, data) { devlog('error', msg, data); }

// --- Per-project dev log ---

export function projectLog(projectPath, level, msg, data) {
  const logDir = path.join(projectPath, '.jump.sh');
  const logPath = path.join(logDir, 'dev.log');
  fs.mkdirSync(logDir, { recursive: true });
  const entry = { ts: new Date().toISOString(), level, msg };
  if (data !== undefined) entry.data = data;
  try {
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch { /* best effort */ }
}

export function projectInfo(projectPath, msg, data) { projectLog(projectPath, 'info', msg, data); }
export function projectWarn(projectPath, msg, data) { projectLog(projectPath, 'warn', msg, data); }
export function projectError(projectPath, msg, data) { projectLog(projectPath, 'error', msg, data); }
