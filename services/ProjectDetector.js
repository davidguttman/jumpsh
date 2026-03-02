import fs from 'fs';
import path from 'path';

/**
 * Detect project type, framework, dev command, port, and package manager.
 * @param {string} projectPath - Absolute path to the project directory
 * @returns {{ type: string, framework?: string, devCommand: string, port: number, packageManager?: object, installCommand?: string, needsManualConfig?: boolean, message?: string, error?: string }}
 */
export function detectProjectType(projectPath) {
  // Validate path
  if (!projectPath || !path.isAbsolute(projectPath)) {
    return { error: `Invalid project path: must be absolute. Got: ${projectPath}` };
  }
  if (!fs.existsSync(projectPath)) {
    return { error: `Invalid project path: does not exist: ${projectPath}` };
  }
  try {
    if (!fs.statSync(projectPath).isDirectory()) {
      return { error: `Invalid project path: not a directory: ${projectPath}` };
    }
  } catch (e) {
    return { error: `Invalid project path: ${e.message}` };
  }

  // Detection priority: package.json > requirements.txt > pyproject.toml > go.mod
  if (fs.existsSync(path.join(projectPath, 'package.json'))) {
    return detectNode(projectPath);
  }
  if (fs.existsSync(path.join(projectPath, 'requirements.txt'))) {
    return detectPython(projectPath, 'requirements.txt');
  }
  if (fs.existsSync(path.join(projectPath, 'pyproject.toml'))) {
    return detectPython(projectPath, 'pyproject.toml');
  }
  if (fs.existsSync(path.join(projectPath, 'go.mod'))) {
    return { type: 'go', framework: null, devCommand: 'go run .', port: 8080 };
  }

  return { error: 'Could not detect project type. Add a docker-compose.yml manually.' };
}

// ---- Node detection ----

const PM_PRIORITY = [
  { lock: 'bun.lockb', name: 'bun', install: 'bun install', run: 'bun run' },
  { lock: 'bun.lock', name: 'bun', install: 'bun install', run: 'bun run' },
  { lock: 'pnpm-lock.yaml', name: 'pnpm', install: 'pnpm install', run: 'pnpm run' },
  { lock: 'yarn.lock', name: 'yarn', install: 'yarn install', run: 'yarn' },
  { lock: 'package-lock.json', name: 'npm', install: 'npm install', run: 'npm run' },
];

function detectPackageManager(projectPath) {
  for (const pm of PM_PRIORITY) {
    if (fs.existsSync(path.join(projectPath, pm.lock))) {
      return { name: pm.name, install: pm.install, run: pm.run, lockFile: pm.lock };
    }
  }
  return { name: 'npm', install: 'npm install', run: 'npm run', lockFile: null };
}

function detectNode(projectPath) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8'));
  } catch {
    return { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: detectPackageManager(projectPath) };
  }

  const pm = detectPackageManager(projectPath);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts || {};

  // If project has an explicit dev script that is NOT vite, trust it over dependency heuristics.
  if (scripts.dev && !scripts.dev.includes('vite')) {
    return { type: 'node', framework: null, devCommand: `${pm.run} dev`, port: 3000, packageManager: pm, installCommand: pm.install };
  }

  // Framework detection
  if (deps.vite || (scripts.dev && scripts.dev.includes('vite'))) {
    return { type: 'node', framework: 'vite', devCommand: `${pm.run} dev`, port: 5173, packageManager: pm, installCommand: pm.install };
  }
  if (deps.next) {
    return { type: 'node', framework: 'next', devCommand: `${pm.run} dev`, port: 3000, packageManager: pm, installCommand: pm.install };
  }
  if (deps.nuxt) {
    return { type: 'node', framework: 'nuxt', devCommand: `${pm.run} dev`, port: 3000, packageManager: pm, installCommand: pm.install };
  }

  // Has a dev script
  if (scripts.dev) {
    return { type: 'node', framework: null, devCommand: `${pm.run} dev`, port: 3000, packageManager: pm, installCommand: pm.install };
  }

  // Has a start script
  if (scripts.start) {
    const startCmd = pm.name === 'yarn' ? 'yarn start' : `${pm.run} start`;
    return { type: 'node', framework: null, devCommand: startCmd, port: 3000, packageManager: pm, installCommand: pm.install };
  }

  // Fallback: find entrypoint
  const entrypoint = findNodeEntrypoint(projectPath, pkg);
  return { type: 'node', framework: null, devCommand: `node ${entrypoint}`, port: 3000, packageManager: pm, installCommand: pm.install };
}

