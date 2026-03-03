# jump.sh

Local dev server with Docker containers + automatic subdomain routing.

**No more remembering port numbers.** Just `my-project.jump.sh`.

## Features

- **Subdomain routing** — Access projects at `project-name.jump.sh` instead of `localhost:3847`
- **Remote routing** — Register with the control plane for `*.username.jump.sh` access
- **Docker-based** — Reliable start/stop, no orphan processes
- **Git worktree support** — Auto-discovers `.worktrees/`, creates `project--branch.jump.sh` URLs
- **Live logs** — Stream container logs in the dashboard
- **Zero config for projects** — Just point to a directory; jump.sh auto-detects the stack

## Quick Start

```bash
# Install
npx jump.sh install

# Add a project
cd ~/my-project
npx jump.sh add .

# Start it
npx jump.sh start my-project

# Open in browser
open https://my-project.jump.sh
```

## Requirements

- Node.js 18+
- Docker + Docker Compose v2
- macOS or Linux

## CLI Commands

```
jump.sh                    Run daemon in foreground
jump.sh add [path]         Register a project (default: current directory)
jump.sh remove <name>      Unregister a project
jump.sh install            Install daemon service + download certs
jump.sh install --uninstall  Remove daemon service
jump.sh certs              Download TLS certificates
jump.sh ls                 List projects with status
jump.sh start [name]       Start project containers
jump.sh stop [name]        Stop project containers
jump.sh logs [name]        Tail project logs
jump.sh ip                 Print LAN IP address
jump.sh login              Authenticate with remote control plane
jump.sh register           Register machine for remote routing
jump.sh status             Show machine + route sync status
jump.sh sync               Fetch remote routes
```

## Configuration

Copy `.env.example` to `.env`:

```env
JUMPSH_HTTPS=true
JUMPSH_PORT=4443
JUMPSH_DOMAIN=jump.sh
JUMPSH_CERT_PATH=~/.jump.sh/certs
```

### HTTPS Setup

Certificates are downloaded from the jump.sh server:

```bash
jump.sh certs
```

This fetches `server.pem` and `server-key.pem` into `~/.jump.sh/certs/`.
`jump.sh install` also downloads certs automatically when `JUMPSH_HTTPS=true`.

The download endpoint is configurable via `JUMPSH_ORIGIN` (default: `https://jump.sh`).

**Linux only:** To bind port 443, Node.js needs low-port capability:
```bash
scripts/enable-low-port-bind-linux.sh
```
macOS does not need this step. If you prefer not to use a privileged port, set `JUMPSH_PORT=5050`.

## Project Setup

Each project needs a `docker-compose.yml`, or jump.sh will auto-generate one:

- **Node.js** — detects `package.json`, package manager (npm/yarn/pnpm/bun), framework (vite/next/nuxt)
- **Python** — detects `requirements.txt` or `pyproject.toml`, framework (FastAPI/Flask/Django)
- **Manual** — provide your own `docker-compose.yml` for full control

Auto-generated files live in `.jump.sh/` inside your project directory.

## Worktrees

jump.sh auto-discovers git worktrees in `.worktrees/`:

```
my-project/
├── .worktrees/
│   ├── feature-auth/     → my-project--feature-auth.jump.sh
│   └── bugfix-login/     → my-project--bugfix-login.jump.sh
├── docker-compose.yml
└── ...
```

URLs use double-dash as separator: `my-project--feature-auth.jump.sh`

## Remote Routing

Connect your local projects to the jump.sh control plane for remote access:

```bash
# Authenticate
jump.sh login --token <YOUR_TOKEN>

# Register this machine
jump.sh register

# Sync remote routes
jump.sh sync

# Check status
jump.sh status
```

Projects are accessible at `project-name.username.jump.sh` (configurable via `JUMPSH_REMOTE_DOMAIN`).
The daemon automatically syncs routes every 30 seconds when logged in.

## Log Locations

- **Global daemon logs** — `~/.jump.sh/logs/daemon.log` and `daemon.err` (stdout/stderr from the daemon process)
- **Per-project dev log** — `<project>/dev.log` (project-specific events: container start/stop/errors)

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                     jump.sh                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │  Dashboard  │  │   Docker    │  │  Subdomain  │  │
│  │     UI      │  │   Manager   │  │    Proxy    │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  │
└─────────────────────────────────────────────────────┘
         │                 │                 │
         ▼                 ▼                 ▼
    Project CRUD    docker compose     my-app.jump.sh
    Start/Stop       up/down/logs      → container:port
```

## Reproducible Lifecycle Proof

Run the full create → start → proxy → logs → stop → delete lifecycle in an isolated Docker environment:

```bash
npm run test:lifecycle
```

Requires Docker with compose plugin. No other dependencies — the test builds its own localhaus image, starts a fixture container, runs 11 assertions, and cleans up.

## License

MIT
