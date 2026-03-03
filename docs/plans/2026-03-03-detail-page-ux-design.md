# Detail Page UX Simplification

**Date:** 2026-03-03
**Status:** Approved

## Changes

### Main Project Card
- Remove status indicator (RUNNING/STOPPED/STARTING) — status implicit in Start/Stop button
- Remove "Path:" and "Subdomain:" labels (keep values only)

### Worktree Table
- Remove header row entirely
- Remove status column
- Remove full URL column  
- Remove logs button per worktree
- Branch name becomes clickable link to worktree URL
- Keep Start/Stop buttons

### Logs Section
- Replace with tabbed view
- Tabs: main branch (project name) + one tab per worktree
- Main tab selected by default
- Tab switch disconnects old stream, loads history, connects new stream

## Wireframe
```
┌─────────────────────────────────────┐
│ project-name                        │
│ /home/.../project                   │
│ project.jump.sh                     │
│ [Delete]           [Restart] [Stop] │
├─────────────────────────────────────┤
│ Worktrees (2)                       │
│ feature-x              [Restart][Stop]│
│ bugfix-y                    [Start] │
├─────────────────────────────────────┤
│ Logs                                │
│ [main] [feature-x] [bugfix-y]       │
│ ┌─────────────────────────────────┐ │
│ │ > Server listening on 3000      │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```
