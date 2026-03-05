# Test Coverage Expansion — Implementation Plan

**Issue**: #4
**Branch**: `test-coverage-expansion`
**Runner**: `node --test test/*.test.js` (Node built-in, ESM)
**Assertions**: `node:assert/strict`
**Pattern**: tmpdir fixtures, manual DI mocks, `?t=N` cache-busting for env-sensitive re-imports

---

## Phase 1: ProjectDetector Unit Tests (Priority 1)

**File**: `test/project-detector.test.js` (extend existing)

### New test cases

#### Framework detection
| Test | Fixture | Assert |
|------|---------|--------|
| Next.js via dependency | `{ dependencies: { next: '*' } }` | `framework === 'next'`, `type === 'node'` |
| Nuxt via dependency | `{ dependencies: { nuxt: '*' } }` | `framework === 'nuxt'` |
| Remix via dependency | `{ dependencies: { '@remix-run/dev': '*' } }` | `framework === 'remix'` or detected correctly |
| SvelteKit via dependency | `{ devDependencies: { '@sveltejs/kit': '*' } }` | `framework === 'sveltekit'` or correct detection |
| Vite via dependency | `{ dependencies: { vite: '*' } }` | `framework === 'vite'` |
| Astro via dependency | `{ dependencies: { astro: '*' } }` | `framework === 'astro'` |
| Express detection | `{ dependencies: { express: '*' }, scripts: { start: 'node server.js' } }` | `type === 'node'`, no framework or `framework === null` |
| Fastify detection | `{ dependencies: { fastify: '*' }, scripts: { start: 'node server.js' } }` | `type === 'node'` |

#### Package managers
| Test | Fixture | Assert |
|------|---------|--------|
| bun (bun.lockb) | `package.json` + touch `bun.lockb` | `packageManager.name === 'bun'` |
| bun (bun.lock) | `package.json` + touch `bun.lock` | `packageManager.name === 'bun'` |
| pnpm | `package.json` + touch `pnpm-lock.yaml` | `packageManager.name === 'pnpm'` |
| yarn | `package.json` + touch `yarn.lock` | `packageManager.name === 'yarn'` |
| npm (default) | `package.json` + touch `package-lock.json` | `packageManager.name === 'npm'` |
| npm (no lockfile) | `package.json` only | `packageManager.name === 'npm'` |

#### Python projects
| Test | Fixture | Assert |
|------|---------|--------|
| Flask via requirements.txt | `requirements.txt` with `flask` | `type === 'python'`, `framework === 'flask'` |
| FastAPI via requirements.txt | `requirements.txt` with `fastapi` | `type === 'python'`, `framework === 'fastapi'` |
| Django via requirements.txt | `requirements.txt` with `django` | `type === 'python'`, `framework === 'django'` |
| Python via pyproject.toml | `pyproject.toml` (minimal) | `type === 'python'` |
| Flask edge: case insensitive | `requirements.txt` with `Flask` | Still detects flask |

#### Ruby projects
| Test | Fixture | Assert |
|------|---------|--------|
| Rails via Gemfile | `Gemfile` with `gem 'rails'` | `type === 'ruby'`, `framework === 'rails'` |
| Sinatra via Gemfile | `Gemfile` with `gem 'sinatra'` | `type === 'ruby'`, `framework === 'sinatra'` |

#### Go projects
| Test | Fixture | Assert |
|------|---------|--------|
| Go project | `go.mod` file | `type === 'go'` |

#### Static sites
| Test | Fixture | Assert |
|------|---------|--------|
| index.html only | `index.html` | `type === 'static'` |
| No recognizable project | empty dir | returns error or `needsManualConfig` |

#### Port detection
| Test | Fixture | Assert |
|------|---------|--------|
| `--port 4000` in dev script | `scripts: { dev: 'vite --port 4000' }` | `port === 4000` |
| webpack default port | `scripts: { start: 'webpack serve' }` | `port === 8080` |
| parcel default port | `scripts: { start: 'parcel index.html' }` | `port === 1234` |
| No port info → default 3000 | `scripts: { dev: 'node server.js' }` | `port === 3000` |
| Env-prefixed `PORT=4000 node server.js` | `scripts: { dev: 'PORT=4000 node server.js' }` | `port === 4000` if supported, else `port === 3000` (see note) |

