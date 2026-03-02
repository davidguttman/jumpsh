import os from 'os';
import { readAuth, writeAuth, isLoggedIn, getApiOrigin, getRemoteDomain } from '../remote/auth.js';
import { apiRequest } from '../remote/api.js';

export default async function register(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: jumpsh register

Register this machine with the jump.sh control plane.
Reports the machine's hostname and LAN IP for remote routing.

Requires: jumpsh login --token <TOKEN> first.

Environment:
  JUMPSH_API_ORIGIN      API server (default: https://jump.sh)
  JUMPSH_REMOTE_DOMAIN   Remote domain (default: dmg.jump.sh)
`);
    process.exit(0);
  }

  if (!isLoggedIn()) {
    console.error('Not logged in. Run `jumpsh login --token <TOKEN>` first.');
    process.exit(1);
  }

  const lanIp = getLanIp();
  if (!lanIp) {
    console.error('Could not detect LAN IP address.');
    process.exit(1);
  }

  const hostname = os.hostname();
  const remoteDomain = getRemoteDomain();

  console.log(`Registering machine with ${getApiOrigin()}...`);
  console.log(`  Hostname: ${hostname}`);
  console.log(`  LAN IP:   ${lanIp}`);
  console.log(`  Domain:   *.${remoteDomain}`);

  try {
    const { data } = await apiRequest('POST', '/api/v1/machines', {
      hostname,
      ip: lanIp,
      domain: remoteDomain,
    });

    // Persist machine info
    const auth = readAuth();
    writeAuth({
      ...auth,
      machine_id: data.machine_id || data.id,
      machine_name: data.machine_name || hostname,
      ip: lanIp,
    });

    console.log(`\nRegistered successfully.`);
    if (data.machine_id || data.id) {
      console.log(`  Machine ID: ${data.machine_id || data.id}`);
    }
    console.log('\nNext: jumpsh sync');
  } catch (err) {
    console.error(`Registration failed: ${err.message}`);
    if (err.status === 401) {
      console.error('Token may be invalid or expired. Run `jumpsh login --token <TOKEN>`.');
    }
    process.exit(1);
  }
}

function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}
