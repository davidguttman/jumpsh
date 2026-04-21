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

  // Detection priority: package.json > requirements.txt > pyproject.toml > Gemfile > go.mod > composer.json > *.php
  if (fs.existsSync(path.join(projectPath, 'package.json'))) {
    return detectNode(projectPath);
  }
  if (fs.existsSync(path.join(projectPath, 'requirements.txt'))) {
    return detectPython(projectPath, 'requirements.txt');
  }
  if (fs.existsSync(path.join(projectPath, 'pyproject.toml'))) {
    return detectPython(projectPath, 'pyproject.toml');
  }
  if (fs.existsSync(path.join(projectPath, 'Gemfile'))) {
    return detectRuby(projectPath);
  }
  if (fs.existsSync(path.join(projectPath, 'go.mod'))) {
    return { type: 'go', framework: null, devCommand: 'go run .', port: 8080, dockerImage: 'golang:1.22-alpine' };
  }
  if (fs.existsSync(path.join(projectPath, 'composer.json'))) {
    return detectPhp(projectPath);
  }
  if (hasPhpFiles(projectPath)) {
    return detectPhp(projectPath);
  }

  // Fallback: static site (index.html with no recognizable project markers)
  const staticResult = detectStatic(projectPath);
  if (staticResult) return staticResult;

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


/**
 * Detect port from dev script content based on known tools.
 * @param {string} scriptContent - The actual script command
 * @returns {number} - Detected port or 3000 as default
 */
function detectPortFromScript(scriptContent) {
  if (!scriptContent) return 3000;
  
  // Check for explicit --port or -p flags first
  const portFlagMatch = scriptContent.match(/(?:--port|-p)\s+(\d+)/);
  if (portFlagMatch) return parseInt(portFlagMatch[1], 10);
  
  // Known tool defaults
  const toolPorts = {
    'budo': 9966,
    'webpack-dev-server': 8080,
    'webpack serve': 8080,
    'parcel': 1234,
    'snowpack': 8080,
    'esbuild --serve': 8000,
    'live-server': 8080,
    'http-server': 8080,
    'eleventy': 8080,
    'serve': 3000,
    'nodemon': 3000,
    'ts-node': 3000,
    'tsx': 3000,
  };
  
  for (const [tool, port] of Object.entries(toolPorts)) {
    if (scriptContent.includes(tool)) return port;
  }
  
  return 3000;
}

/**
 * Check if a dev/start script uses a tool that supports --host.
 * Only returns true for known dev servers (vite, next, astro, nuxt, webpack-dev-server, etc.).
 * Returns false for nodemon, plain node, ts-node, or unknown scripts.
 */
const HOST_SUPPORTING_TOOLS = [
  'vite', 'next', 'astro', 'nuxt',
  'webpack-dev-server', 'webpack serve',
  'parcel', 'snowpack',
];

function scriptSupportsHost(scriptContent) {
  if (!scriptContent) return false;
  return HOST_SUPPORTING_TOOLS.some(tool => scriptContent.includes(tool));
}

function nodeDockerImage(pm) {
  return pm.name === 'bun' ? 'oven/bun:latest' : 'node:20-slim';
}