> **Note on `PORT=` env prefix**: `detectPortFromScript` currently only parses `--port`/`-p` flags and tool-specific defaults. It does **not** parse `PORT=N` env-var prefixes in scripts. This test should confirm the current behavior (likely returns default 3000). If we want to support it, file a follow-up issue — do not change detection logic in this test-expansion PR.

### Mocking strategy
No mocks needed — uses real filesystem via tmpdir. Each test creates the minimal fixture files, calls `detectProjectType(tmpDir)`, asserts the returned object.

---

## Phase 2: ComposeGenerator Unit Tests (Priority 2)

**File**: `test/compose-generator.test.js` (new)

### Test cases

#### `getJumpshDir(slug)`
- Returns `path.join(os.homedir(), '.jump.sh', slug)`

#### `generateCompose` — skip behavior
- When `.jumpsh/` dir + compose file already exist and `opts.force` is falsy → returns `{ skipped: true }`
- When `opts.force` is true → overwrites, returns compose/dockerfile paths

#### Node projects
- Generates Dockerfile with `FROM node:20-slim`
- Bun project uses `FROM oven/bun:latest`
- pnpm includes `RUN corepack enable`
- Sets `NODE_ENV=development`, `HOST=0.0.0.0` in compose environment
- Includes anonymous `node_modules` volume
- Includes `extra_hosts: ["host.docker.internal:host-gateway"]`

#### Python projects
- Generates Dockerfile with pip install from `requirements.txt`
- pyproject.toml uses `pip install .`
- Sets `PYTHONDONTWRITEBYTECODE=1`, `PYTHONUNBUFFERED=1`

#### Go projects
- Uses `golang:*` base image
- Copies `go.mod` and `go.sum`

#### Ruby projects
- Uses ruby base image
- Runs `bundle install`

#### Static sites
- No Dockerfile generated
- Compose uses `nginx:alpine` image
- Volume mount to `/usr/share/nginx/html:ro`

#### `.env` transformation
- `localhost` in `.env` → `host.docker.internal`
- `127.0.0.1` in `.env` → `host.docker.internal`

#### `opts.overrides`
- `overrides.build` replaces build command
- `overrides.start` replaces start command
- `overrides.port` replaces exposed port
- `overrides.dockerImage` replaces base image
- `overrides.env` (JSON) appended to environment

#### `formatCmd`
- Simple command `"npm start"` → exec form `["npm", "start"]`
- Command with pipes/shell chars `"cmd1 && cmd2"` → shell form `["sh", "-c", "cmd1 && cmd2"]`

#### `.dockerignore`
- Creates `.dockerignore` in project root if absent
- Does not overwrite existing `.dockerignore`

#### Error case
- Unsupported type throws

### Mocking strategy
- Use tmpdir for project path (real FS for fixture files like `package.json`, `.env`)
- Override `getJumpshDir` output path to tmpdir so generated files go to temp location
- No network or Docker needed — only file generation is tested
- Read generated files back and assert contents (parse YAML for compose, check Dockerfile lines)

### Setup helper
```js
function setupProject(tmpDir, { type, packageJson, envFile, existingCompose } = {}) {
  // Write fixture files based on type
  // Return { projectPath, jumpshDir }
}
```

---

## Phase 3: Database Integration Tests (Priority 3)

**File**: `test/database.test.js` (new)

### Database path isolation

`database.js` computes `DATA_DIR` and `DB_PATH` from `os.homedir()` **at module load time** (lines 7-8):
```js
const DATA_DIR = path.join(os.homedir(), '.jump.sh');
const DB_PATH = path.join(DATA_DIR, 'projects.json');
```

Because these are module-level constants resolved on first import, tests **must**:
1. Set `process.env.HOME` (Linux) to a tmpdir **before** importing `database.js`
2. Use dynamic import with `?t=N` cache-busting for each test suite/context that needs a fresh DB path
3. Clean up the tmpdir in `afterEach`/`after`

