import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class Database {
  constructor() {
    const dbPath = path.join(__dirname, 'localhaus.db');
    this.db = new (sqlite3.verbose().Database)(dbPath, (err) => {
      if (err) {
        console.error('Error opening database:', err.message);
      } else {
        console.log('Connected to SQLite database');
        this.init();
      }
    });
  }

  init() {
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
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
}

export default Database;