function findNodeEntrypoint(projectPath, pkg) {
  if (pkg.main && fs.existsSync(path.join(projectPath, pkg.main))) {
    return pkg.main;
  }
  for (const candidate of ['index.js', 'server.js', 'app.js', 'src/index.js']) {
    if (fs.existsSync(path.join(projectPath, candidate))) {
      return candidate;
    }
  }
  return 'index.js';
}

// ---- Python detection ----

function detectPython(projectPath, markerFile) {
  const type = 'python';

  // Read marker file content for framework grep
  let content = '';
  try {
    content = fs.readFileSync(path.join(projectPath, markerFile), 'utf8').toLowerCase();
  } catch { /* empty */ }

  // Django: manage.py is definitive
  if (fs.existsSync(path.join(projectPath, 'manage.py'))) {
    return { type, framework: 'django', devCommand: 'python manage.py runserver 0.0.0.0:8000', port: 8000, installCommand: buildPythonInstall(markerFile) };
  }

  // FastAPI / Uvicorn
  if (content.includes('fastapi') || content.includes('uvicorn')) {
    const entrypoint = findPythonEntrypoint(projectPath, 'FastAPI');
    return { type, framework: 'fastapi', devCommand: `uvicorn ${entrypoint} --reload --host 0.0.0.0`, port: 8000, installCommand: buildPythonInstall(markerFile) };
  }

  // Flask
  if (content.includes('flask')) {
    const module = findFlaskModule(projectPath);
    return { type, framework: 'flask', devCommand: `flask --app ${module} run --reload --host 0.0.0.0`, port: 5000, installCommand: buildPythonInstall(markerFile) };
  }

  // Generic Python — try to find an entrypoint
  const pyEntry = findGenericPythonEntrypoint(projectPath);
  if (pyEntry) {
    return { type, framework: null, devCommand: `python ${pyEntry}`, port: 8000, installCommand: buildPythonInstall(markerFile) };
  }

  return {
    type,
    framework: null,
    devCommand: 'python app.py',
    port: 8000,
    installCommand: buildPythonInstall(markerFile),
    needsManualConfig: true,
    message: 'Could not detect Python entrypoint. Set start command manually.'
  };
}

function buildPythonInstall(markerFile) {
  if (markerFile === 'pyproject.toml') return 'pip install -e .';
  return 'pip install -r requirements.txt';
}

function findPythonEntrypoint(projectPath, frameworkClass) {
  // Search common files for `app = FastAPI()` pattern
  const candidates = ['main.py', 'app.py', 'server.py', 'api.py'];
  for (const file of candidates) {
    const filePath = path.join(projectPath, file);
    if (!fs.existsSync(filePath)) continue;
    try {
      const src = fs.readFileSync(filePath, 'utf8');
      // Look for `app = FastAPI(` or `application = FastAPI(`
      const match = src.match(/(\w+)\s*=\s*(?:FastAPI|Starlette)\s*\(/);
      if (match) {
        const module = file.replace(/\.py$/, '');
        return `${module}:${match[1]}`;
      }
    } catch { /* skip */ }
  }
  return 'main:app';
}

function findFlaskModule(projectPath) {
  // Check .flaskenv or .env for FLASK_APP
  for (const envFile of ['.flaskenv', '.env']) {
    const envPath = path.join(projectPath, envFile);
    if (!fs.existsSync(envPath)) continue;
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/FLASK_APP\s*=\s*(.+)/);
      if (match) return match[1].trim();
    } catch { /* skip */ }
  }

  // Grep common files for `app = Flask(`
  for (const file of ['app.py', 'main.py', 'server.py']) {
    const filePath = path.join(projectPath, file);
    if (!fs.existsSync(filePath)) continue;
    try {
      const src = fs.readFileSync(filePath, 'utf8');
      if (src.includes('Flask(')) {
        return file.replace(/\.py$/, '');
      }
    } catch { /* skip */ }
  }

  return 'app';
}

function findGenericPythonEntrypoint(projectPath) {
  for (const file of ['app.py', 'main.py', 'server.py', 'run.py']) {
    if (fs.existsSync(path.join(projectPath, file))) return file;
  }
  return null;
}

export default { detectProjectType };
