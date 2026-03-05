const TOTAL_STEPS = 5;
const STEP_LABELS = {
  1: 'Building image...',
  2: 'Creating container...',
  3: 'Starting container...',
  4: 'Waiting for health check...',
  5: 'Ready!'
};

class MockDockerManager {
  constructor(db, opts = {}) {
    this.db = db;
    this.isMock = true;
    this.simulatedDelay = opts.delay ?? 500;
    this.containers = new Map();
    this.healthStates = new Map();
    this.startupListeners = new Map();
    this.startupSteps = new Map();
    this._startingProjects = new Set();
    this._opTokens = new Map(); // projectId -> token for cancelling stale timers
  }

  _emitStartup(projectId, data) {
    const id = projectId.toString();
    this.startupSteps.set(id, data);
    const listeners = this.startupListeners.get(id);
    if (listeners) {
      for (const cb of listeners) cb(data);
    }
    if (data.done) {
      this.startupSteps.delete(id);
    }
  }

  addStartupListener(projectId, callback) {
    const id = projectId.toString();
    if (!this.startupListeners.has(id)) {
      this.startupListeners.set(id, new Set());
    }
    this.startupListeners.get(id).add(callback);
    return () => {
      const set = this.startupListeners.get(id);
      if (set) {
        set.delete(callback);
        if (set.size === 0) this.startupListeners.delete(id);
      }
    };
  }

  getStartupStep(projectId) {
    return this.startupSteps.get(projectId?.toString()) || null;
  }

  getHealth(projectId) {
    return this.healthStates.get(projectId?.toString()) || 'unknown';
  }

  getHealthWithProbe(project, status) {
    const idStr = project.id.toString();
    const health = this.getHealth(project.id);
    if (health === 'unknown' && status.running) {
      // Mirror DockerManager: set starting, emit step 4, then async transition
      this.healthStates.set(idStr, 'starting');
      this._emitStartup(project.id, { step: 4, totalSteps: TOTAL_STEPS, label: STEP_LABELS[4] });
      // Capture current op token so we can detect stale transitions
      const token = this._opTokens.get(idStr);
      // Async transition to healthy — guarded by token + container state
      this._delay(Math.floor(this.simulatedDelay / 2)).then(() => {
        if (this._opTokens.get(idStr) !== token) return;
        const container = this.containers.get(idStr);
        if (!container || container.state !== 'running') return;
        this.healthStates.set(idStr, 'healthy');
        this._emitStartup(project.id, { step: 5, totalSteps: TOTAL_STEPS, label: STEP_LABELS[5], done: true });
      });
      return 'starting';
    }
    return health;
  }

  _delay(ms) {
    return new Promise(r => setTimeout(r, ms ?? this.simulatedDelay));
  }

  _newOpToken(projectId) {
    const token = {};
    this._opTokens.set(projectId, token);
    return token;
  }

  _isCurrentOp(projectId, token) {
    return this._opTokens.get(projectId) === token;
  }

  async start(project) {
    const idStr = project.id.toString();

    if (this._startingProjects.has(idStr)) {
      return { success: false, error: 'Already starting', alreadyStarting: true };
    }
    this._startingProjects.add(idStr);
    const token = this._newOpToken(idStr);

    try {
      this.healthStates.set(idStr, 'starting');
      const port = project.assigned_port || 3000;

      for (let step = 1; step <= 4; step++) {
        if (!this._isCurrentOp(idStr, token)) {
          return { success: false, error: 'Operation cancelled' };
        }
        this._emitStartup(project.id, { step, totalSteps: TOTAL_STEPS, label: STEP_LABELS[step] });
        await this._delay(Math.floor(this.simulatedDelay / 4));
      }

      if (!this._isCurrentOp(idStr, token)) {
        return { success: false, error: 'Operation cancelled' };
      }

      this.containers.set(idStr, {
        state: 'running',
        startedAt: new Date(),
        port
      });

      this.healthStates.set(idStr, 'healthy');
      this._emitStartup(project.id, { step: 5, totalSteps: TOTAL_STEPS, label: STEP_LABELS[5], done: true });

      return {
        success: true,
        status: { running: true, containers: [{ State: 'running', Name: `mock-${project.name}` }] }
      };
    } finally {
      this._startingProjects.delete(idStr);
    }
  }

  async stop(project) {
    const idStr = project.id.toString();
    this._newOpToken(idStr); // cancel any in-flight start
    await this._delay(Math.floor(this.simulatedDelay / 4));
    const container = this.containers.get(idStr);
    if (container) container.state = 'stopped';
    this.healthStates.set(idStr, 'unknown');
    this._emitStartup(project.id, { error: 'Project stopped', done: true });
    return { success: true };
  }

  async restart(project) {
    await this.stop(project);
    return this.start(project);
  }

  async cleanup(project) {
    const idStr = project.id.toString();
    this._newOpToken(idStr);
    this.containers.delete(idStr);
    this.healthStates.delete(idStr);
    return { success: true };
  }

  async getStatus(project) {
    const container = this.containers.get(project.id.toString());
    if (container && container.state === 'running') {
      return {
        running: true,
        containers: [{ State: 'running', Name: `mock-${project.name}` }]
      };
    }
    return { running: false, containers: [] };
  }

  async getPort(project) {
    const container = this.containers.get(project.id.toString());
    if (container && container.state === 'running') {
      return container.port;
    }
    return null;
  }

  async getLogs(project, lines = 100) {
    const container = this.containers.get(project.id.toString());
    if (!container) return '';
    const logLines = [
      `[mock] Server starting...`,
      `[mock] Loaded configuration for ${project.name}`,
      `[mock] Listening on port ${container.port}`,
      `[mock] Ready for connections`
    ];
    return logLines.slice(0, lines).join('\n');
  }

  streamLogs(project, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const lines = [
      `[mock] Server starting...`,
      `[mock] Loaded configuration for ${project.name}`,
      `[mock] Listening on port ${project.assigned_port || 3000}`,
      `[mock] Ready for connections`
    ];

    let i = 0;
    let closed = false;
    const sendLine = () => {
      if (closed) return;
      if (i < lines.length) {
        res.write(`data: ${JSON.stringify({ line: lines[i] })}\n\n`);
        i++;
      } else {
        res.write(`data: ${JSON.stringify({ line: `[mock] ${new Date().toISOString()} heartbeat` })}\n\n`);
      }
    };

    const interval = setInterval(sendLine, 1000);
    sendLine();

    const cleanup = () => {
      closed = true;
      clearInterval(interval);
    };

    res.on('close', cleanup);

    // Return child-like handle compatible with DockerManager callers
    return { kill: cleanup };
  }

  getComposeFile(_project) {
    return { composePath: null, isGenerated: false };
  }

  getBuildLog(_project) {
    return null;
  }
}

export default MockDockerManager;
