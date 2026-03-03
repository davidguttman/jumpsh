import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import slugify from 'slugify';

const execAsync = promisify(exec);

class WorktreeScanner {
  constructor(db, docker) {
    this.db = db;
    this.docker = docker;
    this.watchers = new Map(); // projectId -> FSWatcher
  }

  // Start watching a project's .worktrees directory
  watchProject(project) {
    const worktreesDir = path.join(project.path, '.worktrees');
    
    if (this.watchers.has(project.id)) {
      return; // Already watching
    }

    if (!fs.existsSync(worktreesDir)) {
      return; // No .worktrees directory
    }

    console.log(`Watching worktrees for ${project.name}: ${worktreesDir}`);
    
    // Initial scan
    this.scanWorktrees(project);

    // Watch for changes
    try {
      const watcher = fs.watch(worktreesDir, { persistent: false }, (eventType, filename) => {
        console.log(`Worktree change detected: ${eventType} ${filename}`);
        this.scanWorktrees(project);
      });

      this.watchers.set(project.id, watcher);
    } catch (error) {
      console.error(`Error watching ${worktreesDir}:`, error.message);
    }
  }

  // Stop watching a project
  unwatchProject(projectId) {
    const watcher = this.watchers.get(projectId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(projectId);
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

      // Auto-start worktrees if parent project is running
      if (this.docker) {
        const parentStatus = await this.docker.getStatus(project);
        if (parentStatus.running) {
          const activeWorktrees = dbWorktrees.filter(wt => currentPaths.has(wt.path));
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
    for (const [projectId, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
  }
}

export default WorktreeScanner;
