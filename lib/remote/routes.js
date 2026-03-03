import fs from 'fs';
import os from 'os';
import path from 'path';
import { apiRequest, ApiError } from './api.js';
import { readAuth, isLoggedIn, getRemoteDomain } from './auth.js';

const JUMPSH_DIR = path.join(os.homedir(), '.jump.sh');
const ROUTES_PATH = path.join(JUMPSH_DIR, 'remote-routes.json');

/**
 * Route cache entry:
 * { subdomain: string, target_port: number, remote_host: string }
 *
 * The cache file format:
 * { updated_at: ISO8601, routes: Route[] }
 */

/**
 * Load remote routes from the local cache file.
 * @returns {{ updated_at: string, routes: Array<{ subdomain: string, target_port: number, remote_host: string }> }}
 */
export function loadRouteCache() {
  try {
    const data = JSON.parse(fs.readFileSync(ROUTES_PATH, 'utf8'));
    return {
      updated_at: data.updated_at || null,
      routes: Array.isArray(data.routes) ? data.routes : [],
    };
  } catch {
    return { updated_at: null, routes: [] };
  }
}

/**
 * Save remote routes to the local cache file.
 */
export function saveRouteCache(routes) {
  fs.mkdirSync(JUMPSH_DIR, { recursive: true });
  const data = {
    updated_at: new Date().toISOString(),
    routes,
  };
  fs.writeFileSync(ROUTES_PATH, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Fetch routes from the remote API and update the local cache.
 * @returns {Array<{ subdomain: string, target_port: number, remote_host: string }>}
 * @throws {ApiError} if not logged in or API fails
 */
export async function syncRoutes() {
  const { data } = await apiRequest('GET', '/api/v1/routes');
  const routes = Array.isArray(data.routes) ? data.routes : [];
  saveRouteCache(routes);
  return routes;
}

/**
 * Build a hostname→port map from remote routes for the current machine's domain.
 * Maps e.g. "my-project.username.jump.sh" → 10001
 *
 * @param {Array} routes - Route entries from cache
 * @returns {Map<string, number>} hostname → local port
 */
export function buildRemoteHostMap(routes) {
  const remoteDomain = getRemoteDomain();
  if (!remoteDomain) return new Map();
  const map = new Map();
  for (const route of routes) {
    if (route.subdomain && route.target_port) {
      const hostname = `${route.subdomain}.${remoteDomain}`;
      map.set(hostname, route.target_port);
    }
  }
  return map;
}
