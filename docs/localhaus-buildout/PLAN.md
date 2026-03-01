# Localhaus Build-Out Implementation Plan

**Date:** 2026-02-28
**Revised:** 2026-03-01
**Scope:** Remaining MVP work per design doc

---

## TLD Recommendation: `.localhost` (not `.local`)

**Chosen TLD: `.localhost`**

`.localhost` is defined by RFC 6761 to always resolve to loopback (`127.0.0.1` / `::1`). Modern browsers and OSes handle it natively. This is the right choice for localhaus.

**macOS caveat with `.local`:**
- macOS reserves `.local` for mDNS/Bonjour. Any DNS lookup to `*.local` triggers a 5-second multicast DNS timeout before falling back to unicast DNS. This makes `.local` unusable for local dev — every page load hangs for seconds.
- `.localhost` does NOT have this problem on macOS. Chrome, Firefox, and Safari all resolve `*.localhost` to `127.0.0.1` without mDNS.
- dnsmasq is still needed for `.localhost` wildcard resolution in system-level tools (curl, wget, etc.) since the RFC 6761 behavior is browser-specific. On macOS, the `/etc/resolver/localhost` file handles this without dnsmasq for most use cases, but dnsmasq provides a reliable fallback.

**Alternative considered:** `.test` (also RFC 6761 reserved, but requires dnsmasq on all platforms since browsers don't auto-resolve it). `.localhost` wins because it works in browsers without any setup.

---

## Phase 1: Setup Scripts (dnsmasq + mkcert)

Foundation work — enables HTTPS and wildcard DNS for all subsequent phases.

### Task 1.1: macOS Setup Script

**File:** `scripts/setup-macos.sh`

**Key steps:**
1. Check for Homebrew, abort with instructions if missing
2. `brew install dnsmasq` (skip if already installed)
3. Detect Homebrew prefix via `brew --prefix` (Intel: `/usr/local`, Apple Silicon: `/opt/homebrew`)
4. Write `$(brew --prefix)/etc/dnsmasq.d/localhost.conf`:
   ```
   address=/.localhost/127.0.0.1
   ```
5. `sudo brew services restart dnsmasq`
6. Create resolver: `sudo mkdir -p /etc/resolver && sudo tee /etc/resolver/localhost <<< "nameserver 127.0.0.1"`
7. `brew install mkcert && mkcert -install` (installs root CA)
8. `mkdir -p ~/.localhaus/certs`
9. `mkcert -cert-file ~/.localhaus/certs/localhost.pem -key-file ~/.localhaus/certs/localhost-key.pem "*.localhost" localhost 127.0.0.1 ::1`
10. Print cert paths to stdout, verify with `dig test.localhost @127.0.0.1`
11. Print reminder: **"Restart your browser(s) for the mkcert root CA to take effect."**

**Dependencies:** Homebrew, sudo access
**Verification:** `curl -s https://test.localhost` should resolve (after localhaus is running)

**Edge cases:**
- Existing dnsmasq config: check if `address=/.localhost/` line already exists before appending
- mkcert already installed: skip install, but still generate certs if cert files are missing
- Existing `~/.localhaus/certs/*.pem` files: skip cert generation, print "Certs already exist at ..."

### Task 1.2: Linux Setup Script

**File:** `scripts/setup-linux.sh`

**Key steps:**
1. Detect package manager (apt, dnf, pacman)
2. Install dnsmasq via detected package manager
3. Write `/etc/dnsmasq.d/localhost.conf`:
   ```
   address=/.localhost/127.0.0.1
   ```
4. Ensure `/etc/resolv.conf` or systemd-resolved is configured to use dnsmasq
5. Handle systemd-resolved conflict: configure as upstream DNS, not replacement
   - Write `/etc/systemd/resolved.conf.d/localhaus.conf` to set DNS=127.0.0.1 for `.localhost`
   - Alternative: add `server=/localhost/127.0.0.1` to dnsmasq and set dnsmasq as systemd-resolved upstream
6. `sudo systemctl restart dnsmasq`
7. Install mkcert (check for package manager availability, fall back to GitHub release binary)
8. `mkcert -install && mkdir -p ~/.localhaus/certs`
9. Generate certs same as macOS (skip if cert files already exist)
10. Print cert paths
11. Print reminder: **"Restart your browser(s) for the mkcert root CA to take effect."**

**Dependencies:** sudo access, one of apt/dnf/pacman
**Verification:** `dig +short test.localhost @127.0.0.1` returns `127.0.0.1`

**Edge cases:**
- systemd-resolved occupying port 53: must configure dnsmasq to use a different port and set as resolved's DNS
- NetworkManager managing resolv.conf: add `dns=dnsmasq` to NetworkManager.conf

#### WSL2-Specific Workaround

**Detection:** Check `grep -qi microsoft /proc/version` or presence of `/mnt/c/`.

WSL2 runs its own DNS stub on port 53 that forwards to the Windows host. dnsmasq conflicts with this. The workaround:

1. **Skip dnsmasq entirely** — print clear warning explaining why
2. **Write `/etc/hosts` entries** for known project subdomains:
   ```
   127.0.0.1 localhaus.localhost
   ```
3. **Add a helper function** `localhaus-dns` that the user can run after adding projects, which appends new subdomain entries to `/etc/hosts`:
   ```bash
   # Reads subdomains from localhaus SQLite DB and writes /etc/hosts entries
   localhaus-dns() {
     sqlite3 ~/.localhaus/localhaus.db "SELECT subdomain FROM projects" | \
       while read sub; do
         grep -q "$sub.localhost" /etc/hosts || \
           echo "127.0.0.1 $sub.localhost" | sudo tee -a /etc/hosts
       done
   }
   ```
4. **Print post-setup instructions** explaining the limitation and suggesting the user run `localhaus-dns` after adding new projects
5. mkcert install proceeds normally (works fine in WSL2)

### Task 1.3: Shared Setup Utilities

**File:** `scripts/setup-common.sh` (sourced by both platform scripts)

**Contents:**
- `check_command()` — verify a binary exists
- `print_status()` — colored output helpers
- `generate_certs()` — mkcert cert generation (shared logic); checks if cert files already exist before regenerating
- `verify_dns()` — test wildcard resolution
- `check_existing_localhaus_dir()` — if `~/.localhaus/` exists, check for existing certs/config and skip steps already done
- Idempotency: every step checks if already done before acting

**Rollback strategy:**
- Each script logs what it changed to `~/.localhaus/setup.log`
- Provide `scripts/teardown-macos.sh` and `scripts/teardown-linux.sh` that undo all changes
- Teardown: remove resolver file, remove dnsmasq config, uninstall mkcert root CA (`mkcert -uninstall`)

---

## Phase 2: HTTPS Support in Express Server

### Task 2.1: Conditional HTTPS Server Creation

**File:** `server.js` (modify)

**Key code changes:**
1. Import `https`, `http`, `fs`, and `os` from node stdlib
2. Resolve `LOCALHAUS_CERT_PATH` with explicit tilde expansion (Node does not expand `~` in env vars):
   ```js
   function resolvePath(p) {
     if (p.startsWith('~/') || p === '~') {
       return path.join(os.homedir(), p.slice(1));
     }
     return path.resolve(p);
   }
   const certPath = resolvePath(
     process.env.LOCALHAUS_CERT_PATH || '~/.localhaus/certs'
   );
   ```
3. HTTPS with cert existence check and graceful fallback:
   ```js
   let server;
   if (config.https) {
     const keyPath = path.join(certPath, 'localhost-key.pem');
     const certFile = path.join(certPath, 'localhost.pem');

     if (!fs.existsSync(keyPath) || !fs.existsSync(certFile)) {
       console.warn(
         `LOCALHAUS_HTTPS=true but certs not found at ${certPath}\n` +
         `Run scripts/setup-macos.sh or scripts/setup-linux.sh first.\n` +
         `Falling back to HTTP.`
       );
       config.https = false; // override so templates generate http:// URLs
       server = http.createServer(app);
     } else {
       const httpsOptions = {
         key: fs.readFileSync(keyPath),
         cert: fs.readFileSync(certFile)
       };
       server = https.createServer(httpsOptions, app);
     }
   } else {
     server = http.createServer(app);
   }
   server.listen(config.port, ...);
   ```
4. Update banner to show `https://` when HTTPS is active (after fallback resolution)
5. Update `config` object to include `certPath`

**Dependencies:** Phase 1 (certs must exist for HTTPS; HTTP fallback works without them)
**Verification:** `curl -v https://localhaus.localhost:5050` with valid TLS; verify fallback by deleting certs and confirming HTTP starts with warning

### Task 2.2: Protocol-Aware URL Generation

**Files:** `views/index.ejs`, `views/project.ejs`, `services/SubdomainProxy.js`

**Key changes:**
- All hardcoded `http://` references in templates must use `config.https ? 'https' : 'http'`
- SubdomainProxy error pages: use protocol from config
- Dashboard links: use protocol from config
- Config object passed to views already — just reference `config.https`

**Grep targets (all `http://` in views):**
- `index.ejs`: subdomain URLs in project cards and worktree links
- `project.ejs`: subdomain URL in info section, worktree table links
- `SubdomainProxy.js`: "Back to Localhaus" links in 404/503 pages

### Task 2.3: Update .env.example

**File:** `.env.example` (modify)

Add documentation comments:
```env
# Set to true after running scripts/setup-macos.sh or scripts/setup-linux.sh
LOCALHAUS_HTTPS=false
# Path to mkcert certificates (default: ~/.localhaus/certs)
# Tilde (~) is expanded to $HOME at runtime
LOCALHAUS_CERT_PATH=~/.localhaus/certs
```

---

## Phase 3: Nixpacks Auto-Generation

### Task 3.1: Project Type Detector

**File:** `services/ProjectDetector.js` (create)

**Exports:** `detectProjectType(projectPath) → { type, framework, devCommand, port }`

**Path validation:** Before any detection, validate the project path:
- `projectPath` must be an absolute path (`path.isAbsolute()`)
- Must exist on disk (`fs.existsSync()`)
- Must be a directory (`fs.statSync().isDirectory()`)
- Return `{ error: 'Invalid project path: ...' }` on failure

**Detection logic (ordered by priority):**

| Marker File | Type | Framework Detection |
|---|---|---|
| `package.json` | `node` | Read `scripts.dev` for vite/next/nuxt; check `dependencies` for express/fastify/koa |
| `requirements.txt` | `python` | Grep for django/flask/fastapi/uvicorn |
| `pyproject.toml` | `python` | Parse `[tool.poetry]` or `[project]` for dependencies |
| `go.mod` | `go` | — |

**Node: Package manager detection**

Detect which package manager the project uses by checking for lock files, in priority order:

| Lock File | Package Manager | Install Command | Run Prefix |
|---|---|---|---|
| `bun.lockb` or `bun.lock` | bun | `bun install` | `bun run` |
| `pnpm-lock.yaml` | pnpm | `pnpm install` | `pnpm run` |
| `yarn.lock` | yarn | `yarn install` | `yarn` |
| `package-lock.json` (or none) | npm | `npm install` | `npm run` |

The detected package manager affects:
- Dockerfile `RUN` command (install step)
- Dockerfile `COPY` of lock file alongside `package.json`
- `command:` in compose (e.g., `bun run dev` vs `npm run dev`)

**Framework → dev command mapping (Node):**
| Indicator | Dev Command | Default Port |
|---|---|---|
| `vite` in deps or `scripts.dev` contains `vite` | `{pm} run dev` | 5173 |
| `next` in deps | `{pm} run dev` | 3000 |
| `nuxt` in deps | `{pm} run dev` | 3000 |
| `scripts.start` exists | `{pm} start` | 3000 |
| Fallback | `node {entrypoint}` | 3000 |

Where `{pm}` is the detected package manager run prefix.

**Framework → dev command mapping (Python):**

**Entrypoint detection** — the `main:app` assumption is fragile. Detect the actual ASGI/WSGI entrypoint:

| Framework | Detection Strategy | Dev Command |
|---|---|---|
| FastAPI/Uvicorn | 1. Check `pyproject.toml` for `[tool.uvicorn]` or `[project.scripts]` entry<br>2. Grep `*.py` files for `app = FastAPI()` — use `{filename}:app`<br>3. Check common names: `main.py`, `app.py`, `server.py`<br>4. Fallback: `main:app` | `uvicorn {module}:{var} --reload --host 0.0.0.0` |
| Flask | 1. Grep for `app = Flask(` — use `{filename}`<br>2. Check `FLASK_APP` in `.env` or `.flaskenv`<br>3. Fallback: `app` | `flask --app {module} run --reload --host 0.0.0.0` |
| Django | Check for `manage.py` existence | `python manage.py runserver 0.0.0.0:8000` |
| Fallback | Check for `app.py`, `main.py`, `server.py` | `python {entrypoint}` (default port 8000) |

**Default ports:** FastAPI/Uvicorn → 8000, Flask → 5000, Django → 8000

**Edge cases:**
- Monorepo with both `package.json` and `requirements.txt`: prefer `package.json` (most common case)
- `package.json` with no `scripts`: still detect as Node, use `node index.js`
- Entry point detection: check for `main` field in package.json, existence of `index.js`, `server.js`, `app.js`
- Python project with no recognizable framework and no obvious entrypoint: return detection with `{ needsManualConfig: true, message: "Could not detect entrypoint. Set 'start' command manually." }`

### Task 3.2: Docker Compose Generator

**File:** `services/ComposeGenerator.js` (create)

**Exports:** `generateCompose(projectPath, detection) → string` (YAML content)

**Docker Compose command detection:**

Before generating, detect which compose command variant is available. Add a shared helper (used by both ComposeGenerator and DockerManager):

```js
// services/dockerCommand.js
import { execSync } from 'child_process';

let _composeCommand = null;

export function getComposeCommand() {
  if (_composeCommand) return _composeCommand;
  try {
    execSync('docker compose version', { stdio: 'ignore' });
    _composeCommand = 'docker compose';     // v2 plugin
  } catch {
    try {
      execSync('docker-compose --version', { stdio: 'ignore' });
      _composeCommand = 'docker-compose';   // v1 standalone
    } catch {
      _composeCommand = null;               // neither available
    }
  }
  return _composeCommand;
}
```

All `exec('docker compose ...')` calls in DockerManager must use `getComposeCommand()` instead of hardcoding `docker compose`. This is a refactor across `start()`, `stop()`, `getStatus()`, `getPort()`, `getLogs()`, `streamLogs()`.

**Generated compose structure:**
```yaml
# Auto-generated by localhaus — do not edit
services:
  app:
    build:
      context: .
      dockerfile: .localhaus/Dockerfile
    ports:
      - "${assignedPort}:${internalPort}"
    volumes:
      - .:/app
      - /app/node_modules  # for Node projects — prevents overwriting container's node_modules
    environment:
      - NODE_ENV=development
    command: ${devCommand}
```

Note: omit `version:` key — it is deprecated in Compose v2 and ignored. Both v1 and v2 work without it for this simple structure.

**Dockerfile generation** (`.localhaus/Dockerfile`):

For Node (adapts to detected package manager):
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json bun.lockb* pnpm-lock.yaml* yarn.lock* ./
RUN ${installCommand}
COPY . .
CMD ["${pm}", "run", "dev"]
```

For Python:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt* pyproject.toml* ./
RUN pip install -r requirements.txt  # or: pip install -e . for pyproject.toml
COPY . .
CMD ${detected dev command}
```

**Port assignment:** Start at 10000, increment by 1 for each project. Store assigned port in DB (add `assigned_port` column).

**Volume mount for live reload:**
- Node: Mount `.:/app` with anonymous volume for `node_modules` to prevent host overwrite
- Python: Mount `.:/app` directly (pip packages are in system python)
- Key: `command:` override in compose uses the dev command with `--reload`/`--watch` flags

**Output location:** `.localhaus/docker-compose.yml` and `.localhaus/Dockerfile` inside the project directory

**Safe handling of existing `.localhaus/` files:**
- If `.localhaus/docker-compose.yml` already exists, do NOT overwrite. Log: "Using existing .localhaus/docker-compose.yml"
- If `.localhaus/Dockerfile` already exists, do NOT overwrite
- Add a `--force` flag to the rebuild route/button that allows regeneration
- Before writing, create `.localhaus/` directory if it doesn't exist

### Task 3.3: Integrate into DockerManager.start()

**File:** `services/DockerManager.js` (modify)

**Changes to `start(project)`:**
1. Replace the `// TODO: Auto-generate with nixpacks` block
2. Refactor all compose exec calls to use `getComposeCommand()` from `services/dockerCommand.js`
3. If no `docker-compose.yml` or `docker-compose.yaml` in project root:
   a. Call `ProjectDetector.detectProjectType(projectPath)`
   b. If detection returns `needsManualConfig`, return error with the detection message
   c. If detection fails entirely, return error: "Could not detect project type. Add a docker-compose.yml manually."
   d. Call `ComposeGenerator.generateCompose(projectPath, detection)` — only if `.localhaus/docker-compose.yml` does not already exist
   e. Write to `.localhaus/docker-compose.yml` and `.localhaus/Dockerfile`
   f. Run `${composeCommand} -f .localhaus/docker-compose.yml up -d --build` (note the `-f` flag)
4. Also update `stop()`, `getStatus()`, `getPort()`, `getLogs()`, `streamLogs()` to use `-f .localhaus/docker-compose.yml` when the compose file is in `.localhaus/`

**Helper method:** `getComposeFile(project)` — returns the path to the compose file (project root or `.localhaus/`)

**Edge cases:**
- Regeneration: If `.localhaus/docker-compose.yml` already exists, don't regenerate unless user explicitly requests rebuild via a `POST /projects/:id/rebuild` route
- `.gitignore`: Add `.localhaus/` to project's `.gitignore` if not already present (prompt, don't force)
- Stale compose: If project files changed (e.g., added `requirements.txt`), re-detection needed — the rebuild button/route handles this

