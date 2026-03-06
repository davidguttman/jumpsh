import { execSync, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

let _composeCommand = null;
let _dockerAvailable = null;

const DOCKER_INSTALL_HELP = `Docker not found. Install Docker Desktop from https://docker.com/products/docker-desktop or run:
  - macOS:         brew install --cask docker
  - Ubuntu/Debian: sudo apt install docker.io
  - Arch:          sudo pacman -S docker`;

const COMPOSE_INSTALL_HELP = `docker-compose not found. Install Docker Desktop from https://docker.com/products/docker-desktop or run:
  - macOS:         brew install docker-compose
  - Ubuntu/Debian: sudo apt install docker-compose
  - Arch:          sudo pacman -S docker-compose`;

/**
 * Check if docker daemon is reachable.
 */
export function isDockerAvailable() {
  if (_dockerAvailable !== null) return _dockerAvailable;
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    _dockerAvailable = true;
  } catch {
    _dockerAvailable = false;
  }
  return _dockerAvailable;
}

/**
 * Check if docker daemon is reachable (fresh check, bypasses cache).
 * @returns {Promise<{ available: boolean, error?: string }>}
 */
export async function checkDockerAvailability() {
  try {
    await execFileAsync('docker', ['info'], { timeout: 5000 });
    _dockerAvailable = true;
    return { available: true };
  } catch (err) {
    _dockerAvailable = false;
    const notInstalled = err.code === 'ENOENT';
    const message = notInstalled
      ? DOCKER_INSTALL_HELP
      : 'Docker is not running. Please start Docker and try again.';
    return { available: false, error: message };
  }
}

/**
 * Require Docker to be available. If not, prints an error and exits with code 5.
 */
export function requireDocker() {
  if (!isDockerAvailable()) {
    console.error(DOCKER_INSTALL_HELP);
    process.exit(5);
  }
}

/**
 * Detect whether `docker compose` (v2 plugin) or `docker-compose` (v1 standalone)
 * is available. Returns the command string or null if neither is found.
 */
export function getComposeCommand() {
  if (_composeCommand !== null) return _composeCommand || null;
  try {
    execSync('docker compose version', { stdio: 'ignore' });
    _composeCommand = 'docker compose';
  } catch {
    try {
      execSync('docker-compose --version', { stdio: 'ignore' });
      _composeCommand = 'docker-compose';
    } catch {
      _composeCommand = '';
    }
  }
  return _composeCommand || null;
}

/**
 * Build spawn-friendly { command, args } for a compose invocation.
 * All paths are passed as discrete args — no shell interpolation.
 * @param {string|string[]} subcommand - e.g. 'up -d --build' or ['up', '-d', '--build']
 * @param {string} [composeFile] - path to compose file (uses -f flag if provided)
 * @returns {{ command: string, args: string[] }}
 * @throws {Error} if no compose command is available
 */
export function buildComposeSpawn(subcommand, composeFile) {
  const cmd = getComposeCommand();
  if (!cmd) {
    throw new Error(COMPOSE_INSTALL_HELP);
  }
  const parts = cmd.split(' '); // ['docker', 'compose'] or ['docker-compose']
  const command = parts[0];
  const args = [...parts.slice(1)];
  if (composeFile) {
    args.push('-f', composeFile);
  }
  const subArgs = Array.isArray(subcommand) ? subcommand : subcommand.split(' ');
  args.push(...subArgs);
  return { command, args };
}

/**
 * Execute a compose command safely via execFile (no shell).
 * @param {string|string[]} subcommand
 * @param {string} [composeFile]
 * @param {object} [opts] - options passed to execFile (cwd, timeout, etc.)
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export async function execCompose(subcommand, composeFile, opts = {}) {
  const { command, args } = buildComposeSpawn(subcommand, composeFile);
  return execFileAsync(command, args, opts);
}
