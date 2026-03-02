# jump.sh Implementation Plan

**Date:** 2026-03-01
**Branch:** `jump-sh`
**Status:** Draft v2 — awaiting approval

---

## Decisions Locked

These decisions are authoritative and final. Do not revisit.

1. **Not a migration.** localhaus was never released or used. There are no legacy users, no legacy data, no backward-compat fallbacks needed. All `.localhaus` references are simply replaced — not dual-pathed.
2. **No local DNS setup.** jump.sh removes the local DNS setup burden entirely. No dnsmasq, no `/etc/resolver`, no `/etc/hosts` management, no systemd-resolved config. DNS for `*.jump.sh` is handled externally by the jump.sh service.
3. **Keep Docker + worktrees + process management.** Core architecture (Docker compose generation, subdomain proxy, worktree scanner) is preserved.
4. **TLS via mkcert for localhost mode.** Certs are generated locally; future remote mode will distribute certs differently.
5. **Daemon must be always-running.** `jumpsh install` sets up a system service; `npx jumpsh` is the foreground fallback.
6. **State at `~/.jump.sh/projects.db`.** Fresh DB only — no migration from `.localhaus`.
7. **CLI commands:** `add`, `remove`, `install`, `login`, `ip`, `ls`, `start`, `stop`, `logs`.
8. **Node path brittleness must be solved.** Daemon startup must survive nvm/mise/fnm node version changes.
9. **Windows is out of scope.**
10. **Port conflicts must be handled robustly.** Detect, choose free port, or fail with actionable output.

---

## Goals

1. Replace all localhaus naming/paths/config with jump.sh equivalents (clean cut, not migration)
2. Build CLI entry point (`npx jumpsh`) with full command surface
3. Implement always-running daemon via system service (launchd/systemd) with robust foreground fallback
4. Preserve Docker runtime, compose generation, worktree scanning, and subdomain proxy
5. Handle port conflicts, signal lifecycle, and log rotation as first-class concerns
6. Provide clean install/uninstall with rollback for partial failures

## Scope / Non-goals

**In scope:**
- All file/path/env renames: `localhaus` → `jump.sh` / `jumpsh` (delete old, not dual-path)
- CLI with `add`, `remove`, `install`, `login`, `ip`, `ls`, `start`, `stop`, `logs`
- Daemon install/uninstall (systemd user unit + launchd plist)
- Wrapper-script approach for nvm/mise-safe node resolution
- Port conflict detection and resolution
- Signal handling (SIGTERM, SIGINT, SIGHUP) with graceful shutdown
- Log rotation for daemon logs and per-project dev logs
- Per-project `.jump.sh/` generated directory (Dockerfile, docker-compose.yml)
- TLS via mkcert (localhost mode)
- README rewrite
- Install/uninstall rollback playbook

**Non-goals:**
- Cloud DNS API integration
- Let's Encrypt certificate issuance
- GitHub OAuth / remote login backend
- npm publish / global install (npx-only for now)
- Windows support
- Local DNS setup (dnsmasq, resolver files, /etc/hosts management)
- Backward compatibility with `.localhaus` paths or data
- Dashboard visual redesign (text rebrand only)

---

## Phase 1 — Clean Rename

All mechanical renames. Delete all `.localhaus` references — no fallbacks, no dual paths.

### 1.1 Package identity
| File | Change |
|---|---|
| `package.json` | `name` → `jumpsh`, add `"bin": { "jumpsh": "./bin/jumpsh.js" }`, update `description` |
| `.env.example` | Rename `LOCALHAUS_*` → `JUMPSH_*` |

### 1.2 Runtime state directory
| File | Change |
|---|---|
| `database.js` | Path → `~/.jump.sh/projects.db`. Remove any `.localhaus` references. |
| `server.js` | `LOCALHAUS_PORT` → `JUMPSH_PORT`, `LOCALHAUS_DOMAIN` → `JUMPSH_DOMAIN` (default `jump.sh`), `LOCALHAUS_HTTPS` → `JUMPSH_HTTPS`, `LOCALHAUS_CERT_PATH` → `JUMPSH_CERT_PATH` (default `~/.jump.sh/certs`) |