```js
let tmpHome, Database;
beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jumpsh-db-'));
  process.env.HOME = tmpHome;
  // Cache-bust to force module re-evaluation with new HOME
  const mod = await import(`../database.js?t=${Date.now()}`);
  Database = mod.default ?? mod.Database;
});
afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});
```

This guarantees each test gets its own `projects.json` in an isolated directory.

### Test cases

#### CRUD
| Test | Action | Assert |
|------|--------|--------|
| Create project | `createProject({ name, path, subdomain })` | callback gets `id`, project retrievable by `getProject(id)` |
| Create sets defaults | `createProject(...)` | `assigned_port === null`, `created_at` set, `updated_at` set |
| Get nonexistent | `getProject(999)` | returns `null` |
| Get by subdomain | `getProjectBySubdomain('myapp')` | returns correct project |
| Get by name | `getProjectByName('myapp')` | returns project, excludes worktrees |
| Get by path | `getProjectByPath('/some/path')` | returns correct project |
| Find by name then subdomain | `findProject('myapp')` | tries name first, falls back to subdomain |
| Get all projects | `getAllProjects()` | excludes worktrees, sorted by name |
| Get all including worktrees | `getAllProjectsIncludingWorktrees()` | includes worktrees, sorted parent-first |
| Update project | `updateProject(id, { description: 'new' })` | field updated, `updated_at` changed |
| Delete project | `deleteProject(id)` | project gone, child worktrees also deleted |

#### Worktrees
| Test | Action | Assert |
|------|--------|--------|
| Upsert new worktree | `upsertWorktree({ name, path, ... })` | creates new entry |
| Upsert existing worktree | `upsertWorktree` with same name | updates, doesn't duplicate |
| Delete worktree | `deleteWorktree(path)` | removed from db |
| Get worktrees for project | `getWorktreesForProject(parentId)` | returns child worktrees only |

#### Port allocation
| Test | Action | Assert |
|------|--------|--------|
| Get next port | `getNextPort()` | returns port in 10000-10999 |
| Port excludes used | Create projects with ports, then `getNextPort()` | not in used set |
| Release port | `releasePort(id)` | `assigned_port` becomes null |
| `makePortRange` static | `Database.makePortRange(usedPorts, 10000, 10999)` | returns up to 100 candidates excluding used |
| Port exhaustion → overflow | Fill primary range | next port from 11000-11999 |

### Mocking strategy
- Real Database class with isolated `HOME` pointed at tmpdir (see "Database path isolation" above)
- Each test suite uses `?t=N` dynamic import cache-busting so `DATA_DIR`/`DB_PATH` are re-resolved per test
- No mock database — tests exercise the real lowdb-backed implementation against a disposable `projects.json`

---

## Phase 4: DockerManager DI Refactor (Priority 4 — Architecture)

**File changed**: `services/DockerManager.js`

> **Note**: DockerManager lives at `services/DockerManager.js` (not project root). Verified via `ls services/DockerManager.js`.

### Refactor steps

1. **Add `spawner` option to constructor**:
   ```js
   // Before
   constructor(db) {
     this.db = db;
     // ...
   }

   // After
   constructor(db, { spawner = spawn } = {}) {
     this.db = db;
     this.spawner = spawner;
     // ...
   }
   ```

2. **Replace direct `spawn` calls with `this.spawner`**:
   - `_execComposeStreaming` (line ~141): `spawn(command, spawnArgs, ...)` → `this.spawner(command, spawnArgs, ...)`
   - `streamLogs` (line ~539): `spawn(command, args, ...)` → `this.spawner(command, args, ...)`

3. **Add `execCompose` injection** (optional, for deeper testing):
   ```js
   constructor(db, { spawner = spawn, execCompose: execComposeFn = execCompose } = {}) {
     this.execCompose = execComposeFn;
     // ...
   }
   ```
   Then replace all `execCompose(...)` calls with `this.execCompose(...)`.

4. **Verify**: Existing callers (`server.js`) pass no options, so `spawn` default preserves behavior. Run existing tests to confirm.

### Scope of change
- Only `services/DockerManager.js` modified
- No API changes — purely additive (optional constructor param)
- All existing `new DockerManager(db)` calls continue to work unchanged

