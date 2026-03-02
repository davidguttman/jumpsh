#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/e2e/lifecycle/docker-compose.e2e.yml"

# The fixture path on the host — Docker daemon needs this exact path
export FIXTURE_HOST_PATH="$REPO_ROOT/e2e/lifecycle/fixture"

echo "=== Localhaus E2E Lifecycle Test ==="
echo "  REPO_ROOT=$REPO_ROOT"
echo "  FIXTURE_HOST_PATH=$FIXTURE_HOST_PATH"
echo ""

# Clean up prior runs
cleanup() {
  echo ""
  echo "=== Cleaning up ==="
  docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans 2>/dev/null || true
  # Also clean up the fixture's containers if they were started
  docker compose -f "$FIXTURE_HOST_PATH/docker-compose.yml" down --volumes --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

# Remove any leftover state
cleanup

# Build and run
echo "=== Building and running e2e tests ==="
docker compose -f "$COMPOSE_FILE" up \
  --build \
  --abort-on-container-exit \
  --exit-code-from test-runner

RESULT=$?

echo ""
if [ $RESULT -eq 0 ]; then
  echo "=== E2E lifecycle test PASSED ==="
else
  echo "=== E2E lifecycle test FAILED (exit code $RESULT) ==="
fi

exit $RESULT
