import sqlite3 from 'sqlite3';
import getPort from 'get-port';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class Database {
  constructor() {
    const dataDir = path.join(os.homedir(), '.jump.sh');
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'projects.db');

    this._ready = new Promise((resolve, reject) => {
      this.db = new (sqlite3.verbose().Database)(dbPath, (err) => {
        if (err) {
          console.error('Error opening database:', err.message);
          return reject(err);
        }
        this.db.run('PRAGMA journal_mode=WAL', () => {
          this.init(() => resolve());
        });
      });
    });
  }

  /** Wait for the database to be fully initialized. */
  ready() {
    return this._ready;
  }

  init(done) {
    // Projects table - minimal, Docker is source of truth for status
    this.db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL,
        subdomain TEXT UNIQUE,
        description TEXT,
        parent_project_id INTEGER REFERENCES projects(id),
        is_worktree BOOLEAN DEFAULT 0,
        branch_name TEXT,
        assigned_port INTEGER,
        override_build_command TEXT,
        override_start_command TEXT,
        override_port INTEGER,
        override_docker_image TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, () => {
      // Migration: add assigned_port if table already exists without it
      this.db.run('ALTER TABLE projects ADD COLUMN assigned_port INTEGER', () => {
        // Silently ignore "duplicate column" error
        // Migration: add command override columns
        this.db.run('ALTER TABLE projects ADD COLUMN override_build_command TEXT', () => {
          this.db.run('ALTER TABLE projects ADD COLUMN override_start_command TEXT', () => {
            this.db.run('ALTER TABLE projects ADD COLUMN override_port INTEGER', () => {
              this.db.run('ALTER TABLE projects ADD COLUMN override_docker_image TEXT', () => {
                done();
              });
            });
          });
        });
      });
    });
  }

  // Port allocation: prefer deterministic range starting at 10000,
  // exclude DB-assigned ports, let get-port verify host availability.
  // When primary range is exhausted, extends to overflow range with a notice.
  static PORT_RANGE_START = 10000;
  static PORT_RANGE_END = 10999;
  static PORT_OVERFLOW_END = 11999;

  getNextPort(callback) {
    this.db.all(
      'SELECT assigned_port FROM projects WHERE assigned_port IS NOT NULL ORDER BY assigned_port',
      async (err, rows) => {
        if (err) return callback(err);

        const usedPorts = new Set((rows || []).map(r => r.assigned_port));
        const exclude = new Set(usedPorts);

        try {
          let candidates = this.constructor.makePortRange(usedPorts, Database.PORT_RANGE_START, Database.PORT_RANGE_END);
          let extended = false;

          if (candidates.length === 0) {
            candidates = this.constructor.makePortRange(usedPorts, Database.PORT_RANGE_END + 1, Database.PORT_OVERFLOW_END);
            extended = true;
            if (candidates.length === 0) {
              return callback(new Error(
                `No free port in range ${Database.PORT_RANGE_START}-${Database.PORT_OVERFLOW_END}`
              ));
            }
          }

          const port = await getPort({ port: candidates, exclude });
          if (port < Database.PORT_RANGE_START || port > Database.PORT_OVERFLOW_END) {
            return callback(new Error(
              `No free port in range ${Database.PORT_RANGE_START}-${Database.PORT_OVERFLOW_END}`
            ));
          }

          if (extended) {
            console.log(`Notice: Primary port range (10000-10999) exhausted, using overflow range (11000-11999).`);
          }

          callback(null, port);
        } catch (e) {
          callback(e);
        }
      }
    );
  }

  /** Release a project's assigned port back to the pool. */
  releasePort(projectId, callback) {
    this.db.run('UPDATE projects SET assigned_port = NULL WHERE id = ?', [projectId], callback);
  }

  // Generate candidate ports within a given range, skipping used ports
  static makePortRange(usedPorts, start, end) {
    const candidates = [];
    for (let p = start; p <= end && candidates.length < 100; p++) {
      if (!usedPorts.has(p)) candidates.push(p);
    }
    return candidates;
  }

  // Project CRUD
  createProject(project, callback) {
    const { name, path, subdomain, description, parent_project_id, is_worktree, branch_name } = project;
    this.db.run(
      `INSERT INTO projects (name, path, subdomain, description, parent_project_id, is_worktree, branch_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, path, subdomain || name.toLowerCase().replace(/[^a-z0-9]/g, '-'), description, parent_project_id, is_worktree ? 1 : 0, branch_name],
      function(err) {
        callback(err, this?.lastID);
      }
    );
  }

  getProject(id, callback) {
    this.db.get('SELECT * FROM projects WHERE id = ?', [id], callback);
  }

  getProjectBySubdomain(subdomain, callback) {
    this.db.get('SELECT * FROM projects WHERE subdomain = ?', [subdomain.toLowerCase()], callback);
  }

  getProjectByName(name, callback) {
    this.db.get('SELECT * FROM projects WHERE name = ? AND is_worktree = 0', [name], callback);
  }

  getProjectByPath(projectPath, callback) {
    this.db.get('SELECT * FROM projects WHERE path = ?', [projectPath], callback);
  }

  findProject(nameOrSubdomain, callback) {
    this.getProjectByName(nameOrSubdomain, (err, project) => {
      if (err) return callback(err);
      if (project) return callback(null, project);
      this.getProjectBySubdomain(nameOrSubdomain, callback);
    });
  }

  getAllProjects(callback) {
    this.db.all('SELECT * FROM projects WHERE is_worktree = 0 ORDER BY name', callback);
  }

  getAllProjectsIncludingWorktrees(callback) {
    this.db.all('SELECT * FROM projects ORDER BY parent_project_id NULLS FIRST, name', callback);
  }

  getWorktreesForProject(projectId, callback) {
    this.db.all('SELECT * FROM projects WHERE parent_project_id = ? ORDER BY name', [projectId], callback);
  }

  updateProject(id, updates, callback) {
    const fields = [];
    const values = [];
    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    
    this.db.run(
      `UPDATE projects SET ${fields.join(', ')} WHERE id = ?`,
      values,
      callback
    );
  }

  deleteProject(id, callback) {
    // Delete worktrees first
    this.db.run('DELETE FROM projects WHERE parent_project_id = ?', [id], (err) => {
      if (err) return callback(err);
      this.db.run('DELETE FROM projects WHERE id = ?', [id], callback);
    });
  }

  // Worktree management
  upsertWorktree(worktree, callback) {
    const { name, path, subdomain, parent_project_id, branch_name } = worktree;
    this.db.run(
      `INSERT INTO projects (name, path, subdomain, parent_project_id, is_worktree, branch_name)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(name) DO UPDATE SET
         path = excluded.path,
         subdomain = excluded.subdomain,
         branch_name = excluded.branch_name,
         updated_at = CURRENT_TIMESTAMP`,
      [name, path, subdomain, parent_project_id, branch_name],
      callback
    );
  }

  deleteWorktree(path, callback) {
    this.db.run('DELETE FROM projects WHERE path = ? AND is_worktree = 1', [path], callback);
  }

  close(callback) {
    this.db.close(callback || (() => {}));
  }
}

export default Database;