### Task 3.4: Database Schema Update

**File:** `database.js` (modify)

**Add column:** `assigned_port INTEGER` to projects table

**Migration approach:** SQLite `ALTER TABLE ADD COLUMN` (safe, additive)
```js
db.run('ALTER TABLE projects ADD COLUMN assigned_port INTEGER', () => {});
```
Run in constructor, silently ignore "duplicate column" error.

**Port allocation with collision detection:**

The naive `MAX(assigned_port) + 1` approach fails when ports are freed (project deleted) and reused, or when a port is already occupied by a non-localhaus process.

```js
async getNextPort(callback) {
  // 1. Find candidate: first gap in assigned range, or max+1
  this.db.all(
    'SELECT assigned_port FROM projects WHERE assigned_port IS NOT NULL ORDER BY assigned_port',
    async (err, rows) => {
      if (err) return callback(err);

      const usedPorts = new Set(rows.map(r => r.assigned_port));
      let candidate = 10000;

      // Find first unused port in our range
      while (usedPorts.has(candidate)) {
        candidate++;
      }

      // 2. Verify port is actually free on the host
      const isFree = await this.checkPortFree(candidate);
      if (!isFree) {
        // Try next ports until we find a free one (max 100 attempts)
        let attempts = 0;
        while (!await this.checkPortFree(candidate) && attempts < 100) {
          candidate++;
          while (usedPorts.has(candidate)) candidate++;
          attempts++;
        }
        if (attempts >= 100) {
          return callback(new Error('Could not find a free port in range 10000-10100'));
        }
      }

      callback(null, candidate);
    }
  );
}

// Check if a port is free using net.createServer
checkPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}
```

