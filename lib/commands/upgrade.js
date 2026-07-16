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
  const plan = createUpgradePlan({
    installMode,
    binPath: LOCAL_BIN,
    packageRoot: PACKAGE_ROOT,
    latest: values.latest,
  });
  const commandCwd = resolveSafeUpgradeCwd();

  console.log(`old: jump.sh ${oldVersion}`);
  console.log(`mode: ${installMode}`);
  console.log('preserve: ~/.jump.sh state, projects, certs, and registration');

  if (values['dry-run']) {
    for (let index = 0; index < plan.commands.length; index += 1) {
      if (index === plan.removeDaemonBeforeCommandIndex) {
        console.log('dry-run: would remove daemon service files only');
      }
      const step = plan.commands[index];
      console.log(`dry-run: would run ${formatCommand(step)}`);
    }
    return;
  }

  const newVersionBeforeInstall = resolveLatestVersion(installMode, {
    cwd: commandCwd,
    toolchain: plan.toolchain,
  });

  try {
    executeUpgradePlan(plan, {
      cwd: commandCwd,
      beforeCommand: (step) => console.log(`\nRunning: ${formatCommand(step)}`),
      removeDaemon: () => {
        console.log('\nRemoving current daemon service files...');
        const removed = removeDaemonOnly();
        if (removed.length === 0) {
          console.log('  No daemon files found. State directory left untouched.');
        } else {
          for (const msg of removed) {
            console.log(`  ${msg}`);
          }
        }
        return removed;
      },
    });
  } catch (err) {
    console.error('\nUpgrade failed.');
    if (err.upgradeDaemonRemoved) {
      console.error('State was preserved. To recover after fixing the issue, run: jump.sh install');
    } else {
      console.error('The current daemon was left untouched.');
    }
    process.exit(err.status || 1);
  }

  const newVersion = newVersionBeforeInstall || readInstalledVersion(installMode, {
    cwd: commandCwd,
    toolchain: plan.toolchain,
  }) || oldVersion;
  printFinalStatus({ oldVersion, newVersion });
}

function printHelp() {
  console.log(`Usage: jump.sh upgrade [options]

Upgrade jump.sh itself while preserving user state.

For global installs, the command installs the new package with its owning Node
toolchain before removing the current daemon service, then installs the new one.
It preserves ~/.jump.sh, projects, certificates, and registration.

Install modes:
  npx/transient       Runs: npx --yes jump.sh@latest install
  global npm         Uses the owning Node/npm prefix, then its jump.sh install
  local checkout     Reinstalls the daemon from this checkout; no global npm mutation

Options:
  --dry-run          Show the daemon-only removal and reinstall plan
  --latest           Require registry latest (unsupported for local checkouts)
  --help, -h         Show this help
`);
}

export function createUpgradePlan({
  installMode,
  binPath = LOCAL_BIN,
  packageRoot = PACKAGE_ROOT,
  latest = false,
  fileSystem = fs,
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
  execFileSync: commandRunner = execFileSync,
} = {}) {
  if (installMode === 'npx') {
    return {
      preserveState: true,
      removeDaemonBeforeCommandIndex: 0,
      commands: [{ command: 'npx', args: ['--yes', 'jump.sh@latest', 'install'] }],
    };
  }

  if (installMode === 'global') {
    const toolchain = resolveGlobalToolchain({
      packageRoot,
      fileSystem,
      env,
      execPath,
      platform,
      execFileSync: commandRunner,
    });
    return {
      preserveState: true,
      toolchain,
      removeDaemonBeforeCommandIndex: 1,
      commands: [
        {
          command: toolchain.nodePath,
          args: [
            toolchain.npmCliPath,
            'install',
            '-g',
            'jump.sh@latest',
            '--prefix',
            toolchain.prefix,
          ],
        },
        { command: toolchain.nodePath, args: [toolchain.jumpBinPath, 'install'] },
      ],
    };
  }

  if (latest) {
    throw new Error('Local checkout detected; --latest would require mutating npm globally. Pull/update this checkout, then run `jump.sh upgrade`.');
  }

  return {
    preserveState: true,
    removeDaemonBeforeCommandIndex: 0,
    commands: [{ command: process.execPath, args: [binPath, 'install'] }],
  };
}

