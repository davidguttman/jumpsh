# Localhaus Build-Out Design

**Date:** 2026-02-28
**Status:** Approved

## Overview

Complete the localhaus MVP — a Docker-only local dev server dashboard with subdomain routing.

## Already Implemented (Scaffold)

- Express server with SQLite database
- Project CRUD (add/edit/delete)
- Docker start/stop/logs via `docker compose`
- WorktreeScanner (auto-discovers `.worktrees/`)
- SubdomainProxy (routes subdomain → container port)
- SSE log streaming
- Dashboard UI (EJS + CSS)

## Remaining Work

### 1. Nixpacks Auto-Generation

**Goal:** Projects without `docker-compose.yml` get auto-generated container configs.

**Implementation:**
- Detect project type via file markers:
  - `package.json` → Node.js
  - `requirements.txt` / `pyproject.toml` → Python
  - `go.mod` → Go
- Generate `docker-compose.yml` with:
  - Build context using nixpacks
  - Volume mounts for source (live reload)
  - Exposed port
- Store generated compose in `.localhaus/docker-compose.yml`
- Dev command override for live reload:
  - Node: `npm run dev` (or detect vite/next/etc.)
  - Python: `uvicorn --reload` or `flask run`

### 2. Setup Scripts

**Goal:** One-command setup for wildcard DNS + HTTPS.

#### `scripts/setup-macos.sh`
- Install dnsmasq via Homebrew
- Configure wildcard `*.localhost` → 127.0.0.1
- Create resolver file `/etc/resolver/localhost`
- Install mkcert, generate certs for `*.localhost`
- Output: cert paths to stdout

#### `scripts/setup-linux.sh`
- Install dnsmasq
- Configure `/etc/dnsmasq.d/localhost.conf`
- Install mkcert, generate certs
- Output: cert paths to stdout

### 3. HTTPS Support

**Goal:** Serve dashboard and proxy over HTTPS.

**Implementation:**
- If `LOCALHAUS_HTTPS=true` and certs exist:
  - Create HTTPS server with mkcert certs
  - Proxy to containers over HTTP (containers don't need HTTPS)
- Config:
  ```env
  LOCALHAUS_HTTPS=true
  LOCALHAUS_CERT_PATH=~/.localhaus/certs
  ```

### 4. Nginx Reverse Proxy Config

**Goal:** Optional nginx config for production-like setup.

- Generate `nginx.conf` template with wildcard server block
- Setup script to install and enable

### 5. Polish & Testing

- Test on macOS (dnsmasq + mkcert flow)
- Test worktree URL generation
- Error handling for missing Docker
- Better error pages (container starting, not found, etc.)
- CLI for common operations (`localhaus add`, `localhaus start`)

## Non-Goals (Post-MVP)

- Windows support
- Remote access / Cloudflare Tunnel integration
- Dashboard cards / widgets
- Multi-user / auth
- Automatic port assignment conflicts

## Success Criteria

1. User runs setup script → wildcard DNS + HTTPS works
2. User adds project path → auto-detects and generates compose
3. User clicks "Start" → container runs, subdomain works
4. Worktrees auto-discovered and get their own URLs
5. Logs stream in real-time via SSE