---

## Phase 5: DockerManager Integration Tests (Priority 4)

**File**: `test/docker-manager.test.js` (new)

### Mock factory
```js
import { EventEmitter } from 'node:events';

function createMockSpawner({ exitCode = 0, stdout = '', stderr = '' } = {}) {
  const calls = [];
  const spawner = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode);
    });
    return child;
  };
  spawner.calls = calls;
  return spawner;
}

function createMockExecCompose(responses = {}) {
  return async (subcommand, composePath, opts) => {
    const key = Array.isArray(subcommand) ? subcommand[0] : subcommand.split(' ')[0];
    if (responses[key]) return responses[key];
    return { stdout: '', stderr: '' };
  };
}
```

### Mock database
```js
function createMockDb(projects = []) {
  return {
    getProject(id, cb) { cb(null, projects.find(p => p.id === id) || null); },
    getNextPort(cb) { cb(null, 10042); },
    updateProject(id, updates, cb) {
      const p = projects.find(x => x.id === id);
      if (p) Object.assign(p, updates);
      cb(null);
    },
    releasePort(id, cb) { cb(null); },
    getWorktreesForProject(id, cb) { cb(null, []); },
  };
}
```

### Test cases

#### Pure/internal methods
| Test | Assert |
|------|--------|
| `_detectStep('Container xyz Created')` | returns step 2 |
| `_detectStep('Container xyz Started')` | returns step 3 |
| `_detectStep('random output')` | returns null/undefined |
| `getHealth(unknownId)` | returns `'unknown'` |
| `addStartupListener` + `_emitStartup` | listener called with data |
| `addStartupListener` unsubscribe | listener not called after unsub |
| `getStartupStep(unknownId)` | returns null |

#### `getComposeFile(project)`
- Project with root `docker-compose.yml` → returns that path, `isGenerated: false`
- Project with `.jumpsh/docker-compose.yml` → returns that path, `isGenerated: true`
- Project with neither → returns `{ composePath: null }`

#### `start(project)` flow
| Test | Assert |
|------|--------|
| Prevents double-start | Second call returns `{ alreadyStarting: true }` |
| Calls spawner with correct compose args | `spawner.calls[0]` matches expected command |
| Successful start | returns `{ success: true }` |
| Spawn exit code != 0 | returns `{ success: false, error: ... }` |
| Port conflict detection + retry | stderr matches bind pattern → calls `releasePort`, retries |

#### `stop(project)`
| Test | Assert |
|------|--------|
| Calls execCompose with 'down' | mock verifies call |
| Returns `{ success: true }` | on clean exit |

#### `getStatus(project)` / `getPort(project)`
| Test | Assert |
|------|--------|
| Parses `docker compose ps --format json` output | returns `{ running: true/false, containers }` |
| Parses port from container info | returns correct port number |

#### Worktree env merging
| Test | Assert |
|------|--------|
| Worktree project merges parent env | `_mergedEnv` has parent + child |
| Child env values win over parent | conflicting key uses child value |

### Mocking strategy
- Inject `spawner` mock via constructor DI (from Phase 4)
- Inject `execCompose` mock if refactored, else use `?t=N` re-import
- Use `createMockDb` for all database interactions
- Use tmpdir for any compose file checks (`getComposeFile`)

---

## Phase 6: SubdomainProxy Integration Tests (Priority 3)

**File**: `test/subdomain-proxy.test.js` (new)

### Test cases

#### `extractSubdomain(host)`
| Test | Input | Expected |
|------|-------|----------|
| Standard | `'myapp.jump.sh'` | `'myapp'` |
| With port | `'myapp.jump.sh:4443'` | `'myapp'` |
| Bare domain | `'jump.sh'` | `null` (< 2 parts) |
| Localhost | `'localhost'` | `null` |
| Worktree subdomain | `'myapp--feature.jump.sh'` | `'myapp--feature'` |

#### `isMainDomain(subdomain)`
| Test | Input | Expected |
|------|-------|----------|
| `'dash'` | → `true` |
| `'dashboard'` | → `true` |
| `'www'` | → `true` |
| `'jump'` (domain prefix) | → `true` |
| `'myapp'` | → `false` |

