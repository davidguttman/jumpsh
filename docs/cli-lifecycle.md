# jump.sh start / stop / restart

Control a registered project's containers via the jump.sh daemon API.

## Usage

```bash
jump.sh start   [name] [--json]
jump.sh stop    [name] [--json]
jump.sh restart [name] [--json]
```

`name` is the project name or subdomain. If omitted, the project is resolved
from the current working directory (matching the `logs` command convention).

## Options

| Flag | Description |
|------|-------------|
| `--json` | Emit machine-readable JSON output |
| `--help`, `-h` | Show help |

## Behavior

These commands talk to the local jump.sh daemon (`https://dash.<domain>`):

- `start` → `POST /projects/:id/start` — also auto-starts known worktrees
- `stop` → `POST /projects/:id/stop` — also auto-stops known worktrees
- `restart` → `POST /projects/:id/restart` — stop + start, including worktrees

The daemon must be running. If not, the command exits non-zero with a clear
`DAEMON_NOT_RUNNING` error.

## JSON Output

Success:

```json
{
  "ok": true,
  "action": "start",
  "id": 7,
  "name": "my-app",
  "subdomain": "my-app",
  "url": "https://my-app.jump.sh",
  "status": "started",
  "health": "starting"
}
```

Failure:

```json
{
  "ok": false,
  "action": "start",
  "name": "my-app",
  "subdomain": "my-app",
  "error": "Project is already starting",
  "code": "HTTP_409"
}
```

When the daemon returns a build log on failure, it is included as
`"buildLog": "..."`.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Daemon error or daemon not running |
| 2 | No project name given and cwd is not a registered project |
| 3 | Named project not found |

## Agent Workflow

```bash
# Start a project and wait for the JSON ack
result=$(jump.sh start my-app --json)
ok=$(echo "$result" | jq -r '.ok')
if [ "$ok" = "true" ]; then
  url=$(echo "$result" | jq -r '.url')
  echo "Running at $url"
fi
```