function detectNode(projectPath) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8'));
  } catch {
    const pm = detectPackageManager(projectPath);
    return { type: 'node', framework: null, devCommand: 'node index.js', port: 3000, packageManager: pm, dockerImage: nodeDockerImage(pm) };
  }

  const pm = detectPackageManager(projectPath);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts || {};
  const image = nodeDockerImage(pm);

  // If project has an explicit dev script that is NOT vite, trust it over dependency heuristics.
  if (scripts.dev && !scripts.dev.includes('vite') && !deps['@11ty/eleventy']) {
    const hostFlag = scriptSupportsHost(scripts.dev) ? ' -- --host' : '';
    return { type: 'node', framework: null, devCommand: `${pm.run} dev${hostFlag}`, port: detectPortFromScript(scripts.dev), packageManager: pm, installCommand: pm.install, dockerImage: image };
  }

  // Framework detection (Astro before Vite since Astro uses Vite internally)
  if (deps['@11ty/eleventy']) {
    const devCmd = scripts.dev ? `${pm.run} dev` : `npx @11ty/eleventy --serve`;
    return { type: 'node', framework: 'eleventy', devCommand: devCmd, port: 8080, packageManager: pm, installCommand: pm.install, dockerImage: image };
  }
  if (deps.astro) {
    return { type: 'node', framework: 'astro', devCommand: `${pm.run} dev -- --host`, port: 4321, packageManager: pm, installCommand: pm.install, dockerImage: image };
  }
  if (deps['@sveltejs/kit']) {
    return { type: 'node', framework: 'sveltekit', devCommand: `${pm.run} dev -- --host`, port: 5173, packageManager: pm, installCommand: pm.install, dockerImage: image };
  }
  if (deps.vite || (scripts.dev && scripts.dev.includes('vite'))) {
    return { type: 'node', framework: 'vite', devCommand: `${pm.run} dev -- --host`, port: 5173, packageManager: pm, installCommand: pm.install, dockerImage: image };
  }
  if (deps.next) {
    return { type: 'node', framework: 'next', devCommand: `${pm.run} dev -- --host`, port: 3000, packageManager: pm, installCommand: pm.install, dockerImage: image };
  }
  if (deps.nuxt) {
    return { type: 'node', framework: 'nuxt', devCommand: `${pm.run} dev -- --host`, port: 3000, packageManager: pm, installCommand: pm.install, dockerImage: image };
  }

  // Has a dev script
  if (scripts.dev) {
    const hostFlag = scriptSupportsHost(scripts.dev) ? ' -- --host' : '';
    return { type: 'node', framework: null, devCommand: `${pm.run} dev${hostFlag}`, port: detectPortFromScript(scripts.dev), packageManager: pm, installCommand: pm.install, dockerImage: image };
  }

  // Has a start script
  if (scripts.start) {
    const startCmd = pm.name === 'yarn' ? 'yarn start' : `${pm.run} start`;
    const hostFlag = scriptSupportsHost(scripts.start) ? ' -- --host' : '';
    return { type: 'node', framework: null, devCommand: `${startCmd}${hostFlag}`, port: detectPortFromScript(scripts.start), packageManager: pm, installCommand: pm.install, dockerImage: image };
  }

  // Fallback: find entrypoint
  const entrypoint = findNodeEntrypoint(projectPath, pkg);
  return { type: 'node', framework: null, devCommand: `node ${entrypoint}`, port: 3000, packageManager: pm, installCommand: pm.install, dockerImage: image };
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

  const pyImage = 'python:3.12-slim';

  // Django: manage.py is definitive
  if (fs.existsSync(path.join(projectPath, 'manage.py'))) {
    return { type, framework: 'django', devCommand: 'python manage.py runserver 0.0.0.0:8000', port: 8000, installCommand: buildPythonInstall(markerFile), dockerImage: pyImage };
  }

  // FastAPI / Uvicorn
  if (content.includes('fastapi') || content.includes('uvicorn')) {
    const entrypoint = findPythonEntrypoint(projectPath, 'FastAPI');
    return { type, framework: 'fastapi', devCommand: `uvicorn ${entrypoint} --reload --host 0.0.0.0`, port: 8000, installCommand: buildPythonInstall(markerFile), dockerImage: pyImage };
  }

  // Flask
  if (content.includes('flask')) {
    const module = findFlaskModule(projectPath);
    return { type, framework: 'flask', devCommand: `flask --app ${module} run --reload --host 0.0.0.0`, port: 5000, installCommand: buildPythonInstall(markerFile), dockerImage: pyImage };
  }

  // Generic Python — try to find an entrypoint
  const pyEntry = findGenericPythonEntrypoint(projectPath);
  if (pyEntry) {
    return { type, framework: null, devCommand: `python ${pyEntry}`, port: 8000, installCommand: buildPythonInstall(markerFile), dockerImage: pyImage };
  }

  return {
    type,
    framework: null,
    devCommand: 'python app.py',
    port: 8000,
    installCommand: buildPythonInstall(markerFile),
    dockerImage: pyImage,
    needsManualConfig: true,
    message: 'Could not detect Python entrypoint. Set start command manually.'
  };
}