### 1.3 Per-project generated directory
| File | Change |
|---|---|
| `services/ComposeGenerator.js` | `.localhaus/` → `.jump.sh/` everywhere |
| `services/DockerManager.js` | `getComposeFile()` search order: top-level `docker-compose.yml` / `.yaml`, then `.jump.sh/docker-compose.yml`. Remove `.localhaus` from search. |
| `.gitignore` | Replace `.localhaus/` with `.jump.sh/` |

### 1.4 Domain and subdomain references
| File | Change |
|---|---|
| `services/SubdomainProxy.js` | Replace `localhaus` skip-list with `jump.sh` |
| `views/*.ejs` | Update branding strings, page titles, help text |
| `public/styles.css` | Update any branding strings |
| `README.md` | Full rewrite for jump.sh |

### 1.5 Setup scripts
- **Delete** `scripts/setup-macos.sh`, `scripts/setup-linux.sh`, `scripts/teardown-macos.sh`, `scripts/teardown-linux.sh` — these installed dnsmasq/resolver configs for local DNS, which jump.sh does not need.
- **Keep** `scripts/setup-common.sh` — rename cert-related references from `.localhaus` → `.jump.sh`. Remove any DNS verification functions.
- **Keep** `scripts/enable-low-port-bind-linux.sh` — no changes needed (generic node binary detection).

### Verification
- [ ] `grep -ri 'localhaus' --include='*.js' --include='*.sh' --include='*.ejs' --include='*.json' --include='*.css'` returns zero hits
- [ ] Server starts with `JUMPSH_PORT=5050 node server.js`
- [ ] Dashboard loads at `http://localhost:5050`
- [ ] `~/.jump.sh/` directory created on first run

---

## Phase 2 — CLI Entry Point

### 2.1 File structure
```
bin/
  jumpsh.js             # #!/usr/bin/env node — CLI entry, parses args, dispatches
lib/
  cli.js                # Argument parser + command dispatch table
  commands/
    add.js              # Register a project directory
    remove.js           # Unregister a project (optionally clean up .jump.sh/ dir)
    install.js          # Install daemon service + certs; --uninstall flag
    login.js            # Stub for future remote auth
    ip.js               # Print LAN IP
    ls.js               # List projects + status
    start.js            # Start project containers
    stop.js             # Stop project containers
    logs.js             # Stream/tail project logs
```

### 2.2 Argument parsing
Use **`parseArgs`** from `node:util` (zero deps, Node 18.3+).

```
jumpsh                          # Run daemon in foreground (default)
jumpsh add [path]               # Add project at path (default: cwd)
jumpsh remove <name>            # Remove project from DB; --clean removes .jump.sh/ dir
jumpsh install                  # Install daemon service + generate certs
jumpsh install --uninstall      # Remove daemon service + optionally clean state
jumpsh login                    # (stub) Future remote auth
jumpsh ip                       # Print LAN IP address
jumpsh ls                       # List projects with status
jumpsh start [name]             # Start project containers
jumpsh stop [name]              # Stop project containers
jumpsh logs [name]              # Tail logs (--follow default, --lines=N)
```

### 2.3 Command behavior details

**`jumpsh` (no subcommand)** — Run daemon in foreground.
- Checks for port conflict before binding (see Phase-level port strategy below)
- Starts Express server, SubdomainProxy, WorktreeScanner
- Logs to stdout
- Handles SIGTERM/SIGINT/SIGHUP (see signal handling section)

**`jumpsh add [path]`**
- Resolves `path` to absolute (default: `process.cwd()`)
- Runs `ProjectDetector.detectProjectType()` to validate it's a recognized project
- Derives subdomain from directory name via `slugify()`
- If subdomain already taken: append numeric suffix, print warning
- Inserts into DB; prints assigned subdomain
- Scans for `.worktrees/` and registers any found

**`jumpsh remove <name>`**
- Looks up project by name or subdomain in DB
- If containers are running: stop them first (with confirmation prompt, or `--force` to skip)
- Deletes DB row (and any worktree child rows)
- With `--clean`: also deletes `<project>/.jump.sh/` generated directory
- Prints confirmation

