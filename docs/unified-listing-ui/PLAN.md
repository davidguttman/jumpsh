# Unified Listing UI — Implementation Plan

Reference: `docs/plans/2026-03-04-unified-listing-ui-design.md`

## Key Design Decision: Full Page Navigation for Expand

Expanding a project triggers a **full page reload**, not AJAX:
1. User clicks expand toggle → `window.location` updates to `/?expand=<name>`
2. Server renders the page with that project's detail data pre-loaded
3. Collapsing navigates back to `/` (no expand param)

This avoids the complexity of client-side data fetching, AJAX endpoints, and partial hydration. Alpine.js is used only for client-side interactions within the already-rendered page (settings toggle, log tabs, filter/sort), not for data loading.

---

## Step 1: Add Alpine.js CDN to layout

**Files:** `views/index.ejs`

- Add `<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js"></script>` before `</head>`
- Add `[x-cloak] { display: none !important; }` style to CSS
- Wrap `<main>` content in an `x-data` scope for client-side state (filter, sort, settings toggle — NOT expand state)

**Verify:** Page loads without errors, Alpine initializes (check `$data` in console)

---

## Step 2: Convert project grid to row-based layout

**Files:** `views/index.ejs`, `public/styles.css`

- Replace `.project-grid` div with a `.project-list` container (stacked full-width rows)
- Replace `.project-card` with `.project-row` — a full-width row containing:
  - Expand toggle link (`<a href="/?expand=<name>">`) showing ▶ (collapsed) or ▼ (expanded)
  - Project name
  - URL (linked when healthy, plain when not)
  - Start/Stop button (existing `_action_btn` partial)
  - Worktree branch names inline (desktop only)
- CSS: Remove `.project-grid` grid styles, add `.project-list` as flex column with gap
- CSS: `.project-row` is a `.panel` with horizontal flex layout

**Verify:** All projects render as full-width rows, same info as current cards, no grid

---

## Step 3: Add collapsed row responsive styles

**Files:** `public/styles.css`

- Desktop (>600px): `.project-row` is horizontal flex. Left side: toggle + name + URL + action btn. Right side: worktree branches as horizontal list
- Mobile (<=600px): `.project-row` stacks vertically — name/URL on top, worktrees below
- Worktree branches in collapsed row: small inline chips/links, not the full `<ul>` from current cards

**Verify:** Resize browser — desktop shows worktrees to the right, mobile stacks them below

---

## Step 4: Extract detail content into reusable EJS partial

**Files:** `views/partials/_project_detail.ejs` (new), `views/project.ejs`

- Extract the detail content from `views/project.ejs` into `views/partials/_project_detail.ejs`:
  - Project path (`<code>`)
  - Settings section (collapsible)
  - Worktrees table
  - Build logs section
  - Logs section (tabbed viewer)
  - Action buttons (Delete, Restart, Stop/Start)
- The partial expects locals: `project`, `worktrees`, `logs`, `detection`, `config`
- Update `views/project.ejs` to `<%- include('partials/_project_detail', { ... }) %>`
- Confirm standalone `/projects/:id` page still works identically

**Verify:** `/projects/:id` renders exactly as before using the new partial

---

## Step 5: Pass detail data to index page from server

**Files:** `server.js`

- Read `req.query.expand` in the `GET /` handler
- If `expand` param is present, find the matching project by name (case-insensitive match against `mainProjects`)
- If found, fetch detail data for that project only:
  - `logs` (last 200 lines via `docker.getLogs`)
  - `detection` (via `detectProjectType`)
  - `worktrees` with status — already available via `worktreesByParent`
- **If `expand` param doesn't match any project name, ignore it** (don't error — just render all collapsed)
- Add to render locals: `expandedProject` (full detail data or `null`), `expandedName` (the name string or `null`)
- Auto-expand logic: if `projects.length === 1` and no `?expand` param, set `expandedProject` to that project's detail data automatically

**Verify:** `/?expand=openclaw` passes full detail data for openclaw to the template. `/?expand=nonexistent` renders normally with all collapsed.

---

## Step 6: Implement expand/collapse in the template

**Files:** `views/index.ejs`