#### Middleware routing
| Test | Setup | Assert |
|------|-------|--------|
| No host header | `req.headers.host = undefined` | `next()` called |
| Main domain | `req.headers.host = 'dash.jump.sh'` | `next()` called |
| Unknown project | subdomain not in db | 404 HTML response |
| Project found, no port | docker.getPort returns null | 503 HTML response |
| Project found with port | docker.getPort returns 10000 | proxy middleware called |

#### Cache
| Test | Assert |
|------|--------|
| `getOrCreateProxy` returns same proxy for same port | reference equality |
| `clearCache` makes next call create new proxy | reference inequality |

### Mocking strategy
```js
const mockDb = {
  getProjectBySubdomain(sub, cb) { /* return from fixture map */ }
};
const mockDocker = {
  async getPort(project) { /* return from fixture map */ }
};
const config = {
  port: 4443,
  domain: 'jump.sh',
  https: true,
  dashboardHost: 'dash.jump.sh',
  formatUrl: (host) => `https://${host}`
};
```
- Mock `req`/`res`/`next` objects (minimal Express-compatible shapes)
- For proxy creation: may need to mock `createProxyMiddleware` via `?t=N` re-import or test at the method level

---

## Phase 7: WorktreeScanner Integration Tests (Priority 3)

**File**: `test/worktree-scanner.test.js` (new)

### Test cases

| Test | Setup | Assert |
|------|-------|--------|
| `watchProject` skips if no `.worktrees/` dir | project path with no `.worktrees/` | no watcher created |
| `watchProject` skips duplicate watch | call twice with same projectId | only one watcher |
| `scanWorktrees` skips non-git entries | `.worktrees/foo/` without `.git` | not upserted |
| `scanWorktrees` detects valid worktree | `.worktrees/feat/` with `.git` file + init git repo | `upsertWorktree` called |
| Subdomain format | parent subdomain `myapp`, branch `feature-x` | worktree subdomain `myapp--feature-x` |
| Stale worktree removal | DB has worktree not on disk | `deleteWorktree` called |
| Auto-start when parent running | parent is running | `docker.start` called for new worktree |
| `unwatchProject` | watch then unwatch | watcher closed |
| `cleanup` | watch multiple, then cleanup | all watchers closed |
| `scanAllProjects` | multiple projects in db | `watchProject` called for each |

### Mocking strategy
- Mock `db` and `docker` objects passed to constructor
- For `exec` calls (git): use real git in tmpdir (simpler than mocking exec)

### Worktree fixture setup — using real `git worktree add`

Do **not** create ad-hoc `.git` files or fake worktree directories. `WorktreeScanner.scanWorktrees` checks for a valid `.git` marker (file pointing to the parent repo's `.git/worktrees/` entry), and `git branch --show-current` requires a real git worktree to work.

Use `git worktree add` to create real worktrees in the tmpdir:

```js
import { execSync } from 'node:child_process';

