# Project Health States Design (jump.sh)

## Problem

When clicking "start" on a project, the UI shows status as "running" once the Docker container starts, but the server inside may still be booting. This causes proxy errors when clicking the jump.sh link too early.

## Solution

Add a `health` state that tracks whether the server inside the container is actually responding, separate from whether the container is running.

## Health States

- `unknown` — initial/stopped state
- `starting` — container running, waiting for port to respond
- `healthy` — port responding to connections
- `unhealthy` — container running but port not responding after timeout

## Implementation

### 1. DockerManager Changes

Add to DockerManager:
```js
constructor(db) {
  this.db = db;
  this.healthStates = new Map();  // projectId -> 'unknown' | 'starting' | 'healthy' | 'unhealthy'
}
```

After `start()` succeeds:
1. Set `healthStates.set(id, 'starting')`
2. Call `_probeHealth(project, port)` (don't await — run in background)

New methods:
```js
async _probeHealth(project, port) {
  const id = project.id.toString();
  const maxAttempts = 120;  // 60 seconds at 500ms intervals
  
  for (let i = 0; i < maxAttempts; i++) {
    // Check if container died
    const status = await this.getStatus(project);
    if (!status.running) {
      this.healthStates.set(id, 'unknown');
      return;
    }
    
    if (await this._canConnect(port)) {
      this.healthStates.set(id, 'healthy');
      console.log(`✓ ${project.name} health check passed on port ${port}`);
      return;
    }
    
    await new Promise(r => setTimeout(r, 500));
  }
  
  this.healthStates.set(id, 'unhealthy');
  console.log(`✗ ${project.name} health check failed after 60s`);
}

async _canConnect(port) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    
    socket.connect(port, '127.0.0.1');
  });
}

getHealth(projectId) {
  return this.healthStates.get(projectId?.toString()) || 'unknown';
}
```

On stop: `this.healthStates.set(id, 'unknown')`

### 2. Server Routes Changes

Add health to all project responses:
- Dashboard `/` route
- Project detail `/projects/:id` route
- API `/api/projects` route
- Start response `/projects/:id/start`

Add new endpoint:
```js
app.get('/api/projects/:id', (req, res) => {
  // Return single project with health
});
```

### 3. UI Changes (project.ejs)

Status badge:
```html
<% const health = project.health || 'unknown'; %>
<span class="status status-<%= health %>">
  <%= health === 'starting' ? 'STARTING...' : 
      health === 'healthy' ? 'RUNNING' : 
      health === 'unhealthy' ? 'FAILED' : 
      project.status === 'running' ? 'RUNNING' : 'STOPPED' %>
</span>
```

Subdomain link — only clickable when healthy.

### 4. Client JS Changes

After clicking start, poll `/api/projects/:id` until `health !== 'starting'`:
- Update status badge in real-time
- Reload page once health resolves

### 5. CSS

```css
.status-starting { 
  color: orange; 
  animation: pulse 1s infinite; 
}
.status-healthy { color: green; }
.status-unhealthy { color: red; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
```

## Files to Modify

- `services/DockerManager.js` — health probing logic
- `server.js` — add health to responses, add /api/projects/:id endpoint
- `views/project.ejs` — status badge + conditional link
- `views/index.ejs` — status badge in project list
- `public/style.css` or inline styles — status-starting animation