---

## Phase 4: Worktree-First URL Behavior & Deterministic URL Rules

### Task 4.1: Document and Enforce URL Rules

**No code changes needed** — current implementation already follows these rules. This task is about verification and documentation.

**Current URL rules (already implemented in WorktreeScanner.js:83-86):**
| Entity | URL Pattern | Example |
|---|---|---|
| Main project | `{slug}.localhost` | `my-app.localhost` |
| Worktree | `{parent-slug}--{branch-slug}.localhost` | `my-app--feature-auth.localhost` |

**Slug rules (via `slugify`):**
- Lowercase
- `strict: true` — removes all non-alphanumeric except hyphens
- Hyphens preserved, consecutive hyphens collapsed
- Double-dash `--` is the separator (never appears in slugified branch names due to `strict: true`)

**Verification steps:**
1. Add project "My App" → subdomain is `my-app`
2. Create worktree on branch `feature/auth` → subdomain is `my-app--featureauth`
3. Create worktree on branch `fix-bug-123` → subdomain is `my-app--fix-bug-123`
4. Confirm `--` never appears within a single slug component

### Task 4.2: Worktree Compose File Handling

**File:** `services/DockerManager.js` (modify)

**Problem:** Worktrees currently have their own `path` but may not have their own `docker-compose.yml`. They need their own containers with their own ports.

