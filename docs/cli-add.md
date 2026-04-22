# jump.sh add

Add a project to jump.sh from the command line. Auto-detects project type, framework, dev command, and port.

## Usage

```bash
jump.sh add [path] [options]
```

**path** defaults to the current directory (`.`).

## Options

| Flag | Short | Type | Description |
|------|-------|------|-------------|
| `--name` | `-n` | string | Project name (default: folder name) |
| `--build` | | string | Build/install command override |
| `--start` | | string | Start/dev command override |
| `--port` | `-p` | number | Port override |
| `--image` | | string | Docker image override |
| `--env` | `-e` | string | Environment variable `KEY=value` (repeatable) |
| `--yes` | `-y` | boolean | Skip confirmation prompt |
| `--json` | | boolean | Emit JSON. Without `--yes`: detection only. With `--yes`: create + JSON result. |
| `--help` | `-h` | boolean | Show help |

## Examples

### Interactive (detect, confirm, create)
```bash
jump.sh add .
```

### Non-interactive
```bash
jump.sh add . --name my-app --yes
```

### Detection only (dry-run, for LLMs/agents)
```bash
jump.sh add . --json
```

### Create + JSON result (for LLMs/agents)
```bash
jump.sh add . --name my-app --json --yes
```

### Full override
```bash
jump.sh add . \
  --name my-app \
  --start "npm run dev" \
  --build "npm install" \
  --port 3000 \
  --image node:20-slim \
  --env API_URL=http://localhost:8080 \
  --env DEBUG=true \
  --yes
```

## JSON Output Format

### Detect (`--json` without `--yes`)

```json
{
  "path": "/absolute/path/to/project",
  "detected": {
    "type": "node",
    "framework": "vite",
    "devCommand": "npm run dev -- --host",
    "port": 5173,
    "installCommand": "npm install",
    "dockerImage": "node:20-slim",
    "packageManager": { "name": "npm", "lockFile": "package-lock.json" }
  },
  "suggested": {
    "name": "my-project",
    "subdomain": "my-project"
  }
}
```

### Create (`--json --yes`)

```json
{
  "ok": true,
  "action": "add",
  "id": 7,
  "name": "my-project",
  "subdomain": "my-project",
  "path": "/absolute/path/to/project",
  "url": "https://my-project.jump.sh",
  "detected": { "...": "..." }
}
```

On failure (daemon not running, duplicate, etc.):

```json
{
  "ok": false,
  "action": "add",
  "error": "...",
  "code": "DAEMON_NOT_RUNNING | DUPLICATE_PATH | DUPLICATE_NAME | ..."
}
```

## API Fields

The CLI maps flags to the following API fields when POSTing to `/projects`:

| CLI Flag | API Field | Type |
|----------|-----------|------|
| `--name` | `name` | string (required) |
| (path arg) | `path` | string (required) |
| `--build` | `override_build_command` | string |
| `--start` | `override_start_command` | string |
| `--port` | `override_port` | number |
| `--image` | `override_docker_image` | string |
| `--env` | `override_env` | JSON array of `{key, value}` |

## Detected Project Types

| Type | Detected By | Frameworks |
|------|-------------|------------|
| node | `package.json` | next, vite, nuxt, astro, eleventy |
| python | `requirements.txt`, `pyproject.toml` | django, flask, fastapi |
| ruby | `Gemfile` | rails |
| go | `go.mod` | - |
| php | `composer.json`, `*.php` | laravel, symfony |
| static | `index.html` only | - |

## Error Codes

| Code | Meaning |
|------|---------|
| `MISSING_FIELDS` | Name or path not provided |
| `DUPLICATE_PATH` | Directory already registered |
| `DUPLICATE_SUBDOMAIN` | Subdomain already in use |
| `DUPLICATE_NAME` | Project name already exists |

## Requirements

- jump.sh daemon must be running (`jump.sh install` or `jump.sh server`)
- Project path must be a valid directory

## Agent Workflow

For automated project setup:

```bash
# 1. Detect project type
result=$(jump.sh add /path/to/project --json)

# 2. Parse detection
type=$(echo "$result" | jq -r '.detected.type')
port=$(echo "$result" | jq -r '.detected.port')

# 3. Create with overrides if needed
jump.sh add /path/to/project --name my-app --port "$port" --yes
```
