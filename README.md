# 🏠 Localhaus

Local dev server dashboard with Docker containers + automatic subdomain routing.

**No more remembering port numbers.** Just `my-project.localhost`.

## Features

- **Subdomain routing** — Access projects at `project-name.localhost` instead of `localhost:3847`
- **Docker-based** — Reliable start/stop, no orphan processes
- **Git worktree support** — Auto-discovers `.worktrees/`, creates `project--branch.localhost` URLs
- **Live logs** — Stream container logs in the dashboard
- **Zero config for projects** — Just point to a directory with `docker-compose.yml`

## Quick Start

```bash
# Install
git clone https://github.com/localhaus/localhaus
cd localhaus
npm install

# Setup DNS + HTTPS certs (one-time)
scripts/setup-macos.sh   # or setup-linux.sh

# Configure
cp .env.example .env

# Run
npm run dev

# Open dashboard
open https://localhaus.localhost
```

## Requirements

- Node.js 18+
- Docker + Docker Compose v2
- macOS or Linux (Windows via WSL)

## Subdomain Setup

For `*.localhost` subdomains to work, you need wildcard DNS + HTTPS.

### macOS

```bash
# Install dnsmasq
brew install dnsmasq

# Configure wildcard
echo "address=/.localhost/127.0.0.1" >> $(brew --prefix)/etc/dnsmasq.conf

# Start dnsmasq
sudo brew services start dnsmasq

# Point macOS to use dnsmasq for .localhost
sudo mkdir -p /etc/resolver
echo "nameserver 127.0.0.1" | sudo tee /etc/resolver/localhost

# Install mkcert for HTTPS
brew install mkcert
mkcert -install
mkcert "*.localhost" localhost 127.0.0.1
```

### Linux

```bash
# Install dnsmasq
sudo apt install dnsmasq

# Configure wildcard
echo "address=/.localhost/127.0.0.1" | sudo tee /etc/dnsmasq.d/localhost.conf
sudo systemctl restart dnsmasq

# Install mkcert
# See: https://github.com/FiloSottile/mkcert#installation
mkcert -install
mkcert "*.localhost" localhost 127.0.0.1
```

## Configuration

Copy `.env.example` to `.env`:

```env
LOCALHAUS_HTTPS=true
LOCALHAUS_PORT=443
LOCALHAUS_DOMAIN=localhost
LOCALHAUS_CERT_PATH=~/.localhaus/certs
```

### No-Port HTTPS (Recommended)

For clean URLs like `https://localhaus.localhost` and `https://my-app.localhost`:

1. Run the setup script for your platform:
   ```bash
   scripts/setup-macos.sh   # macOS
   scripts/setup-linux.sh   # Linux
   ```

2. Set `LOCALHAUS_HTTPS=true` and `LOCALHAUS_PORT=443` in `.env`.

3. **Linux only:** Node.js needs permission to bind port 443:
   ```bash
   scripts/enable-low-port-bind-linux.sh
   ```
   This runs `setcap cap_net_bind_service=+ep` on the node binary (requires sudo).
   macOS does not need this step.

4. If you prefer not to use a privileged port, set `LOCALHAUS_PORT=5050` instead.
   URLs will include the port: `https://localhaus.localhost:5050`.

## Project Setup

Each project needs a `docker-compose.yml`, or localhaus will auto-generate one:

- **Node.js** — detects `package.json`, package manager (npm/yarn/pnpm/bun), framework (vite/next/nuxt)
- **Python** — detects `requirements.txt` or `pyproject.toml`, framework (FastAPI/Flask/Django)
- **Manual** — provide your own `docker-compose.yml` for full control

Auto-generated files live in `.localhaus/` inside your project directory.

## Worktrees

Localhaus auto-discovers git worktrees in `.worktrees/`:

```
my-project/
├── .worktrees/
│   ├── feature-auth/     → feature-auth.my-project.localhost
│   └── bugfix-login/     → bugfix-login.my-project.localhost
├── docker-compose.yml
└── ...
```

URLs follow the pattern: `{branch}.{project}.{domain}` using double-dash as separator:
- `my-project--feature-auth.localhost`

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Localhaus                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │  Dashboard  │  │   Docker    │  │  Subdomain  │  │
│  │     UI      │  │   Manager   │  │    Proxy    │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  │
└─────────────────────────────────────────────────────┘
         │                 │                 │
         ▼                 ▼                 ▼
    Project CRUD    docker compose     my-app.localhost
    Start/Stop       up/down/logs      → container:port
```

## License

MIT
