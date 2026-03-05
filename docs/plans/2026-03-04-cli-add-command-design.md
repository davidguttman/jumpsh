# CLI `add` Command Design

**Date:** 2026-03-04
**Status:** Approved

## Overview

Add a CLI `jump.sh add` command with full feature parity to the web UI, plus LLM-friendly documentation and a sync mechanism to keep CLI and web UI in alignment.

## Goals

1. CLI-only project creation (no browser required)
2. All web UI options available as CLI flags
3. Auto-detection with optional overrides
4. LLM/agent-friendly output and documentation
5. Single source of truth for field definitions

## Usage

```bash
# Interactive (detect, confirm, create)
jump.sh add [path]

# Non-interactive with explicit name
jump.sh add [path] --name my-app

# Detection only (JSON output for LLMs)
jump.sh add [path] --json

# Full override example
jump.sh add . --name my-app --start "npm run dev" --port 3000 --env API_URL=http://localhost:8080
```

## CLI Options

| Flag | Short | Description |
|------|-------|-------------|
| `--name` | `-n` | Project name (required; defaults to folder name) |
| `--build` | | Build/install command override |
| `--start` | | Start/dev command override |
| `--port` | `-p` | Port override |
| `--image` | | Docker image override |
| `--env` | `-e` | Environment variable KEY=value (repeatable) |
| `--yes` | `-y` | Skip confirmation prompt |
| `--json` | | Output detection result as JSON (no create) |
| `--help` | `-h` | Show help |

## Implementation

### File: `lib/commands/add.js`

```javascript
export default async function add(argv) {
  // 1. Parse arguments
  // 2. Resolve path (default: cwd)
  // 3. Run detection via ProjectDetector
  // 4. If --json: output JSON and exit
  // 5. Apply overrides from flags
  // 6. If not --yes: show summary and confirm
  // 7. POST to /projects endpoint OR call db.createProject directly
  // 8. Report success with URL
}
```

### API vs Direct DB

Use the HTTP API (`POST /projects`) rather than calling `db.createProject` directly:
- Single source of truth for validation
- Includes duplicate path check
- Auto-starts container after creation
- Consistent error handling

The CLI will `fetch('http://localhost:<port>/projects')` when daemon is running,
or report "daemon not running" and suggest `jump.sh install` or `jump.sh server`.

### Schema File: `lib/project-schema.js`

Shared field definitions for CLI validation and documentation generation:

```javascript
export const PROJECT_FIELDS = {
  name: {
    required: true,
    type: 'string',
    description: 'Project name (used for subdomain)',
    cliFlag: '--name, -n',
  },
  path: {
    required: true,
    type: 'string',
    description: 'Absolute path to project directory',
  },
  override_build_command: {
    required: false,
    type: 'string',
    description: 'Build/install command (e.g., "npm install")',
    cliFlag: '--build',
  },
  override_start_command: {
    required: false,
    type: 'string',
    description: 'Start/dev command (e.g., "npm run dev")',
    cliFlag: '--start',
  },
  override_port: {
    required: false,
    type: 'number',
    description: 'Port the dev server listens on',
    cliFlag: '--port, -p',
  },
  override_docker_image: {
    required: false,
    type: 'string',
    description: 'Docker image (e.g., "node:20-slim")',
    cliFlag: '--image',
  },
  override_env: {
    required: false,
    type: 'array',
    items: { key: 'string', value: 'string' },
    description: 'Environment variable overrides',
    cliFlag: '--env, -e (repeatable)',
  },
};
```

## JSON Output Format

For `--json` flag (LLM-friendly):

```json
{
  "path": "/Users/dev/my-project",
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

## Documentation

### `docs/cli-add.md`

LLM-readable documentation including:
- Full usage examples
- JSON schema for all fields
- Detection behavior
- Error codes and troubleshooting
- Example workflows for agents

## Testing

Add to `test/cli.test.js`:

1. `add --help` prints help
2. `add --json` outputs valid JSON with detection
3. `add` with missing path shows error
4. `add` with duplicate path shows error
5. `add --name --yes` creates project (mock API)

## Success Criteria

- [ ] `jump.sh add .` creates project interactively
- [ ] `jump.sh add . --name foo --yes` creates non-interactively
- [ ] `jump.sh add . --json` outputs detection JSON
- [ ] All web UI options available as flags
- [ ] `docs/cli-add.md` exists with full documentation
- [ ] Tests pass for new command