function buildPythonInstall(markerFile) {
  if (markerFile === 'pyproject.toml') return 'pip install -e .';
  return 'pip install -r requirements.txt';
}

function findPythonEntrypoint(projectPath, _frameworkClass) {
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

// ---- Ruby detection ----

function detectRuby(projectPath) {
  const rubyImage = 'ruby:3.2';

  // Rails: Gemfile + config.ru
  if (fs.existsSync(path.join(projectPath, 'config.ru'))) {
    return { type: 'ruby', framework: 'rails', devCommand: 'bundle exec rails server -b 0.0.0.0', port: 3000, installCommand: 'bundle install', dockerImage: rubyImage };
  }

  return { type: 'ruby', framework: null, devCommand: 'bundle exec ruby app.rb', port: 4567, installCommand: 'bundle install', dockerImage: rubyImage };
}

// ---- PHP detection ----

function hasPhpFiles(projectPath) {
  try {
    const entries = fs.readdirSync(projectPath);
    return entries.some(f => f.endsWith('.php'));
  } catch { return false; }
}

function detectPhpExtensions(projectPath) {
  try {
    const composer = JSON.parse(fs.readFileSync(path.join(projectPath, 'composer.json'), 'utf8'));
    const require = { ...composer.require, ...composer['require-dev'] };
    return Object.keys(require)
      .filter(dep => dep.startsWith('ext-'))
      .map(dep => dep.replace('ext-', ''));
  } catch { return []; }
}

function detectPhp(projectPath) {
  const type = 'php';
  const phpImage = 'php:8.3-cli';
  const extensions = detectPhpExtensions(projectPath);

  // Laravel: has artisan file
  if (fs.existsSync(path.join(projectPath, 'artisan'))) {
    return { type, framework: 'laravel', devCommand: 'php artisan serve --host=0.0.0.0 --port=8000', port: 8000, installCommand: 'composer install', dockerImage: phpImage, phpExtensions: extensions };
  }

  // Symfony: has symfony.lock or config/bundles.php
  if (fs.existsSync(path.join(projectPath, 'symfony.lock')) || fs.existsSync(path.join(projectPath, 'config', 'bundles.php'))) {
    return { type, framework: 'symfony', devCommand: 'php -S 0.0.0.0:8000 -t public', port: 8000, installCommand: 'composer install', dockerImage: phpImage, phpExtensions: extensions };
  }

  // Plain PHP
  const hasComposer = fs.existsSync(path.join(projectPath, 'composer.json'));
  return { type, framework: null, devCommand: 'php -S 0.0.0.0:8000', port: 8000, installCommand: hasComposer ? 'composer install' : null, dockerImage: phpImage, phpExtensions: extensions };
}

// ---- Static site detection ----

const PROJECT_MARKERS = [
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'Gemfile',
  'Cargo.toml',
  'composer.json',
  'pom.xml',
  'build.gradle',
];

function detectStatic(projectPath) {
  if (!fs.existsSync(path.join(projectPath, 'index.html'))) return null;
  for (const marker of PROJECT_MARKERS) {
    if (fs.existsSync(path.join(projectPath, marker))) return null;
  }
  return { type: 'static', framework: null, devCommand: null, port: 80, dockerImage: 'nginx:alpine' };
}

export default { detectProjectType };
