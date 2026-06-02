import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { isDaemonRunning } from '../daemon-status.js';
import { detectDomain, detectDomainFromCerts } from '../domain.js';
import { removeDaemonOnly } from '../daemon-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const PACKAGE_JSON = path.join(PACKAGE_ROOT, 'package.json');
const LOCAL_BIN = path.join(PACKAGE_ROOT, 'bin', 'jumpsh.js');

export { removeDaemonOnly };

export default async function upgrade(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      'dry-run': { type: 'boolean', default: false },
      latest: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const oldVersion = readPackageVersion();
  const installMode = detectInstallMode();
  const plan = createUpgradePlan({ installMode, binPath: LOCAL_BIN, latest: values.latest });
  const commandCwd = resolveSafeUpgradeCwd();

  console.log(`old: jump.sh ${oldVersion}`);
  console.log(`mode: ${installMode}`);
  console.log('preserve: ~/.jump.sh state, projects, certs, and registration');

  if (values['dry-run']) {
    console.log('dry-run: would remove daemon service files only');
    for (const step of plan.commands) {
      console.log(`dry-run: would run ${formatCommand(step)}`);
    }
    return;
  }

  const newVersionBeforeInstall = resolveLatestVersion(installMode, { cwd: commandCwd });

  console.log('\nRemoving current daemon service files...');
  const removed = removeDaemonOnly();
  if (removed.length === 0) {
    console.log('  No daemon files found. State directory left untouched.');
  } else {
    for (const msg of removed) {
      console.log(`  ${msg}`);
    }
  }

  try {
    for (const step of plan.commands) {
      console.log(`\nRunning: ${formatCommand(step)}`);
      executeUpgradeCommand(step, { cwd: commandCwd });
    }
  } catch (err) {
    console.error('\nUpgrade failed while reinstalling jump.sh.');
    console.error('State was preserved. To recover after fixing the issue, run: jump.sh install');
    process.exit(err.status || 1);
  }

  const newVersion = newVersionBeforeInstall || readInstalledVersion(installMode, { cwd: commandCwd }) || oldVersion;
  printFinalStatus({ oldVersion, newVersion });
}

function printHelp() {
  console.log(`Usage: jump.sh upgrade [options]

Upgrade jump.sh itself while preserving user state.

The command removes only daemon service files/wrappers, then reinstalls the
service against the appropriate package source. It preserves ~/.jump.sh,
projects, certificates, and registration.

Install modes:
  npx/transient       Runs: npx --yes jump.sh@latest install
  global npm         Runs: npm install -g jump.sh@latest, then jump.sh install
  local checkout     Reinstalls the daemon from this checkout; no global npm mutation

Options:
  --dry-run          Show the daemon-only removal and reinstall plan
  --latest           Require registry latest (unsupported for local checkouts)
  --help, -h         Show this help
`);
}

export function createUpgradePlan({ installMode, binPath = LOCAL_BIN, latest = false } = {}) {
  if (installMode === 'npx') {
    return {
      preserveState: true,
      commands: [{ command: 'npx', args: ['--yes', 'jump.sh@latest', 'install'] }],
    };
  }

  if (installMode === 'global') {
    return {
      preserveState: true,
      commands: [
        { command: 'npm', args: ['install', '-g', 'jump.sh@latest'] },
        { command: 'jump.sh', args: ['install'] },
      ],
    };
  }

  if (latest) {
    throw new Error('Local checkout detected; --latest would require mutating npm globally. Pull/update this checkout, then run `jump.sh upgrade`.');
  }

  return {
    preserveState: true,
    commands: [{ command: process.execPath, args: [binPath, 'install'] }],
  };
}


export function resolveSafeUpgradeCwd({
  homeDir = os.homedir(),
  packageRoot = PACKAGE_ROOT,
  fileSystem = fs,
} = {}) {
  for (const candidate of [homeDir, packageRoot, path.parse(packageRoot).root]) {
    if (!candidate) continue;
    try {
      if (fileSystem.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Try the next safe fallback.
    }
  }

  return path.sep;
}

export function executeUpgradeCommand(
  step,
  { cwd = resolveSafeUpgradeCwd(), execFileSync: commandRunner = execFileSync } = {},
) {
  commandRunner(step.command, step.args, { stdio: 'inherit', cwd });
}

export function detectInstallMode({
  packageRoot = PACKAGE_ROOT,
  env = process.env,
  fileSystem = fs,
} = {}) {
  const npmExecPath = env.npm_execpath || '';
  if (npmExecPath.includes('npx')) return 'npx';
  if (packageRoot.includes(`${path.sep}_npx${path.sep}`) || packageRoot.includes(`${path.sep}.npm${path.sep}_npx${path.sep}`)) {
    return 'npx';
  }

  if (fileSystem.existsSync(path.join(packageRoot, '.git'))) return 'local';

  const normalizedRoot = packageRoot.split(path.sep).join('/');
  if (normalizedRoot.endsWith('/node_modules/jump.sh')) return 'global';
  if (env.npm_config_global === 'true') return 'global';

  return 'local';
}

function resolveLatestVersion(installMode, { cwd = resolveSafeUpgradeCwd(), execFileSync: commandRunner = execFileSync } = {}) {
  if (installMode === 'local') return readPackageVersion();

  try {
    return commandRunner('npm', ['view', 'jump.sh@latest', 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
      cwd,
    }).trim();
  } catch {
    return null;
  }
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function readInstalledVersion(installMode, { cwd = resolveSafeUpgradeCwd(), execFileSync: commandRunner = execFileSync } = {}) {
  if (installMode === 'local') return readPackageVersion();

  try {
    return commandRunner('jump.sh', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      cwd,
    }).trim().replace(/^jump\.sh\s+/, '');
  } catch {
    return null;
  }
}

function printFinalStatus({ oldVersion, newVersion }) {
  const running = isDaemonRunning();
  const domain = detectDomain();
  const hasDomain = detectDomainFromCerts() || process.env.JUMPSH_DOMAIN;
  const port = process.env.JUMPSH_PORT || (process.platform === 'linux' ? '443' : '443');
  const portSuffix = port === '443' ? '' : `:${port}`;
  const dashboard = hasDomain
    ? `https://dash.${domain}${portSuffix}`
    : `https://dash.jump.sh${portSuffix}`;

  console.log('');
  console.log(`old: jump.sh ${oldVersion}`);
  console.log(`new: jump.sh ${newVersion || 'unknown'}`);
  console.log(`status: daemon ${running ? 'running' : 'not confirmed running'}`);
  console.log(`dashboard: ${dashboard}`);
  if (!running) {
    console.log('guidance: run `jump.sh status` or `jump.sh install` if the daemon did not start.');
  }
}

function formatCommand(step) {
  return [step.command, ...step.args.map(quoteArg)].join(' ');
}

function quoteArg(arg) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return JSON.stringify(arg);
}
