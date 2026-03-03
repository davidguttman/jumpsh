import { parseArgs } from 'node:util';

const COMMANDS = {
  add:      () => import('./commands/add.js'),
  remove:   () => import('./commands/remove.js'),
  install:  () => import('./commands/install.js'),
  certs:    () => import('./commands/certs.js'),
  login:    () => import('./commands/login.js'),
  register: () => import('./commands/register.js'),
  status:   () => import('./commands/status.js'),
  sync:     () => import('./commands/sync.js'),
  ip:       () => import('./commands/ip.js'),
  ls:       () => import('./commands/ls.js'),
  start:    () => import('./commands/start.js'),
  stop:     () => import('./commands/stop.js'),
  logs:     () => import('./commands/logs.js'),
};

const HELP = `
jump.sh — local dev server with Docker + subdomain routing

Usage: jump.sh [command] [options]

Commands:
  (none)              Run daemon in foreground
  add [path]          Register a project (default: current directory)
  remove <name>       Unregister a project
  install             Install daemon service + download certs
  install --uninstall Remove daemon service
  certs               Download TLS certificates from jump.sh
  ls                  List projects with status
  start [name]        Start project containers
  stop [name]         Stop project containers
  logs [name]         Tail project logs
  ip                  Print LAN IP address
  login               Authenticate with remote control plane
  register            Register via GitHub SSH key (provisions *.you.jump.sh)
  status              Show machine + route sync status
  sync                Fetch remote routes from control plane

Options:
  --help, -h          Show this help
  --version, -v       Show version
  --sub <name>        Set subdomain (e.g. --sub alice → alice.jump.sh)
  --domain <domain>   Set full custom domain
  --port <port>       Set server port
`.trim();

export async function run(argv) {
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    console.error('jump.sh only supports macOS and Linux. Detected: ' + platform);
    process.exit(1);
  }

  // Check for top-level --help or --version before command parsing
  if (argv.includes('--help') || argv.includes('-h')) {
    // If there's a command before --help, let the command handle it
    const firstArg = argv[0];
    if (!firstArg || firstArg.startsWith('-') || !COMMANDS[firstArg]) {
      console.log(HELP);
      process.exit(0);
    }
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    console.log(`jump.sh ${pkg.version}`);
    process.exit(0);
  }

  const command = argv[0];

  // No subcommand → run daemon in foreground
  if (!command || command.startsWith('-')) {
    const { default: startDaemon } = await import('./commands/daemon.js');
    await startDaemon(argv);
    return;
  }

  if (!COMMANDS[command]) {
    console.error(`Unknown command: ${command}`);
    console.error(`Run 'jump.sh --help' for usage.`);
    process.exit(2);
  }

  try {
    const mod = await COMMANDS[command]();
    await mod.default(argv.slice(1));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
