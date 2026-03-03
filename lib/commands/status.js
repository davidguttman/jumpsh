import { readAuth, isLoggedIn, getApiOrigin, getRemoteDomain } from '../remote/auth.js';
import { loadRouteCache } from '../remote/routes.js';

export default async function status(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: jumpsh status

Show machine registration and remote route sync status.
`);
    process.exit(0);
  }

  const auth = readAuth();
  const loggedIn = isLoggedIn();

  console.log('jump.sh remote status');
  console.log('─'.repeat(40));

  // Auth
  if (loggedIn) {
    console.log(`  Auth:       logged in`);
    console.log(`  API:        ${getApiOrigin()}`);
  } else {
    console.log(`  Auth:       not logged in`);
    console.log(`  Run:        jumpsh login --token <TOKEN>`);
    return;
  }

  // Machine
  if (auth.machine_id) {
    console.log(`  Machine ID: ${auth.machine_id}`);
    console.log(`  Machine:    ${auth.machine_name || '(unknown)'}`);
    if (auth.ip) {
      console.log(`  LAN IP:     ${auth.ip}`);
    }
  } else {
    console.log(`  Machine:    not registered`);
    console.log(`  Run:        jumpsh register`);
  }

  // Remote domain
  const remoteDomain = getRemoteDomain();
  console.log(`  Domain:     ${remoteDomain ? `*.${remoteDomain}` : '(not configured)'}`);

  // Route cache
  const cache = loadRouteCache();
  console.log('');
  console.log('Route cache');
  console.log('─'.repeat(40));
  if (cache.routes.length === 0) {
    console.log(`  No remote routes cached.`);
    if (loggedIn) {
      console.log(`  Run:        jumpsh sync`);
    }
  } else {
    console.log(`  Last sync:  ${cache.updated_at}`);
    console.log(`  Routes:     ${cache.routes.length}`);
    const statusDomain = getRemoteDomain();
    for (const route of cache.routes) {
      const host = statusDomain ? `${route.subdomain}.${statusDomain}` : route.subdomain;
      console.log(`    ${host} → localhost:${route.target_port}`);
    }
  }
}
