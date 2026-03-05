# Dev Mode: Mock Docker + Test Fixtures

**Date:** 2026-03-04
**Status:** Draft

## Problem

When developing Jump SH features in worktrees, agents need to test their changes via Jump SH URLs (`jumpsh--feature-branch.davidguttman.jump.sh`). But Jump SH manages Docker containers, and Docker can't run inside Docker without special configuration.

Most feature development doesn't need real containers—it needs the UI, detection, and management flows to work.

## Solution

Add a **dev mode** that:
1. Swaps `DockerManager` for `MockDockerManager` (simulates container lifecycle)
2. Pre-loads fixture apps of various types for realistic testing
3. Optionally binds a different port to coexist with production instance

## Activation

```bash
# Environment variable
JUMPSH_DEV_MODE=true npm run dev

# Or CLI flag
jump.sh --dev

# Or auto-detect when DOCKER_HOST is unavailable
```

## MockDockerManager

Same interface as `DockerManager`, returns simulated responses:

```javascript
class MockDockerManager {
  constructor(opts = {}) {
    this.containers = new Map() // projectId → simulated state
    this.simulatedDelay = opts.delay || 500
  }

  async start(project) {
    await this.delay()
    this.containers.set(project.id, {
      state: 'running',
      startedAt: new Date(),
      port: project.port || 3000
    })
    return { success: true, containerId: `mock-${project.id}-${Date.now()}` }
  }

  async stop(project) {
    await this.delay()
    const container = this.containers.get(project.id)
    if (container) container.state = 'stopped'
    return { success: true }
  }

  async getStatus(project) {
    const container = this.containers.get(project.id)
    return container?.state || 'stopped'
  }

  async streamLogs(project, onData) {
    // Emit fake log lines periodically
    const lines = [
      '[mock] Server starting...',
      '[mock] Loaded configuration',
      '[mock] Listening on port ' + (project.port || 3000),
      '[mock] Ready for connections'
    ]
    for (const line of lines) {
      await this.delay(200)
      onData(line + '\n')
    }
    // Then emit periodic heartbeat logs
    const interval = setInterval(() => {
      onData(`[mock] ${new Date().toISOString()} heartbeat\n`)
    }, 5000)
    return () => clearInterval(interval)
  }

  delay(ms) {
    return new Promise(r => setTimeout(r, ms || this.simulatedDelay))
  }
}
```

## Test Fixture Apps

Directory: `test/fixtures/apps/`

Each fixture is a minimal but real project structure so detection actually runs:

```
test/fixtures/apps/
├── node-npm-vite/
│   ├── package.json        # { "scripts": { "dev": "vite" } }
│   ├── vite.config.js
│   └── index.html
│
├── node-pnpm-next/
│   ├── package.json
│   ├── pnpm-lock.yaml
│   └── pages/index.js
│
├── node-yarn-express/
│   ├── package.json
│   ├── yarn.lock
│   └── server.js
│
├── python-fastapi/
│   ├── requirements.txt    # fastapi, uvicorn
│   └── main.py
│
├── python-flask/
│   ├── requirements.txt
│   └── app.py
│
├── python-django/
│   ├── requirements.txt
│   ├── manage.py
│   └── mysite/settings.py
│
├── static-html/
│   ├── index.html
│   └── styles.css
│
├── docker-compose-custom/
│   └── docker-compose.yml  # pre-existing compose file
│
└── monorepo-turbo/
    ├── package.json
    ├── turbo.json
    └── apps/
        └── web/package.json
```

## Dev Mode Initialization

On startup with dev mode enabled:

```javascript
async function initDevMode(server) {
  // 1. Swap Docker manager
  server.dockerManager = new MockDockerManager()

  // 2. Auto-register fixture apps
  const fixturesDir = path.join(__dirname, '../test/fixtures/apps')
  const fixtures = await fs.readdir(fixturesDir)
  
  for (const name of fixtures) {
    const fixturePath = path.join(fixturesDir, name)
    await server.addProject({
      name: `fixture-${name}`,
      path: fixturePath,
      isFixture: true  // flag to distinguish from real projects
    })
  }

  console.log(`[dev] Loaded ${fixtures.length} fixture apps`)
}
```

## Subdomain Proxy in Dev Mode

The `SubdomainProxy` needs to handle mock containers. Options:

### Option A: Serve a placeholder page
For mock containers, serve a static "Mock App Running" page with project info.

### Option B: Proxy to a single dev server
If fixture apps have actual runnable code, start ONE real dev server and proxy all fixtures to it.

### Option C: Port mapping file
Each fixture can have a `.devport` file specifying a real port if the developer wants to run it manually.

**Recommendation:** Start with Option A (placeholder page), add Option C for advanced use.

```javascript
// In SubdomainProxy
if (devMode && mockDockerManager.isRunning(project)) {
  return res.send(`
    <html>
      <body style="font-family: system-ui; padding: 2rem;">
        <h1>🦘 ${project.name}</h1>
        <p>Mock container running</p>
        <pre>${JSON.stringify(project, null, 2)}</pre>
      </body>
    </html>
  `)
}
```

## UI Considerations

- Dashboard shows fixture apps with a badge: `[fixture]`
- Fixture apps can't be deleted (or require confirmation)
- "Add Project" in dev mode could default to fixtures directory as root folder
- Status indicators work normally (green = mock running, etc.)

## Benefits

1. **Agents can develop Jump SH features** without Docker-in-Docker complexity
2. **Faster iteration** — no container build/start delays
3. **Better testability** — MockDockerManager can be used in automated tests
4. **Offline development** — works without Docker daemon running
5. **CI-friendly** — tests can run in environments without Docker

## Implementation Steps

1. Create `MockDockerManager` class with same interface as `DockerManager`
2. Add `JUMPSH_DEV_MODE` detection in server startup
3. Create fixture app directories with minimal real files
4. Wire up dev mode initialization
5. Update `SubdomainProxy` to serve placeholder for mock containers
6. Add `[fixture]` badge to dashboard UI
7. Document in README

## Open Questions

- Should dev mode auto-start all fixtures, or require manual start?
- Should fixtures persist in database or be ephemeral?
- Add a "reset fixtures" button to dashboard?