**Solution:**
1. When starting a worktree, check for compose file in worktree path
2. If not found, auto-generate one (same as Phase 3 logic) into `.localhaus/` within the worktree directory
3. Each worktree gets its own assigned port (from `getNextPort()` with collision detection)
4. Worktree containers are independent from parent — different source code, different container

**Edge cases:**
- Worktree inherits parent's `docker-compose.yml` if it exists in the worktree (git tracks it)
- If parent has `.localhaus/docker-compose.yml`, don't copy it — regenerate for the worktree (different port)

### Task 4.3: Improve SubdomainProxy for Worktree URLs

**File:** `services/SubdomainProxy.js` (modify)

**Current behavior:** `extractSubdomain()` takes the first segment before the first dot. For `my-app--feature-auth.localhost`, it correctly extracts `my-app--feature-auth`. This already works.

**Improvement:** When a worktree subdomain is not found, check if the part before `--` matches a parent project and show a helpful error:
```
"Worktree 'feature-auth' not found for project 'my-app'.
Available worktrees: feature-login, fix-bug-123"
```

---

## Phase 5: SSE Logs & Error Handling / Polish

### Task 5.1: Improve SSE Log Streaming

**File:** `services/DockerManager.js` (modify `streamLogs`)

**Current issues:**
- No heartbeat — connection may silently drop
- No event types (everything is generic `data:`)

