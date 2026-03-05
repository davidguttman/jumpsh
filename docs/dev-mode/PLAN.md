# Dev Mode Implementation Plan

Based on the design doc at `docs/plans/2026-03-04-dev-mode-design.md`.

## 1. MockDockerManager (`services/MockDockerManager.js`) — NEW FILE

Implements the same interface as `DockerManager` but simulates container lifecycle in-memory. No Docker daemon required.

### Interface to implement (from `DockerManager`):

```
constructor(db, opts)
start(project)             -> { success, status?, containerId?, error? }
stop(project)              -> { success, error? }
restart(project)           -> calls stop then start
cleanup(project)           -> { success }
getStatus(project)         -> { running, containers }
getPort(project)           -> number | null
getLogs(project, lines)    -> string
streamLogs(project, res)   -> child (returns SSE stream)
getComposeFile(project)    -> { composePath, isGenerated }
getBuildLog(project)       -> string | null
getHealth(projectId)       -> 'unknown' | 'starting' | 'healthy' | 'unhealthy'
getHealthWithProbe(project, status) -> health string
addStartupListener(projectId, callback) -> unsubscribe fn
getStartupStep(projectId)  -> step data | null
```

### Key design decisions:

- **In-memory state**: Use a `Map<projectId, { state, startedAt, port }>` for container state
- **Simulated delay**: Configurable `opts.delay` (default 500ms) for start/stop to feel realistic
- **Port assignment**: Use `project.assigned_port || 3000` — no real port binding
- **Health**: Immediately transition to `healthy` after simulated start delay (skip real TCP probe)
- **Startup events**: Emit the same step progression (1-5) as real DockerManager, with shorter delays
- **Logs**: Return canned log lines; `streamLogs` sends SSE events with fake periodic lines
- **`getComposeFile`**: Return `{ composePath: null, isGenerated: false }` (no compose files needed)
- **`getBuildLog`**: Return null (no build logs in mock mode)

### Skeleton:

```javascript
class MockDockerManager {
  constructor(db, opts = {}) {
    this.db = db
    this.simulatedDelay = opts.delay || 500
    this.containers = new Map()         // projectId -> { state, startedAt, port }
    this.healthStates = new Map()       // projectId -> health string
    this.startupListeners = new Map()   // projectId -> Set<callback>
    this.startupSteps = new Map()       // projectId -> current step data
    this._startingProjects = new Set()
  }
  // ... implement each method
}
```

The `_emitStartup`, `addStartupListener`, `getStartupStep`, `getHealth`, `getHealthWithProbe` methods can be copied directly from `DockerManager` since they don't touch Docker at all.

---

## 2. Test Fixture Apps (`test/fixtures/apps/`) — NEW DIRECTORIES

Each fixture is a minimal but valid project directory so `ProjectDetector.detectProjectType()` works on them.

### Fixtures to create:

| Directory | Key files | Detection target |
|-----------|-----------|-----------------|
| `node-npm-vite/` | `package.json` (scripts.dev: "vite"), `vite.config.js`, `index.html` | node/vite |
| `node-pnpm-next/` | `package.json`, `pnpm-lock.yaml`, `pages/index.js` | node/next |
| `python-fastapi/` | `requirements.txt` (fastapi, uvicorn), `main.py` | python/fastapi |
| `python-flask/` | `requirements.txt` (flask), `app.py` | python/flask |
| `static-html/` | `index.html`, `styles.css` | static |
| `docker-compose-custom/` | `docker-compose.yml` | docker-compose |

Skip `node-yarn-express`, `python-django`, and `monorepo-turbo` for now — can add later. Start with 6 representative fixtures.

### File contents:

Each fixture needs the minimum files for detection. For example:

**`node-npm-vite/package.json`:**
```json
{
  "name": "fixture-vite",
  "scripts": { "dev": "vite" },
  "devDependencies": { "vite": "^5.0.0" }
}
```

**`python-fastapi/requirements.txt`:**
```
fastapi
uvicorn
```

**`python-fastapi/main.py`:**
```python
from fastapi import FastAPI
app = FastAPI()

@app.get("/")
def root():
    return {"message": "hello"}
```