- For each project row, check server-side: `<% if (expandedName === project.name) { %>`
  - Render toggle as ▼ with link to `/` (collapse = navigate to index without expand)
  - Render the `_project_detail` partial below the collapsed header
- Otherwise:
  - Render toggle as ▶ with link to `/?expand=<%= encodeURIComponent(project.name) %>`
- The expand/collapse links are plain `<a>` tags — clicking them triggers a full page navigation
- No Alpine needed for expand/collapse itself

**Verify:** Click row → page reloads with that project expanded. Click collapse → page reloads with all collapsed. Only one row expanded at a time.

---

## Step 7: URL state and deep linking

**Files:** `views/index.ejs`

- Expand links use `encodeURIComponent(project.name)` to handle special characters in project names (spaces, ampersands, etc.)
- Server reads `decodeURIComponent(req.query.expand)` and matches against project names
- Start/Stop buttons on collapsed rows use form POST or fetch + `location.reload()` (current behavior) — the reload preserves the current URL including any `?expand` param
- Deep link flow: `/?expand=openclaw` → server pre-renders expanded → no flash, no client-side hydration needed

**Verify:** Project name with special chars (e.g., `my-app_v2`) round-trips correctly through URL. Deep link from CLI opens correctly.

---

## Step 8: Auto-expand single project

**Files:** `server.js`, `views/index.ejs`

- Server-side in `GET /`: if `mainProjects.length === 1` and no `?expand` param, automatically set `expandedProject` to that project's detail data and `expandedName` to its name
- Template renders the single project as expanded (same as if `?expand` was set)
- URL stays as `/` (no redirect to `/?expand=<name>`) — the auto-expand is implicit

**Verify:** With 1 project → page loads with it expanded. With 2+ → all collapsed. Adding a second project → auto-expand stops.

---

## Step 9: Smooth CSS transitions for expand/collapse

**Files:** `public/styles.css`

- Since expand/collapse is a full page navigation, traditional CSS transitions won't apply between page loads
- Instead, focus on:
  - Clean visual distinction between expanded and collapsed rows (border highlight, background tint)
  - `.project-row.expanded` gets a visual indicator (e.g., accent border-left, subtle background change)
  - Expanded detail section has no abrupt layout — smooth border between header and detail
- Logs section has fixed `max-height` to prevent layout jumps
- Consider `scroll-margin-top` on the expanded row so it scrolls into view on page load

**Verify:** Expanded row is visually distinct. Page loads with expanded row visible (not scrolled off-screen).

---

## Step 10: Adapt detail scripts for inline context

**Files:** `views/partials/_project_detail.ejs`, `views/index.ejs`

Since only one project can be expanded at a time (server-rendered), the detail scripts don't need multi-instance scoping. However, they do need lifecycle management:

**EventSource lifecycle:**
- Log stream `EventSource` connects on page load when a project is expanded
- On `beforeunload`, close the EventSource to prevent connection leaks
- Error handling: on `EventSource.onerror`, close and show "connection lost" message (no auto-retry — user can reload)
- Build log streaming follows same pattern

**Script scoping:**
- The detail partial's `<script>` block runs in the context of the expanded project only
- `projectId` is set from the expanded project's ID (server-rendered)
- Settings save, Start/Stop/Restart/Delete functions already take `id` param — confirm they work
- `deleteProject()` redirects to `/` (removes expand param naturally)

**Alpine interactions within detail:**
- Settings toggle uses Alpine `x-data="{ open: false }"` scoped to the settings section
- Build logs toggle similarly scoped
- Log tab switching uses Alpine state, not global variables

**Verify:** Expand project → logs stream. Navigate away → EventSource closes. Settings save works. Delete redirects to `/`.

---

## Step 11: Adaptive controls (sort/filter at thresholds)

**Files:** `views/index.ejs`, `public/styles.css`

- Add a controls bar above the project list, rendered conditionally with EJS:
  ```ejs
  <% if (projects.length >= 4) { %>
    <div class="project-controls" x-data="{ filter: '', sort: 'status' }">
      <input type="text" placeholder="filter..." x-model="filter" class="input">
      <% if (projects.length >= 6) { %>
        <select x-model="sort" class="input">
          <option value="status">by status</option>
          <option value="name">by name</option>
        </select>
      <% } %>
    </div>
  <% } %>
  ```
