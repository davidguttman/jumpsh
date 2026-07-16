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
      if (index === plan.refreshedJumpBinCommandIndex) {
        console.log(
          `dry-run: would run ${formatCommand({
            command: step.command,
            args: [`<refreshed target of ${plan.toolchain.jumpBinLexicalPath}>`, ...step.args.slice(1)],
          })}`,
        );
      } else {
        console.log(`dry-run: would run ${formatCommand(step)}`);
      }
      if (index === plan.refreshJumpBinAfterCommandIndex) {
        console.log(`dry-run: would revalidate ${plan.toolchain.jumpBinLexicalPath} and use its refreshed in-package target`);
      }
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
  global npm         Uses a trusted Node/npm pair with the package's explicit prefix
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
  execPath = process.execPath,
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
      execPath,
    });
    const installPackage = {
      command: toolchain.npm.command,
      args: [
        ...toolchain.npm.argsPrefix,
        'install',
        '-g',
        'jump.sh@latest',
        '--prefix',
        toolchain.prefix,
      ],
    };
    const installService = {
      command: toolchain.nodePath,
      args: [toolchain.jumpBinPath, 'install'],
    };
    const plan = {
      preserveState: true,
      toolchain,
      removeDaemonBeforeCommandIndex: 1,
      refreshJumpBinAfterCommandIndex: 0,
      refreshedJumpBinCommandIndex: 1,
      commands: [installPackage, installService],
      refreshJumpBin() {
        const refreshedJumpBinPath = validateGlobalJumpBin({
          fileSystem,
          canonicalPackageRoot: toolchain.packageRoot,
          jumpBinLexicalPath: toolchain.jumpBinLexicalPath,
        });
        toolchain.jumpBinPath = refreshedJumpBinPath;
        installService.args = [refreshedJumpBinPath, 'install'];
        return refreshedJumpBinPath;
      },
    };
    return plan;
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
  execPath = process.execPath,
} = {}) {
  const resolvedPackageRoot = path.resolve(packageRoot);
  const canonicalPackageRoot = canonicalPath(fileSystem, resolvedPackageRoot);
  const nodeModulesDir = path.dirname(canonicalPackageRoot);
  const libDir = path.dirname(nodeModulesDir);
  const prefix = canonicalPath(fileSystem, path.dirname(libDir));

  if (
    path.basename(canonicalPackageRoot) !== 'jump.sh'
    || path.basename(nodeModulesDir) !== 'node_modules'
    || path.basename(libDir) !== 'lib'
  ) {
    throw new Error(
      `Cannot upgrade global jump.sh: expected package root layout <prefix>${path.sep}lib${path.sep}node_modules${path.sep}jump.sh, received ${resolvedPackageRoot}`,
    );
  }

  const jumpBinLexicalPath = path.join(canonicalPackageRoot, 'bin', 'jumpsh.js');
  const jumpBinPath = validateGlobalJumpBin({
    fileSystem,
    canonicalPackageRoot,
    jumpBinLexicalPath,
  });
  validateGlobalInstallTarget(fileSystem, nodeModulesDir);

  const targetPair = resolveTrustedToolchainPair({
    nodeCandidate: path.join(prefix, 'bin', 'node'),
    prefix,
    fileSystem,
  });
  const runtimeNodePath = accessibleFilePath(fileSystem, execPath, fileSystem.constants.X_OK);
  let runtimePair = null;
  let runtimePrefix = null;
  if (runtimeNodePath) {
    const runtimeBinDir = path.dirname(runtimeNodePath);
    runtimePrefix = path.dirname(runtimeBinDir);
    runtimePair = resolveTrustedToolchainPair({
      nodeCandidate: runtimeNodePath,
      prefix: runtimePrefix,
      fileSystem,
    });
  }

  const selectedPair = targetPair || runtimePair;
  if (!selectedPair) {
    const runtimeDetails = runtimePrefix
      ? ` current runtime prefix ${runtimePrefix}`
      : ` invalid current Node path ${execPath}`;
    throw new Error(
      `Cannot upgrade global jump.sh: no trusted Node/npm pair found at target prefix ${prefix} or${runtimeDetails}.`,
    );
  }

  return {
    prefix,
    packageRoot: canonicalPackageRoot,
    nodePath: selectedPair.nodePath,
    npm: selectedPair.npm,
    jumpBinLexicalPath,
    jumpBinPath,
    installTarget: nodeModulesDir,
  };
}

function resolveTrustedToolchainPair({ nodeCandidate, prefix, fileSystem }) {
  const canonicalPrefix = canonicalPath(fileSystem, prefix);
  const nodePath = accessibleFilePath(fileSystem, nodeCandidate, fileSystem.constants.X_OK);
  if (!nodePath || !isPathWithin(canonicalPrefix, nodePath)) return null;

  const conventionalNpmCliPath = accessibleFilePath(
    fileSystem,
    path.join(canonicalPrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    fileSystem.constants.R_OK,
  );
  if (conventionalNpmCliPath && isPathWithin(canonicalPrefix, conventionalNpmCliPath)) {
    return {
      nodePath,
      npm: { command: nodePath, argsPrefix: [conventionalNpmCliPath] },
    };
  }

  const sameBinNpmCandidate = path.join(canonicalPrefix, 'bin', 'npm');
  const readableSameBinNpm = accessibleFilePath(
    fileSystem,
    sameBinNpmCandidate,
    fileSystem.constants.R_OK,
  );
  if (!readableSameBinNpm || !isPathWithin(canonicalPrefix, readableSameBinNpm)) return null;

  if (path.extname(readableSameBinNpm) === '.js') {
    return {
      nodePath,
      npm: { command: nodePath, argsPrefix: [readableSameBinNpm] },
    };
  }

  const executableSameBinNpm = accessibleFilePath(
    fileSystem,
    sameBinNpmCandidate,
    fileSystem.constants.X_OK,
  );
  if (executableSameBinNpm && isPathWithin(canonicalPrefix, executableSameBinNpm)) {
    return {
      nodePath,
      npm: { command: executableSameBinNpm, argsPrefix: [] },
    };
  }

  return null;
}

function validateGlobalJumpBin({ fileSystem, canonicalPackageRoot, jumpBinLexicalPath }) {
  const jumpBinPath = accessibleFilePath(
    fileSystem,
    jumpBinLexicalPath,
    fileSystem.constants.R_OK,
  );
  if (!jumpBinPath) {
    throw new Error(
      `Cannot upgrade global jump.sh: jump.sh bin not found or accessible at ${jumpBinLexicalPath}`,
    );
  }
  if (!isPathWithin(canonicalPackageRoot, jumpBinPath)) {
    throw new Error(
      `Cannot upgrade global jump.sh: jump.sh bin resolves outside canonical package root ${canonicalPackageRoot}: ${jumpBinPath}`,
    );
  }
  return jumpBinPath;
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

function isPathWithin(parentPath, childPath) {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
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

      if (index === plan.refreshJumpBinAfterCommandIndex) {
        plan.refreshJumpBin();
      }
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
    const command = installMode === 'global' ? toolchain.npm.command : 'npm';
    const args = installMode === 'global'
      ? [...toolchain.npm.argsPrefix, 'view', 'jump.sh@latest', 'version']
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