---

## 3. Dev Mode Detection & Initialization (`server.js`) — MODIFY

### Detection (near top of `server.js`, after config):

```javascript
const devMode = process.env.JUMPSH_DEV_MODE === 'true' ||
                process.env.JUMPSH_DEV_MODE === '1';
config.devMode = devMode;
```

### Service initialization change (line ~96):

```javascript
// Current:
const docker = new DockerManager(db);

// New:
import MockDockerManager from './services/MockDockerManager.js';

const docker = devMode
  ? new MockDockerManager(db)
  : new DockerManager(db);
```

### Fixture loading (after `server.listen` callback, line ~816):

Add a new function `initDevMode()` that:

1. Reads `test/fixtures/apps/` directory
2. For each fixture dir, calls `db.createProject()` with `is_fixture: true` flag (or a naming convention like `fixture-{name}`)
3. Skips fixtures that already exist in the database (check by path)
4. Optionally auto-starts all fixtures via `docker.start()`

```javascript
async function initDevMode() {
  const fixturesDir = path.join(__dirname, 'test/fixtures/apps');
  const fixtures = fs.readdirSync(fixturesDir);

  for (const name of fixtures) {
    const fixturePath = path.join(fixturesDir, name);
    if (!fs.statSync(fixturePath).isDirectory()) continue;

    // Skip if already registered
    const existing = await new Promise(resolve => {
      db.getProjectByPath(fixturePath, (err, p) => resolve(p));
    });
    if (existing) continue;

    await new Promise((resolve, reject) => {
      db.createProject({
        name: `fixture-${name}`,
        path: fixturePath,
        description: `[fixture] Test fixture app`,
      }, (err) => err ? reject(err) : resolve());
    });
  }

  console.log(`[dev] Loaded ${fixtures.length} fixture apps`);
}
```

Call it inside `server.listen()` callback:
```javascript
if (devMode) {
  await initDevMode();
}
```

### Startup banner change:

Show `[DEV MODE]` in the startup banner when `devMode` is true.

---

## 4. SubdomainProxy Changes (`services/SubdomainProxy.js`) — MODIFY

### Problem:
When a mock container is "running", `docker.getPort()` returns a port, but nothing is actually listening. The proxy will get ECONNREFUSED.

### Solution:
Add a mock response path. When `config.devMode` is true and the docker manager is a MockDockerManager, serve a placeholder page instead of proxying.

### Changes:

Add `config` awareness to the middleware. In the `middleware()` method, after getting the port:

```javascript
// After line 39: const port = await this.docker.getPort(project);
// Add:
if (this.config.devMode && port) {
  const detection = detectProjectType(project.path);
  return res.send(`
    <html>
      <head><title>${project.name} - Mock</title></head>
      <body style="font-family: system-ui; padding: 2rem; max-width: 600px; margin: 0 auto;">
        <h1>${project.name}</h1>
        <p><strong>Mock container running</strong> (dev mode)</p>
        <table style="border-collapse: collapse;">
          <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Type</td><td>${detection.type || 'unknown'}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Framework</td><td>${detection.framework || 'none'}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Path</td><td><code>${project.path}</code></td></tr>
          <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Port</td><td>${port}</td></tr>
        </table>
      </body>
    </html>
  `);
}
```

Import `detectProjectType` at the top of SubdomainProxy.js.

---

## 5. Dashboard UI Changes — MODIFY

### Files to modify:

**`views/index.ejs`:**
- After the project name span (line 55), add a fixture badge:
```ejs
<% if (project.name.startsWith('fixture-')) { %>
  <span class="badge badge-fixture">fixture</span>
<% } %>
```

- Show a dev mode banner at the top when `config.devMode`:
```ejs
<% if (config.devMode) { %>
  <div class="dev-mode-banner">DEV MODE - Using mock containers</div>
<% } %>
```

**`public/styles.css`:**
- Add `.badge-fixture` styles (small, muted tag)
- Add `.dev-mode-banner` styles (yellow/orange bar at top)

**`views/partials/_detail_fragment.ejs`** (or `_project_detail.ejs`):
- Show fixture indicator in project detail view
- Optionally hide "Delete" button for fixture projects, or add confirmation