**`jumpsh install`**
- Detects OS (darwin/linux)
- Generates mkcert certs at `~/.jump.sh/certs/` (installs mkcert if missing, or errors with instructions)
- Writes daemon service file using wrapper script (see Node path strategy below)
- Enables + starts the service
- Runs `enable-low-port-bind-linux.sh` on Linux if binding to port < 1024
- Prints success summary with next steps

**`jumpsh install --uninstall`**
- Stops the daemon service
- Disables the service
- Removes the service file
- Asks whether to also remove `~/.jump.sh/` state directory (default: no)
- Does NOT remove per-project `.jump.sh/` dirs (those belong to the project)
- Prints summary of what was removed

**`jumpsh ip`**
- Uses `os.networkInterfaces()` to find first non-internal IPv4 address
- Prints it

**`jumpsh ls`**
- Queries all projects from DB
- For each, checks Docker container status via `DockerManager.status()`
- Prints table: `name | subdomain | status | port | path`
- Worktrees indented under parent

**`jumpsh start [name]`**
- Looks up project by name/subdomain in DB
- If no name given and cwd is a registered project, use that
- Calls `DockerManager.start(project)`
- Prints URL on success

**`jumpsh stop [name]`**
- Looks up project by name/subdomain in DB
- If no name given and cwd is a registered project, use that
- Calls `DockerManager.stop(project)`

**`jumpsh logs [name]`**
- Looks up project by name/subdomain in DB
- If no name given and cwd is a registered project, use that
- Options: `--follow` (default: true), `--lines=N` (default: 100), `--no-follow`
- Calls `DockerManager.logs(project)` with options
- Pipes stdout/stderr to terminal

**`jumpsh login`**
- Prints: `Remote login is not yet available. Running in localhost mode.`

### 2.4 Exit codes
| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | General error (with message to stderr) |
| 2 | Invalid arguments / unknown command |
| 3 | Project not found |
| 4 | Port conflict (with actionable message) |
| 5 | Docker not available |

### Verification
- [ ] `node bin/jumpsh.js --help` prints usage with all commands
- [ ] `node bin/jumpsh.js add .` in a Node project dir → project in DB
- [ ] `node bin/jumpsh.js ls` shows project
- [ ] `node bin/jumpsh.js remove <name>` removes it; `ls` confirms gone
- [ ] `node bin/jumpsh.js start <name>` → container running
- [ ] `node bin/jumpsh.js stop <name>` → container stopped
- [ ] `node bin/jumpsh.js logs <name>` → output streams
- [ ] `node bin/jumpsh.js ip` → prints IP
- [ ] Unknown command → exit code 2, helpful message

---

## Phase 3 — Daemon & Service Management

### 3.1 Foreground mode
`npx jumpsh` (no subcommand) starts the Express server in-process:
- Binds to `JUMPSH_PORT` (default 5050) or 443 (if HTTPS + low-port capable)
- Starts SubdomainProxy, WorktreeScanner
- Logs to stdout
- On port conflict: prints which process holds the port and exits with code 4

### 3.2 Node path brittleness — wrapper script solution

**Problem:** Hardcoding `process.execPath` into service files breaks when the user updates Node via nvm/mise/fnm (the old binary path disappears).

**Solution:** Generate a thin shell wrapper at `~/.jump.sh/jumpsh-daemon.sh`:

```bash
#!/usr/bin/env bash
# Resolve node from current PATH, supporting version managers
# Order: mise, fnm, nvm, system
for rc in "$HOME/.local/share/mise/activate.sh" \
          "$HOME/.config/mise/activate.sh"; do
  [ -f "$rc" ] && { eval "$(mise activate bash)"; break; }
done
[ -s "$HOME/.fnm/fnm" ] && eval "$(~/.fnm/fnm env)"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

exec node "PACKAGE_ROOT/server.js"
```

- `PACKAGE_ROOT` is resolved at install time via `import.meta.url`
- The service file (plist/systemd) points to this wrapper, not to a node binary
- Wrapper re-resolves node on every daemon start, so version manager changes take effect on next restart
- Wrapper is regenerated by `jumpsh install`