export function resolveGlobalToolchain({
  packageRoot = PACKAGE_ROOT,
  fileSystem = fs,
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
  execFileSync: commandRunner = execFileSync,
} = {}) {
  const resolvedPackageRoot = path.resolve(packageRoot);
  const nodeModulesDir = path.dirname(resolvedPackageRoot);
  const libDir = path.dirname(nodeModulesDir);
  const prefix = path.dirname(libDir);

  if (
    path.basename(resolvedPackageRoot) !== 'jump.sh'
    || path.basename(nodeModulesDir) !== 'node_modules'
    || path.basename(libDir) !== 'lib'
  ) {
    throw new Error(
      `Cannot upgrade global jump.sh: expected package root layout <prefix>${path.sep}lib${path.sep}node_modules${path.sep}jump.sh, received ${resolvedPackageRoot}`,
    );
  }

  const jumpBinPath = path.join(resolvedPackageRoot, 'bin', 'jumpsh.js');
  validateGlobalFile(fileSystem, 'jump.sh bin', jumpBinPath, fileSystem.constants.R_OK);
  validateGlobalInstallTarget(fileSystem, nodeModulesDir);

  const targetPrefix = canonicalPath(fileSystem, prefix);
  const candidates = collectGlobalToolchainCandidates({
    prefix,
    env,
    execPath,
    platform,
    fileSystem,
  });
  const attempts = [];
  const cwd = resolveSafeUpgradeCwd({ packageRoot: resolvedPackageRoot, fileSystem });

  for (const candidate of candidates) {
    let reportedPrefix;
    try {
      reportedPrefix = commandRunner(
        candidate.nodePath,
        [candidate.npmCliPath, 'prefix', '-g'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000,
          cwd,
        },
      ).trim();
    } catch {
      attempts.push(`${candidate.nodePath} + ${candidate.npmCliPath} (prefix check failed)`);
      continue;
    }

    if (
      reportedPrefix
      && path.isAbsolute(reportedPrefix)
      && canonicalPath(fileSystem, reportedPrefix) === targetPrefix
    ) {
      return {
        prefix,
        nodePath: candidate.nodePath,
        npmCliPath: candidate.npmCliPath,
        jumpBinPath,
        installTarget: nodeModulesDir,
      };
    }

    attempts.push(`${candidate.nodePath} + ${candidate.npmCliPath} (reported ${reportedPrefix || 'no prefix'})`);
  }

  const attemptSummary = attempts.length > 0 ? ` Tried: ${attempts.join('; ')}` : '';
  throw new Error(
    `Cannot upgrade global jump.sh: no accessible Node/npm toolchain reports target global prefix ${prefix}.${attemptSummary}`,
  );
}

