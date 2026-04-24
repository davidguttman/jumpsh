import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import slugify from 'slugify';

const execAsync = promisify(exec);
const INSTALL_DEBOUNCE_MS = 300;

class WorktreeScanner {
  constructor(db, docker) {
    this.db = db;
    this.docker = docker;
    this.watchers = new Map(); // projectId -> Map(watcherKey -> FSWatcher)
    this.installTimers = new Map(); // targetId -> Timeout
  }

  _getOrCreateWatcherMap(projectId) {
    let map = this.watchers.get(projectId);
    if (!map) {
      map = new Map();
      this.watchers.set(projectId, map);
    }
    return map;
  }

  _closeWatcher(projectId, key) {
    const map = this.watchers.get(projectId);
    if (!map) return;
    const watcher = map.get(key);
    if (!watcher) return;
    try { watcher.close(); } catch {}
    map.delete(key);
  }

  // Debounced install so a flurry of writes (editor save → npm install rewrites)
  // produces a single dependency install.
  _scheduleInstall(target) {
    const id = target.id;
    const existing = this.installTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.installTimers.delete(id);
      console.log(`Installing dependencies for ${target.name} due to package.json change`);
      Promise.resolve(this.docker.installDependencies(target)).catch((err) => {
        console.error(`Error installing dependencies for ${target.name}:`, err.message);
      });
    }, INSTALL_DEBOUNCE_MS);
    this.installTimers.set(id, timer);
  }

  _watchPackageJson(projectId, key, filePath, onChange) {
    const map = this._getOrCreateWatcherMap(projectId);
    if (map.has(key)) return;
    if (!fs.existsSync(filePath)) return;
    try {
      const watcher = fs.watch(filePath, { persistent: false }, () => {
        onChange();
      });
      map.set(key, watcher);
    } catch (error) {
      console.error(`Error watching ${filePath}:`, error.message);
    }
  }

  // Start watching a project's .worktrees directory and package.json files
  watchProject(project) {
    const map = this._getOrCreateWatcherMap(project.id);

    // Watch root package.json (only set up if it exists — naturally limits to Node.js projects)
    const rootPackageJson = path.join(project.path, 'package.json');
    this._watchPackageJson(project.id, 'package.json', rootPackageJson, () => {
      console.log(`package.json changed for ${project.name}`);
      this._scheduleInstall(project);
    });

    // Watch .worktrees directory for new/removed worktrees
    const worktreesDir = path.join(project.path, '.worktrees');
    if (fs.existsSync(worktreesDir) && !map.has('worktrees')) {
      console.log(`Watching worktrees for ${project.name}: ${worktreesDir}`);

      // Initial scan also wires up per-worktree package.json watchers
      this.scanWorktrees(project);

      try {
        const watcher = fs.watch(worktreesDir, { persistent: false }, (eventType, filename) => {
          console.log(`Worktree change detected: ${eventType} ${filename}`);
          this.scanWorktrees(project);
        });
        map.set('worktrees', watcher);
      } catch (error) {
        console.error(`Error watching ${worktreesDir}:`, error.message);
      }
    }
  }

  // Stop watching a project (closes ALL watchers for this project)
  unwatchProject(projectId) {
    const map = this.watchers.get(projectId);
    if (!map) return;
    for (const watcher of map.values()) {
      try { watcher.close(); } catch {}
    }
    this.watchers.delete(projectId);
  }

  _syncWorktreePackageWatchers(project, activeWorktrees) {
    const map = this._getOrCreateWatcherMap(project.id);

    const desiredKeys = new Set(activeWorktrees.map(wt => `worktree:${wt.path}`));

    // Remove watchers for worktrees that no longer exist
    for (const key of [...map.keys()]) {
      if (key.startsWith('worktree:') && !desiredKeys.has(key)) {
        this._closeWatcher(project.id, key);
      }
    }

    // Add watchers for new worktrees
    for (const wt of activeWorktrees) {
      const key = `worktree:${wt.path}`;
      const wtPackageJson = path.join(wt.path, 'package.json');
      this._watchPackageJson(project.id, key, wtPackageJson, () => {
        console.log(`package.json changed for worktree ${wt.name}`);
        this._scheduleInstall(wt);
      });
    }
  }

  // Scan .worktrees directory and sync with database
  async scanWorktrees(project) {
    const worktreesDir = path.join(project.path, '.worktrees');

    if (!fs.existsSync(worktreesDir)) {
      return [];
    }

    const entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
    const worktrees = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const worktreePath = path.join(worktreesDir, entry.name);
      const gitDir = path.join(worktreePath, '.git');

      // Verify it's a valid worktree (has .git file or directory)
      if (!fs.existsSync(gitDir)) continue;

      // Get branch name
      let branchName = entry.name;
      try {
        const { stdout } = await execAsync('git branch --show-current', { cwd: worktreePath });
        branchName = stdout.trim() || entry.name;
      } catch {
        // Use directory name as fallback
      }

      // Generate subdomain: parent--branch (double-dash separator)
      const parentSubdomain = project.subdomain || slugify(project.name, { lower: true, strict: true });
      const branchSlug = slugify(branchName, { lower: true, strict: true });
      const subdomain = `${parentSubdomain}--${branchSlug}`;

      const worktree = {
        name: `${project.name} (${branchName})`,
        path: worktreePath,
        subdomain,
        parent_project_id: project.id,
        branch_name: branchName
      };

      worktrees.push(worktree);

      // Upsert to database
      this.db.upsertWorktree(worktree, (err) => {
        if (err) console.error(`Error upserting worktree:`, err);
      });
    }

    // Remove worktrees that no longer exist, and auto-start if parent is running
    this.db.getWorktreesForProject(project.id, async (err, dbWorktrees) => {
      if (err || !dbWorktrees) return;

      const currentPaths = new Set(worktrees.map(w => w.path));
      for (const dbWt of dbWorktrees) {
        if (!currentPaths.has(dbWt.path)) {
          this.db.deleteWorktree(dbWt.path, () => {});
        }
      }

      // Sync per-worktree package.json watchers to the current set
      const activeWorktrees = dbWorktrees.filter(wt => currentPaths.has(wt.path));
      this._syncWorktreePackageWatchers(project, activeWorktrees);

      // Auto-start worktrees if parent project is running
      if (this.docker) {
        const parentStatus = await this.docker.getStatus(project);
        if (parentStatus.running) {
          for (const wt of activeWorktrees) {
            this.docker.start(wt); // fire-and-forget
          }
        }
      }
    });

    return worktrees;
  }

  // Scan all projects
  scanAllProjects() {
    this.db.ready().then(() => {
      this.db.getAllProjects((err, projects) => {
        if (err || !projects) return;

        for (const project of projects) {
          this.watchProject(project);
        }
      });
    });
  }

  // Cleanup all watchers
  cleanup() {
    for (const map of this.watchers.values()) {
      for (const watcher of map.values()) {
        try { watcher.close(); } catch {}
      }
    }
    this.watchers.clear();

    for (const timer of this.installTimers.values()) {
      clearTimeout(timer);
    }
    this.installTimers.clear();
  }
}

export default WorktreeScanner;