### 3.3 Daemon install — macOS (launchd)

**Plist:** `~/Library/LaunchAgents/sh.jump.daemon.plist`
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>sh.jump.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>~/.jump.sh/jumpsh-daemon.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>~/.jump.sh/logs/daemon.log</string>
  <key>StandardErrorPath</key><string>~/.jump.sh/logs/daemon.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>JUMPSH_HTTPS</key><string>true</string>
    <key>HOME</key><string>/Users/USERNAME</string>
  </dict>
</dict>
</plist>
```

Install: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/sh.jump.daemon.plist`
Uninstall: `launchctl bootout gui/$(id -u)/sh.jump.daemon`

### 3.4 Daemon install — Linux (systemd user unit)

**Unit file:** `~/.config/systemd/user/jumpsh.service`
```ini
[Unit]
Description=jump.sh local dev daemon
After=network.target

[Service]
Type=simple
ExecStart=/bin/bash %h/.jump.sh/jumpsh-daemon.sh
Restart=always
RestartSec=3
Environment=JUMPSH_HTTPS=true

[Install]
WantedBy=default.target
```

Enable: `systemctl --user daemon-reload && systemctl --user enable --now jumpsh`
Disable: `systemctl --user disable --now jumpsh`

### 3.5 Signal handling

The daemon process (whether foreground or service) must handle:

| Signal | Behavior |
|---|---|
| `SIGTERM` | Graceful shutdown: stop accepting connections, wait up to 10s for in-flight requests, close DB, exit 0 |
| `SIGINT` | Same as SIGTERM (Ctrl-C in foreground) |
| `SIGHUP` | Reload configuration (re-read env, re-scan worktrees). Do NOT exit. |

Implementation in `server.js`:
```js
const shutdown = async (signal) => {
  console.log(`Received ${signal}, shutting down...`)
  server.close()
  await db.close()
  // WorktreeScanner cleanup (close FSWatcher instances)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGHUP', () => { /* re-scan worktrees, re-read config */ })
```

Force-kill timeout: if graceful shutdown takes > 10s, `process.exit(1)`.

### 3.6 Daemon lifecycle detection
- Before starting foreground mode, check if `JUMPSH_PORT` is already in use
- Use `net.createServer().listen()` probe — if EADDRINUSE, check `/proc/net/tcp` or `lsof` for the owning PID
- Print: `Port 5050 is already in use by PID 12345. Is the jump.sh daemon already running?`

### Verification
- [ ] macOS: `launchctl print gui/$(id -u)/sh.jump.daemon` shows service
- [ ] Linux: `systemctl --user status jumpsh` shows active
- [ ] Kill daemon process → auto-restarts within 3s
- [ ] After `nvm install <new-version>` + `jumpsh install` → daemon still starts
- [ ] `jumpsh install --uninstall` → service gone, wrapper script gone
- [ ] Foreground mode: Ctrl-C → clean shutdown, exit 0
- [ ] Foreground mode with port in use → exit code 4, actionable message

---

## Phase 4 — Docker & Worktree Preservation

### 4.1 Docker compose file location
- All projects use `.jump.sh/docker-compose.yml` for auto-generated files
- `DockerManager.getComposeFile()` search order:
  1. `<project>/docker-compose.yml` (user-provided)
  2. `<project>/docker-compose.yaml` (user-provided)
  3. `<project>/.jump.sh/docker-compose.yml` (auto-generated)
- No `.localhaus` fallback (not a migration)

### 4.2 ComposeGenerator updates
- Output dir: `.jump.sh/`
- `.dockerignore`: include `.jump.sh` in exclusion list
- Volume mount in generated compose: `..:/app` (correct relative from `.jump.sh/`)

### 4.3 Worktree scanner
- No hardcoded path references to change (reads from DB, watches `.worktrees/` dirs)
- Subdomain convention unchanged: `{parent}--{branch}.jump.sh`
- WorktreeScanner cleanup must happen during signal handling (close FSWatcher instances)

### 4.4 Container naming
- Uses `container_name: ${project.subdomain}` — unchanged, subdomain comes from DB

