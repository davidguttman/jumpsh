import { JSONFilePreset } from 'lowdb/node';
import getPort from 'get-port';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = path.join(os.homedir(), '.jump.sh');
const DB_PATH = path.join(DATA_DIR, 'projects.json');

const DEFAULT_DATA = { nextId: 1, projects: [] };

class Database {
  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this._ready = JSONFilePreset(DB_PATH, DEFAULT_DATA).then(db => {
      this.db = db;
    });
  }

  ready() {
    return this._ready;
  }

  _write() {
    return this.db.write();
  }

  // Port allocation
  static PORT_RANGE_START = 10000;
  static PORT_RANGE_END = 10999;
  static PORT_OVERFLOW_END = 11999;

  getNextPort(callback) {
    try {
      const usedPorts = new Set(
        this.db.data.projects
          .filter(p => p.assigned_port != null)
          .map(p => p.assigned_port)
      );
      const exclude = new Set(usedPorts);

      let candidates = Database.makePortRange(usedPorts, Database.PORT_RANGE_START, Database.PORT_RANGE_END);
      let extended = false;

      if (candidates.length === 0) {
        candidates = Database.makePortRange(usedPorts, Database.PORT_RANGE_END + 1, Database.PORT_OVERFLOW_END);
        extended = true;
        if (candidates.length === 0) {
          return callback(new Error(
            `No free port in range ${Database.PORT_RANGE_START}-${Database.PORT_OVERFLOW_END}`
          ));
        }
      }

      getPort({ port: candidates, exclude }).then(port => {
        if (port < Database.PORT_RANGE_START || port > Database.PORT_OVERFLOW_END) {
          return callback(new Error(
            `No free port in range ${Database.PORT_RANGE_START}-${Database.PORT_OVERFLOW_END}`
          ));
        }
        if (extended) {
          console.log('Notice: Primary port range (10000-10999) exhausted, using overflow range (11000-11999).');
        }
        callback(null, port);
      }).catch(e => callback(e));
    } catch (e) {
      callback(e);
    }
  }

  releasePort(projectId, callback) {
    const project = this.db.data.projects.find(p => p.id === projectId);
    if (project) {
      project.assigned_port = null;
      this._write().then(() => callback(null)).catch(callback);
    } else {
      callback(null);
    }
  }

  static makePortRange(usedPorts, start, end) {
    const candidates = [];
    for (let p = start; p <= end && candidates.length < 100; p++) {
      if (!usedPorts.has(p)) candidates.push(p);
    }
    return candidates;
  }

  // Project CRUD
  createProject(project, callback) {
    const now = new Date().toISOString();
    const id = this.db.data.nextId++;
    const record = {
      id,
      name: project.name,
      path: project.path,
      subdomain: project.subdomain || project.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
      description: project.description || null,
      parent_project_id: project.parent_project_id || null,
      is_worktree: project.is_worktree ? 1 : 0,
      branch_name: project.branch_name || null,
      assigned_port: null,
      override_build_command: project.override_build_command || null,
      override_start_command: project.override_start_command || null,
      override_port: project.override_port || null,
      override_docker_image: project.override_docker_image || null,
      created_at: now,
      updated_at: now,
    };
    this.db.data.projects.push(record);
    this._write().then(() => callback(null, id)).catch(callback);
  }

  getProject(id, callback) {
    const project = this.db.data.projects.find(p => p.id === id) || null;
    callback(null, project);
  }

  getProjectBySubdomain(subdomain, callback) {
    const s = subdomain.toLowerCase();
    const project = this.db.data.projects.find(p => p.subdomain === s) || null;
    callback(null, project);
  }

  getProjectByName(name, callback) {
    const project = this.db.data.projects.find(p => p.name === name && !p.is_worktree) || null;
    callback(null, project);
  }

  getProjectByPath(projectPath, callback) {
    const project = this.db.data.projects.find(p => p.path === projectPath) || null;
    callback(null, project);
  }

  findProject(nameOrSubdomain, callback) {
    this.getProjectByName(nameOrSubdomain, (err, project) => {
      if (err) return callback(err);
      if (project) return callback(null, project);
      this.getProjectBySubdomain(nameOrSubdomain, callback);
    });
  }

  getAllProjects(callback) {
    const projects = this.db.data.projects
      .filter(p => !p.is_worktree)
      .sort((a, b) => a.name.localeCompare(b.name));
    callback(null, projects);
  }

  getAllProjectsIncludingWorktrees(callback) {
    const projects = [...this.db.data.projects].sort((a, b) => {
      const aParent = a.parent_project_id ?? -Infinity;
      const bParent = b.parent_project_id ?? -Infinity;
      if (aParent !== bParent) return aParent - bParent;
      return a.name.localeCompare(b.name);
    });
    callback(null, projects);
  }

  getWorktreesForProject(projectId, callback) {
    const worktrees = this.db.data.projects
      .filter(p => p.parent_project_id === projectId)
      .sort((a, b) => a.name.localeCompare(b.name));
    callback(null, worktrees);
  }

  updateProject(id, updates, callback) {
    const project = this.db.data.projects.find(p => p.id === id);
    if (!project) return callback(null);
    Object.assign(project, updates, { updated_at: new Date().toISOString() });
    this._write().then(() => callback(null)).catch(callback);
  }

  deleteProject(id, callback) {
    // Delete worktrees first, then the project
    this.db.data.projects = this.db.data.projects.filter(
      p => p.parent_project_id !== id && p.id !== id
    );
    this._write().then(() => callback(null)).catch(callback);
  }

  // Worktree management
  upsertWorktree(worktree, callback) {
    const { name, path, subdomain, parent_project_id, branch_name } = worktree;
    const existing = this.db.data.projects.find(p => p.name === name);
    if (existing) {
      existing.path = path;
      existing.subdomain = subdomain;
      existing.branch_name = branch_name;
      existing.updated_at = new Date().toISOString();
    } else {
      const now = new Date().toISOString();
      const id = this.db.data.nextId++;
      this.db.data.projects.push({
        id,
        name,
        path,
        subdomain,
        description: null,
        parent_project_id,
        is_worktree: 1,
        branch_name,
        assigned_port: null,
        override_build_command: null,
        override_start_command: null,
        override_port: null,
        override_docker_image: null,
        created_at: now,
        updated_at: now,
      });
    }
    this._write().then(() => callback(null)).catch(callback);
  }

  deleteWorktree(path, callback) {
    this.db.data.projects = this.db.data.projects.filter(
      p => !(p.path === path && p.is_worktree)
    );
    this._write().then(() => callback(null)).catch(callback);
  }

  close(callback) {
    if (callback) callback();
  }
}

export default Database;
