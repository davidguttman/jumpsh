#!/usr/bin/env bash
# Install git hooks for the project

set -e

HOOKS_DIR="$(git rev-parse --show-toplevel)/.git/hooks"

mkdir -p "$HOOKS_DIR"

cat > "$HOOKS_DIR/commit-msg" << 'HOOK'
#!/usr/bin/env bash
npx --no -- commitlint --edit "$1"
HOOK

chmod +x "$HOOKS_DIR/commit-msg"

echo "commit-msg hook installed"
