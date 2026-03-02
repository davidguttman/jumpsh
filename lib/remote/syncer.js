import { isLoggedIn } from './auth.js';
import { loadRouteCache, syncRoutes, buildRemoteHostMap } from './routes.js';
import { devinfo, devwarn } from '../devlog.js';

const DEFAULT_SYNC_SECONDS = 30;

/**
 * RemoteSyncer — runs inside the daemon process.
 * Periodically fetches remote routes from the API and provides
 * a hostname→port map for the SubdomainProxy to use.
 */
export class RemoteSyncer {
  constructor() {
    this._remoteHostMap = new Map();
    this._timer = null;
    this._syncIntervalMs = (parseInt(process.env.JUMPSH_REMOTE_SYNC_SECONDS, 10) || DEFAULT_SYNC_SECONDS) * 1000;
  }

  /**
   * Load cached routes on startup and start periodic sync if logged in.
   */
  start() {
    // Always load the cache (may have been populated by `jumpsh sync`)
    const cache = loadRouteCache();
    this._remoteHostMap = buildRemoteHostMap(cache.routes);
    if (cache.routes.length > 0) {
      devinfo('Loaded remote route cache', { routes: cache.routes.length });
    }

    // Only start periodic sync if we have auth
    if (isLoggedIn()) {
      devinfo('Remote sync enabled', { intervalMs: this._syncIntervalMs });
      this._scheduleSync();
    }
  }

  /**
   * Get the current remote hostname→port map.
   * @returns {Map<string, number>}
   */
  getHostMap() {
    return this._remoteHostMap;
  }

  /**
   * Force an immediate sync (e.g., on SIGHUP).
   */
  async refresh() {
    if (!isLoggedIn()) return;
    await this._doSync();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _scheduleSync() {
    this._timer = setInterval(() => this._doSync(), this._syncIntervalMs);
    this._timer.unref();
    // Also do an initial sync soon (not blocking startup)
    setTimeout(() => this._doSync(), 2000).unref();
  }

  async _doSync() {
    try {
      const routes = await syncRoutes();
      this._remoteHostMap = buildRemoteHostMap(routes);
      devinfo('Remote routes synced', { routes: routes.length });
    } catch (err) {
      devwarn('Remote sync failed (will retry)', { error: err.message });
      // Don't crash — local routing continues to work
    }
  }
}