function setupWorktreeFixture() {
  const tmpDir = makeTmpDir();
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);

  // Initialize a real git repo with an initial commit
  execSync('git init && git commit --allow-empty -m "init"', { cwd: projectDir });

  // Create .worktrees/ directory and add real worktrees
  const worktreesDir = path.join(projectDir, '.worktrees');
  fs.mkdirSync(worktreesDir);
  execSync(`git worktree add ${path.join(worktreesDir, 'feature-x')} -b feature-x`, { cwd: projectDir });
  execSync(`git worktree add ${path.join(worktreesDir, 'fix-bug')} -b fix-bug`, { cwd: projectDir });

  return { tmpDir, projectDir, worktreesDir };
}
```

This ensures:
- `.git` files in worktree dirs are real (pointing back to parent repo)
- `git branch --show-current` returns the correct branch name
- `fs.existsSync(gitDir)` checks pass naturally
- Cleanup: `git worktree remove` or just `rm -rf` the tmpdir (worktrees are disposable in test)

---

## Phase 8: CLI Parsing Unit Tests (Priority 2)

**File**: `test/cli.test.js` (new)

### Approach
CLI `run(argv)` calls `process.exit()` and does dynamic imports. Strategy:
- Mock `process.exit` to capture exit codes
- Mock dynamic command imports to track which command was routed to
- Use `?t=N` cache-busting if needed

### Test cases

| Test | Input | Assert |
|------|-------|--------|
| `--help` flag | `run(['--help'])` | prints help text, exits 0 |
| `-h` flag | `run(['-h'])` | prints help text, exits 0 |
| `--version` flag | `run(['--version'])` | prints version, exits 0 |
| `-v` flag | `run(['-v'])` | prints version, exits 0 |
| Unknown command | `run(['foobar'])` | exits 2 |
| Known command `ls` | `run(['ls'])` | routes to `ls` command module |
| Known command `status` | `run(['status'])` | routes to `status` command module |
| `dashboard` command | `run(['dashboard'])` | routes to `dashboard` module |
| `-` alias | `run(['-'])` | routes to dashboard (same as `dashboard`) |
| No command, daemon running | `run([])` + mock daemon running | opens dashboard |
| No command, daemon not running | `run([])` + mock daemon not running | starts server |

### Mocking strategy
- Capture `process.exit` calls (override temporarily)
- Capture `console.log` / `console.error` output
- Mock `isDaemonRunning` via module re-import or by mocking the imported function
- Mock command modules to verify routing without executing real commands

---

## Phase 9: E2E Tests (Priority 5)

**File**: `test/e2e/lifecycle.test.js`, `test/e2e/worktree.test.js`, `test/e2e/cli.test.js`, `test/e2e/errors.test.js` (new directory)

### Prerequisites
- Docker must be available
- Tests are slower, run separately: `node --test test/e2e/*.test.js`
- Add npm script: `"test:e2e": "node --test test/e2e/*.test.js"`
- Add npm script: `"test:all": "node --test test/*.test.js test/e2e/*.test.js"`

### Test cases

#### `lifecycle.test.js` — Project lifecycle
1. Add project (`jumpsh add` or programmatic `createProject` + `detectProjectType` + `generateCompose`)
2. Start project (docker compose up)
3. Verify proxy routes to running container
4. Stop project (docker compose down)
5. Remove project (delete from DB + cleanup)

#### `worktree.test.js` — Worktree flow
1. Add project from a git repo
2. Create worktree (`git worktree add .worktrees/feature ...`)
3. Scanner detects worktree
4. Verify branch-based subdomain URL resolves
5. Remove worktree, verify cleanup

#### `cli.test.js` — CLI verification
1. `jumpsh --version` outputs version
2. `jumpsh --help` shows usage
3. `jumpsh ls` lists projects (with/without projects)
4. `jumpsh status` shows daemon/project status

#### `errors.test.js` — Error scenarios
1. Missing Docker → graceful error message
2. Port conflict → retry with new port
3. Invalid project path → clear error
4. Duplicate project name → clear error

### Approach
- Use `child_process.execFile` to run `bin/jumpsh.js` as a subprocess
- Use tmpdir for project fixtures
- Create a simple test project (e.g., `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(3000)"`)
- E2E tests require Docker — use Node test runner's native skip:
  ```js
  import { describe, it } from 'node:test';
  const dockerAvailable = await isDockerAvailable();
  describe('lifecycle', { skip: !dockerAvailable && 'Docker not available' }, () => { ... });
  // Or per-test: it('starts project', { skip: !dockerAvailable && 'no Docker' }, async () => { ... });
  ```
  Do **not** use `describe.skip` — it does not exist in `node:test`. Use the `{ skip: reason }` options object.
- Timeout: set generous timeouts (30s+) for Docker operations via `{ timeout: 30_000 }` option

---

## Test File Layout Summary

```
test/
├── ssh-register.test.js          # existing (unchanged)
├── project-detector.test.js      # Phase 1: extend with frameworks/pkg-mgrs/languages
├── compose-generator.test.js     # Phase 2: new
├── database.test.js              # Phase 3: new
├── docker-manager.test.js        # Phase 5: new (after Phase 4 DI refactor)
├── subdomain-proxy.test.js       # Phase 6: new
├── worktree-scanner.test.js      # Phase 7: new
├── cli.test.js                   # Phase 8: new
├── helpers/
│   ├── mock-db.js                # Shared mock database factory
│   ├── mock-spawner.js           # Shared mock spawn factory
│   └── fixtures.js               # Shared tmpdir + file helpers
└── e2e/
    ├── lifecycle.test.js          # Phase 9
    ├── worktree.test.js           # Phase 9
    ├── cli.test.js                # Phase 9
    └── errors.test.js             # Phase 9
```

---

## Shared Test Helpers (`test/helpers/`)

### `fixtures.js`
```js
export function makeTmpDir() { /* mkdtemp */ }
export function writeJson(dir, filename, obj) { /* writeFileSync */ }
export function touchFile(dir, filename) { /* writeFileSync('') */ }
export function writeFile(dir, filename, content) { /* writeFileSync */ }
export function cleanTmpDir(dir) { /* rmSync recursive */ }
```

### `mock-db.js`
```js
export function createMockDb(initialProjects = []) {
  // Returns object with all Database methods as stubs
  // Backed by in-memory array
  // Tracks calls for assertion
}
```

### `mock-spawner.js`
```js
export function createMockSpawner(behavior = {}) {
  // Returns spawner function + .calls array
  // Supports configurable exit codes, stdout, stderr per call
}

