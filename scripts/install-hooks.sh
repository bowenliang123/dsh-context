#!/usr/bin/env bash
# Installs a native pre-commit hook that runs `pnpm run typecheck`. Git only
# executes .git/hooks when `core.hooksPath` is unset (husky sets it to .husky/_).
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