function collectGlobalToolchainCandidates({ prefix, env, execPath, platform, fileSystem }) {
  const rawCandidates = [];
  const coLocatedNode = path.join(prefix, 'bin', 'node');
  const coLocatedNpm = path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  rawCandidates.push([coLocatedNode, coLocatedNpm, fileSystem.constants.R_OK]);

  if (path.isAbsolute(execPath)) {
    if (path.isAbsolute(env.npm_execpath || '')) {
      rawCandidates.push([execPath, env.npm_execpath, fileSystem.constants.R_OK]);
    }

    const runtimeBinDirs = new Set([path.dirname(execPath)]);
    const canonicalExecPath = accessibleFilePath(fileSystem, execPath, fileSystem.constants.X_OK);
    if (canonicalExecPath) runtimeBinDirs.add(path.dirname(canonicalExecPath));

    for (const runtimeBinDir of runtimeBinDirs) {
      const runtimePrefix = path.dirname(runtimeBinDir);
      rawCandidates.push([
        execPath,
        path.join(runtimePrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        fileSystem.constants.R_OK,
      ]);
      rawCandidates.push([execPath, path.join(runtimeBinDir, 'npm'), fileSystem.constants.X_OK]);
    }

    if (platform === 'linux' || platform === 'darwin') {
      for (const pathEntry of (env.PATH || '').split(path.delimiter)) {
        if (!path.isAbsolute(pathEntry)) continue;
        rawCandidates.push([execPath, path.join(pathEntry, 'npm'), fileSystem.constants.X_OK]);
      }
    }
  }

  const candidates = [];
  const seen = new Set();
  for (const [nodeCandidate, npmCandidate, npmMode] of rawCandidates) {
    const nodePath = accessibleFilePath(fileSystem, nodeCandidate, fileSystem.constants.X_OK);
    const npmCliPath = accessibleFilePath(fileSystem, npmCandidate, npmMode);
    if (!nodePath || !npmCliPath) continue;

    const key = `${nodePath}\0${npmCliPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ nodePath, npmCliPath });
  }

  return candidates;
}

function accessibleFilePath(fileSystem, filePath, mode) {
  if (!path.isAbsolute(filePath)) return null;

  try {
    if (!fileSystem.statSync(filePath).isFile()) return null;
    fileSystem.accessSync(filePath, mode);
    return canonicalPath(fileSystem, filePath);
  } catch {
    return null;
  }
}

function canonicalPath(fileSystem, filePath) {
  const normalizedPath = path.normalize(path.resolve(filePath));
  try {
    return path.normalize(fileSystem.realpathSync(normalizedPath));
  } catch {
    return normalizedPath;
  }
}

function validateGlobalFile(fileSystem, label, filePath, mode) {
  try {
    if (!fileSystem.statSync(filePath).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`Cannot upgrade global jump.sh: ${label} not found at ${filePath}`);
  }

  try {
    fileSystem.accessSync(filePath, mode);
  } catch {
    throw new Error(`Cannot upgrade global jump.sh: ${label} is not accessible at ${filePath}`);
  }
}

function validateGlobalInstallTarget(fileSystem, installTarget) {
  try {
    if (!fileSystem.statSync(installTarget).isDirectory()) throw new Error('not a directory');
    fileSystem.accessSync(installTarget, fileSystem.constants.W_OK);
  } catch {
    throw new Error(`Cannot upgrade global jump.sh: global install target is not writable at ${installTarget}`);
  }
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

export function executeUpgradePlan(
  plan,
  {
    cwd = resolveSafeUpgradeCwd(),
    executeCommand = (step) => executeUpgradeCommand(step, { cwd }),
    removeDaemon = removeDaemonOnly,
    beforeCommand = () => {},
  } = {},
) {
  let daemonRemoved = false;

  try {
    for (let index = 0; index < plan.commands.length; index += 1) {
      if (index === plan.removeDaemonBeforeCommandIndex) {
        daemonRemoved = true;
        removeDaemon();
      }

      const step = plan.commands[index];
      beforeCommand(step);
      executeCommand(step, { cwd });
    }
  } catch (err) {
    if (err && typeof err === 'object') err.upgradeDaemonRemoved = daemonRemoved;
    throw err;
  }
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

export function resolveLatestVersion(
  installMode,
  {
    cwd = resolveSafeUpgradeCwd(),
    toolchain,
    execFileSync: commandRunner = execFileSync,
  } = {},
) {
  if (installMode === 'local') return readPackageVersion();

  try {
    const command = installMode === 'global' ? toolchain.nodePath : 'npm';
    const args = installMode === 'global'
      ? [toolchain.npmCliPath, 'view', 'jump.sh@latest', 'version']
      : ['view', 'jump.sh@latest', 'version'];
    return commandRunner(command, args, {
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

export function readInstalledVersion(
  installMode,
  {
    cwd = resolveSafeUpgradeCwd(),
    toolchain,
    execFileSync: commandRunner = execFileSync,
  } = {},
) {
  if (installMode === 'local') return readPackageVersion();

  try {
    const command = installMode === 'global' ? toolchain.nodePath : 'jump.sh';
    const args = installMode === 'global' ? [toolchain.jumpBinPath, '--version'] : ['--version'];
    return commandRunner(command, args, {
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
