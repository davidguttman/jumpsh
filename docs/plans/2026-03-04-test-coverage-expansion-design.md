# Test Coverage Expansion Design

## Context
Issue #4 expands test coverage across unit, integration, and e2e layers for jump.sh.

## Scope
1. Unit tests
   - ProjectDetector framework/package-manager coverage
   - ComposeGenerator output generation coverage
   - CLI parsing and command routing behavior
2. Integration tests
   - Database CRUD + port allocation
   - SubdomainProxy routing and error pages with mocked dependencies
   - WorktreeScanner discovery/upsert/delete behavior with mocked exec/fs
3. DockerManager refactor
   - Inject executable runner dependency instead of hardcoded spawn
   - Preserve behavior while enabling deterministic tests
4. DockerManager integration tests
   - Validate command construction, lifecycle handling, error cases via injected runner mocks
5. E2E expansion
   - Lifecycle flow
   - Worktree flow + branch URL behavior
   - CLI command-level verification
   - Key error scenarios (missing docker, port conflicts)

## Non-goals
- Functional product changes beyond testability refactors
- Major API redesign outside minimal DI seams

## Success Criteria
- New tests added for all issue checklist areas
- Existing tests remain green
- `npm test` passes with expanded suite
- Any new e2e scripts are runnable and documented