### Verification
- [ ] `jumpsh add .` in a project → `.jump.sh/docker-compose.yml` and `.jump.sh/Dockerfile` created
- [ ] `docker compose -f .jump.sh/docker-compose.yml up` works
- [ ] Worktree added → appears in `jumpsh ls` with branch-based subdomain
- [ ] `jumpsh start` on worktree project → container starts with correct name

---

## Phase 5 — TLS / Certificate Strategy

### 5.1 Localhost mode (MVP)
Use mkcert to generate local certs:

```bash
mkcert -cert-file ~/.jump.sh/certs/server.pem \
       -key-file ~/.jump.sh/certs/server-key.pem \
       "*.jump.sh" "jump.sh" "localhost" "127.0.0.1" "::1"
```

- `mkcert -install` adds local CA to system trust store
- Certs stored at `~/.jump.sh/certs/`
- `jumpsh install` generates these certs as part of setup

### 5.2 Server TLS config
- `server.js` reads `JUMPSH_CERT_PATH` (default `~/.jump.sh/certs`)
- If certs exist and `JUMPSH_HTTPS=true`: HTTPS server on configured port
- If certs missing: HTTP fallback with warning
- Future remote mode: env vars point to externally-provided certs — no code changes needed

### 5.3 Low-port binding (Linux)
- `scripts/enable-low-port-bind-linux.sh` grants `cap_net_bind_service` to node binary
- Run during `jumpsh install` if `JUMPSH_PORT` < 1024
- If setcap fails (e.g., no sudo): fall back to high port, print warning

### Verification
- [ ] After `jumpsh install`: cert files exist at `~/.jump.sh/certs/`
- [ ] `openssl x509 -in ~/.jump.sh/certs/server.pem -text` shows `*.jump.sh` SAN
- [ ] HTTPS server starts; `curl -v https://localhost:443` shows valid cert
- [ ] Without certs: server starts on HTTP with warning message

---

## Phase 6 — State & Database

### 6.1 Location
`~/.jump.sh/projects.db` — created fresh on first run. No migration from `.localhaus`.

### 6.2 Directory structure
```
~/.jump.sh/
├── projects.db                 # SQLite database
├── certs/
│   ├── server.pem              # mkcert wildcard cert
│   └── server-key.pem          # mkcert private key
├── logs/
│   ├── daemon.log              # Daemon stdout (rotated)
│   ├── daemon.err              # Daemon stderr (rotated)
│   └── dev.log                 # Structured application log (rotated)
└── jumpsh-daemon.sh            # Wrapper script for service startup
```

### 6.3 Schema
Unchanged from current `projects` table. The `ALTER TABLE ADD COLUMN assigned_port` migration-on-startup pattern continues.

### 6.4 DB access mode
- Enable WAL mode on open: `PRAGMA journal_mode=WAL`
- This allows concurrent reads (CLI `ls` while daemon is running) without locking
- CLI write commands (`add`, `remove`) use short transactions

### Verification
- [ ] Fresh start: `~/.jump.sh/projects.db` created
- [ ] `jumpsh add` + `jumpsh ls` → data round-trips correctly
- [ ] WAL mode active: `sqlite3 ~/.jump.sh/projects.db "PRAGMA journal_mode"` → `wal`

---

## Port Conflict Strategy

Port conflicts can occur at two levels: the daemon port and per-project container ports.

### Daemon port (`JUMPSH_PORT`)
1. Before `server.listen()`, probe the port with a throwaway `net.createServer()`
2. If `EADDRINUSE`:
   - Identify the owning process: parse `lsof -i :PORT -t` (macOS/Linux)
   - If it's another jumpsh instance: print `jump.sh daemon is already running (PID XXXX). Use 'jumpsh stop' or kill it first.`
   - If it's something else: print `Port PORT is in use by process XXXX (PROCESSNAME). Set JUMPSH_PORT=OTHERPORT or stop the conflicting process.`
   - Exit code 4
3. Never silently pick a different daemon port — the daemon port must be predictable for the proxy to work

