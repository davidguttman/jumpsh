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
jump.sh uninstall          Remove daemon service (keeps ~/.jump.sh state)
jump.sh upgrade            Upgrade jump.sh itself (keeps ~/.jump.sh state)
jump.sh certs              Download TLS certificates
jump.sh ls                 List projects with status
jump.sh prune worktrees    Prune stale registered worktree records (dry-run by default)
jump.sh start [name]       Start project containers
jump.sh stop [name]        Stop project containers
jump.sh restart [name]     Restart project containers
jump.sh logs [name]        Tail project logs
jump.sh status             Show daemon and domain status
jump.sh ip                 Print LAN IP address
jump.sh register           Register machine for remote routing
```

### Agent / Scripting Mode

Most commands accept `--json` for machine-readable output:

```bash
jump.sh ls --json                       # all projects + status
jump.sh status --json                   # daemon and domain status
jump.sh start my-app --json             # start, JSON result
jump.sh stop my-app --json              # stop, JSON result
jump.sh restart my-app --json           # restart, JSON result
jump.sh add . --json                    # detection only (dry-run)
jump.sh add . --json --yes              # create project + JSON result
jump.sh prune worktrees --json          # preview stale worktree records
jump.sh prune worktrees --json --yes    # prune stale worktree DB records
```

When run inside a registered project's directory, `start`, `stop`, `restart`,
and `logs` resolve the project from `cwd` automatically — no name required.

## Configuration

Copy `.env.example` to `.env`:

```env
JUMPSH_HTTPS=true
JUMPSH_PORT=4443
JUMPSH_DOMAIN=jump.sh
JUMPSH_CERT_PATH=~/.jump.sh/certs
JUMPSH_DASHBOARD_HOST=dash.jump.sh
```

### Management security

The dashboard, management APIs, static assets, logs, and event streams require authentication. `jump.sh install` creates a random token at `~/.jump.sh/management-token`; daemon startup creates it lazily for existing upgrades. The state directory uses mode `0700` and the token file uses `0600` where supported. Existing tokens are preserved, and CLI daemon requests send the token automatically as a bearer credential.

Browsers use standard HTTP Basic authentication once per browser session: username `jump`, password the contents of `~/.jump.sh/management-token`. `jump.sh open` prints the username and token-file location without printing the token or embedding credentials in the URL. After upgrading, existing dashboard tabs receive `401` until Basic authentication is entered. Use HTTPS for the dashboard. Only the exact configured dashboard host is accepted, and `X-Forwarded-Host` is ignored, so reverse proxies must preserve the original `Host` header.

Project app subdomains remain public while running. Opening a stopped project returns `503` and never starts it or changes its desired state. jump.sh-owned published ports bind to `127.0.0.1` and are exposed publicly only through the hostname proxy.

### HTTPS Setup

Certificates are downloaded from the jump.sh server:

```bash
jump.sh certs
```

This fetches `server.pem` and `server-key.pem` into `~/.jump.sh/certs/`.
`jump.sh install` also downloads certs automatically when `JUMPSH_HTTPS=true`.

### Upgrading jump.sh

Use the first-class upgrade command:

```bash
jump.sh upgrade
```

`jump.sh upgrade` preserves `~/.jump.sh`, projects, certificates, and registration. It removes only the current daemon service/wrapper, then reinstalls the daemon against the right package source:

- npx/transient installs trampoline to `npx --yes jump.sh@latest install`
- global npm installs run `npm install -g jump.sh@latest`, then `jump.sh install`
- local checkouts reinstall the daemon from the checkout without mutating global npm

Use `jump.sh upgrade --dry-run` to preview the daemon-only removal and reinstall plan.

The download endpoint is configurable via `JUMPSH_ORIGIN` (default: `https://jump.sh`).

### API Certificate Renewal Scheduling

The hosted jump.sh API stores per-user wildcard certificates in DNS TXT records. The API server does **not** run renewal checks inside the web process; production deployments must schedule the renewal job explicitly.

Preferred production setup is a Google Cloud Scheduler HTTP job that calls the API endpoint:

```http
POST https://<api-host>/api/jobs/renew-certs
Authorization: Bearer <JUMPSH_RENEW_CERTS_SECRET>
```

Configure the API with a strong shared secret:

```env
JUMPSH_RENEW_CERTS_SECRET=generate-a-long-random-value
```

Then configure Cloud Scheduler with the same value in the `Authorization` header. This endpoint intentionally uses the shared secret only; no OIDC setup is required. If the API secret is missing, the endpoint returns `503` and will not run publicly. A bad or missing request secret returns `401`.

Production checklist:

- Schedule the HTTP job at least daily. Twice daily is preferred so certbot/GCP/transient failures have time to recover before the 30-day renewal window closes.
- Run the API with the usual renewal credentials (`JUMP_DOMAIN`, `GCP_DNS_ZONE`, Google DNS credentials, and certbot DNS plugin access).
- Alert on non-2xx scheduler responses. The endpoint returns `500` when the renewal summary has `failed > 0`, and `409` when a previous renewal is still running.
- Confirm deployment platform scheduler config before shipping API changes; without this job, existing user certificates can expire even though registration continues to work.

Manual fallback commands are still available:

```bash
npm run api:cert:renew      # from the repo root
npm run cert:renew          # from ./api
```

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