**Changes:**
1. Add SSE heartbeat every 15 seconds:
   ```js
   const heartbeat = setInterval(() => {
     res.write(': heartbeat\n\n');
   }, 15000);
   // Clear on close/end
   ```
2. Add `event:` types for semantic differentiation:
   ```js
   res.write(`event: log\ndata: ...\n\n`);   // stdout lines
   res.write(`event: error\ndata: ...\n\n`);  // stderr lines
   res.write(`event: status\ndata: ...\n\n`); // container status changes
   ```

**SSE reconnection strategy — simple approach (no `Last-Event-ID` buffering):**

Implementing proper `Last-Event-ID` reconnection would require buffering log lines server-side (a ring buffer or similar), which adds complexity disproportionate to the value for a local dev tool. Instead:

- Do NOT emit `id:` fields on SSE events — this avoids the browser auto-reconnecting with a `Last-Event-ID` header we can't honor
- On the client side, when the EventSource closes or errors, show a "Disconnected — Reconnect" button rather than auto-reconnecting
- When the user clicks reconnect, open a new EventSource that fetches the last N lines via `docker compose logs --tail=100` as an initial burst, then switches to `-f` streaming
- This avoids missed or duplicated lines entirely

**File:** `views/project.ejs` (modify SSE client script)

- Use `addEventListener` for typed events (`log`, `error`, `status`) instead of generic `onmessage`
- Add "Disconnected" UI state with manual reconnect button
- On reconnect, clear log viewer and re-fetch from tail