### Per-project container ports (10000–10999 range)
1. `Database.getNextPort()` already finds gaps in the allocated range and verifies with `get-port`
2. Enhancement: if the entire 10000–10999 range is exhausted, extend to 11000–11999 and print a notice
3. If `docker compose up` fails due to port conflict (host port already bound):
   - Detect from stderr: `Bind for 0.0.0.0:PORT failed: port is already allocated`
   - Deallocate the port in DB
   - Retry once with a new port (regenerate compose file)
   - If retry fails: print error with the conflicting port and exit code 4

### Port allocation on `jumpsh remove`
- When removing a project, release its `assigned_port` (set to NULL in DB, or delete the row)
- This returns the port to the pool for future projects

---

## Logging & Rotation Strategy

### Daemon logs (`~/.jump.sh/logs/`)

**`daemon.log`** — stdout from the daemon process (captured by launchd/systemd)
**`daemon.err`** — stderr from the daemon process

**Rotation policy:**
- On macOS (launchd): launchd does not rotate. The daemon itself handles rotation:
  - Check file size on startup and every 6 hours
  - If > 10 MB: rename to `daemon.log.1`, start fresh
  - Keep at most 3 rotated files (`daemon.log.1`, `.2`, `.3`)
- On Linux (systemd): stdout/stderr go to journal by default. The unit file can redirect to files if preferred, but `journalctl --user -u jumpsh` is the primary interface. Rotation handled by journald config.

**`dev.log`** — structured application-level log (JSON lines format):
- Written by the daemon for events: project added/removed, container start/stop/crash, port allocation, worktree scan results, errors
- Rotation: same policy as `daemon.log` — 10 MB max, 3 rotated files
- Format: `{"ts":"ISO8601","level":"info|warn|error","msg":"...","data":{...}}`

### Per-project container logs
- Container logs are managed by Docker's logging driver (default: `json-file`)
- `jumpsh logs <name>` reads from Docker, not from files
- The generated `docker-compose.yml` should set logging options:
  ```yaml
  logging:
    driver: json-file
    options:
      max-size: "10m"
      max-file: "3"
  ```
  This prevents runaway container logs from filling disk.

### Foreground mode logging
- When running `npx jumpsh` (foreground), all output goes to stdout/stderr directly
- `dev.log` is still written (same events), so `jumpsh logs` for the daemon itself can reference it
- No rotation needed for terminal output

### Verification
- [ ] `daemon.log` exists after daemon runs for a few seconds
- [ ] `dev.log` has JSON lines after adding a project
- [ ] After generating > 10 MB of log data: rotation kicks in, old file renamed
- [ ] Container logs capped at 10 MB × 3 files (inspect via `docker inspect`)
- [ ] `journalctl --user -u jumpsh` works on Linux

---

## Rollout Order

| Order | Phase | Dependencies | Summary |
|---|---|---|---|
| 1 | Phase 1 (Rename) | None | Mechanical find/replace, delete DNS scripts |
| 2 | Phase 6 (State/DB) | Phase 1 | Fresh DB at `~/.jump.sh/projects.db`, WAL mode |
| 3 | Phase 5 (TLS) | Phase 1 | mkcert cert generation, HTTPS server |
| 4 | Phase 2 (CLI) | Phases 1, 6 | All commands including `remove` |
| 5 | Phase 4 (Docker/Worktree) | Phase 1 | Compose paths, worktree preservation |
| 6 | Phase 3 (Daemon) | Phase 2 | Service files, wrapper script, signal handling |

**Cross-cutting (woven into all phases):**
- Port conflict handling (Phase 2 CLI + Phase 3 daemon + Phase 4 Docker)
- Logging/rotation (Phase 3 daemon + Phase 4 Docker)
- Signal handling (Phase 3 daemon)

---

## Test / Verification Checklist

### After Phase 1 (Rename)
- [ ] `grep -ri 'localhaus' --include='*.js' --include='*.sh' --include='*.ejs' --include='*.json' --include='*.css'` → zero hits
- [ ] `scripts/setup-macos.sh` and `scripts/setup-linux.sh` deleted
- [ ] Server starts with `JUMPSH_PORT=5050 node server.js`
- [ ] Dashboard loads at `http://localhost:5050`

