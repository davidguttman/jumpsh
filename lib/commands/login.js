import { parseArgs } from 'node:util';
import { readAuth, writeAuth, clearAuth, getApiOrigin } from '../remote/auth.js';

export default async function login(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      token: { type: 'string' },
      logout: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(`Usage: jump.sh login --token <TOKEN>
       jump.sh login --logout

Authenticate with the jump.sh remote control plane.

Options:
  --token <TOKEN>  API token for authentication
  --logout         Clear stored credentials
  --help, -h       Show this help

Environment:
  JUMPSH_API_ORIGIN  API server URL (default: https://jump.sh)
`);
    process.exit(0);
  }

  if (values.logout) {
    clearAuth();
    console.log('Logged out. Remote credentials cleared.');
    return;
  }

  if (!values.token) {
    const auth = readAuth();
    if (auth) {
      console.log(`Logged in to ${getApiOrigin()}`);
      if (auth.machine_id) {
        console.log(`  Machine ID: ${auth.machine_id}`);
      }
      if (auth.machine_name) {
        console.log(`  Machine:    ${auth.machine_name}`);
      }
    } else {
      console.log('Not logged in.');
      console.log('Run: jump.sh login --token <TOKEN>');
    }
    return;
  }

  const token = values.token.trim();
  if (!token) {
    console.error('Token cannot be empty.');
    process.exit(2);
  }

  // Persist the token
  const existing = readAuth() || {};
  writeAuth({ ...existing, token });

  console.log(`Authenticated with ${getApiOrigin()}`);
  console.log('\nNext steps:');
  console.log('  jump.sh register   Register this machine with the control plane');
  console.log('  jump.sh sync       Fetch remote routes');
  console.log('  jump.sh status     Show machine and route status');
}