export function createMockExecCompose(responses = {}) {
  // Returns async function matching execCompose signature
}
```

---

## Implementation Sequence

| Step | Phase | Files Changed/Created | Estimated Tests |
|------|-------|-----------------------|-----------------|
| 1 | Shared helpers | `test/helpers/{fixtures,mock-db,mock-spawner}.js` | 0 |
| 2 | Phase 1 | `test/project-detector.test.js` | ~25 |
| 3 | Phase 2 | `test/compose-generator.test.js` | ~20 |
| 4 | Phase 3 | `test/database.test.js` | ~18 |
| 5 | Phase 4 (DI) | `services/DockerManager.js` | 0 (refactor) |
| 6 | Phase 5 | `test/docker-manager.test.js` | ~20 |
| 7 | Phase 6 | `test/subdomain-proxy.test.js` | ~12 |
| 8 | Phase 7 | `test/worktree-scanner.test.js` | ~10 |
| 9 | Phase 8 | `test/cli.test.js` | ~11 |
| 10 | Phase 9 | `test/e2e/*.test.js` + npm scripts | ~12 |

**Total new tests**: ~128

---

## Verification Commands

```bash
# Run all unit + integration tests
npm test

# Run specific test file
node --test test/compose-generator.test.js

# Run E2E tests (requires Docker)
npm run test:e2e

# Run everything
npm run test:all

# Verify existing tests still pass after DI refactor (Phase 4)
npm test
```

---

## Package.json Changes

```json
{
  "scripts": {
    "test": "node --test test/*.test.js",
    "test:e2e": "node --test test/e2e/*.test.js",
    "test:all": "node --test test/*.test.js test/e2e/*.test.js"
  }
}
```

---

## Key Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Database `DATA_DIR`/`DB_PATH` computed from `os.homedir()` at module load time | Set `process.env.HOME` to tmpdir **before** import; use `?t=N` cache-busting on dynamic import to force re-evaluation (see Phase 3 "Database path isolation") |
| `dockerCommand.js` memoizes compose command | Use `?t=N` cache-busting on import, or accept memoized value in tests |
| `createProxyMiddleware` import in SubdomainProxy | Test at method level (`extractSubdomain`, `isMainDomain`, middleware with mocked proxy creation) |
| E2E tests need Docker | Gate with `isDockerAvailable()` check, use `{ skip: reason }` option on `describe`/`it` (not `describe.skip` which doesn't exist in `node:test`) |
| WorktreeScanner uses real `exec('git ...')` | Use `git worktree add` to create real worktrees in tmpdir — real `.git` markers and real branch names, no ad-hoc fakes |
| CLI tests call `process.exit` | Temporarily override `process.exit`, restore in afterEach |
| `PORT=N` env prefix in scripts not detected | Test documents current behavior (returns default port); follow-up issue if support desired |
