# jump.sh

Local dev server with Docker containers + automatic subdomain routing.

**No more remembering port numbers.** Just `my-project.jump.sh`.

## Features

- **Subdomain routing** — Access projects at `project-name.jump.sh` instead of `localhost:3847`
- **Docker-based** — Reliable start/stop, no orphan processes
- **Git worktree support** — Auto-discovers `.worktrees/`, creates `project--branch.jump.sh` URLs
- **Live logs** — Stream container logs in the dashboard
- **Zero config for projects** — Just point to a directory; jump.sh auto-detects the stack

## Quick Start

```bash
# Install
npx jumpsh install

# Add a project
cd ~/my-project
npx jumpsh add .

# Start it
npx jumpsh start my-project

# Open in browser
open https://my-project.jump.sh
```

## Requirements

- Node.js 18+
- Docker + Docker Compose v2
- macOS or Linux

## CLI Commands

```
jumpsh                    Run daemon in foreground
jumpsh add [path]         Register a project (default: current directory)
jumpsh remove <name>      Unregister a project
jumpsh install            Install daemon service
jumpsh install --uninstall  Remove daemon service
jumpsh ls                 List projects with status
jumpsh start [name]       Start project containers
jumpsh stop [name]        Stop project containers
jumpsh logs [name]        Tail project logs
jumpsh ip                 Print LAN IP address
jumpsh login              (Future) Remote authentication
```

## Configuration

Copy `.env.example` to `.env`:

```env
JUMPSH_HTTPS=true
JUMPSH_PORT=443
JUMPSH_DOMAIN=jump.sh
JUMPSH_CERT_PATH=~/.jump.sh/certs
```

### HTTPS Setup

HTTPS requires cert files at `~/.jump.sh/certs/` (`server.pem` and `server-key.pem`).
Set `JUMPSH_HTTPS=true` in `.env`. If certs are missing, the server falls back to HTTP.

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

## License

MIT