### Pass `devMode` to templates:

In `server.js`, the `config` object already gets passed to templates. Since we add `config.devMode = devMode`, templates can check `config.devMode`.

---

## 6. Database Considerations

### No schema changes needed.

Fixture projects use the existing `projects` schema. They are distinguished by:
- Naming convention: `fixture-{name}` prefix
- Path: under `test/fixtures/apps/`

### `is_fixture` flag (optional):

Could add an `is_fixture` field to project records, but a naming convention is simpler and avoids a migration. If needed later, can add it.

### Cleanup on shutdown:

In dev mode, optionally remove fixture projects from the database on shutdown so they get re-created fresh next time. Or leave them persistent — re-creation skips existing ones anyway (checked by path).

---

## 7. Testing Strategy

### Unit tests for MockDockerManager:

**`test/MockDockerManager.test.js`** — NEW FILE

```javascript
// Test that MockDockerManager implements the same interface:
- start() returns { success: true, status }
- stop() transitions state to stopped
- getStatus() reflects current state
- getPort() returns assigned_port when running, null when stopped
- getLogs() returns canned lines
- getHealth() / getHealthWithProbe() return correct states
- addStartupListener() receives step events during start
- cleanup() resets state
```

### Integration test for dev mode initialization:

**`test/dev-mode.test.js`** — NEW FILE

```javascript
// Test fixture loading:
- Fixtures are loaded from test/fixtures/apps/
- Each fixture creates a project in the database
- Duplicate fixtures are skipped
- MockDockerManager is used instead of DockerManager

// Test SubdomainProxy mock response:
- When devMode is true, proxy serves placeholder HTML
- Placeholder includes project info and detection results
```

### Manual testing:

1. Run `JUMPSH_DEV_MODE=true npm run dev`
2. Visit dashboard — should show fixture projects with `[fixture]` badge
3. Start a fixture project — should complete quickly (mock delay)
4. Visit fixture's subdomain URL — should see placeholder page
5. Stop/restart should work normally
6. Logs should show mock log lines

---

## 8. File Summary

### New files:
| File | Purpose |
|------|---------|
| `services/MockDockerManager.js` | Mock implementation of DockerManager |
| `test/fixtures/apps/node-npm-vite/package.json` | Vite fixture |
| `test/fixtures/apps/node-npm-vite/vite.config.js` | |
| `test/fixtures/apps/node-npm-vite/index.html` | |
| `test/fixtures/apps/node-pnpm-next/package.json` | Next.js fixture |
| `test/fixtures/apps/node-pnpm-next/pnpm-lock.yaml` | |
| `test/fixtures/apps/node-pnpm-next/pages/index.js` | |
| `test/fixtures/apps/python-fastapi/requirements.txt` | FastAPI fixture |
| `test/fixtures/apps/python-fastapi/main.py` | |
| `test/fixtures/apps/python-flask/requirements.txt` | Flask fixture |
| `test/fixtures/apps/python-flask/app.py` | |
| `test/fixtures/apps/static-html/index.html` | Static HTML fixture |
| `test/fixtures/apps/static-html/styles.css` | |
| `test/fixtures/apps/docker-compose-custom/docker-compose.yml` | Compose fixture |
| `test/MockDockerManager.test.js` | Unit tests |
| `test/dev-mode.test.js` | Integration tests |

### Modified files:
| File | Changes |
|------|---------|
| `server.js` | Dev mode detection, conditional MockDockerManager, fixture loading, banner |
| `services/SubdomainProxy.js` | Mock placeholder page when devMode + mock running |
| `views/index.ejs` | Fixture badge, dev mode banner |
| `public/styles.css` | Badge and banner styles |

---

## 9. Implementation Order

1. **MockDockerManager** — core mock class with all interface methods
2. **Test fixtures** — create minimal app directories
3. **server.js changes** — detection, conditional import, fixture loading
4. **SubdomainProxy changes** — placeholder page for mock containers
5. **Dashboard UI** — fixture badge, dev mode banner
6. **Tests** — unit + integration
7. **Manual verification** — run with `JUMPSH_DEV_MODE=true`