### After Phase 6 (State/DB)
- [ ] `~/.jump.sh/projects.db` created on first run
- [ ] WAL mode enabled
- [ ] No `~/.localhaus` references anywhere in code

### After Phase 5 (TLS)
- [ ] Cert generation works: `~/.jump.sh/certs/server.pem` exists
- [ ] HTTPS server starts on configured port
- [ ] Missing certs → HTTP fallback with warning

### After Phase 2 (CLI)
- [ ] All 9 commands work: `add`, `remove`, `install`, `login`, `ip`, `ls`, `start`, `stop`, `logs`
- [ ] `--help` prints usage
- [ ] Exit codes match spec (0–5)
- [ ] `remove --force` stops running containers before removing
- [ ] `remove --clean` deletes `.jump.sh/` dir

### After Phase 4 (Docker/Worktree)
- [ ] New project → `.jump.sh/docker-compose.yml` generated with log rotation config
- [ ] Worktree URLs: `app--branch` subdomain registered
- [ ] Container starts with correct port mapping

### After Phase 3 (Daemon)
- [ ] `jumpsh install` → service running, wrapper script at `~/.jump.sh/jumpsh-daemon.sh`
- [ ] `jumpsh install --uninstall` → service removed, wrapper removed
- [ ] Daemon auto-restarts after crash (kill -9)
- [ ] SIGTERM → graceful shutdown within 10s
- [ ] SIGINT → same as SIGTERM
- [ ] SIGHUP → worktree rescan (no exit)
- [ ] Port conflict → exit 4 with PID info
- [ ] Log rotation: files stay under 10 MB

### End-to-end
- [ ] `npx jumpsh install` → certs + daemon running
- [ ] `cd ~/my-project && npx jumpsh add .` → project registered
- [ ] `npx jumpsh start my-project` → container running
- [ ] `npx jumpsh logs my-project` → live output
- [ ] `npx jumpsh stop my-project` → container stopped
- [ ] `npx jumpsh remove my-project --clean` → DB row gone, `.jump.sh/` dir gone
- [ ] `npx jumpsh install --uninstall` → clean system
- [ ] Reboot → daemon auto-starts

---

## Risks & Mitigations

### R1: mkcert not installed or unavailable
**Risk:** `jumpsh install` cannot generate certs.
**Mitigation:** Check for `mkcert` at start of `install`. If missing: print platform-specific install instructions (`brew install mkcert`, `sudo apt install mkcert`, etc.) and exit with clear error. Do not attempt to auto-install system packages.

### R2: Docker not running or not installed
**Risk:** `jumpsh start` fails opaquely.
**Mitigation:** Check `docker info` before any Docker operation. If Docker is not available, exit code 5 with message: `Docker is not running. Start Docker Desktop or install Docker Engine.`

### R3: SQLite DB locked by concurrent access
**Risk:** CLI command and daemon both write to `projects.db` simultaneously.
**Mitigation:** WAL mode enables concurrent reads. Write commands (`add`, `remove`) are short transactions. SQLite's built-in busy timeout (set to 5000ms) handles rare write contention. For a single-user local tool, this is sufficient.

### R4: Port range exhaustion
**Risk:** All 1000 ports in 10000–10999 allocated (unlikely but possible with many projects).
**Mitigation:** Extend to 11000–11999 with a notice. If that's also full, error with: `No free ports available. Remove unused projects with 'jumpsh remove'.`

### R5: Partial `jumpsh install` failure
**Risk:** Cert generation succeeds but service file write fails (or vice versa), leaving system in inconsistent state.
**Mitigation:** See rollback playbook below.

### R6: `setcap` lost after Node update
**Risk:** On Linux, `cap_net_bind_service` is lost when Node binary is replaced by version manager.
**Mitigation:** Daemon startup on port < 1024: if `EACCES`, print `Low-port binding failed. Re-run 'jumpsh install' to fix, or set JUMPSH_PORT=5050.` and exit code 4.

### R7: Wrapper script can't find Node
**Risk:** `jumpsh-daemon.sh` fails to resolve node if version manager setup changes.
**Mitigation:** Wrapper script tries multiple resolution strategies in order (mise, fnm, nvm, system PATH). If none found, writes error to `~/.jump.sh/logs/daemon.err` and exits 1. systemd/launchd will retry (RestartSec=3), giving the user time to fix.

