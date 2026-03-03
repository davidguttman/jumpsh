# jump.sh Design

## Summary
Fork localhaus in-place into jump.sh behavior while preserving Docker-based process management and worktree support. Replace manual local DNS/cert setup with managed jump.sh DNS and TLS distribution.

## Confirmed decisions
- Keep Docker runtime and project lifecycle management
- Keep worktree scanning and branch URL conventions
- Daemon should run continuously after `jump.sh install`
- `npx jump.sh` runs foreground daemon
- State stored under `~/.jump.sh/projects.db`

## MVP scope
1. Rebrand localhaus -> jump.sh naming and paths
2. Move runtime state from `~/.localhaus` to `~/.jump.sh`
3. Keep current core architecture: dashboard, Docker manager, subdomain proxy, worktree scanner
4. Add CLI command surface aligned with spec (`add`, `install`, `start`, `stop`, `logs`, `ls`)
5. Keep localhost mode first; remote mode hooks can be scaffolded

## Non-goals for first pass
- Full production Cloud DNS API implementation
- Full Let's Encrypt issuance service
- Full GitHub OAuth production backend