### Task 5.2: Error Handling for Missing Docker

**File:** `services/DockerManager.js` (modify)

**Add method:** `static async checkDocker()` with timeout — runs `docker info` and returns `{ available: boolean, error?: string }`:

```js
static async checkDocker() {
  try {
    await execAsync('docker info', { timeout: 5000 }); // 5s timeout
    return { available: true };
  } catch (error) {
    if (error.killed) {
      return { available: false, error: 'Docker check timed out (5s). Docker may be starting.' };
    }
    return { available: false, error: error.message };
  }
}
```

The 5-second timeout prevents the server from hanging on startup if Docker Desktop is installed but not running (where `docker info` can hang waiting for the daemon socket).

**File:** `server.js` (modify)

**On startup:**
1. Call `DockerManager.checkDocker()`
2. If Docker not available, log warning but still start server
3. Dashboard shows banner: "Docker is not running. Start Docker Desktop to manage projects."

**In routes:** Wrap `docker.start()` / `docker.stop()` calls — if Docker unavailable, return 503 with clear message instead of cryptic exec error.

### Task 5.3: Better Error Pages

**File:** `views/error.ejs` (create)

Styled error page matching dashboard theme (dark, same CSS). Used for:
- 404: Project/subdomain not found
- 503: Container not running (with "Start" button that POSTs)
- 502: Container starting (with auto-refresh meta tag, 3-second interval)
- 500: Internal error

**File:** `services/SubdomainProxy.js` (modify)

Replace inline HTML strings with `res.render('error', { ... })`.

### Task 5.4: Container "Starting" State Detection

**File:** `services/DockerManager.js` (modify `getStatus`)

**Current:** Binary running/stopped.
**Improvement:** Detect intermediate states from Docker:
- `created` / `restarting` → "starting"
- `running` + health check failing → "unhealthy"
- `exited` with non-zero code → "crashed"

Return: `{ state: 'running' | 'stopped' | 'starting' | 'crashed', containers, exitCode? }`

**File:** `views/index.ejs`, `views/project.ejs` (modify)

Add status badge variants: yellow for "starting", red for "crashed" (with exit code).

### Task 5.5: Dashboard Auto-Refresh Improvements

**File:** `views/index.ejs` (modify)

