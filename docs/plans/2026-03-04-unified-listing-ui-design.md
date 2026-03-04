# Unified Listing UI Design

**Date:** 2026-03-04
**Status:** Approved

## Overview

Replace the grid-based project listing with a unified row-based UI where listing and detail are the same thing at different zoom levels. Each project is a full-width row that can expand inline to show detail content.

**Goals:**
- Single project doesn't look lonely in an empty grid
- Scales naturally from 1 to many projects
- Progressive disclosure — show controls only when useful
- Deep-linkable state for CLI integration

## Frontend Approach

**Alpine.js** via CDN (no build step). Provides:
- `x-data` for component state
- `x-show` with `x-transition` for expand/collapse animations
- Simple, LLM-friendly directive syntax

This replaces the inherited EJS + vanilla JS patterns from the homebase prototype.

## Collapsed Row

Each project row when collapsed shows the same info as current cards:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ▶ openclaw   openclaw.davidguttman.jump.sh  [Stop]  │  feature-x  bugfix-y │
└─────────────────────────────────────────────────────────────────────────┘
```

**Content (same as current cards):**
- Expand toggle (▶/▼)
- Project name
- Full URL (linked when running)
- Start/Stop button
- Worktrees listed

**Responsive behavior:**
- **Desktop:** Main project info left, worktrees use horizontal space on right
- **Mobile:** Stacks vertically (same as current cards)

## Expanded Row

When expanded, shows current detail page content inline — no changes, no removals:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ▼ openclaw   openclaw.jump.sh  [Stop]  │  feature-x  bugfix-y           │
├─────────────────────────────────────────────────────────────────────────┤
│  /home/dguttman/play/js/openclaw                                        │
│                                                                          │
│  ▶ settings (collapsible)                                               │
│                                                                          │
│  Worktrees (2) — table format                                           │
│                                                                          │
│  Logs — tabbed view [main] [feature-x] [bugfix-y]                       │
│                                                                          │
│  [Delete]                                              [Restart] [Stop] │
└─────────────────────────────────────────────────────────────────────────┘
```

Expanded state = current detail page content, 1:1.

## Adaptive Behavior

**Auto-expand:**
- 1 project → auto-expanded by default
- 2+ projects → all collapsed by default

**Controls (progressive disclosure):**
- 1-3 projects → no sort/filter controls
- 4+ projects → search box appears
- 6+ projects → sort/filter dropdowns appear

Thresholds can be tuned based on usage.

## Deep Linking

**URL state:**
- `/?expand=openclaw` — index with that project expanded
- `/?expand=openclaw&sort=name` — preserves sort/filter state (when controls exist)

**Route behavior:**
- `/projects/:id` — redirects to `/?expand=:id` (or renders standalone, TBD)
- `/add` — stays as separate route

**CLI integration:**
- `jumpsh dash` → opens `/`
- `jumpsh dash open <project>` → opens `/?expand=<project>`
- `jumpsh dash add` → opens `/add`

## Implementation

**Files to modify:**
- `views/index.ejs` — new row-based layout with Alpine.js
- `public/styles.css` — row styles, responsive breakpoints, transitions
- `views/project.ejs` — extract shared partial for detail content, or deprecate

**Phases:**
1. Add Alpine.js, implement row layout with expand/collapse
2. Extract detail content into partial, use in expanded rows
3. Add URL state management (expand param)
4. Add adaptive controls at thresholds
5. Deprecate or redirect `/projects/:id`

## Acceptance Criteria

- [ ] 1 project auto-expands, shows full detail content
- [ ] 2+ projects show collapsed rows
- [ ] Clicking row expands inline with full detail content (same as current detail page)
- [ ] Expand/collapse has smooth CSS transition
- [ ] `/?expand=<name>` deep links to expanded state
- [ ] `/projects/:id` still works (redirect or standalone)
- [ ] Desktop: worktrees use horizontal space in collapsed row
- [ ] Mobile: stacks vertically
- [ ] No functionality lost from current detail page
- [ ] Sort/filter controls appear only when project count warrants
