#!/usr/bin/env bash
# Publishes dsh-context to npm as the authenticated user.
#
# Usage: NPM_TOKEN=<token> pnpm run release [patch|minor]; 2FA accounts also pass NPM_OTP (or use an Automation
# token). The token comes from the environment only, never a file — export it to keep it out of shell history.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUMP="${1:-patch}"
: "${NPM_TOKEN:?NPM_TOKEN is not set — run with NPM_TOKEN=<token> pnpm run release}"

# Keep npm's cache/logs inside the repo when the default location (~/.npm) is not writable (sandboxed builds, read-only home).
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$ROOT/.npm-cache}"
mkdir -p "$NPM_CONFIG_CACHE"

echo "==> building lib/ artifacts"
pnpm run build

NAME="$(node -p "require('./package.json').name")"
CURRENT="$(node -p "require('./package.json').version")"

# Auto-bump only when the current version is already published, so re-running after a successful publish is a no-op.
PUBLISHED="$(npm view "$NAME" version 2>/dev/null || true)"
if [[ "$CURRENT" == "$PUBLISHED" ]]; then
  echo "==> version $CURRENT already on the registry — bumping ($BUMP)"
  npm version "$BUMP" --no-git-tag-version >/dev/null
  CURRENT="$(node -p "require('./package.json').version")"
fi

echo "==> publishing $NAME@$CURRENT"
PUBLISH_ARGS=(--access public --registry https://registry.npmjs.org \
  --//registry.npmjs.org/:_authToken="$NPM_TOKEN")
if [[ -n "${NPM_OTP:-}" ]]; then PUBLISH_ARGS+=(--otp "$NPM_OTP"); fi
npm publish "${PUBLISH_ARGS[@]}"

echo "==> verifying"
LIVE="$(npm view "$NAME" version --registry https://registry.npmjs.org)"
echo "✔ $NAME@$LIVE is live at https://www.npmjs.com/package/$NAME"
if [[ "$LIVE" != "$CURRENT" ]]; then
  echo "⚠  registry reports $LIVE (expected $CURRENT) — check the publish log above" >&2
  exit 1
fi
