import { isLoggedIn, getApiOrigin, getRemoteDomain } from '../remote/auth.js';
import { syncRoutes } from '../remote/routes.js';

export default async function sync(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: jumpsh sync

Fetch remote routes from the jump.sh control plane and update the local cache.
The daemon will pick up updated routes on its next sync interval.

Requires: jumpsh login --token <TOKEN> first.
`);
    process.exit(0);
  }

  if (!isLoggedIn()) {
    console.error('Not logged in. Run `jumpsh login --token <TOKEN>` first.');
    process.exit(1);
  }

  console.log(`Syncing routes from ${getApiOrigin()}...`);

  try {
    const routes = await syncRoutes();
    const remoteDomain = getRemoteDomain();

    if (routes.length === 0) {
      console.log('No remote routes configured.');
      console.log('Register this machine first: jumpsh register');
    } else {
      console.log(`Synced ${routes.length} route(s):`);
      for (const route of routes) {
        console.log(`  ${route.subdomain}.${remoteDomain} → localhost:${route.target_port}`);
      }
    }

    console.log('\nRoute cache updated. The daemon will use these routes on next refresh.');
  } catch (err) {
    console.error(`Sync failed: ${err.message}`);
    if (err.status === 401) {
      console.error('Token may be invalid or expired. Run `jumpsh login --token <TOKEN>`.');
    }
    process.exit(1);
  }
}
