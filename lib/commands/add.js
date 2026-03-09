import { parseArgs } from 'node:util';
import path from 'path';
import readline from 'readline';
import { detectProjectType } from '../../services/ProjectDetector.js';
import { detectDomain, detectPort, detectProtocol } from '../domain.js';
import { isDaemonRunning } from '../daemon-status.js';
import { isDockerAvailable } from '../../services/dockerCommand.js';

const HELP = `Usage: jump.sh add [path] [options]

Add a project to jump.sh from the command line.

Arguments:
  path                  Project directory (default: current directory)

Options:
  --name, -n <name>     Project name (default: folder name)
  --build <cmd>         Build/install command override
  --start <cmd>         Start/dev command override
  --port, -p <port>     Port override
  --image <image>       Docker image override
  --env, -e <KEY=val>   Environment variable (repeatable)
  --yes, -y             Skip confirmation prompt
  --json                Output detection result as JSON (no create)
  --help, -h            Show this help

Examples:
  jump.sh add .
  jump.sh add . --name my-app --yes
  jump.sh add . --json
  jump.sh add /path/to/project --start "npm run dev" --port 3000
  jump.sh add . --env API_URL=http://localhost:8080 --env DEBUG=true
`;

export default async function add(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP.trim());
    process.exit(0);
  }

  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      name:  { type: 'string', short: 'n' },
      build: { type: 'string' },
      start: { type: 'string' },
      port:  { type: 'string', short: 'p' },
      image: { type: 'string' },
      env:   { type: 'string', short: 'e', multiple: true },
      yes:   { type: 'boolean', short: 'y', default: false },
      json:  { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  // Resolve project path
  const rawPath = positionals[0] || '.';
  const projectPath = path.resolve(rawPath);

  // Run detection
  const detected = detectProjectType(projectPath);
  if (detected.error) {
    console.error(`Error: ${detected.error}`);
    process.exit(1);
  }

  const folderName = path.basename(projectPath);
  const suggestedName = values.name || folderName;

  // --json mode: output detection and exit
  if (values.json) {
    const output = {
      path: projectPath,
      detected,
      suggested: {
        name: suggestedName,
        subdomain: suggestedName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''),
      },
    };
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
  }

  // Check daemon is running
  if (!isDaemonRunning()) {
    console.error('Error: jump.sh daemon is not running.');
    console.error('Start it with: jump.sh install  (daemon mode)');
    console.error('           or: jump.sh server   (foreground mode)');
    process.exit(1);
  }

  // Build the project payload
  const envVars = parseEnvFlags(values.env);
  const payload = {
    name: suggestedName,
    path: projectPath,
  };
  if (values.build) payload.override_build_command = values.build;
  if (values.start) payload.override_start_command = values.start;
  if (values.port)  payload.override_port = parseInt(values.port, 10);
  if (values.image) payload.override_docker_image = values.image;
  if (envVars.length > 0) payload.override_env = JSON.stringify(envVars);

  // Show summary and confirm unless --yes
  if (!values.yes) {
    console.log('');
    console.log('Project to add:');
    console.log(`  Name:    ${payload.name}`);
    console.log(`  Path:    ${payload.path}`);
    console.log(`  Type:    ${detected.type}${detected.framework ? ` (${detected.framework})` : ''}`);
    if (detected.devCommand) console.log(`  Start:   ${payload.override_start_command || detected.devCommand}`);
    if (detected.installCommand) console.log(`  Build:   ${payload.override_build_command || detected.installCommand}`);
    console.log(`  Port:    ${payload.override_port || detected.port}`);
    if (detected.dockerImage) console.log(`  Image:   ${payload.override_docker_image || detected.dockerImage}`);
    if (envVars.length > 0) {
      console.log(`  Env:     ${envVars.map(e => `${e.key}=${e.value}`).join(', ')}`);
    }
    console.log('');

    const confirmed = await confirm('Create this project? [Y/n] ');
    if (!confirmed) {
      console.log('Cancelled.');
      process.exit(0);
    }
  }

  // POST to daemon API
  const protocol = detectProtocol();
  const port = detectPort();
  const domain = detectDomain();
  const defaultPort = protocol === 'https' ? 443 : 80;
  const portSuffix = port === defaultPort ? '' : `:${port}`;
  const url = `${protocol}://dash.${domain}${portSuffix}/projects`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const body = await resp.json();

    if (!resp.ok) {
      console.error(`Error: ${body.error || 'Failed to create project'}`);
      process.exit(1);
    }

    const subdomain = suggestedName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    console.log(`Project "${suggestedName}" created.`);
    console.log(`URL: ${protocol}://${subdomain}.${domain}${portSuffix}`);

    if (!isDockerAvailable()) {
      console.log('');
      console.warn('⚠ Warning: Docker is not available. The project was registered but cannot');
      console.warn('  start until Docker is installed and running.');
      console.warn('  Install Docker Desktop: https://docker.com/products/docker-desktop');
    }
  } catch (err) {
    console.error(`Error: Could not connect to jump.sh daemon at ${url}`);
    console.error(`Make sure the daemon is running: jump.sh status`);
    process.exit(1);
  }
}

function parseEnvFlags(envFlags) {
  if (!envFlags || envFlags.length === 0) return [];
  return envFlags.map(flag => {
    const eqIdx = flag.indexOf('=');
    if (eqIdx === -1) {
      console.error(`Error: Invalid --env format: "${flag}" (expected KEY=value)`);
      process.exit(1);
    }
    return { key: flag.slice(0, eqIdx), value: flag.slice(eqIdx + 1) };
  });
}

function confirm(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() !== 'n');
    });
  });
}
