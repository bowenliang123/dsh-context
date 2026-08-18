#!/usr/bin/env bash
# Installs the repo's git hooks natively (no husky), so `pnpm run typecheck`
# runs on every commit. Requires the repo to be a git working tree.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_DIR="$ROOT/.git/hooks"

mkdir -p "$HOOKS_DIR"

cat > "$HOOKS_DIR/pre-commit" <<'EOF'
#!/usr/bin/env sh
pnpm run typecheck
EOF

chmod +x "$HOOKS_DIR/pre-commit"
echo "pre-commit hook installed at .git/hooks/pre-commit"