**Current:** Full page reload every 30 seconds.
**Improvement:** Use fetch to `/api/projects` and update DOM without full reload:
- Update status badges
- Update port numbers
- Update worktree lists
- Only full reload if project count changes

### Task 5.6: Project Path Validation

**File:** `server.js` (modify `POST /projects` route)

**File:** `services/ProjectDetector.js` (used by validation)

When creating a project, validate the provided path:
1. Must be an absolute path (reject relative paths like `./my-project`)
2. Must exist on disk
3. Must be a directory (not a file)
4. Must be readable by the current user

Return a 400 with a specific error message on failure (e.g., "Path must be absolute", "Directory does not exist").

This validation also applies when the `ProjectDetector` receives a path (Task 3.1).

---

## Implementation Order & Dependencies

```
Phase 1 (Setup Scripts)          Phase 3 (Nixpacks)
  1.3 → 1.1                       3.1 → 3.2 → 3.3
  1.3 → 1.2                       3.4 (parallel with 3.1)
       ↓
Phase 2 (HTTPS)                  Phase 4 (Worktree URLs)
  2.1 → 2.2 → 2.3                 4.1 → 4.2 → 4.3

Phase 5 (Polish) — no hard dependencies, can run in parallel
  5.1, 5.2, 5.3, 5.4, 5.5, 5.6 (all independent)
```

**Recommended execution order:**
1. Phase 1 (unblocks Phase 2)
2. Phase 3 (largest feature, no dependencies on Phase 1/2)
3. Phase 2 (requires Phase 1 certs)
4. Phase 4 (builds on Phase 3 compose generation)
5. Phase 5 (polish, anytime)

Phases 1 and 3 can be developed in parallel.

---

## Files Summary

### New Files
| File | Phase | Purpose |
|---|---|---|
| `scripts/setup-common.sh` | 1.3 | Shared setup utilities |
| `scripts/setup-macos.sh` | 1.1 | macOS dnsmasq + mkcert |
| `scripts/setup-linux.sh` | 1.2 | Linux dnsmasq + mkcert + WSL2 workaround |
| `scripts/teardown-macos.sh` | 1.1 | Undo macOS setup |
| `scripts/teardown-linux.sh` | 1.2 | Undo Linux setup |
| `services/ProjectDetector.js` | 3.1 | Detect Node/Python/Go project type + package manager |
| `services/ComposeGenerator.js` | 3.2 | Generate docker-compose.yml + Dockerfile |
| `services/dockerCommand.js` | 3.2 | Compose v1/v2 command detection (shared helper) |
| `views/error.ejs` | 5.3 | Styled error page |

### Modified Files
| File | Phases | Changes |
|---|---|---|
| `server.js` | 2.1, 5.2, 5.6 | HTTPS with cert fallback, tilde expansion, Docker check, path validation |
| `services/DockerManager.js` | 3.3, 4.2, 5.1, 5.2, 5.4 | Compose command helper, auto-gen, SSE improvements, Docker timeout |
| `services/SubdomainProxy.js` | 2.2, 4.3, 5.3 | Protocol-aware URLs, worktree error messages, error templates |
| `database.js` | 3.4 | Add `assigned_port` column, port allocation with collision detection |
| `views/index.ejs` | 2.2, 5.4, 5.5 | Protocol URLs, status states, AJAX refresh |
| `views/project.ejs` | 2.2, 5.1, 5.4 | Protocol URLs, SSE event types + reconnect UI, status states |
| `.env.example` | 2.3 | Document HTTPS config with tilde note |

---

## Rollback Strategy

Each phase is independently rollbackable:

- **Phase 1:** Teardown scripts undo all system changes. No code depends on setup scripts existing.
- **Phase 2:** Set `LOCALHAUS_HTTPS=false` in `.env` to revert to HTTP. Code change is a conditional branch — HTTP path is preserved. Cert fallback means missing certs never crash the server.
- **Phase 3:** Projects with manual `docker-compose.yml` are unaffected. Auto-generated files live in `.localhaus/` and can be deleted. The `start()` method falls back to the existing error message if detection fails. Compose v1/v2 detection is backwards-compatible.
- **Phase 4:** Worktree URL format is already established. Changes are additive (better errors, compose generation for worktrees).
- **Phase 5:** All polish items are independent, non-breaking improvements. Can be reverted individually via git.

**Global rollback:** `git revert` any phase's commits independently without affecting other phases.