---

## Rollback Playbook

### `jumpsh install` — partial failure recovery

The install command tracks progress through discrete steps. If any step fails, it prints what succeeded and what failed, so the user can re-run or manually clean up.

**Steps and their rollback:**

| Step | Action | Rollback on failure |
|---|---|---|
| 1 | Create `~/.jump.sh/` directory | Remove directory if empty |
| 2 | Generate mkcert certs | Remove `~/.jump.sh/certs/` |
| 3 | Write wrapper script (`jumpsh-daemon.sh`) | Remove the script |
| 4 | Write service file (plist/systemd unit) | Remove the service file |
| 5 | Enable + start service | Disable service, remove service file |
| 6 | (Linux) Run `setcap` for low-port | Print manual instructions; non-fatal |

**Implementation:** Each step is wrapped in try/catch. On failure:
1. Print which step failed and the error
2. Undo completed steps in reverse order
3. Print: `Install failed at step N. The following was cleaned up: [list]. Re-run 'jumpsh install' after fixing the issue.`

### `jumpsh install --uninstall` — cleanup

| Step | Action | Notes |
|---|---|---|
| 1 | Stop daemon service | `launchctl bootout` / `systemctl --user stop` |
| 2 | Disable service | `systemctl --user disable` (Linux) |
| 3 | Remove service file | plist / systemd unit |
| 4 | Remove wrapper script | `~/.jump.sh/jumpsh-daemon.sh` |
| 5 | (Optional, prompted) Remove `~/.jump.sh/` | Deletes DB, certs, logs — asks for confirmation |

If any step fails, continue with remaining steps (best-effort cleanup). Print summary of what was/wasn't removed.

### Manual recovery commands
If automated rollback fails, document these manual steps:

**macOS:**
```bash
launchctl bootout gui/$(id -u)/sh.jump.daemon 2>/dev/null
rm -f ~/Library/LaunchAgents/sh.jump.daemon.plist
rm -f ~/.jump.sh/jumpsh-daemon.sh
# Optional full cleanup:
rm -rf ~/.jump.sh
```

**Linux:**
```bash
systemctl --user stop jumpsh 2>/dev/null
systemctl --user disable jumpsh 2>/dev/null
rm -f ~/.config/systemd/user/jumpsh.service
systemctl --user daemon-reload
rm -f ~/.jump.sh/jumpsh-daemon.sh
# Optional full cleanup:
rm -rf ~/.jump.sh
```

---

## Optional Enhancements

These are not required for MVP but are natural follow-ons. Listed here for future reference.

1. **`jumpsh status`** — Richer than `ls`. Show daemon uptime, port, cert expiry, Docker version, disk usage of containers.

2. **`jumpsh open [name]`** — Open project URL in default browser (`xdg-open` / `open`).

3. **`jumpsh restart [name]`** — Convenience alias for `stop` + `start`.

4. **`jumpsh update`** — Re-detect project type and regenerate `.jump.sh/Dockerfile` + `docker-compose.yml`. Useful after changing frameworks.

5. **Auto-add on `cd`** — Shell hook (bash/zsh) that runs `jumpsh add .` when entering a directory with a recognized project that isn't registered yet. Opt-in via `jumpsh shell-hook`.

6. **Health checks** — Add Docker healthcheck to generated compose files. Surface health status in `jumpsh ls`.

7. **Remote mode scaffolding** — `jumpsh login` connects to jump.sh cloud service, receives a subdomain allocation (`user.jump.sh`), and configures DNS + TLS via API. This replaces mkcert with real certs.

8. **Tab completion** — Generate bash/zsh/fish completions for project names in `start`, `stop`, `logs`, `remove`.

9. **Config file** — `~/.jump.sh/config.json` for persistent settings (default port, preferred port range, auto-start projects on daemon boot).

10. **`jumpsh doctor`** — Diagnostic command that checks: Docker running, certs valid, port available, DB writable, service installed. Prints pass/fail for each.
