import { parseArgs } from 'node:util';
import { isDaemonRunning } from './daemon-status.js';

const COMMANDS = {
  install:   () => import('./commands/install.js'),
  uninstall: () => import('./commands/uninstall.js'),
  register:  () => import('./commands/register.js'),
  status:    () => import('./commands/status.js'),
  ls:        () => import('./commands/ls.js'),
  logs:      () => import('./commands/logs.js'),
  server:    () => import('./commands/server.js'),
  open:      () => import('./commands/open.js'),
  dashboard: () => import('./commands/open.js'),
};

const HELP = `
jump.sh — local dev server with Docker + subdomain routing

Usage: jump.sh [command] [options]

Commands:
  (none)              Open dashboard (or start server if not running)
  server              Run daemon in foreground (for dev/debugging)
  open, dashboard     Open the dashboard in your browser
  install             Install daemon service + download certs
  uninstall            Remove daemon service
  ls                  List projects with status
  logs [name]         Tail project logs
  register            Get *.yourname.jump.sh with custom IP for remote access
  status              Show daemon and domain status

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

  // No subcommand → open dashboard if running, else start server
  if (!command || command.startsWith('-')) {
    const running = isDaemonRunning();
    if (running) {
      const { default: open } = await import('./commands/open.js');
      await open(argv);
    } else {
      const { default: server } = await import('./commands/server.js');
      await server(argv);
    }
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