- **Filter is client-side only:** text match on project name, hide non-matching rows with `x-show="!filter || projectName.includes(filter)"` on each row
- **Filter does NOT persist in URL** — it resets on navigation (keep it simple)
- **Sort options:** `status` (running first, then stopped — default) or `name` (alphabetical). Sort is also client-side only, does not persist.
- If a filtered-out project is expanded, it remains visible (filter doesn't hide expanded row)
- Controls bar styled as a subtle row above the list: flex layout, gap, same panel background

**Verify:** 1-3 projects → no controls. 4+ → search appears. 6+ → sort dropdown appears. Typing in filter hides non-matching rows instantly. Sort reorders rows.

---

## Step 12: Handle `/projects/:id` route (redirect)

**Files:** `server.js`

- Change `GET /projects/:id` to:
  1. Look up project by ID from the database (`db.getProject(id, ...)`)
  2. If not found → return 404
  3. If found → redirect 302 to `/?expand=<encodeURIComponent(project.name)>`
- Keep the redirect as 302 (not 301) so it's not cached permanently — allows reverting later
- Update internal links:
  - Project name links in collapsed rows → `/?expand=<name>` (already handled in Step 6)
  - Remove `detail` link from cards (replaced by expand toggle)
- Keep `views/project.ejs` and the partial intact for now — the standalone route can be re-enabled if needed

**Verify:** `GET /projects/123` → 302 redirect to `/?expand=openclaw`. Invalid ID → 404. No internal links still point to `/projects/:id`.

---

## Step 13: Edge cases and loading states

**Files:** `views/index.ejs`, `server.js`

**Edge cases:**
- **0 projects:** Empty state renders as-is (existing `.empty-state` block — no changes needed)
- **Invalid `?expand` param:** Server ignores it, renders all rows collapsed (no error, no flash)
- **Special characters in project name:** `encodeURIComponent` / `decodeURIComponent` handles this (tested in Step 7)
- **Project deleted while expanded:** `deleteProject()` redirects to `/`, expand param gone
- **Start/Stop while expanded:** Current fetch + `location.reload()` pattern preserves URL, so expanded state persists through start/stop

**Loading states:**
- No special loading indicator needed — full page navigation shows the browser's native loading indicator
- For Start/Stop buttons: existing "Starting..."/"Stopping..." text on button (already implemented)
- Startup progress SSE: existing `subscribeStartup()` pattern works within expanded detail

**Verify:** Test each edge case. 0 projects shows empty state. Bad expand param shows all collapsed. Start/stop preserves expanded state.

---

## Step 14: Final polish and cleanup

**Files:** all modified files

- Remove `.project-grid` CSS styles (dead code)
- Remove `.project-card` CSS styles (replaced by `.project-row`)
- Remove `.detail-link` styles (no longer needed)
- Confirm `views/project.ejs` still works if accessed directly (for backward compat during transition)
- Test all acceptance criteria from design doc:
  - [ ] 1 project auto-expands with full detail
  - [ ] 2+ projects show collapsed rows
  - [ ] Click expand → page loads with detail content
  - [ ] `/?expand=<name>` deep links correctly
  - [ ] `/projects/:id` redirects to `/?expand=<name>`
  - [ ] Desktop: worktrees horizontal in collapsed row
  - [ ] Mobile: stacks vertically
  - [ ] No functionality lost from current detail page
  - [ ] Sort/filter appear at thresholds (4+/6+)
- Test with 0, 1, 3, and 6+ projects
- Test mobile layout
- Test deep link round-trip with special characters

**Verify:** All acceptance criteria pass. No dead CSS. No broken links. No console errors.

---

## File Change Summary

| File | Action |
|---|---|
| `views/index.ejs` | Major rewrite — Alpine.js, row layout, server-rendered expand, controls |
| `views/partials/_project_detail.ejs` | New — extracted from project.ejs |
| `views/project.ejs` | Use new partial (kept for backward compat) |
| `public/styles.css` | Remove grid/card, add row styles, expanded state, responsive, controls |
| `server.js` | Expand `GET /` with `?expand` handling, redirect `GET /projects/:id` |

## Dependencies

- Alpine.js 3.x via CDN (no npm install needed)
- No build step changes
